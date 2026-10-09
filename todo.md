# spendless — Agent TODO (execution plan)

> **This is the agent lane.** Human-only items (accounts, keys, recording, submitting) live in
> [`human-todo.md`](./human-todo.md). The agent lane **blocks** wherever a human item is unchecked.
>
> **Authoritative sources:** [`AGENTS.md`](./AGENTS.md) (rules) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> (design + §12 build order). This file schedules that work; it does not restate the design.
>
> **Format per task:** `[WHERE] [HOW] → expect [RESULT]`. One task in flight at a time.
> Check a box only after the **Verification gates** at the bottom pass.
>
> **Every task is `[tier: unit|integration|e2e]`-tagged.** This repo is developed test-first
> (`AGENTS.md` → *Test-driven development*): **no production file is added or changed without a test
> that fails because of the change.** Write the red test first, then the code. A `[unit]` task is a
> pure function with zero mocks; an `[integration]` task runs against real collaborators (real SQLite,
> real FS); an `[e2e]` task runs the whole journey through every real layer. Reach for the lowest
> tier that can honestly prove the claim.
>
> **Stack:** TypeScript strict · bun · vitest · Cloudflare Workers + D1 (wrangler) · zod ·
> raw SQL (**no ORM**) · React UI. No Expo, no React Native, no RevenueCat, no OneSignal.
>
> **Hard gates:** Spike go/no-go **Oct 12** · kill switch **Oct 20** · Devpost locks **Nov 12, 12:00pm PT**.
> Demo reliability beats features. Scope is frozen — anything not on the ARCHITECTURE.md §12 table is out.

---

## Progress

> **Snapshot: Oct 9 2026.** Repo is docs + config only. No `package.json`, no source, no tests.

**Committed:** `README.md` (scope) · `LICENSE` (MIT — required by Devpost, never remove).

**Untracked — commit these before starting Phase 0:**

- [ ] `AGENTS.md` — rules, binding constraint, Nixt lift instructions
- [ ] `ARCHITECTURE.md` — design, spike, build order
- [ ] `opencode.jsonc` — `paypal-local` (disabled until a token exists), `paypal-sandbox`, `cloudflare-docs`
- [ ] `skills-lock.json` + `.agents/skills/` — `paypal-integration`, `workers-best-practices`, `wrangler`

**Verified true:** sibling repo `D:\Github\nixt` exists; the 9 liftable files and ~6 colocated tests are
present in `D:\Github\nixt\src\lib`; `D:\Github\nixt\src\store\durableNotepad.ts` exists;
the reusable CORS allow-list is at `D:\Github\nixt\worker\src\index.ts:42-57`.

**Nothing else is built. Everything below Phase 0 is unstarted.**

---

## Phase 0 — The Spike (Oct 9–12) · **GO/NO-GO GATE**

> Nothing after this phase gets built until S-1..S-4 are answered. Run the queries **through
> `paypal-local` MCP** where possible, not by reading docs — ARCHITECTURE.md §2 is inference, not fact.
>
> **Blocked by H1-01..H1-04** (PayPal developer account, sandbox business account, app credentials,
> exported access token).

- [ ] **S0-01** `[opencode.jsonc]` Enable the `paypal-local` MCP server (`disabled: false`) after `PAYPAL_ACCESS_TOKEN` is exported → expect `/mcps` shows it connected, not `needs authentication`
  - A server showing `needs authentication` is *configured*, not *connected*. Finish it in `/mcps`.
  - Refresh the token proactively — sandbox tokens live **3–8 hours** (`AGENTS.md`).
- [ ] **S0-02** `[PayPal Dashboard]` Confirm the connected account is a **business** account with **Transaction Search** enabled on the app → expect the exact permission state recorded here
  - This is the assumption ARCHITECTURE.md §2 rests on. Confirm or refute it before anything else.
- [ ] **S0-03** **`list_transactions`** Call it against the sandbox for a recent date range → expect a response; record whether it succeeds, fails, or returns empty
- [ ] **S1 (Spike)** `[PayPal REST + OAuth]` Test OAuth login on a **personal** sandbox account and attempt a consumer-side activity read → expect a definitive yes/no recorded here
  - **This is the decision point.** If consumer-side read *is* possible, ARCHITECTURE.md §3 and
    §2 simplify substantially. If not, binding A (merchant-side) is confirmed. Write the answer into
    ARCHITECTURE.md and replace this box with the evidence.
