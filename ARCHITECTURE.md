# spendless — Architecture

> Companion to [README.md](./README.md). That file is the scope and the business case.
> This file is how the thing gets built, in what order, and what kills it.

**Status:** pre-build. No code written yet. The Spike (§11) is the gate for everything below.

---

## 1. Thesis in one paragraph

An agent reads a PayPal account's recurring-payment activity, works out which commitments
are not earning their keep, and **acts before the next charge lands** — refunding, cancelling,
and resolving disputes through official PayPal APIs. The clock is the renewal date: every
finding is anchored to "this money is about to leave," and the product is judged on whether
it stops that from happening.

The demo runs **merchant-side**. See §2 — this is a scoping decision, not an accident.

### 1a. The framing — locked 2026-10-17 (D1)

**One line, to be used verbatim in the README, the run log and the agent's system prompt:**

> spendless protects this merchant's revenue by finding the subscriptions that are failing,
> disputed, or unused — and acting on them.

Chosen over *"here's what your data shows you"*, for three reasons in order of weight:

1. **It is literally true of our data.** The detectors key on identity spendless itself writes at seed
   time (§11c). The subject is therefore *our merchant's own plans and subscribers* — not a
   consumer's spending, which no PayPal API exposes to anyone.
2. **It puts the "it acts" claim where the actions live.** Refund, cancel and dispute are all
   merchant-side. A consumer narrative would have to explain why every action happens on the
   merchant's account anyway — the exact contradiction `AGENTS.md` flags as still unresolved.
3. **It makes the hero metric legible.** "$63.96/year of Netflix you are not using" reads as revenue
   protection. The same number under a consumer framing reads as advice the merchant can decline, and
   then nothing is lost by ignoring the product.

> **Binding on the build.** The framing has to survive into three places at once: the README, the
> rendered run log, and the agent's system prompt. A demo that opens with "protect your revenue" and
> then narrates "here's your spending" has failed its own first sentence. Treat that as a defect, not
> a wording nit — it is the same class of bug as an adapter reporting a failure as an empty list.

---

## 2. The central constraint

PayPal's official MCP server / agent toolkit exists and maps almost 1:1 onto this scope:

- npm: `@paypal/mcp` (CLI) · `@paypal/agent-toolkit` (AI SDK integration), Apache-2.0
- Hosted: `mcp.paypal.com` · `mcp.sandbox.paypal.com`, OAuth, SSE + streamable HTTP

| Needed | PayPal MCP tool |
|---|---|
| Read activity | `list_transactions` |
| Issue refunds | `create_refund`, `get_refund` |
| Resolve disputes | `list_disputes`, `get_dispute`, `accept_dispute_claim` |
| Cancel subscriptions | `cancel_subscription`, `show_subscription_details`, `update_subscription` |
| Build the demo dataset | `create_subscription_plan`, `create_subscription`, `create_order`, `pay_order` |

**But every one of those tools is merchant-scoped.** `list_transactions` wraps Transaction
Search v1 (`/v1/reporting/transactions`), which requires a business account and a per-app
"Transaction Search" permission toggle. There is no supported consumer/personal-side read.

> ⚠️ **Partly verified by desk research (§11a), still open for a live call.** Reading PayPal's
> OpenAPI specs and the `@paypal/agent-toolkit` source confirms the structural half: every
> transaction tool is merchant-scoped, and `create_refund` targets a capture the calling merchant
> owns — so binding A is confirmed and binding B is not buildable through these APIs.
>
> **The binding-agnostic finding is the more important one:** no PayPal API returns a *merchant*
> name to anyone. A merchant already knows its own name, so PayPal never returns it; a buyer has no
> consumer-side read at all. §11a explains how the seed supplies identity instead.

### The consequence, stated plainly

`POST /v2/payments/captures/{capture_id}/refund` requires the credentials of the merchant that
**captured** the payment. A refund issued on a buyer's own Netflix charge requires Netflix's
credentials, not the buyer's. There is no API that lets a buyer's agent reverse a buyer's
charge — that is what the dispute flow is *for*, and it runs the other direction.

So "connect to my PayPal wallet and refund my subscriptions" is not buildable with these APIs.
It has to be one of:

| Binding | What it means | Viable? |
|---|---|---|
| **A. Merchant-side** | Spendless operates on a merchant account it holds credentials for: protects that merchant's subscription revenue, dunning, and chargebacks. | ✅ Fully. 10+ official tools. **This is the demo.** |
| **B. Consumer-side via API** | Spendless reads and acts on a buyer's account directly. | ❌ No supported API. |
| **C. Consumer-side via CSV** | Buyer exports PayPal activity, Spendless reasons over it and *tells you what to cancel* (no execution). | ⚠️ Partial. Losing the "it acts" half. |

