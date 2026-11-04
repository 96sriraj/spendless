# spendless

**The AI agent that protects recurring revenue.**

An agent that reads a merchant's PayPal activity, works out which subscriptions are failing, disputed, or quietly unused — and then *acts*: it proposes refunds, cancellations, and dispute resolutions. Every action is proposed by the agent, approved by a human, executed through official PayPal APIs, and logged.

> Status: **working end to end** (Oct 2026). The detector engine, the bounded agent, the action
> layer, the Worker API and the React UI are all built, wired, and green — **806 tests across unit,
> integration and e2e**. A real sandbox refund has been issued through the product path. **Sandbox
> only** — no live money is ever moved.

> **Why it is merchant-side.** PayPal's transaction and refund APIs are merchant-scoped: a refund
> requires the credentials of the merchant that *captured* the payment, so no API lets a buyer's
> agent reverse a buyer's charge. Spendless therefore operates on a merchant account it holds
> credentials for, and protects **that merchant's** revenue. The consumer story survives only as a
> read-only mode over a PayPal CSV export, which is the one surface that names a payee.

---

## What it does

1. **Reads** a merchant's recurring-payment activity (PayPal Transaction Search, or a CSV export, or a seeded multi-month history — see *The three data lanes* below).
2. **Detects**, with pure deterministic functions: recurring subscriptions, idle ones renewing soon, price increases, and failed renewals. Every figure on screen traces back to one of these functions — never to the model.
3. **Reasons** with an LLM agent that classifies each finding, ranks it by urgency, and drafts the one sentence a merchant reads. The agent **cannot compute an amount and cannot move money** — those are schema-enforced impossibilities, not prompt requests.
4. **Acts**, after a human clicks approve: refund, cancel, or resolve a dispute through PayPal's MCP server. The chain is `guardrails → kill switch → store (compare-and-set) → executor`, and every step can refuse.
5. **Logs** every LLM call, tool call, rejection, and result — the run log is the demo's centrepiece and the proof the agent is constrained.

---

## Where the AI is load-bearing

This is the question the hackathon screens on. The AI is not a caption generator:

- It **judges** ambiguous, merchant-specific situations the detectors only surface — which idle subscription is worth acting on this week, whether a cancellation or a refund is the right move, how to describe a merchant the cancel-guide has never heard of.
- It is held inside a **bounded loop with a closed, typed tool allowlist** (`list_findings`, `check_cancel_guide`, `record_proposal`). There is deliberately **no execution tool** — the agent sits *before* the action layer, so the demo degrades gracefully and no money moves that a human did not approve.
- Every hallucination is **caught and recorded, not trusted**: an invented tool, a malformed argument, a proposal naming a subscription nobody pays for, a URL in a cancellation step — each is refused and shown on screen.

---

## Target event

**Build What's Next with PayPal and AI** — <https://paypalaihackathon.devpost.com>

| | |
|---|---|
| Submissions close | **Nov 12, 2026, 12:00pm PT** |
| Registered | ~6,957 |
| Prize pool | ~$69,750 across cash positions |
| Eligibility | India ✅ |

**No prescribed tracks, no problem statements.** The only hard requirement: the project must meaningfully use **both** PayPal and AI. Stage One judging is a **pass/fail** screen on exactly that. Stage Two scores five criteria *equally weighted*: Technological Implementation · Design · Potential Impact · Innovation/Idea · Presentation.

**Submission needs:** text description · working demo (repo run instructions **or** a hosted URL) · public repo **with an OSS licence file** · **<3 min YouTube video** showing it working.

---

## The three data lanes

A PayPal sandbox cannot backdate a transaction, so no amount of live seeding produces the multi-month date spread that recurrence inference needs. The demo therefore runs three clearly-labelled lanes, and the UI must always say which one a figure came from:

| Lane | Carries | Role |
|---|---|---|
| **Live sandbox** | real reads, a real identity round trip, and a real refund | Proves *it acts on real PayPal*. |
| **Seeded history** (in D1) | a realistic multi-month series under the same merchant keys | Gives the detectors the date spread only history can provide. Labelled `seeded_history` on every row — never presented as a live payment. |
| **CSV** | a consumer-narrative export | The only PayPal surface that names a real payee. Read-only. |