- [ ] **S2 (Spike)** **`create_subscription_plan` → `create_subscription` → capture → `list_transactions`** Re-query after capture and **dump the actual response fields** → expect merchant name, amount, date, `custom_id` present or absent — recorded verbatim
  - **The one that quietly kills projects.** Without merchant-level identity the lifted detectors
    have no input. Check it before anything else.
  - Paste the real field list into ARCHITECTURE.md §11. Do not paraphrase it.
- [ ] **S3 (Spike)** **`@paypal/mcp --tools=all`** Call each tool once against the sandbox: `list_transactions`, `create_refund`, `get_refund`, `list_disputes`, `get_dispute`, `accept_dispute_claim`, `cancel_subscription`, `show_subscription_details`, `update_subscription`, `create_subscription_plan`, `create_subscription`, `create_order`, `pay_order` → expect a working / non-working / missing verdict per tool
  - Replace the assumption table in ARCHITECTURE.md §2 with the measured result.
- [ ] **S4 (Spike)** **`create_refund` on the S-2 capture · `cancel_subscription` on a live sub** → expect both to succeed end-to-end with real sandbox money moved
  - This is the "it acts" claim. If refund works, the action layer is real. If it does not, say so now.
- [ ] **S0-04** `[PayPal sandbox]` Force a dispute, then exercise `/v1/customer/disputes/{id}/adjudicate` and `/v1/customer/disputes/{id}/require-evidence` (sandbox-only) → expect a dispute that can be accepted by the agent
- [ ] **S0-05** `[measure]` Time a sandbox access token from issue to 401 → expect the real TTL, recorded (docs say 3–8h)
- [ ] **S0-06** `[ARCHITECTURE.md §11]` Write the S-1..S-5 results back into the doc → expect the ⚠️ "inferred, not verified" warning either struck or replaced with evidence
- [ ] **S0-07** `[GO/NO-GO — Oct 12]` Make the call → expect a recorded decision
  - **Go** → continue to Phase 1.
  - **No-go on consumer-side, go on merchant-side** → the default expected path. Proceed; binding A is the demo.
  - **No-go on both** → escalate to the founder immediately. Do not start Phase 1 against a dead integration.

---

## Phase 1 — Scaffold + make the graph pure (Oct 12–13)

> Build order 1. **This is the first refactor and it is one commit.** Everything after is cheaper
> because of it (`ARCHITECTURE.md` §5). Every task below is `[unit]` unless tagged otherwise.

