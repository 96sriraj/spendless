# AGENTS.md — spendless

**The AI agent that spends less, not more.** PayPal AI Hackathon entry (Devpost: [Build What's Next with PayPal and AI](https://paypalaihackathon.devpost.com)).

> This repo is **pre-build as of 2026-10-09**: docs + config only, no `package.json`. Read
> `README.md` (scope + business case) and `ARCHITECTURE.md` (how it gets built, in what order)
> before writing code. Both are the source of truth — this file only records what an agent would
> otherwise get wrong.
>
> **Work the queues:** [`todo.md`](./todo.md) is the agent lane, [`human-todo.md`](./human-todo.md)
> is the founder lane. The agent lane blocks on anything marked 🔴 there (PayPal business account,
> exported token, OpenRouter key, video, submission). Check a box only after the verification gates
> at the bottom of `todo.md` pass.

## Non-negotiables

- **Two hard eligibility requirements: meaningful PayPal integration *and* meaningful AI integration.** Stage-one judging is a pass/fail screen on exactly that. Never let either become a bolt-on.
- **Submissions lock Nov 12, 2026, 12:00pm PT.** Public repo with an OSS licence file, run instructions *or* a hosted URL, and a **<3 min video**. `LICENSE` is already MIT and must never be removed.
- **Kill switch: if the core PayPal integration is not demonstrably working end-to-end by Oct 20, drop it.** Do not spend Nov 1–12 polishing something that cannot make a real PayPal call.
- **Judges judge from the video.** It must stand alone. Never assume anyone opens the live demo.
- **Scope is frozen.** Anything not on the `ARCHITECTURE.md` §12 build-order table is out. Explicit non-goals: native mobile, Expo/React Native, RevenueCat, OneSignal, custom domain, a free-roaming autonomous agent, unbounded spend, multi-tenant auth, an ORM/query builder.

## The binding constraint (read before designing anything)

Every PayPal MCP tool is **merchant-scoped**. `list_transactions` wraps Transaction Search v1, which needs a business account. A refund requires the credentials of the merchant that *captured* the payment — a buyer's agent cannot reverse a buyer's charge; the dispute flow runs the other way.

- **Binding A (merchant-side) is the demo.** C (consumer-side via CSV, read-only) is the consumer narrative. **B (consumer-side execution via API) is not buildable.**
- This is **inferred from docs, not verified** — that is Spike item S-1. Do not present it as settled fact, and do not rebuild the plan around it until a live sandbox call confirms it.
- `README.md` still has consumer framing that implies B. That contradiction is a known open item. Do not resolve it by writing consumer-execution code.
- **Spike S-1..S-4 gates everything.** S-2 (does `list_transactions` return merchant identity, amount, date, `custom_id`?) is the one that quietly kills projects — without merchant detail the lifted detectors have no input. Check it before anything else.

## Ports and adapters — the one seam that matters

Everything above the adapter layer depends on the `AccountSource` / `ActionExecutor` interfaces in `ARCHITECTURE.md` §3, never on MCP or REST.

> **No module above the adapter layer may import `openai`, `@paypal/agent-toolkit`, or `node:fs`.**
> That is the entire risk hedge. If MCP covers everything, delete the other adapters and nothing moves.

- Primary adapter is **in-process** MCP (`npx -y @paypal/mcp --tools=all`, `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX`). Hosted `mcp.paypal.com` OAuth is a stretch goal, not the primary path.
- Sandbox tokens live **3–8 hours**. Refresh proactively; never discover expiry mid-demo.
- Dependencies point **downward only**: UI → run log → action layer → agent → core → adapters. The core imports nothing from layers above it.
- Secrets (PayPal credentials, OpenRouter key) are **server-side only**. They never reach the browser.

## Lifting from Nixt

The detector head start comes from the sibling repo **`D:\Github\nixt`** (a separate Expo/RN app — do not copy its Expo, RevenueCat, OneSignal, or store code). Its `AGENTS.md` describes *that* project and does not apply here.

The 9 files to lift verbatim from `D:\Github\nixt\src\lib\`: `money.ts` `dates.ts` `duplicateDetector.ts` `validators.ts` `cancelGuide.ts` `cancelGuideData.ts` `annualSwitch.ts` `calendar.ts` `brand.ts` — plus the ~6 colocated `*.test.ts` files. They depend only on `zod` and the `@/*` path alias, and run with **zero mocks**.

Order matters (this is the build order, not a suggestion):

1. **First refactor, one commit:** replace `durableNotepad` (in Nixt: `src/store/durableNotepad.ts`) with a DB adapter. Five modules import its `kvGet`/`kvSet` — `insights.ts` (via `priceHistory.ts`), `unusedDetector.ts`, `priceHistory.ts`, `savingsLedger.ts`, `cancelIntent.ts`. Until this is done the detector graph is impure and untestable. Everything after is cheaper because of it.
2. Do **not** port the `kv` blob table. Price history, usage events, savings events, and the action ledger get real columns.

Two invariants to preserve **deliberately, with a comment** — a refactor will silently break them otherwise:

- `computeInsights` upserts by **strictly greater** `savingCents`, making it **order-dependent**: `costPerUse` must run before `checkUnused` so the richer "wasted" headline wins ties.
- `savingCents` is the ranking axis (forward monthly); `displaySaving` is only what the UI renders. They are allowed to differ. Do not collapse them.

Fix on lift: `priceHistory.ts` renders raw cents in its title (no `/100`), and `confidence` is `number` on `DuplicateFlag`/`Recommendation` but the literal `"possibly"` on `UnusedFlag`. Normalise.

**Currency is INR-hardcoded** in Nixt (`CurrencySchema = z.enum(["INR"])`, `en-IN` formatters, ₹1L/5L/10L milestones). **PayPal sandbox is USD.** Widen to `["USD","INR"]`, parameterise formatters, add USD milestones.

Also carried over: raw SQL + zod (no ORM, deliberate), and the reusable CORS allow-list pattern from `D:\Github\nixt\worker\src\index.ts:42-57`.

## The agent

**Bounded loop with a typed tool allowlist** — not a free-roaming agent. Reproducible demo, no hallucinated refunds.

- The LLM **classifies, reasons, ranks, and drafts rationale**. It does **not** compute a normalised monthly figure, decide a refund amount, or execute anything. Every figure on screen traces to a pure function in the core.
- The natural insertion point: `cancelGuide.ts` falls back to `genericGuide(name)`, which fabricates a link. Nixt could not execute a cancellation so it shipped a URL; the agent replaces the weakest branch of an existing resolver with one that acts. That is the answer to "where exactly is the AI here?"
- Use a cheap instruct model via **OpenRouter** with structured tool output. A small model with a tight schema beats a large one wandering.

## Actions and guardrails

Every action is `proposal → approval → execution → result`, all four persisted. Refunds move money; an unreviewed autonomous refund is both a safety problem and a weak Design/Impact story.

- Hard configurable cap on refund amounts.
- Prominent `SANDBOX` indicator in the UI, always.
- Kill switch that halts execution without halting the demo.
- Dispute windows encoded: escalation requires **≥7 days** since payment, disputes auto-close at **20 days**.
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