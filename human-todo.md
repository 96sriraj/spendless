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
| **Oct 9–12** | 🔴 H1 (PayPal accounts + token) · H2 (LLM key) | **Phase 0 Spike** | ✅ **GATE PASSED Oct 17** — GO on binding A |
| Oct 13–19 | ✅ H1 done · ✅ H2 done · H3 (Cloudflare account) available early | Phases 1–4 done or partly done · **Phase 5 (the agent) not started** | ⬜ Core agent works end-to-end locally |
| **Oct 20** | 🔴 **Kill-switch check** | Phase 6 (action layer) | ⚠️ **Money-out still unproven — see below** |
| Oct 20–26 | H4 (repo public) ✅ · decisions | Phase 7 (execution) · Phase 8 (UI, deploy) | Demo runs on a free subdomain |
| Oct 27–Nov 2 | H5 (Cloudflare deploy) · full rehearsal | Phase 8 (deploy + harden) | Deployed, rehearsable, no cold-start breakage |
| Nov 3–8 | 🔴 H6 (record the video) · H7 (Devpost text) | Phase 9 (submission support) | Video <3 min, submission drafted |
| Nov 9–11 | 🔴 **Submit early** | Bugfix only | Devpost locks Nov 12 |

> ## ⚠️ Oct 17 — the schedule warning from Oct 16 is resolved, but not the way it was hoped
>
> **What the warning said:** if Oct 17 passed with no token, move the kill switch and re-plan against
> the CSV-only path. **The token arrived**, `bun run check-env` passes for both credentials, and the
> merchant-side path is confirmed. No pivot is needed.
>
> **What the warning got right, and why it still matters:** the slip was real, and Phases 5–9 have
> not moved. Phases 1–2 finished on Oct 9 and then the agent lane sat idle for a week waiting on a
> credential. Phases 5–7 are still untouched.
>
> **The part nobody had checked when the warning was written:** read and capture working end-to-end is
> **not** the same as "it acts". No refund has been issued, because no code can issue one. The kill
> switch in `AGENTS.md` is not formally triggered — the integration is demonstrably real — but
> `todo.md` P7-01 is now the highest-value hour of work available, and until it returns 201 the demo
> cannot claim it acts.

---

## ✅ Where the human lane actually stands — Oct 17

> **PayPal is done. Two live captures, identity round trip proven, kill switch not triggered.** The
> items still unticked in this file are mostly unticked because nobody went back to edit them.

### Done, and no longer needs you

| Item | Outcome |
|---|---|
| H1-01/02 | Business developer account + sandbox app |
| H1-03 | Transaction Search is **on** — proven, `spike` reads real transactions |
| H1-04 | Credentials in shell; `bun run spike` runs green |
| H1-05 | Buyer sandbox account exists |
| H1-05b | Seeded and approved: `31F89528X81443109`, `6YN00176GH7185627` |
| H1-05d | ~~transfer fallback~~ — **obsolete.** It existed to route around a dead approval screen; the screen is alive. |
| H1-05e/05f | Account reset + buyer funding — both done |
| **S-2-live** | **Answered.** Only `transaction_subject` survives; the key moved into `description`. |

### 🔴 What genuinely blocks the agent lane

**Nothing, as of Oct 17.** This table previously listed H1-07 and H2-02 as open; both were closed the
same day and this section was not updated. Every 🔴 blocker in the H1/H2 lanes is now cleared.

| # | Item | Status |
|---|---|---|
| ~~H1-07~~ | One-line demo persona | ✅ **Closed** — "protect this merchant's revenue" (D1). `README.md` now says it. |
| ~~H2-02~~ | Pick the OpenRouter model | ✅ **Closed** — `mistralai/mistral-small-3.2-24b-instruct` (D2, revised after a live test). |

**H2-01 is done**, and the key is confirmed working — `bun run check-env` gets a real completion. See
`.env.example` for the names a fresh shell needs; `.gitignore` protected `.env` perfectly well, which
is exactly the kind of protection that is useless if you don't know the name to use.

> **The agent lane's blocker is now the agent lane's own work.** Phases 5–7 are untouched: no agent,
> no action layer, no `ActionExecutor`, no refund. That is `todo.md` P5-01 onward, and it is not
> waiting on anyone in this file.

### 🟢 Nice to have, not blocking