**Decision: ship A, keep C as the consumer story.** One agent, one set of detectors, one action
layer. Only the adapter binding changes. This is precisely why §3 exists.

> **Action item:** the README's consumer framing needs to be reconciled with this. Either
> reframe the demo around a merchant persona, or keep consumer framing and be explicit that
> execution happens merchant-side. Do not leave the README implying B.

---

## 3. Ports and adapters — the one seam that matters

Everything above the adapter layer depends on interfaces, never on MCP or REST.

```ts
interface AccountSource {
  listTransactions(range: DateRange): Promise<RawTransaction[]>
  listSubscriptions(): Promise<RawSubscription[]>
  listDisputes(): Promise<RawDispute[]>
}

interface ActionExecutor {
  refund(input: RefundInput): Promise<RefundResult>
  cancelSubscription(id: string): Promise<ActionResult>
  resolveDispute(id: string, move: DisputeMove): Promise<ActionResult>
}
```

Three corrections, each forced by §11a rather than by taste:

1. **`listTransactions` takes any range; every implementation must chunk.** PayPal caps a
   transaction-search window at **31 days** and the MCP wrapper clamps silently. An adapter that
   forwards the caller's range is not an adapter, it is a data-loss bug. The contract test asserts
   that a 90-day request returns 90 days' worth.
2. **`RawTransaction` must carry an explicit identity field, and its provenance is a first-class
   concern.** No PayPal API returns a merchant name to a merchant (§11a S-2). Identity is either
   authored by the seed into `invoice_id`, or read from a CSV export. So the port is honest about
   *where* the identity came from rather than pretending PayPal supplied it.
3. **`capabilities()` is on the port, not a README footnote.** The dispute surface may not exist
   for merchant credentials at all (§11a S-4). An adapter that cannot list disputes says so
   structurally, and the demo degrades instead of 403-ing on camera.

| Adapter | Binds | Notes |
|---|---|---|
| `McpPayPalAdapter` | `PAYPAL_ENVIRONMENT=SANDBOX` | Primary. Client-credentials, in-process. USD-only. Lossy: no `fields=all`, no `transaction_type`. |
| `RestPayPalAdapter` | Same | Escape hatch for what the toolkit lacks — chiefly `fields=all` and `transaction_type`. |
| `CsvAccountAdapter` | Consumer narrative | Parses PayPal activity export. Read-only. **The only adapter that carries real merchant identity**, because a consumer export *does* name the payee. |

**Rule: no module above this layer may import `openai`, `@paypal/agent-toolkit`, or `node:fs`.**
That is the whole risk hedge in one seam. If MCP covers everything, delete the others and nothing
moves. If S-1 fails, swap one file and nothing moves.

### Why in-process MCP, not the hosted server

`npx -y @paypal/mcp --tools=all` with `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX`.
The hosted `mcp.paypal.com` OAuth dance adds a browser round-trip and a token store for no demo
benefit. Hosted MCP is a **stretch goal** (§12), not the primary path.

**Token handling:** sandbox tokens live 3–8 hours, production 8. Refresh proactively; do not
discover expiry mid-demo.

---

## 4. Layers

```
┌─────────────────────────────────────────────────────┐
│  UI — dashboard · findings · action review · replay  │  React
├─────────────────────────────────────────────────────┤
│  Run log — every LLM call, tool call, result        │  ← the demo multiplier, §9
├─────────────────────────────────────────────────────┤
│  Action layer — proposal → approval → execution     │  money moves here, §7
├─────────────────────────────────────────────────────┤
│  Agent — bounded loop, typed tool allowlist         │  OpenRouter, §6
├─────────────────────────────────────────────────────┤
│  Core — money · dates · detectors · insights        │  PURE, deterministic, §5
├─────────────────────────────────────────────────────┤
│  Adapters — MCP · REST · CSV                         │  §3
└─────────────────────────────────────────────────────┘
```

Dependencies point downward only. The core imports nothing from the layers above it.

---

## 5. The deterministic core

Lifted from `D:\Github\nixt`. This is the head start: ~900 lines of pure TypeScript that depend
only on `zod` and the `@/*` path alias, plus ~520 lines of Vitest that run with **zero mocks**.

### Lift verbatim (no edits)

