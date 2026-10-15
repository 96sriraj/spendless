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

> ## ⚠️ Oct 16 — schedule slip, stated plainly
>
> **The kill switch is Oct 20. Four days out.**
>
> H1-01 and H1-02 landed on Oct 16, late. Phases 1–2 are complete and green (357 tests), and the
> adapter ports plus the CSV adapter are done, so the work is staged and waiting on one token —
> but **no real PayPal call has been made yet**, and the kill-switch condition is precisely "a
> real PayPal call works end to end".
>
> **The next four hours matter more than the next four days.** `bun run spike` takes minutes once
> `PAYPAL_ACCESS_TOKEN` is set, and it answers the questions that decide whether the rest of the
> plan survives: whether the sandbox reads transactions at all, whether merchant-authored identity
> round-trips, and whether the dispute lane exists.
>
> If Oct 17 passes with no token, the honest move is to **move the kill switch** and re-plan against
> the CSV-only path, which is fully built and needs no PayPal credential at all.
| Oct 27–Nov 2 | H5 (Cloudflare deploy) · full rehearsal | Phase 8 (deploy + harden) | Deployed, rehearsable, no cold-start breakage |
| Nov 3–8 | 🔴 H6 (record the video) · H7 (Devpost text) | Phase 9 (submission support) | Video <3 min, submission drafted |
| Nov 9–11 | 🔴 **Submit early** | Bugfix only | Devpost locks Nov 12 |

---

## H1 — PayPal: accounts and credentials — Day 1 · 🔴 MOSTLY DONE

> **H1-01 and H1-02 are done.** The remaining blocker is the token. Everything the agent lane needs
> is one command away: `bun run spike` answers S-0-02/03, S-2-live, S-0-04, S-0-04b and S-0-05 and
> writes `spike-result.md`.

- [x] **H1-01** `[developer.paypal.com] Create a PayPal **Business** developer account` → **DONE Oct 16.** Business developer account exists.
- [x] **H1-02** `[Developer Dashboard → Apps & Credentials → Sandbox]` Create the sandbox app → **DONE Oct 16.** Client ID and secret held.
  - In a password manager, **not** in this repo. No secrets in a committed file (`AGENTS.md`).
- [ ] **H1-03** `[My Apps → Transaction Search]` **Enable the Transaction Search permission toggle** on the sandbox app → expect the toggle visibly on
  - **Do this next.** It is the single permission the whole read path depends on, and it is easy to
    miss. Without it every read returns a permission error, which reads exactly like "sandbox is
    broken" and costs an afternoon.
- [ ] **H1-04** **Put the two sandbox credentials in your shell, then run `bun run spike`**
  - **You do not need to mint or manage a token.** `spike.ts` does that itself. Set two variables
    and run one command:

    ```powershell
    cd D:\Github\spendless
    $env:PAYPAL_CLIENT_ID     = "paste-your-client-id-here"
    $env:PAYPAL_CLIENT_SECRET = "paste-your-client-secret-here"
    bun run spike
    ```

  - Prefer these over typing the secret inline — a value typed into a command lands in your
    PowerShell history file in plaintext:

    ```powershell
    $env:PAYPAL_CLIENT_ID     = Read-Host "Client ID"
    $sec = Read-Host "Client Secret" -AsSecureString
    $env:PAYPAL_CLIENT_SECRET = [Net.NetworkCredential]::new("", $sec).Password
    ```

  - Env vars die when the shell closes. That is fine — re-run the two lines in a new window, and
    never persist the secret with `setx`.
  - Then paste back **`spike-result.md`**. It contains verdicts and field names only, no credentials.
  - The `expires_in` in the OAuth response answers **S-0-05** immediately (9 hours, against the 3–8h
    the docs claim). Measuring it for real takes hours and is opt-in via `SPIKE_MEASURE_TTL=1`.
  - Once a read works, the agent can enable `paypal-local` (`todo.md` S0-01).