- **H3-01..04** Cloudflare account + D1 — blocks *deployment*, not building. Worth doing early anyway
  since account creation sometimes needs email verification. **This is the only lane with open 🔴 work left.**
- **H1-06** dispute — **recommend cutting it.** The live probe returned 200 but the namespace is the
  buyer's, so it is not shown to list disputes against the merchant. `AGENTS.md` says cut it rather
  than fake it. Refund + cancel carry "it acts" on their own.
- **H5** rehearsal · **H6** video · **H7** Devpost — the endgame.

---

## H1 — PayPal: accounts and credentials — Day 1 · ✅ COMPLETE

> **All H1 blockers cleared Oct 17.** Kept for the record: the path here cost about a week and three
> wrong diagnoses, all recorded in `ARCHITECTURE.md` §11c. The working method every time was decoding the
> base64 `code=` in the failing URL and reading raw API responses — never reasoning from documentation,
> which was wrong every single time.

- [x] **H1-01** `[developer.paypal.com] Create a PayPal **Business** developer account` → **DONE Oct 16.** Business developer account exists.
- [x] **H1-02** `[Developer Dashboard → Apps & Credentials → Sandbox]` Create the sandbox app → **DONE Oct 16.** Client ID and secret held.
  - In a password manager, **not** in this repo. No secrets in a committed file (`AGENTS.md`).
- [x] **H1-03** `[My Apps → Transaction Search]` **Enable the Transaction Search permission toggle** on the sandbox app → expect the toggle visibly on
  - **Do this next.** It is the single permission the whole read path depends on, and it is easy to
    miss. Without it every read returns a permission error, which reads exactly like "sandbox is
    broken" and costs an afternoon.
- [x] **H1-04** **Put the two sandbox credentials in your shell, then run `bun run spike`**
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
- [x] **H1-05** `[sandbox]` **You need the sandbox BUYER account** → expect you can log into it at
  `https://www.sandbox.paypal.com` and see its balance
  - Dashboard → **Testing Tools → Sandbox Accounts**. Note the **business** account's email/password and
    the **personal/buyer** account's email/password separately. They are two different logins.
  - **This is now the only thing blocking the demo.** The sandbox has **zero payments** — one $5,000
    account adjustment (T1900) and nothing else. There is no data to classify until you approve a real
    payment.
- [x] **H1-05b** `[browser]` `bun run seed` → approve the three orders **as the buyer** → then
  `bun run spike`
  - ⚠️ **A browser is required and cannot be avoided.** Tried and abandoned on 2026-10-16: funding an
    order over the API via `confirm-payment-source` with a sandbox test card returns
    `422 UNPROCESSABLE_ENTITY`, because PayPal gates raw card data behind **PCI SAQ D** compliance.
    The compliant route is a hosted-fields token, which is a browser anyway. Card funding code removed
    rather than left in as a broken path. See `ARCHITECTURE.md` §11c.
  - H1-05c was a wrong diagnosis and is closed. The screen refused because of currency, now fixed.
  - This is the **kill-switch test.** It answers: does a merchant-authored `invoice_id` / `custom_id`
    come back in Transaction Search? Read the `key=` column the script prints. Anything other than
    `unknown` means the identity survived.
- [x] **H1-05c** `[resolved 2026-10-16]` ~~Set the buyer account country to US~~ → **WRONG DIAGNOSIS.
  The cause was `UNSUPPORTED_PAYEE_CURRENCY`: the sandbox **merchant** account is India-based and
  settles in INR, and the orders were charged in USD.
  - Proof: the hosted error page carries a base64 `code`. `VU5TVVBQT1JURURfUEFZRUVfQ1VSUkVOQ1k=`
    decodes to `UNSUPPORTED_PAYEE_CURRENCY`.
  - PayPal **accepted** the orders — only the payer screen refused. The mismatch surfaces on the web
    page and never on an API response, so it looked like a broken checkout.
  - **Country is not the cause** and cannot be changed anyway; it is fixed at account creation. A new
    US buyer account would not have fixed this.
  - Fixed by charging in the payee's currency. `bun run seed` now uses INR by default; override with
    `SEED_CURRENCY=USD` if the merchant account is ever USD-based.

- [x] ~~H1-05d~~ **OBSOLETE** `[fallback, only if approval still fails]` `bun run seed --method transfer` → click the printed
  Send-money link → expect a real payment in the account
  - One click, no checkout flow, no cookies, no country problem. **It carries no `invoice_id`**, so it
    proves the read path sees real payments but proves nothing about identity — do not mistake it for
    the S-2-live answer.