| File | Lines | Note |
|---|---|---|
| `money.ts` | 158 | Integer minor units, never floats. |
| `dates.ts` | 95 | Injectable `nowMs` on every time-dependent fn. |
| `duplicateDetector.ts` | 107 | Hand-rolled Jaro-Winkler, no external dep. Keep it. |
| `validators.ts` | 127 | Canonical type source. |
| `cancelGuide.ts` | 75 | |
| `cancelGuideData.ts` | 195 | |
| `annualSwitch.ts` | 64 | |
| `calendar.ts` | 57 | |
| `brand.ts` | 30 | |

### Test tiers

Three tiers, owned by the same repo, all in `verify` (`AGENTS.md` → *Test-driven development* has the
rules; this is the shape):

| Tier | Lives in | What it proves | What it may fake |
|---|---|---|---|
| Unit | `src/**/*.test.ts` | A pure module. The lifted graph. | **Nothing.** |
| Integration | `test/integration/**` | A module against real collaborators — real SQL on real SQLite, real FS, a real local server. | Only PayPal/OpenRouter, and only behind the §3 seam. |
| End-to-end | `test/e2e/**` | The whole journey: seed → detect → rank → propose → approve → execute → replay. | **Nothing inside the repo.** |

The end-to-end tier is the demo's regression net, so it is written **before** the UI. `P8-06`'s cold
rehearsal should find nothing, because every commit already ran the journey.

The §3 rule — *no module above the adapter layer imports `openai`, `@paypal/agent-toolkit`, or
`node:fs`* — is not a review convention. It is `test/integration/architecture.test.ts`, and it fails
loudly when broken. Same for "zero mocks in `src/core`": a test enforces it, so nobody has to
remember it.

### The first refactor: make the graph pure

`durableNotepad` is the only thing standing between the detector layer and portability. Five
modules import its `kvGet`/`kvSet`:

`insights.ts` · `unusedDetector.ts` · `priceHistory.ts` · `savingsLedger.ts` · `cancelIntent.ts`

`insights.ts` is the most valuable file **and** the impure one — it pulls `readHistory` from
`priceHistory`, which pulls the KV wrapper. Replace `durableNotepad` with a DB adapter (DB-1)
and the entire graph goes pure, unit-testable, no mocks.

**Do this as one commit, first.** Everything after is cheaper because of it.

### Two invariants to preserve deliberately, not by accident

1. `computeInsights` upserts by **strictly greater** `savingCents`, which makes it
   **order-dependent** — `costPerUse` must run before `checkUnused` so the richer "wasted"
   headline wins ties. Comment this or a future refactor will silently break it.
2. `savingCents` is the *ranking axis* (forward monthly). `displaySaving` is *only what the card
   renders*. They are allowed to differ. This split is why one contract serves both a TUI and
   an agent — do not collapse them.

### Fix on lift

- `priceHistory.ts` renders raw cents in the title (`Price hike: ₹${newAmountCents}` — no `/100`).
- `confidence` is `number` on `DuplicateFlag`/`Recommendation` but the literal `"possibly"` on
  `UnusedFlag`. Normalise.

### Currency

`CurrencySchema = z.enum(["INR"])`, `CHECK (currency = 'INR')`, `en-IN` formatters, and
India-only milestones (₹1L/5L/10L) in `savingsLedger`. Sandbox is USD. Widen to
`["USD", "INR"]`, parameterise the formatters, and add USD milestones. `Currency` is already
threaded through the schema, so this is smaller than it looks.

### Data model

Raw SQL + zod. No ORM — Nixt uses none, and at ~100 hours solo a query builder is tax with no
payoff. Continue the existing idiom.

Do **not** port the `kv` blob table. Price history, usage events, savings events, and the action
ledger get real columns:

```
transactions · subscriptions · price_points · usage_events · savings_events
action_proposals · action_results · run_steps
```

---

## 6. The agent

**Not a free-roaming agent.** A bounded loop with a typed tool allowlist. Reproducible demo,
no hallucinated refunds.

### The LLM's job

| Does | Does not |
|---|---|
| Merchant → category classification | Compute a normalised monthly figure |
| Reason about "is this genuinely unused?" | Decide a refund amount |
| Rank findings by annual waste | Execute anything |
| Draft rationale + evidence | |

Every figure on screen traces to a pure function in §5. The LLM explains and ranks; it does not
compute.

### Where it plugs into existing code — the good news

`cancelGuide.ts` resolves via: exact alias → substring over 49 aliases → **`genericGuide(name)`**,
which fabricates a 3-step guide plus a Google search URL for "how to cancel X."

