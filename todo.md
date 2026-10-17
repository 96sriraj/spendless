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

> **Snapshot: Oct 17 2026.** `bun run verify` runs typecheck plus **471 tests** across all three
> tiers, in 2.6s. **Phases 1 and 2 are complete and green.**
>
> **The blockers that froze this file for eight days are gone.** Both credentials work —
> `bun run check-env` confirms a live PayPal sandbox token and a live OpenRouter completion. Two real
> payments are captured server-side. The Spike is answered (see `spike-result.md` and
> `ARCHITECTURE.md` §11c).
>
> **Phases 5–9 have not started, and they are the product.** No agent, no approval UI, no UI, no
> deployment. The kill switch is Oct 20 and **money-out is now proven** — a real refund executed
> through `McpPayPalExecutor` on Oct 17, both full and partial, confirmed by an independent
> `get_refund`. What is still missing is everything above the seam: the thing that decides *what* to
> refund and asks a human first.
>
> Where the tree disagrees with this file, the tree wins. The boxes below were corrected against
> artifacts on Oct 17 rather than left to imply work that did not happen.

**Committed since the last snapshot**

| Commit | What |
|---|---|
| `feat:` | Order payload + identity markers — `spendless:`/plan keys written into the fields that survive |
| `feat:` | `scripts/seed.ts` and `scripts/capture.ts` — orders created, approved in the browser, captured server-side. Two real captures landed |
| `feat:` | Token provider — mint once, refresh ahead of the measured 9h TTL |
| `feat:` | MCP stdio client + an envelope reader that cannot claim success on a malformed reply |
| `feat:` | `chunkRange`, `identityScan`, `inspect`, `freshness`, `orderStatus` — the pieces an adapter composes from |
| `fix:` | Transaction Search **lag is measured, not guessed** (`S-0-03b`), after "not seeded" was read as a bug when it was freshness |
| `fix:` | A false POSITIVE on `S-2-live`, caused by trusting `transaction_subject` |
| `build:` | `bun run check-env` — because "the variable is set" and "the credential works" are different claims |

### Deviations from the plan, and why

Recorded rather than quietly absorbed — each one is a decision a later reader
would otherwise have to reverse-engineer.

- **`brand.ts` was adapted, not lifted verbatim.** It exported Nixt's bundle id, App Store id and
  store-review deep link. spendless is web-first: there is no app to deep link into, and shipping
  another repo's identifiers is how the wrong product gets the right name.
- **`renewalOffsets` gained an injected `nowMs`.** The one time-dependent helper in `dates.ts` that
  read `Date.now()` directly. Its tests needed `vi.useFakeTimers()`, and the architecture gate
  forbids that in `src/core` — the gate caught it on its first run against the real tree.
- **`cancelIntent` no longer fires a notification.** It dynamically imported a OneSignal service
  inside a `try`/`catch`; OneSignal is an explicit non-goal and that hidden import was how Nixt made
  an impure edge invisible. The crossed milestone is returned instead of pushed.
- **Two defects the plan did not anticipate**, both surfaced by a test written to a *different* rule
  and then noticing the violation:
  - `duplicateDetector` attributed its flag to whichever duplicate came first in the input array, so
    the same account could be told to cancel a different bill from one run to the next.
  - A raw Jaro-Winkler score went into the same `confidence` field as an exact merchant match.
    "Netfliks" scored 0.98 against Netflix's 0.9 — a one-character typo outranked a certainty.
- **P4-01's "real API calls, not hand-inserted rows" is superseded (D5).** PayPal cannot backdate a
  transaction, so no amount of real seeding produces the date spread recurrence inference needs. The
  demo carries three labelled lanes instead. Recorded in `AGENTS.md` rather than absorbed.
- **Capture happens server-side, not through the hosted page.** The approval screen approved the
  payment and then failed to redirect back; the spinner was the redirect, not the payment. Removing
  the browser from the capture path is a reliability fix, not a workaround.
- **Card funding was deleted rather than left broken.** PayPal gates raw card data behind PCI SAQ D,
  so `confirm-payment-source` with a test card returns 422. Dead code pretending to be a fallback is
  worse than no fallback.

### Verified true

Sibling repo `D:\Github\nixt` exists; the 9 liftable files and ~6 colocated tests are present in
`D:\Github\nixt\src\lib`; `D:\Github\nixt\src\store\durableNotepad.ts` exists; the reusable CORS
allow-list is at `D:\Github\nixt\worker\src\index.ts:42-57` (**not yet ported — that is P8-03**).

---

## Phase 0 — The Spike (Oct 9–12) · **GO/NO-GO GATE** · **answered Oct 17**