- [x] **H1-05e** `[DONE 2026-10-17]` **RESET the sandbox account pair.** → **WORKED.**
  - Fresh US **business** account + new app attached to it + fresh US **personal** account.
  - **Result: the approval screen now renders correctly.** Pay Now button, the card list, no error
    page. `UNSUPPORTED_PAYEE_CURRENCY` is **gone**. The cause was the payee's settlement currency,
    exactly as the decoded code said — the old pair was India-based.
  - This also retires the transfer fallback (H1-05d): it existed to route around a dead approval
    screen, and the screen is no longer dead.
- [x] **H1-05f** `[DONE 2026-10-17]` **Buyer funding** → **solved, and not the way we expected.**
  - Captures landed: `31F89528X81443109` (Netflix, $15.99), `6YN00176GH7185627` (Spotify, $11.99).
  - **The approval screen was never failing.** It approved the payment and then failed to redirect
    back to us. The spinner was the redirect, not the payment.
  - **Consequence for the demo: the browser is no longer on the critical path.** We approve in the
    browser, then `bun run capture --capture` takes the money server-side. Rehearsal and the video
    both depend on that step working, so this is the reliability fix, not just the diagnosis.
  - **S-2-live is answered on the field names:** `invoice_id`, `custom_field`, `transaction_subject`
    and `cart_info.item_detail` all appear in the live Transaction Search response. Those are exactly
    what `buildOrderPayload` writes, so the detectors have an input.
  - ⚠️ **The full round trip still needs one re-read of the spike.** Transaction Search lags — PayPal
    says "a maximum of three hours", developers report nearer a day. `bun run spike` now prints the
    measured lag (`S-0-03b`) so this is a schedule, not a superstition. **Re-run tomorrow morning and
    read the `key=` column.**

- [ ] **H1-06** `[sandbox]` Force a dispute on a real sandbox payment → expect a dispute visible via the API
  - ⚠️ **Deprioritised, and partly refuted.** All three MCP dispute tools call `/v1/customer/disputes`
    — the **buyer's** namespace — and `accept-claim` pays money *back to the customer*.
  - **But the live probe returned HTTP 200**, so my prediction that merchant credentials would be
    rejected was wrong. Reachable is still not usable: it is the buyer's namespace, and it is not yet
    shown to list disputes *raised against* the merchant.
  - **Only spend time here after H1-05b succeeds.** If the seed does not produce a usable payment, the
    dispute lane is a distraction. Refund + cancel carry the "it acts" claim on their own.
- [x] **H1-07** `[DONE 2026-10-17]` Confirm the demo **persona**: merchant-side is the only executable binding. Is the product framed as "protect this merchant's revenue" or "here's what your data shows you, cancellation happens merchant-side"? → expect a written one-line framing
  - **Needed by Oct 18.** The agent rewrites the README in P8-05; your framing decides what it says.
  - ⚠️ **New constraint from §11a:** no PayPal API returns a *merchant* name to anyone. In the
    merchant-side framing the thing being protected is **this merchant's own subscription revenue**
    — churn, failed renewals, chargebacks. The detectors key on identity spendless writes into
    `invoice_id` at seed time, so the demo's subject is "your plans and your subscribers", not
    "your Netflix". A framing built on the buyer cancelling their own services is not buildable here.
  - The consumer narrative survives via the CSV adapter, which is done and does carry real payee
    names.

## H2 — OpenRouter key — Day 1 · 🔴 BLOCKS PHASE 5