**That fallback is the hole the agent fills.** Nixt couldn't execute a cancellation, so it shipped
a link. The agent replaces the weakest branch of an existing resolver with one that actually
acts. That is a one-sentence answer to "where exactly is the AI here?" — far stronger than a
chat widget bolted on the side.

Second job, equally well-grounded: all five detectors emit a uniform flag with a templated
`subtitle` and `confidence: number | "possibly"`. Sharpening those into a real reason and a real
confidence ranking is a natural LLM task on an already-structured input.

Model: a cheap instruct model via OpenRouter with structured tool output. At demo volume, free
tier. A small model with a tight schema beats a large one wandering.

---

## 7. The action layer

Every action is:

```
proposal → approval → execution → result
```

All four persisted. Refunds move money; an unreviewed autonomous refund is both a safety
problem and a weak Design/Impact story. The ledger is also the demo's narrative spine and the
audit trail — it is not throwaway scaffolding.

Guardrails, built from day one:

- Hard cap on refund amounts, configurable.
- Prominent `SANDBOX` indicator in the UI, always.
- Kill switch that halts execution without halting the demo.
- Dispute timing constraints encoded: escalation requires ≥7 days since payment; disputes
  auto-close at 20 days. The agent must act inside the window.

---

## 8. The honest gap: there is no usage signal

`checkUnused` needs idle > 30 days. The only input is a manually-entered `lastUsedDate` or
app telemetry Nixt never collected. **PayPal transaction history does not contain usage.** It
contains recurrence, price, cadence, and gaps. It cannot tell you whether you opened Netflix
last Tuesday.

This is a product decision, not a bug. **Recommendation: anchor to the renewal deadline and make
`lastUsedDate` something the agent asks for, at the moment it matters.**

`checkUnused` already encodes `IDLE_DAYS = 30` and `RENEWAL_WINDOW_MS = 7 days`. So:

> renewal in 7 days · ₹649/mo · usage not confirmed → ask once → cancel before the money leaves

Needs one field that already exists in the schema. Tight demo. Honest.

**Also:** `cancelGuideData.ts` has 26 guides, heavily India-first (JioCinema, SonyLIV, ZEE5,
Gaana, Airtel Xstream) and **zero PayPal-billed merchants**. Assume `genericGuide` handles most
of the catalogue and build outward from there.

---

## 9. The run log — highest-leverage item for scoring

Persist every LLM call, tool call, and result. Render as a timeline in the UI.

The README says judges judge from the video and will likely never open the live demo. A run log
means the video can *show* the reasoning, and the repo shows it too. Without it you are asking a
judge to trust an assertion. With it, the agent's behaviour is the demo.

---

## 10. Deployment

**Primary: Cloudflare Workers + D1.** One `wrangler deploy`, no cold starts, persistent, free.

**Fallback: Render + Turso (remote libSQL).** Render's filesystem is ephemeral; a file-based
SQLite would silently lose data mid-demo.

Nixt already has a `worker/` (Bun + wrangler) whose CORS allow-list pattern at
`src/index.ts:42-57` is directly reusable for the agent endpoint.

Secrets are server-side only. PayPal credentials and the OpenRouter key never reach the browser.

**Demo reliability beats features.** A one-click "seed the scenario" that creates real plans and
subscriptions through real API calls, so the demo is rehearsable without hand-crafting state.

---

## 11. The Spike — Oct 9–12, go/no-go

### 11a. Desk research — done 2026-10-09, no token required

Everything below was established by reading PayPal's published OpenAPI specifications and the
`@paypal/agent-toolkit@1.11.0` / `@paypal/mcp@1.8.1` source. **None of it required a sandbox
call**, and it changes the plan in three places. Live-call questions remain, marked as such.

#### S-3 — ANSWERED for tool existence. 46 tools, not the 34 the README lists.

| | |
|---|---|
| Present and usable | `list_transactions` · `create_refund` · `get_refund` · `cancel_subscription` · `show_subscription_details` · `update_subscription` · `create_subscription_plan` · `create_subscription` · `create_order` · `pay_order` · `get_order` · `list_invoices` |
| Present but **wrong direction** | `list_disputes` · `get_dispute` · `accept_dispute_claim` — see S-4 below |
| Undocumented bonus | `get_merchant_insights` → `GET /v1/merchant/insights` (`ORDERS`/`SALES` × `DAILY`…`YEARLY`). Aggregates only, but it is a legitimate merchant-dashboard hero metric. |
| Extra surface not in the plan | 5 recurring-series tools, 12 invoicing tools, 4 shipment/product tools |

