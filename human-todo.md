# spendless — Human TODO (parallel lane)

> **Owner: founder — not the agent.** These are account, credential, decision, and recording tasks
> an agent cannot do. The agent lane in [`todo.md`](./todo.md) **blocks** on anything marked 🔴.
>
> Check a box only after the artifact is **verified** — a dashboard you can see, a token that
> worked, a file that exists. No aspirational checks.
>
> **Two hard gates:** submission locks **Nov 12, 2026, 12:00pm PT**. Kill switch: if the core
> PayPal integration is not demonstrably working end-to-end by **Oct 20**, drop it.
>
> Devpost: [Build What's Next with PayPal and AI](https://paypalaihackathon.devpost.com) —
> **public repo with an OSS licence file**, run instructions *or* a hosted URL, and a **<3 min video**.

---

## Timeline — human lane vs agent lane

| Window | Human (this file) | Agent (`todo.md`) | Joint gate |
|---|---|---|---|
| **Oct 9–12** | 🔴 H1 (PayPal accounts + token) · H2 (LLM key) | **Phase 0 Spike S-1..S-5** | **GO/NO-GO** |
| Oct 13–19 | H3 (Cloudflare account) available early | Phases 1–5 (core → adapter → seed → run log → agent) | Core agent works end-to-end locally |
| **Oct 20** | 🔴 **Kill-switch check** | Phases 6–7 (action layer → execution) | **Real PayPal call, or drop it** |
| Oct 20–26 | H4 (repo public) · decisions | Phase 7–8 (UI surface, deploy) | Demo runs on a free subdomain |
| Oct 27–Nov 2 | H5 (Cloudflare deploy) · full rehearsal | Phase 8 (deploy + harden) | Deployed, rehearsable, no cold-start breakage |
| Nov 3–8 | 🔴 H6 (record the video) · H7 (Devpost text) | Phase 9 (submission support) | Video <3 min, submission drafted |
| Nov 9–11 | 🔴 **Submit early** | Bugfix only | Devpost locks Nov 12 |

---

## H1 — PayPal: accounts and credentials — Day 1 · 🔴 BLOCKS THE SPIKE

> **Everything is blocked on this.** Without a business sandbox account and an exported access
> token there is no S-1, no S-2, and no Phase 0. Start here, before anything else.

- [ ] **H1-01** `[developer.paypal.com] Create a PayPal **Business** developer account** → expect the Developer Dashboard shows your sandbox credentials
  - **Business, not personal.** ARCHITECTURE.md §2: `list_transactions` wraps Transaction Search v1,
    which requires a business account. A personal account cannot answer S-1 or S-2.
  - If you already have one, verify sandbox is active and **skip**.
- [ ] **H1-02** `[Developer Dashboard → Apps & Credentials → Sandbox]` Create the sandbox app → expect a **Client ID** and **Secret** on screen
  - Record them in a password manager, **not** in this repo. No secrets in a committed file (`AGENTS.md`).
- [ ] **H1-03** `[My Apps → Transaction Search]` **Enable the Transaction Search permission toggle** on the sandbox app → expect the toggle visibly on
  - This is the single permission the whole read path depends on. Verify it is actually on.
- [ ] **H1-04** `[Dashboard]` Export a **sandbox access token** for the app → expect `PAYPAL_ACCESS_TOKEN` exported into your shell for the Spike
  - **Tokens live 3–8 hours.** Refresh proactively; never discover expiry mid-demo.
  - Agent enables the `paypal-local` MCP server once this exists (`todo.md` S0-01).
  - Never paste the token into a chat, a doc, or a commit.
- [ ] **H1-05** `[sandbox]` Create a **second personal sandbox account** (buyer) → expect it can pay the business account's subscription
  - Needed for S-2 and S-4: create plan → subscription → **capture with the personal account** → re-query.
  - Capture with a personal account is the exact shape that proves or refutes merchant-side read.
- [ ] **H1-06** `[sandbox]` Force a dispute on a real sandbox payment → expect a dispute visible via the API
  - `/v1/customer/disputes/{id}/adjudicate` and `/require-evidence` are **sandbox-only** endpoints.
    If a dispute cannot be created, the agent's dispute-resolve demo cannot be rehearsed — find that out now, not in November.
- [ ] **H1-07** `[decision]` Confirm the demo **persona**: merchant-side is the only executable binding. Is the product framed as "protect this merchant's revenue" or "here's what your data shows you, cancellation happens merchant-side"? → expect a written one-line framing
  - **Do not leave the README implying a buyer can refund their own charge.** It is not buildable
    (`AGENTS.md`, binding B). The agent rewrites the README in P8-05; your framing decides what it says.
  - A merchant persona is the honest, fully-executable option and the one the MCP tool surface supports.

## H2 — OpenRouter key — Day 1 · 🔴 BLOCKS PHASE 5

- [ ] **H2-01** `[openrouter.ai] Create an account and generate an API key** → expect a key that works at free-tier demo volume
  - Agent reads it server-side only (P8-02). **It never reaches the browser.**
- [ ] **H2-02** `[openrouter.ai] Pick a cheap instruct model** → expect a shortlist of 1–2 candidates for P5-02
  - A small model with a tight schema beats a large one wandering. Free tier is enough at demo volume.

## H3 — Cloudflare account — Day 2 · unblocks Phase 8

- [ ] **H3-01** `[dash.cloudflare.com] Create a Cloudflare account` → expect Workers + D1 available on the free tier
  - Primary deploy is Workers + D1 (`AGENTS.md`). Fallback is Render + Turso — Render's filesystem
    is ephemeral, so a file-based SQLite would **silently lose data mid-demo**. Do not use it.
- [ ] **H3-02** `[dashboard]` Confirm a `*.workers.dev` subdomain is assigned → expect a working URL; **no domain purchase** — the README locks this at ₹0
- [ ] **H3-03** `[dashboard]` Create the D1 database** → expect a `database_id` for `wrangler.toml`
- [ ] **H3-04** `[deploy]` Register the Workers subdomain and set the secrets server-side → expect `wrangler secret put` for the PayPal credentials and the OpenRouter key
  - **Demo reliability beats features.** A one-click "seed the scenario" through real API calls is
    worth more than a second feature. Rehearse it (P8-06) — an unrehearsable demo is a failed demo.

## H4 — Repo and licence — Day 2

- [ ] **H4-01** `[github.com/96sriraj/spendless] Confirm the repo is **public**` → expect Devpost's public-repo requirement met
- [ ] **H4-02** `[repo]` Confirm `LICENSE` (MIT) is committed → expect a licence file Devpost can see
  - This was an automatic submission blocker for the rejected Nixt entry. Do not lose it again.
- [ ] **H4-03** `[repo]` Commit the untracked docs and config: `AGENTS.md`, `ARCHITECTURE.md`, `opencode.jsonc`, `skills-lock.json`, `.agents/` → expect a clean `git status`
  - The agent lane starts from `todo.md` Phase 0; commit the instructions it depends on first.

## H5 — Demo rehearsal — Oct 27–Nov 2

- [ ] **H5-01** `[demo]` Rehearse the full demo **cold**, start to finish, on the deployed URL → expect seed → agent → approval → refund → run log, with no hand-fixing
  - Do this at least twice. Once more with the laptop's network off and back on.
- [ ] **H5-02** `[demo]` Confirm the prominent `SANDBOX` indicator is visible in the deployed build → expect no chance of a judge mistaking it for live money movement
- [ ] **H5-03** `[demo] Confirm the kill switch halts execution without breaking the demo** → expect a graceful stop, not a blank screen
- [ ] **H5-04** `[fallback]` Prepare the fallback demo if PayPal sandbox is down on the day → expect something rehearsable without a live PayPal call
  - Save every sandbox token refresh to a password manager **before** the recording day. A 3–8h
    expiry discovered mid-recording is the most likely way this goes wrong.

## H6 — Demo video — Nov 3–8 · 🔴 REQUIRED

> **Judges judge from the video. It must stand alone. Never assume anyone opens the live demo.**
> Hard limit: **under 3 minutes.**

- [ ] **H6-01** `[script] Draft the 3-minute script** → expect a written narrative, not improvised
- [ ] **H6-02** `[script] Show the agent's reasoning, not just its output** → expect the run log timeline on screen
  - The run log is the highest-leverage scoring item (`ARCHITECTURE.md` §9). Without it you are
    asking a judge to trust an assertion. With it, the agent's behaviour *is* the demo.
- [ ] **H6-03** `[script] Prove the PayPal integration is real** → expect a visible refund and cancel against sandbox, plus the SANDBOX indicator
  - Stage one judging is a **pass/fail screen** on genuine use of the required APIs.
- [ ] **H6-04** `[script] Prove the AI is load-bearing** → expect the merchant the old code could only hand a link for, now actually handled
- [ ] **H6-05** `[record] Record, on-device, at 1080p** → expect under 3 minutes, verified by playing it back
- [ ] **H6-06** `[upload] Upload to YouTube as unlisted or public** → expect a URL ready to paste into Devpost

## H7 — Devpost submission — Nov 3–11 · 🔴 HARD LOCK Nov 12, 12:00pm PT

- [ ] **H7-01** `[devpost] Draft the text description** → expect it names the PayPal APIs used and the AI's role explicitly
  - Criterion #1 is PayPal **and** AI. Nixt was rejected for having no AI at all. State both, plainly.
- [ ] **H7-02** `[devpost] Submit repo URL + run instructions** (or the hosted URL) → expect a judge can reach it without asking you anything
  - A free `*.workers.dev` subdomain is sufficient. **No domain purchase.**
- [ ] **H7-03** `[devpost] Attach the video URL** → expect the <3 min upload from H6
- [ ] **H7-04** `[devpost] Confirm the OSS licence file is visible** → expect the public repo + MIT `LICENSE` both check out
- [ ] **H7-05** `[Nov 9–11] SUBMIT EARLY** → expect a confirmation screen, screenshot saved
  - **Devpost locks the submission after Nov 12.** Do not plan to submit on the 12th.

---

## Decisions needed from the founder

| # | Decision | Status | Needed by |
|---|---|---|---|
| D1 | Demo persona framing — merchant-side vs consumer narrative with merchant-side execution | ☐ open | **Oct 12** (H1-07) — changes the README |
| D2 | Which OpenRouter model for the agent | ☐ open | Oct 18 (H2-02) |
| D3 | Hold the `*.workers.dev` subdomain or buy a domain | ☐ open | Nov 2 — **default: hold, do not buy** |
| D4 | Pull the trigger if the Oct 20 kill switch fires | ☐ open | **Oct 20** |

## Escalate immediately if

- A **business** sandbox account cannot read transactions → the entire architecture rests on it.
- Refund or cancel does not work end-to-end in sandbox (S-4) → the "it acts" claim is gone.
- A dispute cannot be created in sandbox → the dispute lane must be cut from the demo, not faked.
- The Oct 20 kill switch is approaching with no working end-to-end PayPal call.

*Human lane. No aspirational checks — a box means you saw the artifact.*