- [x] **H2-01** `[openrouter.ai] Create an account and generate an API key** → expect a key that works at free-tier demo volume
  - Agent reads it server-side only (P8-02). **It never reaches the browser.**
- [x] **H2-02** `[DONE 2026-10-17, revised]` **Pick a cheap instruct model** → **`mistralai/mistral-small-3.2-24b-instruct`** — the 8B pick was cheaper and could not emit valid tool arguments
  - Verified against `/api/v1/models`: $0.05/M in, $0.08/M out, 131k ctx. ~$0.001 per demo run.
  - Upgrade to `mistralai/mistral-small-3.2-24b-instruct` only if proposals come back weak.
  - ⚠️ `qwen/qwen3-8b` — the plausible-looking default — **does not exist** in the catalogue. Guessed
    from memory; would have failed on first use. See D2.

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

- [x] **H4-01** `[github.com/96sriraj/spendless] Confirm the repo is **public**` → expect Devpost's public-repo requirement met
- [x] **H4-02** `[repo]` Confirm `LICENSE` (MIT) is committed → expect a licence file Devpost can see
  - This was an automatic submission blocker for the rejected Nixt entry. Do not lose it again.
- [x] **H4-03** `[repo]` Commit the untracked docs and config: `AGENTS.md`, `ARCHITECTURE.md`, `opencode.jsonc`, `skills-lock.json`, `.agents/` → expect a clean `git status`
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

## ✅ Decision closed — the PayPal integration works

> **Resolved 2026-10-17, three days before the kill switch.** Two real payments captured end to end.
> The `AGENTS.md` kill switch — *"if the core PayPal integration is not demonstrably working
> end-to-end by Oct 20, drop it"* — **is not triggered.** Build the thing as planned.
>
> There is no pivot to make. The CSV adapter stays as the `AccountSource` fallback it was designed to
> be, not as a substitute for the primary path.

| Option | Status | Outcome |
|---|---|---|
| **A. Merchant-side PayPal** | ✅ **works — read, capture, and now refund** | Two live captures, real reads, and a **real refund executed end to end on Oct 17**, full and partial. |
| **B. CSV-only pivot** | **closed, not needed** | Remains as the fallback binding. Unchanged. |

**What made it work**, in case it breaks again: a fresh **US** business account with a new app attached
(fixes `UNSUPPORTED_PAYEE_CURRENCY`), and capturing **server-side** rather than relying on the hosted
page to redirect back. The second is the durable one — it does not depend on the browser at all.

> ### ✅ Update, Oct 17 afternoon — the correction below is now resolved
>
> Earlier today this section said refunds had never been executed, and it was right to say so. An
> hour later they had been:
>
> - **Full refund** on capture `31F89528X81443109` → `status: COMPLETED`
> - **Partial refund** on capture `6YN00176GH7185627` → refund `40551413F19556526`, `COMPLETED`
> - Confirmed by an independent `get_refund` read
>
> It went through the **real product path** — our token, PayPal's MCP server over stdio, our
> `McpPayPalExecutor` — not a raw `fetch`. Evidence in `spike-result.md`.
>
> **`cancel_subscription` is still untested**: the account has no subscriptions and PayPal cannot
> create a backdated one, so there is nothing to cancel. Refund alone carries "it acts".
>
> ⚠️ **Both captures are now refunded.** Re-run `bun run seed` → approve in the browser →
> `bun run capture --capture` for a fresh pair before the demo.

> The lesson worth keeping, because it cost about a week: every one of the wrong diagnoses was made
> from documentation, and every one of the right ones came from reading what the system actually
> returned — the base64 `code=` in a URL, a raw API response, an order's own status. When something
> disagrees with you, interrogate it rather than reason about it.
>
> **The correction was that same lesson, applied one level up.** The original overclaim was not a
> wrong diagnosis from documentation — it was a *true* observation ("captures work") written as a
> *broader* one ("actions work"). Reachability is not usability. The dispute lane taught it; the
> refund claim then repeated it. And the refund that eventually worked found **three more** defects
> hiding behind a single `201`.

## Decisions needed from the founder

| # | Decision | Status | Needed by |
|---|---|---|---|
| **D1** | Demo persona framing | ✅ **CLOSED Oct 17 — "protect this merchant's revenue"** | — |
| **D2** | OpenRouter model | ✅ **CLOSED Oct 17 — revised to `mistralai/mistral-small-3.2-24b-instruct`** | — |
| D3 | Hold the `*.workers.dev` subdomain or buy a domain | ☐ open | Nov 2 — **default: hold, do not buy** |
| D4 | Pull the trigger if the Oct 20 kill switch fires | ✅ **closed — kill switch did not fire** | — |
| **D5** | **How to demo recurrence, given live sandbox cannot produce it** | ✅ **CLOSED — founder chose BOTH (Oct 17)** | — |

### D1 — the persona: protect this merchant's revenue

**Chosen framing, one line:** *spendless protects this merchant's revenue by finding the
subscriptions that are failing, disputed, or unused — and acting on them.*

Chosen over *"here's what your data shows you"* because it is the stronger PayPal story **and** the
more honest one. Three reasons, in order of how much they matter:

1. **It is literally true of our data.** The detectors key on identity spendless itself wrote at seed
   time. ⚠️ **Corrected Oct 17:** that identity survives only in `transaction_subject` — `invoice_id`
   and `custom_field` come back from the API but do not carry our value. The subject of the demo is
   still *our merchant's own plans and subscribers* — not a consumer's spending, which no PayPal API
   exposes — but the field list was wrong.
2. **It puts the "it acts" claim where it belongs.** Refund, cancel and dispute are all merchant-side
   actions. A consumer narrative would have to explain why the actions happen on the merchant's
   account anyway, which is the contradiction AGENTS.md flags.
3. **It makes the hero metric legible.** "£63.96/year of Netflix you are not using" reads as revenue
   protection; the same number under a consumer narrative reads as advice the user can decline.

**Consequences to carry into the build — the README, the run log and the agent prompt must all use
this framing consistently.** A demo that shows "protect your revenue" and then says "here's your
spending" has failed its own first sentence.

### D2 — the OpenRouter model

**Decided: `mistralai/mistral-small-3.2-24b-instruct`. REVISED 2026-10-17 after a live test.**

The original pick was `meta-llama/llama-3.1-8b-instruct` at $0.05/M in, $0.08/M out. It is
**cheaper and unusable.** On OpenRouter it emits every tool call's arguments twice, concatenated:

```
{"limit": "50"}{"limit": "50"}
```

That is not valid JSON, so the agent refused every call. Measured over six consecutive turns:
**zero proposals, and zero convergence** — told its arguments were malformed, it produced the
identical doubled form again.

`mistralai/mistral-small-3.2-24b-instruct` on the identical prompt: **one proposal, zero
rejections, answered in three turns.**

**Nothing for you to do.** The swap is already in the code and the price difference is about
$0.0007 per demo run. It is recorded here because the catalogue check that verified the original
pick was *not enough*: the ID existed, the key worked, and the model still could not call a tool.

> Worth keeping from the same day: `qwen/qwen3-8b`, the other plausible-looking default, **does not
> exist** in the catalogue. It was guessed from memory. Existence in the catalogue says nothing
> about whether a model can emit valid arguments — only a run does.

To try a candidate later, with no code edit:

```powershell
$env:OPENROUTER_MODEL = "some/other-model"
bun run test:integration
```

### D5 — recurrence demo: both lanes, clearly labelled

**The constraint, stated as evidence rather than assumption.** `recurrence.ts` needs a *date gap*:

```ts
if (!Number.isFinite(days) || days <= 0) return "irregular";
```

Every PayPal sandbox transaction is stamped at the moment of capture, and PayPal offers no way to
backdate one. So three Netflix charges in one minute produce gaps of `[0, 0]` → `irregular` →
`isRecurring: false`. **No amount of seeding makes recurrence fire on live merchant data.** Only a
stream with months in it can produce a cadence.

**Decision: do both, and never let the UI blur which is which.**

| Lane | Carries | Why it exists |
|---|---|---|
| **Live sandbox** | identity round-trip, real reads, real refunds, real cancellations, run log | Proves **it acts on real PayPal**. Cannot prove it is *smart*. |
| **Seeded history** | a realistic multi-month series in our own D1, under the same merchant keys | Gives the detectors the date spread only history can provide. This is what a merchant's account genuinely looks like after months of running. |
| **CSV** | a consumer-narrative export | The only source carrying a real merchant name. Keeps the consumer story honest. |

**The rule that makes this acceptable:** seeded history is ours, and it is *history* — it is never
presented as a live payment. The live capture is the newest row on top of it. The UI must label which is
which, because the one thing this project will not do is present invented data as observed data.

> Note this is a deliberate departure from `P4-01`'s "real API calls, not hand-inserted rows". That
> instruction was written before anyone knew PayPal cannot backdate. The departure is recorded here
> rather than absorbed quietly.

## Escalate immediately if

- A **business** sandbox account cannot read transactions → the entire architecture rests on it.
- Refund or cancel does not work end-to-end in sandbox (S-4) → the "it acts" claim is gone.
- A dispute cannot be created in sandbox → the dispute lane must be cut from the demo, not faked.
- The Oct 20 kill switch is approaching with no working end-to-end PayPal call.

*Human lane. No aspirational checks — a box means you saw the artifact.*