> **Status: the gate is closed — GO, on binding A — and S-4-live is now closed too.** The blocking
> H1 items cleared on Oct 16–17, and on Oct 17 afternoon **a real refund went through the product
> path**: full refund on `31F89528X81443109`, partial on `6YN00176GH7185627`
> (`40551413F19556526`), both `COMPLETED`, confirmed by an independent `get_refund`.
>
> **"It acts" is no longer a claim, it is evidence** — and the kill switch cannot fire on money-out.
> Evidence is in [`spike-result.md`](./spike-result.md) (verdicts, ids and field names only, no
> credentials) and `ARCHITECTURE.md` §11c.
>
> **Still open, and neither is on the critical path:**
>
> - **`cancel_subscription` is untested** — the account has no subscriptions and PayPal cannot
>   create a backdated one, so there is nothing to cancel. Refund alone carries "it acts".
> - **S-1 was never run against a personal account.** Binding B is confirmed *structurally*
>   (§11a), not empirically. Enough to proceed, and nothing depends on the answer.

- [ ] **S0-01** `[opencode.jsonc]` Enable the `paypal-local` MCP server (`disabled: false`) after `PAYPAL_ACCESS_TOKEN` is exported → expect `/mcps` shows it connected, not `needs authentication`
  - **Still open, and mechanically so:** `paypal-local` wants `PAYPAL_ACCESS_TOKEN` in the
    environment, while every script mints its own from client credentials. Nothing is blocked on it —
    `stdioClient` drives the same server directly — so do this only for interactive poking.
  - A server showing `needs authentication` is *configured*, not *connected*. Finish it in `/mcps`.
  - Refresh the token proactively — sandbox tokens live **9 hours** (measured, not the 3–8h on record).
- [x] **S0-02** `[PayPal Dashboard]` Confirm the connected account is a **business** account with **Transaction Search** enabled on the app → **DONE.** Toggle confirmed on; `/v1/catalogs/products` returns 200 with the merchant-only shape. (`/v1/identity/.../account/get` 404s on the sandbox host — wrong endpoint path, not a wrong account.)
- [x] **S0-03** **`list_transactions`** Call it against the sandbox for a recent date range → **DONE.** 4 transactions across a 90-day request, correctly split into 3 calls because PayPal caps a window at 31 days.
- [ ] **S1 (Spike)** `[PayPal REST + OAuth]` Test OAuth login on a **personal** sandbox account and attempt a consumer-side activity read → expect a definitive yes/no recorded here
  - **Not run.** The structural case against B is strong and §11a explains it, but this stays open
    because "absence of evidence" was written here for a reason. Nothing depends on the answer.
- [x] **S2 (Spike)** **`create_subscription_plan` → `create_subscription` → capture → `list_transactions`** Re-query after capture and **dump the actual response fields** → **DONE, with a narrower answer than planned.**
  - **Only `transaction_subject` survives the round trip.** `invoice_id` and `custom_field` are both
    present in the response and both **fail to carry our value** — the key moved into the
    subject/description, and `seedMarker` writes it there.
  - The field dump is in `spike-result.md`; §11c has the reasoning, including a false POSITIVE that
    came from trusting the subject and a **measured** Transaction Search lag (`S-0-03b`) that made
    "not seeded" look like "broken".
- [ ] **S3 (Spike)** **`@paypal/mcp --tools=all`** Call each tool once against the sandbox → **desk research answered this (46 tools, §11a); the live per-tool sweep never happened.** The two tools that carry "it acts" — refund and cancel — have never been called. Treat S3 as open for that reason, not for the other 44.
- [x] **S4 (Spike)** **`create_refund` on the S-2 capture · `cancel_subscription` on a live sub** → **ANSWERED for refunds. This was the kill-switch question, and it is closed.**
  - **Full refund:** capture `31F89528X81443109` → refund id returned, `status: COMPLETED`.
  - **Partial refund:** capture `6YN00176GH7185627`, `{USD, 1.00}` → refund `40551413F19556526`, `COMPLETED`.
  - An independent `get_refund` read agrees. Covered by
    `test/integration/actionExecutor.live.test.ts`, which **skips loudly** rather than failing once
    both captures are spent.
  - **It went through the product path** — token → `@paypal/mcp` → `create_refund` — not a raw
    `fetch`. A REST refund would have proved only that PayPal accepts refunds; what was unproven
    was our half.
  - **Three real defects were found on the way**, recorded in `spike-result.md`. The important one:
    the MCP server reports HTTP failures as *successful* tool results, behind which a failed read
    looked like an empty account and a failed cancellation looked like a success.
  - **`cancel_subscription` remains untested** — no subscriptions exist and PayPal cannot create a
    backdated one. Refund alone carries "it acts". P7-02.