- [ ] **H1-05** `[sandbox]` **You need the sandbox BUYER account** → expect you can log into it at
  `https://www.sandbox.paypal.com` and see its balance
  - Dashboard → **Testing Tools → Sandbox Accounts**. Note the **business** account's email/password and
    the **personal/buyer** account's email/password separately. They are two different logins.
  - **This is now the only thing blocking the demo.** The sandbox has **zero payments** — one $5,000
    account adjustment (T1900) and nothing else. There is no data to classify until you approve a real
    payment.
- [ ] **H1-05b** `[browser]` `bun run seed` → approve the three orders **as the buyer** → then
  `bun run spike`
  - ⚠️ **A browser is required and cannot be avoided.** Tried and abandoned on 2026-10-16: funding an
    order over the API via `confirm-payment-source` with a sandbox test card returns
    `422 UNPROCESSABLE_ENTITY`, because PayPal gates raw card data behind **PCI SAQ D** compliance.
    The compliant route is a hosted-fields token, which is a browser anyway. Card funding code removed
    rather than left in as a broken path. See `ARCHITECTURE.md` §11c.
  - **Do H1-05c first.** The screen does not work until the buyer account's country is US.
  - This is the **kill-switch test.** It answers: does a merchant-authored `invoice_id` / `custom_id`
    come back in Transaction Search? Read the `key=` column the script prints. Anything other than
    `unknown` means the identity survived.
- [ ] **H1-05c** `[dashboard, ~5 min]` Set the **buyer** sandbox account's **country to US**, then run
  `bun run seed` and approve → expect the approval screen to render
  - On 2026-10-16 the hosted approval screen returned *"Things don't appear to be working at the
    moment"* **while the orders were created successfully** — a PayPal web checkout failure, not ours.
    Known causes, most likely first:
    1. **The buyer sandbox account's country is not US.** The most commonly reported cause. Edit the
       existing buyer account to US, or delete it and create a new one with country = US.
    2. **Not signed in** to `sandbox.paypal.com` in the same browser when the link is opened. Sign in
       as the buyer *first*, then open the URL.
    3. **Third-party cookies blocked**, or an ad/privacy extension. Try a clean browser profile.
    4. The link is **single-use and expires** — create a fresh order rather than reusing an old URL.
  - The order payload now sends `application_context` (brand, `PAY_NOW`, `LOGIN`), which makes the
    hosted screen materially more reliable.
- [ ] **H1-05d** `[fallback, only if H1-05c fails]` `bun run seed --method transfer` → click the printed
  Send-money link → expect a real payment in the account
  - One click, no checkout flow, no cookies, no country problem. **It carries no `invoice_id`**, so it
    proves the read path sees real payments but proves nothing about identity — do not mistake it for
    the S-2-live answer.
- [ ] **H1-06** `[sandbox]` Force a dispute on a real sandbox payment → expect a dispute visible via the API
  - ⚠️ **Deprioritised, and partly refuted.** All three MCP dispute tools call `/v1/customer/disputes`
    — the **buyer's** namespace — and `accept-claim` pays money *back to the customer*.
  - **But the live probe returned HTTP 200**, so my prediction that merchant credentials would be
    rejected was wrong. Reachable is still not usable: it is the buyer's namespace, and it is not yet
    shown to list disputes *raised against* the merchant.
  - **Only spend time here after H1-05b succeeds.** If the seed does not produce a usable payment, the
    dispute lane is a distraction. Refund + cancel carry the "it acts" claim on their own.
- [ ] **H1-07** `[decision]` Confirm the demo **persona**: merchant-side is the only executable binding. Is the product framed as "protect this merchant's revenue" or "here's what your data shows you, cancellation happens merchant-side"? → expect a written one-line framing
  - **Needed by Oct 18.** The agent rewrites the README in P8-05; your framing decides what it says.
  - ⚠️ **New constraint from §11a:** no PayPal API returns a *merchant* name to anyone. In the
    merchant-side framing the thing being protected is **this merchant's own subscription revenue**
    — churn, failed renewals, chargebacks. The detectors key on identity spendless writes into
    `invoice_id` at seed time, so the demo's subject is "your plans and your subscribers", not
    "your Netflix". A framing built on the buyer cancelling their own services is not buildable here.
  - The consumer narrative survives via the CSV adapter, which is done and does carry real payee
    names.

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