#### S-2 — ANSWERED structurally. This is the finding that matters most.

`list_transactions` is a thin wrapper: it calls `GET /v1/reporting/transactions` and returns
`response.data` verbatim. So the response is exactly PayPal's `search_response` schema. Its
`transaction_detail` entries contain `transaction_info`, `payer_info`, `shipping_info`,
`cart_info`, `store_info`, `auction_info`, `incentive_info`.

**There is no merchant or payee name anywhere in the response.**

- `payer_info` is the **buyer**. From a merchant's own account the counterparty *is* the
  customer — the merchant already knows its own name, so PayPal never returns it.
- `transaction_info.paypal_account_id` is documented as "the ID of the PayPal account of the
  counterparty" — again the buyer, not the payee.
- `transaction_subject` is "passed by the payer … the payer controls this data".

**The three fields a merchant *can* author, and therefore the only viable identity carriers:**

| Field | Spec wording | Who writes it |
|---|---|---|
| `invoice_id` | "the invoice ID that is **sent by the merchant** with the transaction" | **Merchant**, at order creation |
| `custom_field` | "**The merchant-provided** custom text" | **Merchant** |
| `transaction_event_code` | five-digit T-code classifying money movement | PayPal — `T0001` etc. |

> **This is the answer to "the one that quietly kills projects", and the answer is: it survives,
> but only because we write the identity ourselves.**
>
> The lifted detectors are all shaped like "which merchant am I overpaying?" and every one of
> them keys on a merchant name. No PayPal API will hand that to a merchant. But spendless *seeds
> its own scenario through real API calls* (build order 5) — so the merchant name is
> **authored by the seed**, written into `invoice_id`, and read back out of Transaction Search.
>
> The identity is not a gift from PayPal. It is an artefact of the demo fixture, produced by real
> API calls against real sandbox objects. That is still a real integration — but the honest
> description is "we can classify what we ourselves wrote", and the video must not imply otherwise.

#### Three consequences the plan did not anticipate

1. **`list_transactions` hard-clamps every request to a 31-day window.** The MCP wrapper clamps
   it client-side (`if (dayRange > 31) start = end - 31 days`), and the API caps it too. The
   §3 signature `listTransactions(range: DateRange)` therefore **cannot be implemented naively** —
   a 90-day request silently returns 31 days. The adapter must chunk, and the contract test must
   prove it.
2. **The MCP tool exposes neither `fields` nor `transaction_type`.** Without `fields=all`,
   `payer_info` is absent entirely; without `transaction_type`, there is no server-side filter
   for recurring payments. Both are recoverable — the recurring filter is done client-side off
   `transaction_event_code`, and `payer_info` is the buyer, which the merchant-side demo does not
   need. **But the adapter is lossy, and `RestPayPalAdapter` remains the escape hatch for both.**
3. **The MCP subscription-plan schema is USD-only.** `fixedPriceSchema.currency_code` is
   `z.enum(["USD"])`. INR is reachable through REST, never through this path. The core already
   supports both; only the MCP adapter is USD-bound.

#### S-4 — HALF ANSWERED, and the dispute lane is in trouble

`create_refund` → `POST /v2/payments/captures/{capture_id}/refund`. This is merchant-scoped by
construction: the capture belongs to the merchant that made it, so the merchant's credentials
refund it. **This structurally confirms binding A and rules out binding B** — a buyer cannot
refund their own charge with this endpoint. Good news for the "it acts" claim.

But the dispute tools are the reverse of what the plan assumed:

- `list_disputes` / `get_dispute` / `accept_dispute_claim` all call **`/v1/customer/disputes/…`** —
  the **customer** namespace, i.e. the buyer's view.
- `accept_dispute_claim` posts to `/accept-claim`, whose own description reads: *"the dispute
  closes **in the customer's favor** and PayPal automatically refunds money to the customer."*

That is the **buyer conceding** and paying themselves — not an action a merchant-protective agent
would ever want to take. The real merchant-side dispute surface is the Disputes API / Resolution
Center, reached via a **Platform** account — different account type, different onboarding, and **not
exposed by the MCP server at all**.

> ⚠️ **Partly refuted by the live run (§11c): the endpoint returned HTTP 200 for merchant
> credentials.** The prediction that it would 401/403 was wrong, and is struck. But *reachable* is
> not *usable* — it is still the buyer's namespace, and nothing yet shows it lists disputes **raised
> against** the merchant, which is the only kind worth acting on.