- [ ] **S0-04** `[PayPal sandbox]` Force a dispute, then exercise `/v1/customer/disputes/{id}/adjudicate` and `/require-evidence` → **half answered.** Merchant credentials reach the endpoint (**HTTP 200**), which refuted the prediction that they would be rejected. It is the **buyer's** namespace and does not list disputes *raised against* the merchant, so reachable ≠ usable.
  - **Recommended: cut it.** Refund + cancel carry "it acts" on their own, and `AGENTS.md` says cut
    rather than fake. Only revisit if the seed produces something worth disputing.
- [x] **S0-05** `[measure]` Time a sandbox access token from issue to 401 → **DONE.** The OAuth response says `expires_in=32400` = **9.0h**, against the 3–8h the docs claim. `tokenProvider` refreshes at 432m. Waiting for a real 401 is opt-in via `SPIKE_MEASURE_TTL=1`.
- [x] **S0-06** `[ARCHITECTURE.md §11]` Write the S-1..S-5 results back into the doc → **DONE.** §11a (desk), §11b (status), §11c (live, Oct 15–17). The ⚠️ "inferred, not verified" warning in §2 is now struck with evidence.
- [x] **S0-07** `[GO/NO-GO — Oct 12]` Make the call → **DONE Oct 17: GO, on binding A.** Merchant-side demo; CSV stays a fallback adapter, not a substitute. Recorded in `human-todo.md` (*Decision closed*) and `ARCHITECTURE.md` §12.

---

## Phase 1 — Scaffold + make the graph pure (Oct 12–13)

> Build order 1. **This is the first refactor and it is one commit.** Everything after is cheaper
> because of it (`ARCHITECTURE.md` §5). Every task below is `[unit]` unless tagged otherwise.

