-- spendless schema. SQLite dialect, same as D1.
--
-- Two deliberate choices:
--
--  1. Real columns everywhere. Nixt's `kv` blob table is NOT ported: price
--     history, usage, savings and the action ledger get genuine columns, so
--     they can be queried, indexed and reasoned about. A JSON blob would have
--     been less code and more of a lie.
--
--  2. Currency is USD or INR. USD because the PayPal sandbox is USD; INR
--     because the lifted Nixt detectors assume it. It is threaded per row, not
--     global - ARCHITECTURE.md section 5.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Compatibility shim for the lifted detectors.
--
-- The five modules lifted from Nixt (priceHistory, unusedDetector,
-- savingsLedger, cancelIntent, insights) talk to a key/value store. This table
-- is what backs it, and it exists ONLY so those modules work unchanged against
-- D1 before they are rewritten to use the typed tables below.
--
-- It is not the data model. price_points, usage_events and savings_events are.
-- When those three modules are migrated, this table and the D1 KVStore
-- adapter are deleted and nothing above them changes - that is the whole point
-- of routing them through the KVStore interface rather than importing a DB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Subscriptions - the recurring commitments spendless reasons about.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
  currency               TEXT NOT NULL CHECK (currency IN ('USD', 'INR')),
  billing_cycle          TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly', 'weekly')),
  -- Nullable on purpose: a PayPal transaction can be seen before its
  -- subscription plan is. `checkUnused` needs this date; `listTransactions`
  -- does not.
  next_renewal           TEXT,
  category               TEXT NOT NULL DEFAULT 'other',
  trial_end_date         TEXT,
  -- There is no usage signal in PayPal data (ARCHITECTURE.md section 8). This
  -- is the field the agent ASKS for, at the moment the renewal makes it matter.
  last_used_date         TEXT,
  annual_amount_cents    INTEGER CHECK (annual_amount_cents IS NULL OR annual_amount_cents > 0),
  notes                  TEXT,
  paypal_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'cancelled', 'ended')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_next_renewal ON subscriptions (next_renewal);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status       ON subscriptions (status);

-- ---------------------------------------------------------------------------
-- Transactions - the raw PayPal activity the whole thing is anchored on.
--
-- `custom_id` and `raw` exist because Spike S-2 has NOT been answered yet:
-- it is unknown whether list_transactions surfaces merchant-level identity.
-- `raw` keeps the verbatim response so that answer can be recovered from data
-- already collected, rather than requiring the sandbox to still be up.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT REFERENCES subscriptions (id) ON DELETE SET NULL,
  merchant_name    TEXT NOT NULL,
  merchant_id      TEXT,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL CHECK (currency IN ('USD', 'INR')),
  billing_cycle    TEXT CHECK (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'yearly', 'weekly')),
  direction        TEXT NOT NULL CHECK (direction IN ('sale', 'refund')),
  status           TEXT NOT NULL
                     CHECK (status IN ('completed', 'pending', 'denied', 'refunded')),
  captured_at      TEXT NOT NULL,
  custom_id        TEXT,
  raw              TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_captured_at     ON transactions (captured_at);
CREATE INDEX IF NOT EXISTS idx_transactions_subscription_id ON transactions (subscription_id);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant        ON transactions (merchant_name);

-- ---------------------------------------------------------------------------
-- Price points - one row per observed amount, so a hike is a diff of rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_points (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL CHECK (currency IN ('USD', 'INR')),
  recorded_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_points_sub ON price_points (subscription_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Usage events - append-only, because "when did you last use this" is a
-- question with a history, and only the latest row answers `checkUnused`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  last_used_at    TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent', 'import')),
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_sub ON usage_events (subscription_id, last_used_at);

-- ---------------------------------------------------------------------------
-- Action ledger. proposal -> approval -> execution -> result, all persisted
-- (ARCHITECTURE.md section 7). `action_proposals` and `action_results` are
-- separate tables because the gap between them IS the approval, and a refund
-- must never be able to reach a result row without one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_proposals (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('refund', 'cancel_subscription', 'resolve_dispute', 'ask_usage')),
  status             TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  target_id          TEXT,
  -- Nullable: a cancellation moves no money. A refund always has one.
  amount_cents       INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  currency           TEXT NOT NULL CHECK (currency IN ('USD', 'INR')),
  rationale          TEXT NOT NULL,
  evidence           TEXT,
  -- Hard-coded 1, not a default anyone can flip. Autonomy is a product change.
  requires_approval  INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval = 1),
  approved_at        TEXT,
  approved_by        TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_proposals_status ON action_proposals (status);
CREATE INDEX IF NOT EXISTS idx_action_proposals_run_id ON action_proposals (run_id);

CREATE TABLE IF NOT EXISTS action_results (
  id           TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL REFERENCES action_proposals (id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  provider_ref TEXT,
  amount_cents INTEGER,
  message      TEXT,
  executed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_results_proposal ON action_results (proposal_id);

-- ---------------------------------------------------------------------------
-- Savings events - money actually stopped. Append-only, monthly-normalised so
-- the running total and the trend are comparable across billing cycles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_events (
  id                   TEXT PRIMARY KEY,
  subscription_id      TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('cancel', 'downgrade', 'refund')),
  amount_delta_cents   INTEGER NOT NULL,
  currency             TEXT NOT NULL CHECK (currency IN ('USD', 'INR')),
  confirmed_at         TEXT NOT NULL,
  action_proposal_id   TEXT REFERENCES action_proposals (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_savings_events_confirmed ON savings_events (confirmed_at);

-- ---------------------------------------------------------------------------
-- Run log - every LLM call, tool call and result. The demo multiplier
-- (ARCHITECTURE.md section 9): without it a judge has to take the agent's
-- behaviour on trust. UNIQUE (run_id, seq) is what makes a replay faithful.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('llm_call', 'tool_call', 'tool_result', 'note')),
  label       TEXT NOT NULL,
  payload     TEXT,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps (run_id, seq);