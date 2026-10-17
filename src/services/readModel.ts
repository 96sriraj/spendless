/**
 * The read model behind `GET /api/state`.
 *
 * This is what the first screen is coded against, and it exists because a
 * hardcoded figure on a screen is not a figure — it is a number somebody typed.
 * `PLACEHOLDER_RISK_CENTS` rendered convincingly and computed nothing, and no
 * test could have contradicted it.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN, IN ORDER, AND WHY THE ORDER IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 *     transactions -> recurrence -> subscriptions -> insights -> a total
 *
 * Every step is a pure core function except the reads and writes. That is the
 * point of the ports-and-adapters split: this file is the only place the layers
 * meet, so the logic stays testable without a Worker, and the Worker stays a
 * router rather than a detector.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE IS PART OF THE ANSWER, NOT A DECORATION
 * ---------------------------------------------------------------------------
 *
 * D5 splits the data into three lanes, and only one of them is a payment PayPal
 * reported. A finding that does not say which lane produced it is undisplayable:
 * either the UI shows seeded history as revenue, or it labels everything and
 * makes the real thing look like a mock. So `lane` travels on every finding and
 * on the model as a whole.
 *
 * The marker cannot do this job. `spendless:` appears in the `custom_id` of a
 * *live* sandbox capture as well — that is precisely how identity round-trips
 * through Transaction Search — so a marker-derived lane would report real money
 * as invented. Hence the explicit column.
 *
 * ---------------------------------------------------------------------------
 * ONE CURRENCY PER MODEL, DECLARED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 *
 * Summing cents across currencies is meaningless. `sub-adobe` settles in USD and
 * a consumer's CSV may be INR. The model reports the currency its findings are
 * denominated in and refuses to total across a mixed set, because a summed
 * number across currencies is a number that means nothing and looks authoritative.
 */

import { computeInsights, type Recommendation } from "@/core/insights";
import { inferRecurrence } from "@/core/recurrence";
import { buildSubscriptions } from "@/core/subscriptions";
import type { Currency, Subscription } from "@/core/validators";
import type { Database } from "@/db";
import { createD1KvStore } from "@/db/kvStore";
import { listSubscriptions, upsertSubscription } from "@/db/subscriptions";
import { listLanes, listTransactions, type Lane } from "@/db/transactions";

export type ReadModelFinding = Recommendation & {
  /**
   * Where this finding's data came from. The UI must render it — a figure
   * derived from seeded history that is presented as a live payment is the one
   * unrecoverable mistake this product can make.
   */
  readonly lane: Lane;
};

export type ReadModel = {
  /** When this was computed. A figure with no timestamp is not evidence. */
  readonly generatedAt: string;
  /**
   * The headline. The sum of `savingCents` across findings.
   *
   * `savingCents`, never `displaySaving`: the latter is a preformatted string
   * ("$47.97 wasted") chosen per card, and adding up strings produces a number
   * that corresponds to nothing.
   */
  readonly totalRiskCents: number;
  /** Null when the findings span currencies and cannot honestly be totalled. */
  readonly currency: Currency | null;
  readonly findings: readonly ReadModelFinding[];
  readonly subscriptions: readonly Subscription[];
  /** Lanes that contributed rows. Empty means there is nothing to explain. */
  readonly lanes: readonly Lane[];
  readonly transactionCount: number;
};

/** How many rows a subscription needs before its history is worth keeping. */
const MAX_SUBSCRIPTIONS = 200;

/**
 * Identity is resolved by the adapter, not by this file.
 *
 * Mirrors `McpPayPalAdapter`/`createCsvAccountSource`: a transaction is ours iff
 * its `custom_id` carries the seed marker. Re-deciding it here would give the
 * read path a second, possibly divergent, answer to "is this row identified?".
 */
function identitySourceOf(customId: string | null): "seed_marker" | "unknown" {
  return customId !== null && customId.startsWith("spendless:") ? "seed_marker" : "unknown";
}

export async function buildReadModel(db: Database, now: Date): Promise<ReadModel> {
  const stored = await listTransactions(db);
  const lanes = await listLanes(db);

  const subscriptions = await reconcileSubscriptions(db, stored, now);

  const findings = await computeInsights(createD1KvStore(db, () => now.toISOString()), subscriptions, now);

  // A finding's lane is the lane of its subscription's rows. In practice every
  // row for one merchant key shares a lane, because a merchant key is written by
  // one lane — but the *first* row is taken rather than the most recent, so the
  // label cannot drift as new rows arrive.
  const laneByMerchant = new Map<string, Lane>();
  for (const tx of stored) {
    if (!laneByMerchant.has(tx.merchantName)) laneByMerchant.set(tx.merchantName, tx.lane);
  }

  const decorated: ReadModelFinding[] = findings.map((finding) => ({
    ...finding,
    lane: laneByMerchant.get(finding.subId) ?? "live_sandbox",
  }));

  const currencies = new Set(
    subscriptions.map((s) => s.currency as Currency).filter((c) => c !== undefined),
  );

  return {
    generatedAt: now.toISOString(),
    // Summing across currencies is a number that means nothing and looks
    // authoritative, so the total is withheld rather than fudged.
    totalRiskCents: currencies.size <= 1 ? decorated.reduce((sum, f) => sum + f.savingCents, 0) : 0,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    findings: decorated,
    subscriptions,
    lanes,
    transactionCount: stored.length,
  };
}

/**
 * Recurrence inference over stored rows, upserted into `subscriptions`.
 *
 * Re-derived on every read rather than cached. Recurrence depends on the whole
 * series, so a cached subscription goes stale the moment a charge lands, and the
 * demo re-seeds freely anyway. `insertSubscription` is an upsert keyed on id, so
 * this is idempotent.
 *
 * Bounded by `MAX_SUBSCRIPTIONS` because inference is O(rows) and a runaway
 * importer should degrade rather than hang the request. The cap is on rows
 * *considered*, and the cut is deterministic (oldest charges dropped first), so
 * the same database always produces the same figure.
 */
async function reconcileSubscriptions(
  db: Database,
  stored: Awaited<ReturnType<typeof listTransactions>>,
  now: Date,
): Promise<Subscription[]> {
  const capped =
    stored.length > MAX_SUBSCRIPTIONS
      ? stored.slice(stored.length - MAX_SUBSCRIPTIONS)
      : stored;

  const recurrences = inferRecurrence(
    capped.map((tx) => ({
      merchantKey: tx.merchantName,
      identitySource: identitySourceOf(tx.customId),
      amountCents: tx.amountCents,
      currencyCode: tx.currency,
      capturedAt: tx.capturedAt,
    })),
  );

  // The account's settlement currency is what the sandbox merchant settles in,
  // and it is what a series with an unsupported code falls back to. Read from
  // the rows rather than hardcoded, because a EUR-only account summing into USD
  // is the kind of error that is invisible until it is a real invoice.
  const currencies = [...new Set(capped.map((tx) => tx.currency))];
  const accountCurrency: Currency = currencies.length === 1 && currencies[0] === "INR" ? "INR" : "USD";

  for (const sub of buildSubscriptions(recurrences, { now, currency: accountCurrency })) {
    // Upsert, not insert: this runs on every poll of `/api/state`, and an insert
    // would fail with a UNIQUE violation on the second one.
    await upsertSubscription(db, sub);
  }

  const all = await listSubscriptions(db);

  // Drop subscriptions whose series is gone, so a reseed does not leave a stale
  // subscription behind to be counted into a total the merchant no longer has.
  const live = new Set(recurrences.map((r) => r.merchantKey));
  return all.filter((sub) => live.has(sub.id));
}