- [x] **P1-01** `[repo root]` `package.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `paths: { "@/*": ["./src/*"] }`), `vitest.config.mts`, `.gitignore` → expect `tsc --noEmit` and `vitest run` both run green on an empty suite
  - Carry the strict flags across from `D:\Github\nixt\tsconfig.json`.
- [x] **P1-02** `[vitest.config.mts]` **The three-tier harness**: vitest `projects` for `unit` / `integration` / `e2e`, separate `include` globs, `node` environment, e2e gets the long timeout → expect `vitest --project unit|integration|e2e` each run in isolation
  - `src/**/*.test.ts` · `test/integration/**` · `test/e2e/**`. A test in the wrong tier is a wrong-tier test.
- [x] **P1-03** `[package.json]` Scripts: `dev`, `deploy`, `test`, `test:unit`, `test:integration`, `test:e2e`, `test:watch`, `typecheck`, `verify` (typecheck + **all three tiers**), `db:migrate` → expect `bun run verify` works end to end
  - `verify` runs unit + integration + e2e. The gate does not get a tier exemption.
  - `seed` lands with P4-01, not here — a script pointing at a file that does not exist is worse than no script.
- [x] **P1-04** `[test/integration/architecture.test.ts]` **Architecture gates as failing tests**: no `openai` / `@paypal/agent-toolkit` / `node:fs` above `src/adapters/`; zero `vi.mock`/`vi.fn` in `src/core`; no `as any` / `@ts-ignore` / `@ts-expect-error` without a justification comment → expect the rules to **fail loudly** the moment they are broken, instead of being remembered
  - Run this **first**. The grep in P3-05 becomes redundant once this exists.
  - This is the entire risk hedge in `AGENTS.md`, converted from a convention into a regression test.
- [x] **P1-05** `[src/db/schema.sql]` Write the real column schema — **do not port Nixt's `kv` blob table**: `transactions` · `subscriptions` · `price_points` · `usage_events` · `savings_events` · `action_proposals` · `action_results` · `run_steps` → expect each of these has genuine columns, not a JSON blob
- [x] **P1-06** `[src/db/index.ts]` D1 access layer: `get`, `all`, `run` helpers + a `KVStore`-shaped adapter implementing the `kvGet`/`kvSet` surface the five Nixt modules expect → expect the adapter to be swappable and pure from the caller's view
  - **This is what replaces `durableNotepad`.** Signature match matters more than internals.
  - `KVStore` is a real injected interface, so `src/core` never imports the DB.
- [x] **P1-07** `[test/integration/db]` **Cover the D1 adapter against real local SQLite** (`better-sqlite3`, same dialect D1 uses) → expect green with **no mocks of the adapter itself and no faked SQL**
  - Round-trip every table. Also prove the `KVStore` surface is a drop-in for `kvGet`/`kvSet`,
    including corrupt-JSON tolerance, which is the behaviour the lifted modules rely on.
  - `wrangler d1 execute --local` is the manual check for the real D1 runtime; the suite runs the
    same `schema.sql` through a real SQLite engine so CI needs no Cloudflare account.
- [x] **P1-08** `[commit]` `refactor: replace durableNotepad KV wrapper with D1 adapter` → expect one clean commit, before any lifted file is copied

---

## Phase 2 — Lift the core (Oct 13–14)

> Build order 2. Copy, get green with **zero mocks**, then widen currency.
> Each "fix on lift" task is preceded by a **red** test that reproduces the defect.

- [x] **P2-01** `[test/unit]` Copy the ~6 colocated tests from `D:\Github\nixt\src\lib` (`money` `dates` `validators` `brand` `cancelGuide` `cancelGuide.extended`) → expect them **red or failing to resolve**, because the modules do not exist here yet
  - This is the red step, honestly done: lift the tests *before* the source.
- [x] **P2-02** `[src/core/]` Copy the 9 source files to make P2-01 green: `money.ts` `dates.ts` `duplicateDetector.ts` `validators.ts` `cancelGuide.ts` `cancelGuideData.ts` `annualSwitch.ts` `calendar.ts` `brand.ts` → expect every P2-01 test passes
  - Do **not** copy Nixt's Expo/RevenueCat/OneSignal/store code. Only `src/lib`.
  - `validators.ts` is the canonical type source — import from it, don't redeclare shapes.
  - `priceHistory` · `unusedDetector` · `savingsLedger` · `cancelIntent` · `insights` are **not** lifted
    here — they are the five impure modules and land with the `KVStore` interface in P2-05.
- [x] **P2-03** `[test/unit]` All green with **zero mocks** — no `vi.mock` anywhere in `src/core` → expect the P1-04 gate test to be the thing that enforces it
  - If a lifted test needs a mock to pass, the purity refactor failed. Go back rather than mocking.
- [x] **P2-04** `[test/unit]` **Regression test for invariant 1** (`ARCHITECTURE.md` §5): `computeInsights` upserts by strictly greater `savingCents`, so `costPerUse` must run before `checkUnused` for the richer "wasted" headline to win ties → expect a test that **fails if the two loops are swapped**
  - Then comment it in `src/core/insights.ts`, naming both functions and the reason.
- [x] **P2-05** `[test/unit]` **Regression test for invariant 2**: `savingCents` is the ranking axis (forward monthly) and `displaySaving` is only what the UI renders; they are allowed to differ → expect a test that fails if either is collapsed into the other
  - Then comment it: **do not collapse.**
- [x] **P2-06** `[test/unit → red]` Reproduce the `priceHistory` lift defect: the title renders raw cents (`Price hike: ₹${newAmountCents}` — no `/100`) → expect a failing assertion on the title string
- [x] **P2-07** `[src/core/priceHistory.ts]` Fix P2-06 → expect correct currency in the title, P2-06 green
- [x] **P2-08** `[test/unit → red]` Normalise `confidence` — it is `number` on `DuplicateFlag`/`Recommendation` but the literal `"possibly"` on `UnusedFlag` → expect a type-level assertion plus a value assertion failing on `"possibly"`
- [x] **P2-09** `[src/core/]` Fix P2-08: one consistent numeric `confidence` across all five detectors → expect `UnusedFlag.confidence: number`, and a documented mapping from the old `"possibly"`
  - This type flows all the way to the agent's ranking input (P5-05), so it is a type change, not a cast.
- [x] **P2-10** `[test/unit → red]` Currency pass, tests first: `["USD","INR"]` accepted, `en-US`/`en-IN` formatters parameterised, USD milestone ladder present → expect failures on every USD assertion
- [x] **P2-11** `[src/core/validators.ts + money.ts + savingsLedger.ts]` Widen `CurrencySchema` to `["USD","INR"]`, parameterise the formatters, add USD milestones alongside ₹1L/5L/10L → expect P2-10 green, INR paths unchanged
  - **PayPal sandbox is USD.** INR-only was a Nixt assumption, not a spendless one.
  - `Currency` is already threaded through the schema, so this is smaller than it looks.
  - Do **not** rename `formatINR` into something vague in the same commit — keep the lift diff reviewable.
- [x] **P2-12** `[test/unit]` The five impure modules (`priceHistory` `unusedDetector` `savingsLedger` `cancelIntent` `insights`) now take an injected `KVStore` instead of importing `durableNotepad`, each with its own tests → expect green against an in-memory `KVStore`, still zero mocks
  - This is the payoff of P1-06: the graph is pure **and** portable, and no test needed a stub of the DB.
- [x] **P2-13** `[test/unit]` Determinism: the same input + same injected clock yields byte-identical detector output across repeated runs → expect green, no ordering drift
- [x] **P2-14** `[test/e2e]` **First vertical slice**, all real layers, zero mocks: scenario rows → real SQL → the whole detector graph → ranked recommendations → every headline figure traced back to a pure function → run steps persisted → replayed → expect the seed→detect→rank→replay spine green before any UI exists
  - This is the demo's regression net arriving *before* the demo (`AGENTS.md`, e2e tier).
  - It grows into `seed → agent → approval → refund → run log` as Phases 5–7 land.
- [x] **P2-15** `[src/core/recurrence.ts]` **Recurrence inference** — added after §11a showed it is what the project actually needs, not an extra → expect a repeated-interval + stable-amount series detected as a subscription, from either Transaction Search output or a CSV export
  - Deliberately contains **no hardcoded T-code list**: those were never verified, and a guessed constant in the ranking path is worse than none. Recurrence is inferred from the series itself, which is checkable without a sandbox.
  - Recurring means **both** a repeating interval **and** a stable amount. Three equal monthly charges is a subscription; three equal charges at irregular intervals is noise; a **rising** series is a price hike — a different detector, so calling it recurring would double-count it.
  - Unattributable transactions are **dropped**, not lumped together: one made-up series is a fabricated recommendation.
  - Verified by mutation — removing the identity guard, widening the amount tolerance and relaxing the cadence check each turn tests red.

---

## Phase 3 — The adapter (Oct 14–16) · **unblocked; the MCP adapter itself is still unwritten**

> **Status Oct 17.** P3-01, P3-04, P3-05 and P3-07 are done. **P3-02 is plumbing without an adapter**,
> and P3-03, P3-06 are open. The unblocking credential arrived, which changed what could be built —
> it did not change what was built.
>
> **§11a desk research answered S-2 and S-3 without a token.** Read that section before starting
> P3-02: the MCP tool is lossy in two known ways, `listTransactions` is capped at 31 days per call,
> the plan schema is USD-only, and **the dispute tools are the buyer's, not the merchant's**.

- [x] **P3-01** `[src/adapters/AccountSource.ts]` Define `AccountSource` + `ActionExecutor` exactly as ARCHITECTURE.md §3 specifies → **DONE**, with three corrections research forced in (§11a): `listTransactions` must **chunk**, since PayPal caps a window at 31 days and the MCP wrapper clamps silently; `RawTransaction` carries **`identitySource`** beside `merchantKey`, because no PayPal API returns a merchant name to anyone; and **`capabilities()`** is on the interface, so the dispute lane reports itself unavailable instead of 403-ing on camera.
  - `McpPayPalExecutor` implements it (Oct 17) and has issued a **real refund** against a sandbox
    capture, confirmed by an independent `get_refund`. `cancelSubscription` is written and
    unit-tested but has never run against a live subscription — none exists.
- [ ] **P3-02** `[src/adapters/mcp/]` `McpPayPalAdapter` driving the **same stdio server** the `paypal-local` MCP entry runs → expect `listTransactions`, `listSubscriptions`, `listDisputes` returning real sandbox data
  - **Everything underneath it is built and tested:** `stdioClient` (real server, real dispatch),
    `mcpEnvelope` (cannot report success on a malformed reply), `tokenProvider`, `chunkRange`
    (the 31-day split), `identityScan` (scans every row, not just the first), `inspect`, `freshness`.
  - [x] **P3-02** `[src/adapters/mcp/]` `McpPayPalAdapter` driving the **same stdio server** the `paypal-local` MCP entry runs → **DONE (Oct 17),** with `McpPayPalExecutor` alongside it.
  - `server.ts` mints the token and spawns the server (removing the client secret from the child's
    environment); `McpPayPalAdapter` is the read side; `McpPayPalExecutor` is the money side.
  - **Proven live**: handshake completes, 28 tools enumerated, `create_refund` and `get_refund`
    called against real captures. See `spike-result.md`.
  - **Three defects the live run exposed**, all fixed: the MCP server's second failure channel
    (`{ok: false, status: 422}` inside a *successful* result), `create_refund` returning no amount
    field, and `spawn npx.cmd` needing a shell on Windows.
  - **`listSubscriptions` is not implemented yet** — Billing v1 → `RawSubscription` mapping. It
    throws rather than returning a plausible `[]`.
  - **Known lossiness:** no `fields=all` (no `payer_info`), no `transaction_type` (filter
    client-side off `transaction_event_code`), USD-only plan schema, and **no refund amounts** in
    the response. Chunking is mandatory and enforced.
- [ ] **P3-03** `[src/adapters/rest/]` `RestPayPalAdapter` — the escape hatch for what the toolkit lacks → expect at least one method that the MCP path could not serve
  - **Deferred deliberately, and the deferral is now evidence-backed rather than assumed.** Everything
    the REST escape hatch was wanted for has been reached directly by a script: order create/capture,
    Transaction Search, disputes, subscriptions. A REST adapter earns its place when it serves a
    method the MCP path provably cannot — not because the plan named it.
- [x] **P3-04** `[src/adapters/csv/]` `CsvAccountAdapter` — parses a PayPal activity export, **read-only** → **DONE.** `createCsvAccountSource` in `src/adapters/csv/parsePayPalCsv.ts`.
  - §11a made it **more important than planned**: a consumer export is the only PayPal surface that
    names the payee, so this is where the lifted detectors get a real merchant identity.
  - Two hazards handled: PayPal localises export dates (MM/DD vs DD/MM guessed wrong would silently shift
    every renewal window — detected from the data, and **refused** when undeterminable), and amounts are
    normalised to positive magnitudes with direction carried by `status`/`subject`.
  - `capabilities()` claims read access only; `listSubscriptions`/`listDisputes` throw a typed error rather
    than returning `[]`, because "no disputes" and "cannot see disputes" are different answers.
- [x] **P3-05** `[grep]` Run `grep -rn "openai\|@paypal/agent-toolkit\|node:fs" src/` and confirm **no module above the adapter layer imports any of them** → **DONE.** Zero hits outside `src/adapters/`, and the gate in `architecture.test.ts` is what actually holds the line — plus a guard so the gate cannot pass by scanning nothing.
- [ ] **P3-06** `[test/integration]` Contract tests: all three adapters satisfy the same `AccountSource` shape → expect one shared contract suite run against MCP, REST, and CSV, green with **no live PayPal call**
  - **The CSV side of this is effectively covered** — `parsePayPalCsv.test.ts` asserts both §11a
    properties directly: capabilities that report `false` **throw** rather than returning empty, and
    amounts/dates survive the round trip. MCP and REST cannot join it until P3-02/P3-03 exist.
  - Promote that coverage into a shared suite rather than writing it twice when the second adapter lands.
- [x] **P3-07** `[src/services/token.ts]` Token refresh ahead of the sandbox TTL → **DONE**, as `src/adapters/token.ts` + `tokenProvider.ts`.
  - `[unit]` for the expiry maths with an injected clock; `[integration]` against a local HTTP server. No test waits on wall-clock time.
  - Refresh margin comes from the **measured** TTL — `expires_in=32400` = 9h, refresh at 432m — not the 3–8h the docs claimed.

---

## Phase 4 — Seed + run log (Oct 16–18) · **the scripts exist; the UI does not**

> Build order 5 and 6. The seed makes the demo rehearsable; the run log is the highest-leverage
> item for scoring (`ARCHITECTURE.md` §9).
>
> **Two real captures have landed** (`31F89528X81443109`, `6YN00176GH7185627`) through
> `bun run seed` → approve in the browser → `bun run capture --capture`. The browser is off the
> critical path: the capture is a server-side POST, so the demo does not depend on a hosted page
> redirecting back.

- [ ] **P4-01** `[scripts/seed.ts]` Seed-the-scenario: create real plans and subscriptions through **real API calls** (not hand-inserted rows) → **partly done, and the instruction itself is superseded.**
  - **Done:** `scripts/seed.ts` writes real Orders through the real API, and `scripts/capture.ts`
    captures server-side. That is real API calls and real money moving.
  - **Not done:** subscription *plans*. PayPal cannot backdate a transaction, so no amount of real
    seeding produces the date spread recurrence inference needs — gaps of `[0, 0]` read as
    `irregular`. **D5 replaces the instruction:** three labelled lanes (live sandbox, seeded history,
    CSV) instead of one pure lane.
  - `[unit]` for the scenario builder's plan derivation; `[e2e]` for the seeding run itself.
- [ ] **P4-02** `[run_steps]` Persist every LLM call, tool call, and result → expect a row per step with enough detail to replay the reasoning
  - **The store exists and round-trips** (`src/db/runLog.ts`, covered in `test/integration/repositories.test.ts`),
    and the e2e journey replays a run. **Nothing writes real steps**, because there is no agent yet
    (Phase 5) and no live `AccountSource` to record against (P3-02).
- [ ] **P4-03** `[ui]` Render the run log as a timeline → expect the video can *show* the reasoning rather than ask a judge to trust an assertion
  - **There is no UI of any kind in this repo yet.** This is the highest-leverage scoring item in the
    plan and it has not been started. `ARCHITECTURE.md` §9 says so; this is the reminder.
- [ ] **P4-04** `[test/integration]` Run-log write + read round-trip, and ordering/timestamping → expect a replay to reconstruct the exact sequence, including out-of-order tool results
  - Round-trip is covered; **ordering under out-of-order tool results is not.** Write it when the
    agent exists, because that is what produces them.

---

## Phase 5 — The agent (Oct 18–19) · **no execution yet** · **DONE Oct 17**

> Build order 7. **Deliberately before the action layer** so the demo degrades gracefully.
>
> **The eligibility gate is cleared.** Criterion #1 is PayPal *and* AI; this phase is the AI half,
> and it produces valid proposals against the live model.
>
> **Two defects only a live run could find**, both recorded in `AGENTS.md`:
> `llama-3.1-8b-instruct` cannot emit valid tool arguments on OpenRouter (so **D2 was revised** to
> `mistral-small-3.2-24b-instruct`), and tool results need `tool_call_id` with the requesting
> assistant turn echoed first — an HTTP 400 that a local stub server will never catch, because it
> does not validate the protocol.

- [x] **P5-01** `[src/agent/]` Bounded loop with a typed tool allowlist — **not** a free-roaming agent → **DONE.** `src/agent/agent.ts`: three tools, a hard turn cap, and **no execution tool at all**. Membership of the allowlist *is* the dispatch mechanism, so the loop cannot reach a handler that is not in the table.
- [x] **P5-02** `[src/agent/tools.ts]` OpenRouter client, cheap instruct model, structured tool output → **DONE.** `fetch`-based, no SDK — the architecture gate bans `openai` above the adapter layer anyway. `temperature: 0` plus a fixed seed; the key appears only in the `Authorization` header, never the body, because the body lands in the run log.
  - **D2 revised by measurement:** `mistralai/mistral-small-3.2-24b-instruct`. The 8B original cost less and produced **zero** proposals.
- [x] **P5-03** `[src/agent/prompts.ts]` Classification + reasoning + ranking + rationale drafting → **DONE, and the LLM provably never computes money.** `ProposalSchema` is `.strict()`, so a proposal carrying `amountCents` is **rejected** — the rule is a boundary, not a prompt instruction.
  - `severity` is deliberately a **separate axis** from `savingCents`: collapsing urgency into money is how a $2 finding outranks a $40 one because the model was more emphatic.
  - The brief omits `displaySaving` entirely, so the model is never shown a figure it might restate as its own.
- [x] **P5-04** `[src/agent/]` Replace the `genericGuide(name)` fallback with an agent-driven branch → **DONE.** `resolveCancelGuide` checks the verified guide first and **never asks the model about a merchant we already know** — rewriting an answer we hold is strictly worse than reading it.
  - For an unknown merchant it describes the settings path in the merchant's own words, and **no URL can reach the output** — including one buried inside a step sentence, which is where a model actually puts one.
- [x] **P5-05** `[src/agent/]` Sharpen detector `confidence` + templated `subtitle` into real reasoning → **DONE.** The agent ranks by urgency over the already-structured findings and records one proposal per subscription. `savingCents` stays the money ranking and is never touched by the model.
- [x] **P5-06** `[test/unit]` Agent determinism: same input + same seed → same proposals → **DONE.** Byte-identical `AgentRun` across repeated runs. `temperature: 0` alone is not enough in practice, which is why a fixed `seed` goes with it.
  - A golden set from the **live** model is deliberately *not* committed: it breaks every time the provider changes weights, and a gate that cries wolf gets deleted. The live contract is an opt-in test that asserts schema validity instead.
- [x] **P5-07** `[test/integration]` Tool allowlist is genuinely closed → **DONE, and the live model produced a real failure of all three kinds.** Unknown tool, malformed arguments, and turn cap are each **rejected and recorded**; a refused call's arguments never reach the run log.
  - `test/integration/agentLoop.test.ts` runs the real client against a real HTTP server, because the seams *between* the two halves are where they fail to fit — argument double-encoding, tool-name matching, and the `tool_call_id` pairing.

---

## Phase 6 — Action layer + approval UI (Oct 19–20) · **kill-switch date** · **action layer DONE, UI NOT STARTED**

> **The executor could already issue a real refund. Nothing decided *whether* to.** That is what this
> phase adds, and the interesting part is where the enforcement lives: **in the store, not the UI.**
> P6-08's reason is the obvious one — UI-level enforcement is not enforcement. A disabled button is a
> request; a `POST /execute` is not.
>
> **What is built:** `src/actions/` — `guardrails` · `killSwitch` · `disputeWindow` · `actionLayer` —
> plus `src/db/actions.ts`, the repository that *is* the state machine. Transitions are conditional
> updates (`WHERE id = ? AND status = 'approved'`), so `changes === 0` is the refusal and the
> database produced it.
>
> **What is not built:** P6-02 and P6-04. There is no UI in this repository at all, which makes
> approval a real HTTP endpoint and the SANDBOX indicator a real requirement rather than a styling
> note. That is the next chunk.

- [x] **P6-01** `[src/actions/]` `proposal -> approval -> execution -> result`, **all four persisted** -> **DONE.** `src/actions/actionLayer.ts` + `src/db/actions.ts`. The amount enters the pipeline exactly once, read from the core's `savingCents`; the agent's proposal carries no amount at all.
- [ ] **P6-02** `[ui]` Approval UI: a proposal cannot execute without explicit human approval -> **NOT STARTED, and now the whole of what is left in Phase 6.** The store already refuses an unapproved action, so this is the screen that makes it a *decision* rather than an error message. There is no UI in this repository yet.
- [x] **P6-03** `[src/actions/guardrails.ts]` Hard configurable cap on refund amounts -> **DONE.** Config-driven, and it **refuses rather than clamps** - a clamped refund would show one number on the approval screen and issue another. A zero cap is honoured as zero rather than read as "unset", and a cap in one currency is never compared against an amount in another.
- [ ] **P6-04** `[ui]` Prominent `SANDBOX` indicator, always visible -> **NOT STARTED** (no UI yet). Note the floor is already enforced below it: `connectPayPalMcp` hard-refuses anything but `SANDBOX`, so the indicator is stating a fact rather than promising one.
- [x] **P6-05** `[src/actions/killSwitch.ts]` Kill switch that halts **execution** without halting the demo -> **DONE.** The read paths (`canRead`, `canRenderRunLog`, `canPropose`) answer true unconditionally, and the test asserts that *inversely* on purpose - if anyone ever makes them consult the switch, the assertion is what fails. It resolves rather than throwing, because a throw becomes a 500 during the recording.
- [x] **P6-06** `[src/actions/disputeWindow.ts]` Encode the dispute windows: escalation requires **>=7 days** since payment; disputes auto-close at **20 days** -> **DONE.** Pure, injected clock, and tested on the *boundaries* rather than the middle: day 7 escalates, day 6 does not, day 20 is closed. A payment dated in the future is refused, because a negative age satisfies "at least 7 days ago" - the one error direction that loses a dispute.
- [x] **P6-07** `[test/unit]` Guardrail tests: over-cap rejected, unapproved not executed, kill switch stops execution but not rendering -> **DONE.** All three mutation-verified: neutering the cap check, the kill switch, or the store precondition each turns the suite red.
- [x] **P6-08** `[test/integration]` The full lifecycle writes **four persisted states** and cannot skip one -> **DONE, and this is the load-bearing claim of the phase.** Transitions are conditional updates (`WHERE id = ? AND status = 'approved'`), so `changes === 0` is the refusal and the database produced it. Removing that precondition fails **10 of 11** lifecycle tests.
  - UI-level enforcement is not enforcement. A direct HTTP POST to the execute endpoint must fail too.

---

## Phase 7 — Execution (Oct 20–24) · **depends on S-4, P6** · **NOT STARTED**

> **P7-01 is DONE and the kill switch is settled.** A real refund executed through the product path
> on Oct 17 — see `spike-result.md`. What remains in this phase is everything above the seam: the
> proposal → approval → execution chain that decides *whether* to refund, and the UI that shows it.

- [x] **P7-01** `[src/adapters/mcp/]` `refund` against a real sandbox capture → expect the refunded amount and `get_refund` to agree → **DONE Oct 17.**
  - Full refund on `31F89528X81443109` and partial on `6YN00176GH7185627` (`40551413F19556526`),
    both `COMPLETED`, confirmed by an independent `get_refund` read.
  - **One deviation, recorded because it was forced:** "the refunded amount and `get_refund` agree"
    could not be asserted on a figure, because the MCP `create_refund` response carries **no
    `amount` field**. The agreement is now asserted over "both report no amount" or "both report the
    same amount", and `RefundResult.amountCents` is `number | null`.
  - Regression net: `test/integration/actionExecutor.live.test.ts`. It **skips loudly** once both
    captures are spent — re-run `bun run seed` → approve → `bun run capture --capture`.
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

- Do not start anything past Phase 0 with S-1..S-4 unanswered. **(Phase 0 closed Oct 17 — GO on
  binding A, and S-4-live answered by a real refund. `cancel_subscription` and S-1 remain open;
  neither blocks the build.)**
- Do not add a free-roaming agent, an ORM, multi-tenant auth, or a domain.
- Do not put a secret in a committed file.
- Do not let the LLM compute a money figure or choose a refund amount.
- Do not build the CSV adapter's write path — it is read-only by design.
- Do not mock your way past a red lifted test. Fix the purity.
- Do not write code before its test. Red first, then green, then refactor.
- Do not mock a collaborator you could run for real — use real SQLite, a real filesystem, a real
  local HTTP server. A mock in an integration or e2e test is a seam in the wrong place.