> **Risk to the build order.** Item 9 and P7-03 assume a working dispute lane. Per `AGENTS.md` this
> is cut, not faked — so S-0-04 still decides it, and a `HTTP 200` is not a green light. The refund
> and cancellation lanes are unaffected and carry the "it acts" claim on their own.

#### S-1 — still open, and it does not need to block

No consumer-side read endpoint was found in the 46-tool catalogue or the documented REST surface.
Every transaction tool is merchant-scoped. **Absence of evidence, not evidence of absence** — the
live test in S-1 still stands, but the prior is now much stronger, and nothing in the current
build depends on B being possible.

### 11b. Still requires a live sandbox call

| # | Question | How | Blocks |
|---|---|---|---|
| **S-0-01/02/03** | Is the connected account a business account with Transaction Search enabled? Does `list_transactions` return anything at all in sandbox? | Enable `paypal-local`; call it. | Everything |
| **S-2-live** | Does a merchant-written `invoice_id` actually appear as `transaction_info.invoice_id`? Does `custom_id` populate `custom_field`? **Which T-codes do subscription renewals emit?** | Create a plan + subscription, capture, re-query, dump fields verbatim. | Seed script (P4-01) |
| **S-3-live** | Which of the 46 tools actually authenticate and succeed in sandbox? | Call each one. | Action layer scope |
| **S-4-live** | Refund + cancel end to end? | `create_refund` on a capture. `cancel_subscription` on a live sub. | The "it acts" claim |
| **S-0-04** | **Can merchant credentials touch `/v1/customer/disputes` at all?** Can a dispute be forced in sandbox? | Force one, then call it. | The dispute lane |
| **S-0-05** | Real token TTL (docs say `expires_in: 32400` = 9h for sandbox, which contradicts the 3–8h in `AGENTS.md`) | Time it to a 401. | Token refresh (P3-07) |

**S-2-live is now the sharpest question, and it is a much smaller one than it was.** It is no
longer "does the data support the detectors" — it is "does the field we are going to write come
back". That is a five-minute test with a known answer either way.

### 11c. Live result — 2026-10-15, first real sandbox call

`bun run spike`, first run. **This is the evidence, including where it refuted the desk research.**

| Probe | Verdict | What it actually means |
|---|---|---|
| S-0-03 transactions readable | **OK** | Transaction Search works. The read path is real. |
| S-0-05 token TTL | **OK** | `expires_in=32400` = **9 hours**, not the 3–8h in `AGENTS.md`. Refresh at 7h12m. |
| S-0-02 business account | *probe bug* | `/v1/identity/v1/account/get` 404s on the sandbox host. Endpoint path was wrong, not the account. Re-probing via `/v1/catalogs/products`. |
| **S-2-live identity** | **NOT ANSWERABLE YET** | See below. |
| S-0-04 disputes reachable | **REACHABLE — I was wrong** | See below. |
| S-0-04b subscriptions | OK | Listing responds. |

#### The single transaction is not a payment

```
transaction 5210947356119124D   event_code=T1900   amount=500000   status=settled
```

**T1900 is "General account correction"** per PayPal's published T-code reference — an accounting
adjustment, not a purchase. The sandbox shipped with a $5,000 balance correction and **zero payments**.

So `S-2-live → NEGATIVE` is **not** evidence against the identity approach. It answered a question
that had not been asked: *does an identity survive the round trip* cannot be tested on a transaction
**we did not author**. Nothing was written into `invoice_id` or `custom_field`, because nothing was
ever created.

**The real state: the sandbox has no payments at all.** Until one exists there is nothing to classify,
and the demo has no data. `bun run seed` (below) is now the critical path.

#### I was wrong about the dispute tools

`ARCHITECTURE.md §11a` predicted `/v1/customer/disputes` would most likely 401 or 403 for merchant
credentials. **It returned HTTP 200.** The prediction was wrong and is struck.

What that does *not* establish is that the dispute lane is usable. Reachable is not usable: the
endpoint is still the buyer's namespace, and a merchant reaching it does not mean it lists disputes
*raised against* the merchant — which is the only kind a merchant-protective agent would act on. The
response body was not captured on this run, so the shape is still unknown. Re-probing with the body
recorded. **Build-order item 9 stays contingent.** Do not treat `HTTP 200` as a green light.

#### Response fields actually returned

Thinner than the published schema. Present: `transaction_amount`, `invoice_id`, `custom_field`,
`transaction_subject`, `transaction_event_code`, `transaction_status`, `instrument_type`,
`protection_eligibility`, balances. **Absent: `payer_info` entirely** (confirming the MCP tool does not
pass `fields=all`), plus `paypal_account_id`, `paypal_reference_id`, `fee_amount`, `transaction_note`.