---

## Demo strategy — two surfaces, on purpose

A Cloudflare Worker cannot spawn PayPal's MCP stdio server, so the *deployed* app cannot issue a live refund. That is not hidden — the deployed approve button honestly says "nothing was sent to PayPal," while the enforcement chain above it (cap, kill switch, compare-and-set claim) is real and runs.

So the demo has two surfaces, each doing what it is good at:

- **Option A — local, for the video.** Everything runs on one machine with a real executor that spawns the MCP server and issues a **real sandbox refund**. This is what the <3-min video records: the agent reasons, a human approves, and money actually moves in sandbox.
- **Option B — deployed `*.workers.dev`, for the clickable URL.** A judge can open it, seed the scenario, run the agent, and read the run log. The refund is honestly reported as not wired in that environment. Satisfies the hosted-URL requirement.

---

## Architecture in one paragraph

Ports and adapters. Everything above the adapter layer depends only on the `AccountSource` / `ActionExecutor` interfaces — never on PayPal MCP, OpenRouter, or the filesystem directly. Dependencies point downward only: `UI → Worker API → run log → action layer → agent → core → adapters`. The core imports nothing from the layers above it, and an architecture test fails the build if any module above `src/adapters/` imports `openai`, `@paypal/agent-toolkit`, or `node:fs`. That seam is the entire risk hedge: if the MCP adapter covers everything, the others can be deleted at no cost.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design and build order, and [`AGENTS.md`](./AGENTS.md) for the invariants.

---

## Running it

```sh
# Node 20 or 26. On this repo better-sqlite3 needs a native build; Node 26 works with
# better-sqlite3 @13. Use nvm to pick a version, then:
bun install
bun run verify          # typecheck + all 806 tests (unit, integration, e2e)

# Credentials (never committed). Copy .env.example to .env and fill in:
#   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  (sandbox business app, Transaction Search enabled)
#   OPENROUTER_API_KEY
bun run check-env       # confirms both credentials actually work, without printing them

bun run dev             # the UI + Worker locally (Vite + workerd)
```

The one-click **seed** control in the UI creates the scenario; **Run the agent** streams the run log; **Approve** runs the action chain.

---

## Stack

| | |
|---|---|
| Language | TypeScript (strict) |
| Runtime / tests | bun · vitest (three tiers: unit / integration / e2e) |
| Data | Cloudflare D1, raw SQL + zod — **no ORM** |
| Hosting | Cloudflare Workers + D1 — a free `*.workers.dev` subdomain is a valid demo URL |
| LLM | OpenRouter — `mistralai/mistral-small-3.2-24b-instruct` (the 8B pick could not emit valid tool arguments) |
| PayPal | `@paypal/mcp` over stdio, sandbox only |
| Direct cash cost | **≈ ₹0** — no domain, free tiers throughout |

### Explicitly out of scope
Native mobile · React Native / Expo · RevenueCat · OneSignal · custom domain · multi-tenant auth · a free-roaming autonomous agent · unbounded spend · paid API credits unless free tiers are outgrown.

---

## What is reused from Nixt

Nixt (a sibling project) was evaluated as an entry and rejected — no AI anywhere, no merchant surface, no `LICENSE`, and judges could not run an Expo dev-client build. Spendless is a new repo that borrows Nixt's *logic*, not its identity: the monthly-normalisation math, the renewal-date math, and the duplicate / price-hike / unused-subscription detectors — the genuinely hard, already-tested parts. Everything expensive about Nixt (device QA, store review, IAP sandbox) is gone.

---

## Honest odds

At ~7,000 entries, a grand prize is a lottery. A sponsor prize or honourable mention is plausible **only** with a deep, visible PayPal integration and a flawless video — which is exactly what the run log and the real sandbox refund are built to show. The direct cost is zero, and the project finishes as a public repo with a working PayPal + AI build and a demo video regardless.

**Judges judge from the video.** It must stand alone. Never assume anyone opens the live demo.
