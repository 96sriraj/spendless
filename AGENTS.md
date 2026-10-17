# AGENTS.md — spendless

**The AI agent that spends less, not more.** PayPal AI Hackathon entry (Devpost: [Build What's Next with PayPal and AI](https://paypalaihackathon.devpost.com)).

> **Snapshot 2026-10-17.** `bun run verify` = typecheck + **628 tests**, all green. Phases 1–2, 5 and
> the action half of 6 are **done**. The PayPal sandbox account, app and credentials are **live**. Money
> has moved **both ways**: two orders captured, and a real refund issued end to end through the product
> path. Both credentials pass `bun run check-env`.
> Read `README.md` (scope + business case) and `ARCHITECTURE.md` (how it gets built, in what
> order) before writing code. Both are the source of truth — this file only records what an agent
> would otherwise get wrong.
>
> **What is NOT built:** **any UI at all** — no React, no `wrangler.toml`, no deployment (P6-02, P6-04,
> P4-03, Phase 7–8). The action layer, the agent, the adapters and the core all exist and are tested;
> the demo cannot be recorded because there is nothing on screen to record. **That is the whole of what
> is left**, and it is a different kind of work from everything so far.
>
> **Work the queues:** [`todo.md`](./todo.md) is the agent lane, [`human-todo.md`](./human-todo.md)
> is the founder lane. The agent lane blocks on anything marked 🔴 there (PayPal business account,
> exported token, OpenRouter key, video, submission). Check a box only after the verification gates
> at the bottom of `todo.md` pass.

## Non-negotiables

- **Two hard eligibility requirements: meaningful PayPal integration *and* meaningful AI integration.** Stage-one judging is a pass/fail screen on exactly that. Never let either become a bolt-on.
- **Submissions lock Nov 12, 2026, 12:00pm PT.** Public repo with an OSS licence file, run instructions *or* a hosted URL, and a **<3 min video**. `LICENSE` is already MIT and must never be removed.
- **Kill switch: if the core PayPal integration is not demonstrably working end-to-end by Oct 20, drop it.** Do not spend Nov 1–12 polishing something that cannot make a real PayPal call.
  - **Position Oct 17, evening: the kill switch cannot fire.** A **real refund executed end to end**
    through the product path — full and partial, both `COMPLETED`, confirmed by an independent
    `get_refund`. Evidence in `spike-result.md`. `cancel_subscription` is still untested because the
    account has no subscriptions and PayPal cannot backdate one.
- **Judges judge from the video.** It must stand alone. Never assume anyone opens the live demo.
- **Scope is frozen.** Anything not on the `ARCHITECTURE.md` §12 build-order table is out. Explicit non-goals: native mobile, Expo/React Native, RevenueCat, OneSignal, custom domain, a free-roaming autonomous agent, unbounded spend, multi-tenant auth, an ORM/query builder.

## The binding constraint (read before designing anything)

Every PayPal MCP tool is **merchant-scoped**. `list_transactions` wraps Transaction Search v1, which needs a business account. A refund requires the credentials of the merchant that *captured* the payment — a buyer's agent cannot reverse a buyer's charge; the dispute flow runs the other way.

- **Binding A (merchant-side) is the demo.** C (consumer-side via CSV, read-only) is the consumer narrative. **B (consumer-side execution via API) is not buildable.**
- **This is now verified, not inferred.** S-2-live answered Oct 17: a merchant business account with
  Transaction Search enabled reads real transactions. What survives the round trip is narrower than
  the plan assumed — **only `transaction_subject`**; `invoice_id` and `custom_field` are returned by
  the API but do not carry our value. The detector key therefore lives in the subject/description,
  and the seed writes it there.
- **No PayPal API returns a merchant name to anyone** (§11a, re-confirmed live). The subject of the
  demo is a merchant's *own* subscription revenue — the plans and subscribers spendless itself
  authored at seed time. **D1 is closed: "protect this merchant's revenue."** `README.md` has been
  corrected to that framing. Do not reintroduce consumer framing, and never write consumer-execution
  code.
- **Money-out is proven (Oct 17 evening).** `McpPayPalExecutor` issued a real refund through the
  real product path — full and partial, both `COMPLETED`, confirmed by `get_refund`. **What the live
  sandbox has still NOT proven:** `cancel_subscription` (no subscriptions exist, and PayPal cannot
  backdate one) and the dispute lane. Reachability is not usability — the dispute tools answer 200
  from a merchant account and are still the buyer's.
- **Sandbox tokens last 9 hours** (`expires_in=32400`, measured Oct 15). The 3–8h figure in the
  docs below was wrong. Refresh at ~7h.

## Ports and adapters — the one seam that matters

Everything above the adapter layer depends on the `AccountSource` / `ActionExecutor` interfaces in `ARCHITECTURE.md` §3, never on MCP or REST.

> **No module above the adapter layer may import `openai`, `@paypal/agent-toolkit`, or `node:fs`.**
> That is the entire risk hedge. If MCP covers everything, delete the other adapters and nothing moves.

- Primary adapter is **in-process** MCP (`npx -y @paypal/mcp --tools=all`, `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX`). Hosted `mcp.paypal.com` OAuth is a stretch goal, not the primary path.
- Sandbox tokens live **9 hours** (measured, `expires_in=32400`). Refresh proactively; never discover expiry mid-demo.
- **What exists as of Oct 17:** `createCsvAccountSource` (real, tested, and the *only* adapter that names a payee — a consumer export does); `McpPayPalAdapter` and `McpPayPalExecutor` over the real `@paypal/mcp` stdio server; and the plumbing under them — `server.ts`, `stdioClient`, `mcpEnvelope`, `tokenProvider`, `chunkRange`, `identityScan`, `inspect`, `orderPayload`, `orderStatus`, `seedMarker`, `freshness`.
- **What does not exist:** `RestPayPalAdapter`, `listSubscriptions` mapping (the adapter throws rather than return a plausible `[]`), the agent, the action layer, and any UI.
- Dependencies point **downward only**: UI → run log → action layer → agent → core → adapters. The core imports nothing from layers above it.
- Secrets (PayPal credentials, OpenRouter key) are **server-side only**. They never reach the browser.

## Lifting from Nixt

The detector head start comes from the sibling repo **`D:\Github\nixt`** (a separate Expo/RN app — do not copy its Expo, RevenueCat, OneSignal, or store code). Its `AGENTS.md` describes *that* project and does not apply here.

The 9 files to lift verbatim from `D:\Github\nixt\src\lib\`: `money.ts` `dates.ts` `duplicateDetector.ts` `validators.ts` `cancelGuide.ts` `cancelGuideData.ts` `annualSwitch.ts` `calendar.ts` `brand.ts` — plus the ~6 colocated `*.test.ts` files. They depend only on `zod` and the `@/*` path alias, and run with **zero mocks**.

Order matters (this is the build order, not a suggestion):

> **Both steps are DONE (Oct 9).** `durableNotepad` → the `KVStore` port + D1 adapter landed in one
> commit; `src/db/schema.sql` has real columns and no `kv` blob table. All 9 modules are lifted and
> green with zero mocks, both lift defects are fixed, and currency is widened to `["USD","INR"]`.
> Kept below because the invariants are still load-bearing, not because the work is pending.

1. **First refactor, one commit:** replace `durableNotepad` (in Nixt: `src/store/durableNotepad.ts`) with a DB adapter. Five modules import its `kvGet`/`kvSet` — `insights.ts` (via `priceHistory.ts`), `unusedDetector.ts`, `priceHistory.ts`, `savingsLedger.ts`, `cancelIntent.ts`. Until this is done the detector graph is impure and untestable. Everything after is cheaper because of it.
2. Do **not** port the `kv` blob table. Price history, usage events, savings events, and the action ledger get real columns.

Two invariants to preserve **deliberately, with a comment** — a refactor will silently break them otherwise:

- `computeInsights` upserts by **strictly greater** `savingCents`, making it **order-dependent**: `costPerUse` must run before `checkUnused` so the richer "wasted" headline wins ties.
- `savingCents` is the ranking axis (forward monthly); `displaySaving` is only what the UI renders. They are allowed to differ. Do not collapse them.

Fix on lift: `priceHistory.ts` renders raw cents in its title (no `/100`), and `confidence` is `number` on `DuplicateFlag`/`Recommendation` but the literal `"possibly"` on `UnusedFlag`. Normalise.

**Currency was INR-hardcoded** in Nixt (`CurrencySchema = z.enum(["INR"])`, `en-IN` formatters, ₹1L/5L/10L milestones). **Fixed: widened to `["USD","INR"]`, formatters parameterised, USD milestones added.** (The sandbox merchant account settles in **USD** — read from the response by the spike's currency probe, not assumed.)

Also carried over: raw SQL + zod (no ORM, deliberate), and the reusable CORS allow-list pattern from `D:\Github\nixt\worker\src\index.ts:42-57`.

## The agent

**Bounded loop with a typed tool allowlist** — not a free-roaming agent. Reproducible demo, no hallucinated refunds.

> **Built, 2026-10-17.** `src/agent/` — `tools.ts` (OpenRouter edge), `agent.ts` (the loop),
> `proposal.ts` (the schemas), `cancelResolution.ts` (P5-04). No `src/agent/index.ts` yet; import
> the modules directly.

- The LLM **classifies, reasons, ranks, and drafts rationale**. It does **not** compute a normalised monthly figure, decide a refund amount, or execute anything. Every figure on screen traces to a pure function in the core.
- **The no-money rule is a schema, not a prompt.** `ProposalSchema` is `.strict()`, so a proposal
  carrying `amountCents` is *rejected* whatever the model was told. A proposal names a `subId` and
  gives a reason; Phase 6 resolves `subId` to an amount through the core, where `savingCents` is
  already computed and already the ranking axis.
- **There is no execution tool.** `list_findings`, `check_cancel_guide`, `record_proposal` — that
  is the whole allowlist. The agent sits *before* the action layer so the demo degrades gracefully,
  and adding an `execute` tool here would make that ordering fictional.
- **Every rejection is recorded, not thrown.** Unknown tool, malformed arguments, unknown `subId`,
  turn cap. The run log is what the demo shows a judge, so "the agent is constrained" has to be
  visible on screen rather than asserted in a comment.
- The natural insertion point: `cancelGuide.ts` falls back to `genericGuide(name)`, which fabricates a link. Nixt could not execute a cancellation so it shipped a URL; the agent replaces the weakest branch of an existing resolver with one that acts. That is the answer to "where exactly is the AI here?"
  - **P5-04, done.** `resolveCancelGuide` tries the verified guide first and never asks the model
    about a merchant we already know. For an unknown one it describes the settings path in the
    merchant's own words — and **no URL can ever reach the output**, because a link that 404s is
    worse than no link. Not a key concern either: the check that matters is a URL *inside a step
    sentence*, which is where a model actually puts one.
- Use a cheap instruct model via **OpenRouter** with structured tool output. A small model with a tight schema beats a large one wandering.
  - **D2 is CLOSED and REVISED by measurement: `mistralai/mistral-small-3.2-24b-instruct`** ($0.09/M in, $0.25/M out). The original pick, `meta-llama/llama-3.1-8b-instruct`, **cannot be used** — see below.
  - ⚠️ **`llama-3.1-8b-instruct` doubles every tool call's arguments on OpenRouter.** It emits the same JSON object twice, concatenated: `{"limit":"50"}{"limit":"50"}`, which is not valid JSON. Measured over six consecutive turns: **0 proposals, 0 convergence** — told its arguments were malformed, it produced the identical doubled form again. `mistral-small-3.2-24b-instruct` on the identical prompt: 1 proposal, 0 rejections, answered in 3 turns.
  - ⚠️ `qwen/qwen3-8b` — the other plausible-looking default — **is not in the catalogue**. It was guessed from memory.
  - **Verify model IDs against `/api/v1/models`, then verify tool-calling against a live call.** Existence in the catalogue says nothing about whether a model can emit valid arguments; only a run does.
  - The client takes `model` as a parameter, so a candidate is `OPENROUTER_MODEL=… bun run test:integration` — no code edit.
  - ⚠️ **Tool results need `tool_call_id`, and the assistant turn that requested them must be echoed
    first.** Omitting either is an HTTP 400 that mentions a field the loop never touches. Measured
    live; a local stub server will not catch it, because it does not validate the protocol.

## Actions and guardrails

Every action is `proposal → approval → execution → result`, all four persisted. Refunds move money; an unreviewed autonomous refund is both a safety problem and a weak Design/Impact story.

> **Built, 2026-10-17, minus the UI.** `src/actions/` — `guardrails` · `killSwitch` · `disputeWindow`
> · `actionLayer` — plus `src/db/actions.ts`. **The UI (P6-02, P6-04) is the whole of what is left**
> in this phase, and there is no UI in this repository yet.

- **The enforcement lives in the store, not the UI.** P6-08's reason is the obvious one: a disabled
  button is a request, and a `POST /execute` is not. Transitions are conditional updates —
  `UPDATE … WHERE id = ? AND status = 'approved'` — so `changes === 0` *is* the refusal, produced by
  the database. A read-then-write would pass every other test and still refund twice under two
  concurrent requests; there is a test that fires two claims at once and asserts exactly one wins.
- **An `executing` state exists so a crash is visible rather than a lie.** Without it a row must be
  claimed as `executed` *before* the provider is called, and a failure leaves a proposal claiming
  success with no result row — the audit trail's one unforgivable falsehood.
- **The chain runs `guardrails → kill switch → store → executor`**, and each step can stop it. The
  order is load-bearing: the cap is checked first because an over-cap refund is wrong regardless of
  whether execution is enabled; the switch before the store so a halted deployment does not
  accumulate approvals it can never act on.
- **Every refusal is an outcome, not an exception.** The kill switch *resolves* — a throw becomes a
  500 during the recording, and the one artefact the judges watch would be a stack trace.
- **The cap refuses; it never clamps.** A clamped refund shows one number on the approval screen and
  issues another. A zero cap is honoured as zero rather than read as "unset".
- Hard configurable cap on refund amounts.
- Prominent `SANDBOX` indicator in the UI, always. (The floor is already enforced below it:
  `connectPayPalMcp` hard-refuses anything but `SANDBOX`, so the indicator states a fact.)
- Kill switch that halts execution without halting the demo. Its read paths answer true
  unconditionally, and the test asserts that **inversely** — if anyone makes them consult the switch,
  that assertion is what fails.
- Dispute windows encoded: escalation requires **≥7 days** since payment, disputes auto-close at
  **20 days**. Boundaries tested rather than middles: day 7 escalates, day 6 does not, day 20 is
  closed, and a payment dated in the future is refused because a negative age satisfies "≥7 days".
- Agent proposes long before it can move money (build order 7 → 8 → 9). Keep it that way — the demo degrades gracefully.

## Test-driven development

**This project is developed test-first. Not "tests exist" — tests are written first.**

The rule, unarguable: **no production file is added or changed without a test that fails because of
the change.** Write the failing test, watch it fail for the right reason, make it pass with the
minimum code, then refactor under a green suite. A commit that contains behaviour and no test for
that behaviour is not done, regardless of how obviously correct the behaviour looks.

- **Red before green.** If you cannot name the assertion that failed first, you did not test-drive it.
- **Tests are deliverables.** They are not a follow-up task, not "cleanup", not something to add when
  the feature is stable. There is no such thing as "just add tests later" here.
- **A refactor that needs a mock to stay green is a bug, not a difficulty.** It means the purity
  boundary regressed. Fix the boundary (see *Ports and adapters* above).
- **Every bug fix starts with a failing test that reproduces the bug.** Keep it as a regression test.
- **Coverage is not the goal — behaviour is.** A test that asserts a line was executed proves nothing.
  Assert the number, the ordering, the guardrail, the rejection.
- **Prefer the test pyramid's lowest tier that can honestly prove the claim.** Unit tests are
  cheapest to write and to read; reach up only when the claim genuinely spans layers.

### The three tiers

Every test belongs to exactly one tier, and the tier decides what it is allowed to fake.

| Tier | Lives in | Scope | Faking allowed | Runs in `verify` |
|---|---|---|---|---|
| **Unit** | `src/**/*.test.ts`, colocated | One pure module. No I/O, no network, no clock beyond injected `nowMs`. | **Nothing.** Zero mocks, period — this is the lifted detector net. | Yes |
| **Integration** | `test/integration/**` | This module against its **real** collaborators: real SQL against real SQLite, the real filesystem, a real in-process HTTP server. | **No mocking of the system under test.** Fake only what is genuinely external and unavailable (PayPal, OpenRouter) — and only behind the seam. | Yes |
| **End-to-end** | `test/e2e/**` | A whole journey through every real layer: seed → detect → rank → propose → approve → execute → replay. Nothing in between is faked. | **Nothing inside the repo.** If an e2e test needs a mock, the seam is in the wrong place. | Yes, but it may be slow |

```sh
bun run test:unit          # the fast loop, run on every save
bun run test:integration   # real SQLite, real FS
bun run test:e2e           # the full vertical journey
bun run verify             # typecheck + all three tiers — this is the gate
```

Rules that follow from the table:

1. **Unit tests in `src/core` are pure by construction.** No `vi.mock`, no `vi.useFakeTimers` except
   where `nowMs` is already injectable, no filesystem, no `Date.now()` dependence. This is enforced by
   a test, not by discipline — see *Architecture gates* below.
2. **Integration tests use real dependencies.** The D1 adapter is tested against real SQLite
   (`better-sqlite3`, same dialect), not against a fake query builder. A test that mocks SQL is not an
   integration test.
3. **E2E tests are the demo's regression net.** The demo path is `seed → agent → approval → refund →
   run log`. If that journey is not covered end to end, the demo is unrehearsable and
   `H5-01`/`P8-06` are wishful. The e2e tier must exist before, not after, the UI.
4. **External services are faked at the seam, never inside the core.** Sandbox PayPal and OpenRouter
   calls live behind `AccountSource`/`ActionExecutor` (§3). Tests substitute a recording double for
   those two only, and always through the real interface. A sandbox-touching test **skips** unless
   `PAYPAL_ACCESS_TOKEN` is set — it must never make CI fail on a missing credential.
5. **Timing is injected, never slept.** `nowMs`/`now` parameters exist for exactly this. A test that
   waits on wall-clock time is a flaky test.
6. **No snapshot tests for money or ranking.** `toMatchSnapshot` on a `savingCents` figure or a
   detector ordering hides exactly the regressions that cost real money. Assert the value.

### Architecture gates, enforced by tests

`ARCHITECTURE.md`'s seam rules are not conventions to remember — each one is a test that fails when
broken, in `test/integration/architecture.test.ts`:

- No module above `src/adapters/` imports `openai`, `@paypal/agent-toolkit`, or `node:fs`.
  This is the entire risk hedge. If MCP covers everything, deleting the other adapters must cost
  nothing — and a test proves it still would.
- Zero `vi.mock` / `vi.fn` in `src/core`.
- No `as any`, `@ts-ignore`, or `@ts-expect-error` without an adjacent justification comment.

If one of these is annoying, the architecture is wrong. Fix the architecture.

## The honest gap: there is no usage signal

PayPal transaction history contains recurrence, price, cadence, and gaps. It **cannot** tell you whether a user opened Netflix last Tuesday. `checkUnused` needs `lastUsedDate`, which Nixt never collected (`IDLE_DAYS = 30`, `RENEWAL_WINDOW_MS = 7d` already encode the intended flow).

Product decision, not a bug: anchor to the renewal deadline and have the agent **ask** for `lastUsedDate` at the moment it matters. Do not fabricate a usage signal from transaction data.

Also: `cancelGuideData.ts` has 26 guides, heavily India-first, and **zero PayPal-billed merchants**. Assume `genericGuide` covers most of the catalogue.

### The second gap: the sandbox cannot produce recurrence at all

Discovered Oct 17, and it constrains the demo rather than the code. `recurrence.ts` requires a
**date gap** between charges, and every sandbox transaction is stamped at the moment of capture —
PayPal offers no way to backdate one. Three charges in the same minute give gaps of `[0, 0]` →
`irregular` → `isRecurring: false`. **No amount of seeding makes recurrence fire on live sandbox
data.**

**D5 is closed: demo all three lanes, and never blur which is which.**

| Lane | Carries |
|---|---|
| Live sandbox | real reads, real identity round trip, and (from Phase 7) real refunds and cancels |
| Seeded history in D1 | the multi-month date spread only history can provide, under the same merchant keys |
| CSV | the consumer narrative — the only source naming a real payee |

Seeded history is *ours*, and it is history — it is never presented as a live payment, and the UI must
label it. This is a deliberate departure from `todo.md` P4-01's "real API calls, not hand-inserted
rows", which was written before anyone knew PayPal cannot backdate.

## Toolchain (decided 2026-10-09)

- **bun** · **vitest** · **wrangler** (Cloudflare Workers + D1 primary; Render + Turso fallback — Render's filesystem is ephemeral, so a file-based SQLite would silently lose data mid-demo).
- **Raw SQL + zod. No ORM.** Nixt uses none, and at ~100 hours solo a query builder is tax with no payoff.
- `bun run verify` (typecheck + unit + integration + e2e) is the gate and must be green from the first commit onward. The lifted tests are the project's regression net; the e2e tier is the demo's.
- **Environment gotcha:** vitest 5 declares Node ≥ 22.12 but **runs fine on the machine's Node 20.18** — verified, not assumed. `bun` is on disk at `C:\Users\srira\AppData\Roaming\npm\bun`; that npm prefix had to be added to `PATH`.
- Demo reliability beats features: a one-click "seed the scenario" that creates real plans and subscriptions through real API calls, so the demo is rehearsable without hand-crafting state.

## Agent tooling — MCP servers, skills, plugins

**This set is deliberately open.** New MCP servers, skills, and plugins get added whenever a task
needs one. It is not scope-frozen the way the product is. Two rules keep that safe:

1. **Adding agent tooling must not change what gets built.** Nothing on the `ARCHITECTURE.md` §12
   build-order table may be justified by "we installed a tool for it".
2. **Secrets stay out of config.** `{env:VAR}` substitution only. No tokens, no client secrets, in any
   committed file.

### Installed

Config lives in `opencode.jsonc` (project) and `~/.config/opencode/opencode.json` (global).

| Server | Scope | Why |
|---|---|---|
| `paypal-local` | project | `npx -y @paypal/mcp --tools=all`, `PAYPAL_ENVIRONMENT=SANDBOX`. The stdio server `McpPayPalAdapter` will drive at runtime, so Spike S-3 is answered against the real thing. Ships `disabled: true` — flip it once `PAYPAL_ACCESS_TOKEN` is exported. |
| `paypal-sandbox` | project | Hosted OAuth at `mcp.sandbox.paypal.com`. §3 stretch goal; good for poking the catalogue by hand during the Spike. Sign in via `/mcps`. |
| `cloudflare-docs` | project | §10 primary deployment is Workers + D1. |
| `context7` | global | Library docs across every repo. Not spendless-specific. |

| Skill | Scope | Source |
|---|---|---|
| `paypal-integration` | project | `wshobson/agents` |
| `workers-best-practices`, `wrangler` | project | `cloudflare/skills` (official) |
| `vitest`, `vercel-react-best-practices`, `find-skills` | global | `antfu/skills`, `vercel-labs/agent-skills`, `vercel-labs/skills` |

Skills are installed via the skills.sh CLI and tracked in `skills-lock.json`:

```sh
npx skills add <owner/repo> --skill <name> [-g] -y   # -g = global, default = project
npx skills list [-g]
npx skills update [-g]
```

Anything under `.agents/skills/` is committed. Global skills (`~/.agents/skills/`) are not.

### Adding more

- **MCP:** `opencode mcp add <name> --url <url>` (add `--global` for cross-project), or hand-edit
  `opencode.jsonc`. Prefer official/first-party sources. Check `opencode mcp list` afterwards; a
  server showing `needs authentication` is configured, not connected — finish it in `/mcps`.
- **Skill:** use the `find-skills` skill, or `npx skills find <query>`, then install. Prefer 1K+
  installs and official publishers. **Read the `SKILL.md` before trusting it** — these run with full
  agent permissions. Drop anything that duplicates or contradicts `AGENTS.md`; this file wins.
- **Plugin:** add under `plugins` in the same config files.

If a tool turns out to be noise, delete it. A smaller set that is actually read beats a large one.

## Git

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`), one logical change per commit, committed directly to `main`. No PR process.

The commit that carries behaviour also carries its tests. Splitting them is not allowed.