The three identity carriers *are* present as fields. They were simply empty. That is now a question
with a test rather than an assumption.

#### Next: `bun run seed`

Creates real orders with `invoice_id`, `custom_id` and an item `name` all set on every purchase unit —
all the merchant-authored carriers at once, so the round trip answers the question whichever one
survives. Then re-run `bun run spike` and read which field came back populated.
read which field came back populated.

**This is the kill-switch question.** If no merchant-authored identity survives, the detector graph has
no merchant input from any PayPal API, and the demo must be reframed around recurrence and amounts
alone — or the CSV-only path is taken.

#### Card funding is not available — a finding, not a workaround

The obvious way to take the browser out of the demo is to skip approval and fund the order
directly: `POST /v2/checkout/orders/{id}/confirm-payment-source`. The schema allows a raw card, and
PayPal's sandbox publishes test card numbers. **It does not work** — every call returns
`422 UNPROCESSABLE_ENTITY` with no field detail. The reason is in the schema itself:

> `card_request`: *"Passing card number, cvv and expiry directly via the API requires **PCI SAQ D**
> compliance. PayPal offers a mechanism by which you do not have to take on the PCI SAQ D burden by
> using hosted fields."*

The compliant route is a `single_use_token`, produced by **hosted fields** — a browser again.
`vault_id` needs the Payment Methods API, which is not exposed here.

> **Consequence, now an owned constraint rather than a surprise four days from a deadline: order
> approval is a browser flow and cannot be automated away.** `invoice_id` and `custom_id` exist only
> on a merchant-initiated order, so they can only be proven by approving one.
>
> It also means **`bun run seed` is not rehearsalable unattended**, which is exactly what `H5-01`
> depends on (rehearse cold, twice, once with the network dropped). Budget a human into the seed
> loop, and keep a pre-recorded capture for the video.

#### The hosted screen failure was the PAYEE's settlement currency — resolved

The generic "Things don't appear to be working at the moment" page carries a base64 `code`. Decoded:

```
code=VU5TVVBQT1JURURfUEFZRUVfQ1VSUkVOQ1k=
    = "UNSUPPORTED_PAYEE_CURRENCY"
```

**Resolved 2026-10-17.** The cause was the **payee** side, not the buyer and not the payload. The
sandbox pair was India-based; a fresh **US** business account with a new app attached accepts a USD
order and the approval screen **renders correctly** — Pay Now, the card list, no error page. Charging
in INR instead was a workaround for a symptom; it was never the fix.

Three diagnoses were wrong before this one, and they are worth recording because each looked
plausible:

| Attempted fix | Read | Why it was wrong |
|---|---|---|
| Buyer country must be US | `UNSUPPORTED_PAYEE_CURRENCY` | Country is **unfixable after creation** and was never the cause. |
| Charge in INR | `INVALID_CURRENCY_CODE` | Order creation rejected INR outright — PayPal India does not accept it. |
| `application_context` fixes the screen | same error | Every field in it is deprecated in Orders v2.9. |

The method that actually worked each time was **decoding the base64 `code=` and reading the raw API
response**, never reasoning from documentation. §11a exists because the docs were actively
misleading here.

#### S-2-live: SOLVED. Only `transaction_subject` survives, so the key goes there

**Answered 2026-10-17, from a real capture read back through Transaction Search.** Both captures are
visible now (`31F89528X81443109`, `6YN00176GH7185627`, both `T0006`), and the answer is not the
documented one:

| Carrier written at seed time | Round trip |
|---|---|
| `purchase_units[].invoice_id` → `transaction_info.invoice_id` | ❌ **empty** |
| `purchase_units[].custom_id` → `transaction_info.custom_field` | ❌ **empty** |
| `purchase_units[].description` → `transaction_info.transaction_subject` | ✅ **survives** |

```text
31F89528X81443109  T0006  subject="Netflix monthly plan"
6YN00176GH7185627  T0006  subject="Spotify monthly plan"
647530330R035101U  T1900  subject="Initial balance"     ← PayPal's own text, not ours
```

**Orders v2 accepts `invoice_id` and `custom_id` and the reporting API drops them.** `invoice_id` is
documented as *"sent by the merchant with the transaction"* — it is documented, it validates, and it
arrives empty. This is precisely what the Spike existed to find, and it is not the answer the
documentation would have given you. Both carriers are still written, because they would be the better
answer if PayPal populated them, but nothing depends on them.

**So the identity moves into `description`,** which is the one field proven to round-trip:

```text
spendless:sub-netflix — Netflix monthly plan
```

Two rules make that safe rather than a guess:

1. **The key comes first and unparsed.** Recovering `sub-netflix` from `"Netflix monthly plan"` is a
   lookup table wearing a disguise — it breaks on the first ambiguous name and silently starts missing
   rows.
2. **Trust is derived from a namespace, not from the field.** `transaction_subject` is free text and
   PayPal populates it on its own rows — that `"Initial balance"` above is the proof. A subject only
   counts as an identity when it carries `spendless:` (`seedMarker.ts`). This is what lets it sit in
   `TRUSTWORTHY_IDENTITY`, and it is the same guard that prevents the false POSITIVE below recurring.

> The `weak (free-text subject only)` bucket that appeared in the first post-capture run was this
> module working: the two real payments were detected, recognised as *not yet* carrying a seed key, and
> reported as such rather than being counted as identified. They landed in `weak` because at that point
> the seed had not been writing markers yet.

#### Why the approval screen "spun forever" — and why the browser is now optional

The symptom was an infinite spinner on **Pay Now**, surviving incognito, a second browser, and correct
credentials. It was never a payment failure.

| What the spinner hid | What actually happened |
|---|---|
| looks identical | the payment was **approved**; only the redirect back to the merchant never fired |

Two of three orders came back `APPROVED` with funds owed. The order's own status was unambiguous, cost
one GET, and needed no browser at all.

This is why `src/adapters/orderStatus.ts` exists and why `bun run capture` is a first-class command
rather than a workaround:

- **`APPROVED` is capturable server-side.** The demo's payment step no longer depends on the redirect
  firing. That is a reliability win for `H5-01` rehearsal and for the video capture, not just a fix.
- **The status disambiguates all three failure modes** the spinner conflates: buyer never confirmed a
  funding source, risk silently rejected, or succeeded-but-no-redirect. Only the third is recoverable
  without the browser.

#### Transaction Search lags. Measure it, do not guess it.

`/v1/reporting/transactions` is served from a cache. PayPal documents *"a maximum of three hours"*;
developers report considerably worse, and the practical figure has been closer to a day.

`bun run spike` now prints `last_refreshed_datetime` and the measured lag (`S-0-03b`). Without it,
*"not seeded"* and *"will never be seeded"* look identical, and the only available strategy is to sleep
and hope — which is precisely how this Spike was stalled before.

PayPal's own guidance for a current transaction is explicit: **use the capture response, not Transaction
Search.** That is exactly what `bun run capture` does, and it is why the capture ids above are known
within seconds while the reporting API is still catching up.

> Worth keeping: the currency in the product core is already threaded per row (§5, the
> `["USD","INR"]` pass). That decision, made for a different reason in a different week, is why
> switching the seed's currency was a one-line change rather than a refactor.

#### Browser fallback for the read path

If the hosted screen stays broken, `--method transfer` prints a pre-filled sandbox **Send money**
link: one click, no checkout flow, no cookies, no country dependency, and it produces a real payment.
It carries **no `invoice_id`**, so it proves the read path sees payments without proving anything
about identity. Worth having — but it must not be mistaken for the answer.

## 12. Build order

| # | Task | Depends on |
|---|---|---|
| 1 | Replace `durableNotepad` with DB adapter; get the detector graph pure | — |
| 2 | Copy the 9 files + 6 test files; get them green with zero mocks | 1 |
| 3 | Currency pass → `["USD","INR"]` | 2 |
| 4 | `McpPayPalAdapter`, in-process, sandbox | S-2, S-3 |
| 5 | Seed-the-scenario script | 4 |
| 6 | Run log persisted + rendered | 4 |
| 7 | Agent: classify → rank → propose. No execution yet. | 2, 6 |
| 8 | Action layer + approval UI | 7 |
| 9 | Execution: refund, cancel. Guardrails on. **Dispute lane only if S-0-04 proves merchant credentials can reach it.** | S-4, 8 |
| 10 | **Stretch:** expose spendless as an MCP server — cheap, and puts you in the MCP-server prize track | 9 |

Step 7 before 8 before 9 is deliberate: the agent produces *proposals* long before it can move
money, so the demo degrades gracefully. A working "reads and reasons" demo beats a broken
"reads, reasons, and executes."

---

## 13. Explicit non-goals

Native mobile · RevenueCat · OneSignal · custom domain · a free-roaming autonomous agent ·
unbounded spend · multi-tenant auth · a query builder.

The scope freeze is real. Anything not on the build-order table is out.
