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

> ⚠️ **Inferred from PayPal docs, not verified against a live call.** This is Spike item S-1.
> If it turns out consumer-side read *is* possible, roughly half this document collapses and
> §3 simplifies. Verify before building anything.

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

| Adapter | Binds | Notes |
|---|---|---|
| `McpPayPalAdapter` | `PAYPAL_ENVIRONMENT=SANDBOX` | Primary. Client-credentials, in-process. |
| `RestPayPalAdapter` | Same | Escape hatch for what the toolkit lacks. |
| `CsvAccountAdapter` | Consumer narrative | Parses PayPal activity export. Read-only. |

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

Nothing below this section gets built until S-1 through S-4 are answered.

| # | Question | How | Blocks |
|---|---|---|---|
| **S-1** | Is consumer/personal-side transaction read *actually* impossible? | Inspect the connected account type; test OAuth login on a personal sandbox account. | §2 decision |
| **S-2** | Does `list_transactions` return enough detail to derive recurrence? | Create a plan + subscription, capture with a personal account, re-query. **Inspect the actual fields** — merchant name, amount, date, `custom_id`. If merchant identity isn't there, the core detectors have no input. | Everything |
| **S-3** | Which MCP tools actually work in sandbox? | Run `npx -y @paypal/mcp --tools=all` against the sandbox token and call each one. | Action layer scope |
| **S-4** | Refund + cancel end-to-end? | `create_refund` on a capture. `cancel_subscription` on a live sub. | The "it acts" claim |

**S-2 is the one that quietly kills projects.** Transaction history without merchant-level
detail means the detectors — the entire lifted head start — have nothing to run on. Check it
before anything else.

Also confirm: sandbox token TTL, and whether disputes can be forced in sandbox
(`/v1/customer/disputes/{id}/adjudicate` and `require-evidence` are sandbox-only endpoints).

### Kill switch (from README)

If by **Oct 20** the core PayPal integration is not demonstrably working end-to-end, drop it.
Do not spend Nov 1–12 polishing something that cannot make a real PayPal call.

---

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
| 9 | Execution: refund, cancel, dispute. Guardrails on. | S-4, 8 |
| 10 | **Stretch:** expose spendless as an MCP server — cheap, and puts you in the MCP-server prize track | 9 |

Step 7 before 8 before 9 is deliberate: the agent produces *proposals* long before it can move
money, so the demo degrades gracefully. A working "reads and reasons" demo beats a broken
"reads, reasons, and executes."

---

## 13. Explicit non-goals

Native mobile · RevenueCat · OneSignal · custom domain · a free-roaming autonomous agent ·
unbounded spend · multi-tenant auth · a query builder.

The scope freeze is real. Anything not on the build-order table is out.