- [ ] **P1-01** `[repo root]` `package.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `paths: { "@/*": ["./src/*"] }`), `vitest.config.mts`, `.gitignore` → expect `tsc --noEmit` and `vitest run` both run green on an empty suite
  - Carry the strict flags across from `D:\Github\nixt\tsconfig.json`.
- [ ] **P1-02** `[vitest.config.mts]` **The three-tier harness**: vitest `projects` for `unit` / `integration` / `e2e`, separate `include` globs, `node` environment, e2e gets the long timeout → expect `vitest --project unit|integration|e2e` each run in isolation
  - `src/**/*.test.ts` · `test/integration/**` · `test/e2e/**`. A test in the wrong tier is a wrong-tier test.
- [ ] **P1-03** `[package.json]` Scripts: `dev`, `deploy`, `test`, `test:unit`, `test:integration`, `test:e2e`, `test:watch`, `typecheck`, `verify` (typecheck + **all three tiers**), `db:migrate`, `seed` → expect `bun run verify` works end to end
  - `verify` runs unit + integration + e2e. The gate does not get a tier exemption.
- [ ] **P1-04** `[test/integration/architecture.test.ts]` **Architecture gates as failing tests**: no `openai` / `@paypal/agent-toolkit` / `node:fs` above `src/adapters/`; zero `vi.mock`/`vi.fn` in `src/core`; no `as any` / `@ts-ignore` / `@ts-expect-error` without a justification comment → expect the rules to **fail loudly** the moment they are broken, instead of being remembered
  - Run this **first**. The grep in P3-05 becomes redundant once this exists.
  - This is the entire risk hedge in `AGENTS.md`, converted from a convention into a regression test.
- [ ] **P1-05** `[src/db/schema.sql]` Write the real column schema — **do not port Nixt's `kv` blob table**: `transactions` · `subscriptions` · `price_points` · `usage_events` · `savings_events` · `action_proposals` · `action_results` · `run_steps` → expect each of these has genuine columns, not a JSON blob
- [ ] **P1-06** `[src/db/index.ts]` D1 access layer: `get`, `all`, `run` helpers + a `KVStore`-shaped adapter implementing the `kvGet`/`kvSet` surface the five Nixt modules expect → expect the adapter to be swappable and pure from the caller's view
  - **This is what replaces `durableNotepad`.** Signature match matters more than internals.
  - `KVStore` is a real injected interface, so `src/core` never imports the DB.
- [ ] **P1-07** `[test/integration/db]` **Cover the D1 adapter against real local SQLite** (`better-sqlite3`, same dialect D1 uses) → expect green with **no mocks of the adapter itself and no faked SQL**
  - Round-trip every table. Also prove the `KVStore` surface is a drop-in for `kvGet`/`kvSet`,
    including corrupt-JSON tolerance, which is the behaviour the lifted modules rely on.
  - `wrangler d1 execute --local` is the manual check for the real D1 runtime; the suite runs the
    same `schema.sql` through a real SQLite engine so CI needs no Cloudflare account.
- [ ] **P1-08** `[commit]` `refactor: replace durableNotepad KV wrapper with D1 adapter` → expect one clean commit, before any lifted file is copied

---

## Phase 2 — Lift the core (Oct 13–14)

> Build order 2. Copy, get green with **zero mocks**, then widen currency.
> Each "fix on lift" task is preceded by a **red** test that reproduces the defect.

- [ ] **P2-01** `[test/unit]` Copy the ~6 colocated tests from `D:\Github\nixt\src\lib` (`money` `dates` `validators` `brand` `cancelGuide` `cancelGuide.extended`) → expect them **red or failing to resolve**, because the modules do not exist here yet
  - This is the red step, honestly done: lift the tests *before* the source.
- [ ] **P2-02** `[src/core/]` Copy the 9 source files to make P2-01 green: `money.ts` `dates.ts` `duplicateDetector.ts` `validators.ts` `cancelGuide.ts` `cancelGuideData.ts` `annualSwitch.ts` `calendar.ts` `brand.ts` → expect every P2-01 test passes
  - Do **not** copy Nixt's Expo/RevenueCat/OneSignal/store code. Only `src/lib`.
  - `validators.ts` is the canonical type source — import from it, don't redeclare shapes.
  - `priceHistory` · `unusedDetector` · `savingsLedger` · `cancelIntent` · `insights` are **not** lifted
    here — they are the five impure modules and land with the `KVStore` interface in P2-05.
- [ ] **P2-03** `[test/unit]` All green with **zero mocks** — no `vi.mock` anywhere in `src/core` → expect the P1-04 gate test to be the thing that enforces it
  - If a lifted test needs a mock to pass, the purity refactor failed. Go back rather than mocking.
- [ ] **P2-04** `[test/unit]` **Regression test for invariant 1** (`ARCHITECTURE.md` §5): `computeInsights` upserts by strictly greater `savingCents`, so `costPerUse` must run before `checkUnused` for the richer "wasted" headline to win ties → expect a test that **fails if the two loops are swapped**
  - Then comment it in `src/core/insights.ts`, naming both functions and the reason.
- [ ] **P2-05** `[test/unit]` **Regression test for invariant 2**: `savingCents` is the ranking axis (forward monthly) and `displaySaving` is only what the UI renders; they are allowed to differ → expect a test that fails if either is collapsed into the other
  - Then comment it: **do not collapse.**
- [ ] **P2-06** `[test/unit → red]` Reproduce the `priceHistory` lift defect: the title renders raw cents (`Price hike: ₹${newAmountCents}` — no `/100`) → expect a failing assertion on the title string
- [ ] **P2-07** `[src/core/priceHistory.ts]` Fix P2-06 → expect correct currency in the title, P2-06 green
- [ ] **P2-08** `[test/unit → red]` Normalise `confidence` — it is `number` on `DuplicateFlag`/`Recommendation` but the literal `"possibly"` on `UnusedFlag` → expect a type-level assertion plus a value assertion failing on `"possibly"`
- [ ] **P2-09** `[src/core/]` Fix P2-08: one consistent numeric `confidence` across all five detectors → expect `UnusedFlag.confidence: number`, and a documented mapping from the old `"possibly"`
  - This type flows all the way to the agent's ranking input (P5-05), so it is a type change, not a cast.
- [ ] **P2-10** `[test/unit → red]` Currency pass, tests first: `["USD","INR"]` accepted, `en-US`/`en-IN` formatters parameterised, USD milestone ladder present → expect failures on every USD assertion
- [ ] **P2-11** `[src/core/validators.ts + money.ts + savingsLedger.ts]` Widen `CurrencySchema` to `["USD","INR"]`, parameterise the formatters, add USD milestones alongside ₹1L/5L/10L → expect P2-10 green, INR paths unchanged
  - **PayPal sandbox is USD.** INR-only was a Nixt assumption, not a spendless one.
  - `Currency` is already threaded through the schema, so this is smaller than it looks.
  - Do **not** rename `formatINR` into something vague in the same commit — keep the lift diff reviewable.
- [ ] **P2-12** `[test/unit]` The five impure modules (`priceHistory` `unusedDetector` `savingsLedger` `cancelIntent` `insights`) now take an injected `KVStore` instead of importing `durableNotepad`, each with its own tests → expect green against an in-memory `KVStore`, still zero mocks
  - This is the payoff of P1-06: the graph is pure **and** portable, and no test needed a stub of the DB.
- [ ] **P2-13** `[test/unit]` Determinism: the same input + same injected clock yields byte-identical detector output across repeated runs → expect green, no ordering drift
- [ ] **P2-14** `[test/e2e]` **First vertical slice**, all real layers, zero mocks: scenario rows → real SQL → the whole detector graph → ranked recommendations → every headline figure traced back to a pure function → run steps persisted → replayed → expect the seed→detect→rank→replay spine green before any UI exists
  - This is the demo's regression net arriving *before* the demo (`AGENTS.md`, e2e tier).
  - It grows into `seed → agent → approval → refund → run log` as Phases 5–7 land.

---

## Phase 3 — The adapter (Oct 14–16) · **depends on S-2, S-3**

- [ ] **P3-01** `[src/adapters/AccountSource.ts]` Define `AccountSource` + `ActionExecutor` exactly as ARCHITECTURE.md §3 specifies → expect the two interfaces compiling and nothing above them importing MCP or REST
- [ ] **P3-02** `[src/adapters/mcp/]` `McpPayPalAdapter` driving the **same stdio server** the `paypal-local` MCP entry runs (`npx -y @paypal/mcp --tools=all`, `PAYPAL_ENVIRONMENT=SANDBOX`, client-credentials) → expect `listTransactions`, `listSubscriptions`, `listDisputes` returning real sandbox data
- [ ] **P3-03** `[src/adapters/rest/]` `RestPayPalAdapter` — the escape hatch for what the toolkit lacks → expect at least one method that the MCP path could not serve
- [ ] **P3-04** `[src/adapters/csv/]` `CsvAccountAdapter` — parses a PayPal activity export, **read-only** → expect a consumer-narrative fixture parsing without any network call
- [ ] **P3-05** `[grep]` Run `grep -rn "openai\|@paypal/agent-toolkit\|node:fs" src/` and confirm **no module above the adapter layer imports any of them** → expect zero hits outside `src/adapters/`
  - Redundant with P1-04 — keep it as a one-glance manual confirmation, but the failing test is what actually holds the line.
- [ ] **P3-06** `[test/integration]` Contract tests: all three adapters satisfy the same `AccountSource` shape → expect one shared contract suite run against MCP, REST, and CSV, green with **no live PayPal call**
- [ ] **P3-07** `[src/services/token.ts]` Token refresh ahead of the 3–8h sandbox TTL (use the measured value from S0-05) → expect a refresh with margin, never a mid-demo 401
  - `[unit]` for the expiry maths with an injected clock; `[integration]` for the refresh against a local HTTP server. No test waits on wall-clock time.

---

## Phase 4 — Seed + run log (Oct 16–18)

> Build order 5 and 6. The seed makes the demo rehearsable; the run log is the highest-leverage
> item for scoring (`ARCHITECTURE.md` §9).

- [ ] **P4-01** `[scripts/seed.ts]` Seed-the-scenario: create real plans and subscriptions through **real API calls** (not hand-inserted rows) → expect a repeatable merchant scenario in sandbox
  - Demo reliability beats features. No hand-crafted state.
  - `[unit]` for the scenario builder's plan derivation; `[e2e]` for the seeding run itself.
- [ ] **P4-02** `[run_steps]` Persist every LLM call, tool call, and result → expect a row per step with enough detail to replay the reasoning
- [ ] **P4-03** `[ui]` Render the run log as a timeline → expect the video can *show* the reasoning rather than ask a judge to trust an assertion
- [ ] **P4-04** `[test/integration]` Run-log write + read round-trip, and ordering/timestamping → expect a replay to reconstruct the exact sequence, including out-of-order tool results

---

## Phase 5 — The agent (Oct 18–19) · **no execution yet**

> Build order 7. **Deliberately before the action layer** so the demo degrades gracefully.

- [ ] **P5-01** `[src/agent/]` Bounded loop with a typed tool allowlist — **not** a free-roaming agent → expect a hard cap on turns and a closed tool set; reproducible output, no hallucinated actions
- [ ] **P5-02** `[src/agent/tools.ts]` OpenRouter client, cheap instruct model, structured tool output → expect schema-valid responses on the test set
- [ ] **P5-03** `[src/agent/prompts.ts]` Classification + reasoning + ranking + rationale drafting → expect the LLM to **never** compute a normalised monthly figure, decide a refund amount, or execute
  - Every figure on screen must trace to a pure function in Phase 2. The LLM explains and ranks; it does not compute.
- [ ] **P5-04** `[src/agent/]` Replace the `genericGuide(name)` fallback in `cancelGuide.ts` with an agent-driven branch → expect an unknown merchant gets a real answer instead of a fabricated link
  - This is the one-sentence answer to "where exactly is the AI here?" Nixt could only ship a URL; the agent acts.
- [ ] **P5-05** `[src/agent/]` Sharpen detector `confidence` + templated `subtitle` into real reasoning over the already-structured flags → expect a genuine confidence ranking out of `insights.ts` input
- [ ] **P5-06** `[test/unit]` Agent determinism: same input + same seed → same proposals → expect green across repeated runs, and a recorded golden set of proposals
  - The double the agent sees is the real `AccountSource` interface (P3-06), never a hand-built object that happens to match today.
- [ ] **P5-07** `[test/integration]` Tool allowlist is genuinely closed: an unknown tool name, a schema-invalid response, and a turn-cap breach are all **rejected and recorded**, not silently retried → expect the three failure modes green against a stub OpenRouter server
  - A small model with a tight schema wanders. These three are how it fails, so they are tested first.

---

## Phase 6 — Action layer + approval UI (Oct 19–20) · **kill-switch date**

- [ ] **P6-01** `[src/actions/]` `proposal → approval → execution → result`, **all four persisted** → expect a complete audit trail per action; nothing throwaway
- [ ] **P6-02** `[ui]` Approval UI: a proposal cannot execute without explicit human approval → expect refunds are never autonomous
- [ ] **P6-03** `[src/actions/guardrails.ts]` Hard configurable cap on refund amounts → expect a config-driven ceiling enforced server-side
- [ ] **P6-04** `[ui]` Prominent `SANDBOX` indicator, always visible → expect it on every screen that shows money or an action
- [ ] **P6-05** `[src/actions/killswitch.ts]` Kill switch that halts **execution** without halting the demo → expect the UI still renders with execution disabled
- [ ] **P6-06** `[src/actions/disputes.ts]` Encode the dispute windows: escalation requires **≥7 days** since payment; disputes auto-close at **20 days** → expect the agent can only act inside the window, and the UI shows the deadline
- [ ] **P6-07** `[test/unit]` Guardrail tests: over-cap rejected, unapproved not executed, kill switch stops execution but not rendering → expect all green
- [ ] **P6-08** `[test/integration]` The full `proposal → approval → execution → result` lifecycle writes **four persisted states** and cannot skip one → expect an attempt to execute without an approval to be refused by the store, not by the UI
  - UI-level enforcement is not enforcement. A direct HTTP POST to the execute endpoint must fail too.

---

## Phase 7 — Execution (Oct 20–24) · **depends on S-4, P6**

- [ ] **P7-01** `[src/adapters/mcp/]` `refund` against a real sandbox capture → expect the refunded amount and `get_refund` to agree
- [ ] **P7-02** `[src/adapters/mcp/]` `cancelSubscription` against a live subscription → expect the subscription to end, verified by `show_subscription_details`
- [ ] **P7-03** `[src/adapters/mcp/]` `listDisputes` / `getDispute` / `acceptDisputeClaim` → expect a dispute resolved end to end in the scenario seeded in Phase 4
- [ ] **P7-04** `[test/e2e]` Full action lifecycle against sandbox, **skipped unless `PAYPAL_ACCESS_TOKEN` is set** → expect green in sandbox, clean skip in CI
  - A missing credential must never be a red test. Skip loudly, pass loudly.
- [ ] **P7-05** `[test/e2e]` The complete demo journey, hermetic and unmocked: seed → agent → proposal → approval → execution → run log → replay → expect every figure on the replay traceable to a pure function in Phase 2
  - This is `P8-06`'s rehearsal performed on every commit instead of once in October.
- [ ] **P7-06** `[ui]` Dashboard · findings · action review · replay → expect the four surfaces from the layer diagram, with every number traceable to Phase 2

---

## Phase 8 — Deploy + harden (Oct 27–Nov 2)

> Blocked by H3 (Cloudflare account). Render + Turso is the fallback — Render's filesystem is
> ephemeral, so a file-based SQLite would silently lose data mid-demo.

- [ ] **P8-01** `[wrangler.toml]` Cloudflare Workers + D1: bindings, migrations, `compatibility_date` → expect `wrangler deploy` to produce a working `*.workers.dev` URL
- [ ] **P8-02** `[wrangler secret]` PayPal credentials + OpenRouter key as server-side secrets → expect `wrangler secret list` to show names only; no secret in any committed file
  - **These must never reach the browser.** Verify by inspecting the deployed bundle before calling this done.
- [ ] **P8-03** `[src/http/cors.ts]` Port the allow-list pattern from `D:\Github\nixt\worker\src\index.ts:42-57` → expect an unlisted origin is rejected, `ALLOWED_ORIGINS` stays comma-separated and env-driven
  - `[unit]` over the origin matcher (including the exact-match vs prefix case) before it ships.
- [ ] **P8-04** `[ui]` Confirm the prominent `SANDBOX` indicator survives the production build → expect it visible on the deployed URL
- [ ] **P8-05** `[README.md]` Rewrite the consumer framing to match the verified binding — either a merchant persona, or consumer framing with execution explicitly marked merchant-side → expect no line in the repo implying consumer-side execution (binding B is not buildable)
- [ ] **P8-06** `[repo]` Rehearse the full demo from a cold start against the deployed URL → expect seed → agent → approval → refund → run log, no hand-fixing
- [ ] **P8-07** `[repo]` `public` visibility, MIT `LICENSE` intact, run instructions that work from a clean clone → expect Devpost's submission requirements met

---

## Phase 9 — Submission support (Nov 3–8) · **blocked by H4, H5**

- [ ] **P9-01** `[docs/]` Write up the architecture seam and the merchant-side binding for the repo reader → expect the "is it really agentic?" question answered in-repo, not just on-stage
- [ ] **P9-02** `[ui]` Capture demo screenshots showing the run log timeline and the action review → expect evidence frames for the video
- [ ] **P9-03** `[repo]` Polish pass: Design and Presentation are 2 of the 5 equally-weighted criteria → expect the UI holds up on screen-share at 1080p
- [ ] **P9-04** `[repo]` `git push` everything, verify the public repo renders correctly → expect a judge could clone and run it
- [ ] **P9-05** `[stretch — only after 9]` Expose spendless as an MCP server → expect the MCP-server prize track is in play; **drop it the moment it threatens anything on the build-order table**

---

## Verification gates

Before marking **any** box done:

1. `bun run verify` → typecheck + **unit + integration + e2e** green.
2. The behaviour in this task is covered by a test **that failed before the change was written.** If you
   cannot point at the red run, the task is not done.
3. `grep -rn "as any\|@ts-ignore\|@ts-expect-error" src/` → 0 hits, or each with a linked justification comment.
4. Nothing above the adapter layer imports `openai`, `@paypal/agent-toolkit`, or `node:fs`.
5. Tests pass with **zero mocks** in `src/core` — a test that needs a mock means the purity refactor regressed.
6. Conventional Commit, one logical change, tests in the same commit, on `main`.
7. Any item depending on a human checkbox is genuinely done, not aspirational.

Gates 3, 4 and 5 are **automated** in `test/integration/architecture.test.ts` (P1-04). They are still
listed here because a test that is not run is not a gate — `bun run verify` runs in every commit.

## What not to do

- Do not start anything past Phase 0 with S-1..S-4 unanswered.
- Do not add a free-roaming agent, an ORM, multi-tenant auth, or a domain.
- Do not put a secret in a committed file.
- Do not let the LLM compute a money figure or choose a refund amount.
- Do not build the CSV adapter's write path — it is read-only by design.
- Do not mock your way past a red lifted test. Fix the purity.
- Do not write code before its test. Red first, then green, then refactor.
- Do not mock a collaborator you could run for real — use real SQLite, a real filesystem, a real
  local HTTP server. A mock in an integration or e2e test is a seam in the wrong place.