# spendless

**The AI agent that protects recurring revenue.**

An agent that reads a merchant's PayPal activity, works out which subscriptions are failing, disputed, or quietly unused — and then *acts*: issues refunds, cancels plans, and resolves disputes. Every action is proposed, approved, and logged.

> Status: **in build, core complete** (Oct 2026). The detector engine is finished and tested; the
> agent, the action layer and the UI are being built on top of it. **Sandbox only** — no live money
> is ever moved.

> **Why it is merchant-side.** PayPal's transaction and refund APIs are merchant-scoped: a refund
> requires the credentials of the merchant that *captured* the payment, so no API lets a buyer's
> agent reverse a buyer's charge. Spendless therefore operates on a merchant account it holds
> credentials for, and protects **that merchant's** revenue. The consumer story survives as a read-only
> mode over a PayPal CSV export.

---

## Target event

**Build What's Next with PayPal and AI** — <https://paypalaihackathon.devpost.com>

| | |
|---|---|
| Submissions close | **Nov 12, 2026, 12:00pm PT** |
| Judging | Dec 1 – Dec 15, 2026 |
| Winners announced | ~Dec 21, 2026 |
| Registered | ~6,957 |
| Prize pool | $67,500 cash across 20 cash positions |
| Eligibility | India ✅ (Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea excluded) |

**Two hard requirements:** meaningfully integrate PayPal, *and* meaningfully integrate AI.

**Judging** is two-stage. Stage One is a **pass/fail** screen on whether the project genuinely applies the required APIs. Stage Two scores five criteria *equally weighted*: Technological Implementation · Design · Potential Impact · Innovation/Idea · Presentation.

**Submission needs:** text description · working demo (repo run instructions **or** a hosted URL) · public repo **with an OSS licence file** · **<3 min YouTube video** showing it working on-device.

---

## Why this is a new repo, not a Nixt rebrand

Nixt was evaluated and **rejected** as an entry, for reasons that cannot be engineered away in 34 days:

1. **No AI anywhere.** Criterion #1 is PayPal *and* AI. There was nothing to score.
2. **PayPal cannot replace RevenueCat for iOS digital subscriptions.** Nixt's Pro is an auto-renewable subscription — a digital good. StoreKit external-purchase rules are US-only post-*Epic*, EU has a separate regime, India has essentially nothing. Swapping it breaks the App Store build.
3. **A payment-processor swap is not "meaningful integration."** Shallow by definition, and it would have destroyed the paywall-value story Nixt already had.
4. **The prizes target merchant-side agentic commerce** — ACP/UCP delegated tokens, Store Sync, WebMCP, MCP server. Nixt is consumer-side with no merchant surface.
5. **Judges cannot run it.** Expo dev-client with RevenueCat + OneSignal needs a Mac, Xcode, CocoaPods and an Apple dev account.
6. **No `LICENSE` file.** Automatic submission blocker.

Nixt stays untouched and remains its own project. This repo borrows its *logic*, not its identity.

---

## What we reuse from Nixt

The genuinely hard, already-built, already-tested parts — this is the head start most entrants will not have:

- `src/lib/money.ts` — monthly-normalisation across billing cycles
- `src/lib/dates.ts` — renewal-date math and countdown offsets
- duplicate / price-hike / unused-subscription detectors
- merchant cancel guides and the saved-estimate model

---

## Locked scope decisions

| Decision | Choice |
|---|---|
| **Platform** | **Web-first. No React Native, no Expo, no EAS, no TestFlight, no App Store review.** Deploy = git push. |
| **Payments sandbox** | PayPal sandbox (free, unlimited) |
| **LLM provider** | **OpenRouter** — `meta-llama/llama-3.1-8b-instruct` (key held, verified working) |
| **Hosting** | Cloudflare Workers + D1 — a free `*.workers.dev` subdomain is a valid demo URL |
| **Domain** | **None. Do not buy one.** |
| **Direct cash cost** | **≈ ₹0** |
| **Real cost** | Time only: ~80–120 hrs solo |

### Explicitly out of scope
Native mobile · RevenueCat · OneSignal · custom domain · paid API credits unless free tiers are outgrown.

---

## Cost

| Item | Cost |
|---|---|
| PayPal sandbox | Free |
| OpenRouter free tier | Free at demo scale |
| Hosting (Render / Workers / Vercel) | Free tier |
| GitHub + `LICENSE` + YouTube | Free |
| **Domain** | **₹0 — not required** |

Devpost accepts a hosted URL *or* repo run instructions. A free subdomain is sufficient.

---

## Timeline

| Window | Milestone |
|---|---|
| **Oct 9–17** | ✅ **Spike + core.** Sandbox verified end to end, real payments captured, detector engine finished (471 tests green). |
| Oct 18–20 | **Agent + action layer + approval.** The remaining critical path. |
| Oct 20 | **Kill switch:** if a real refund cannot be issued by now, drop the PayPal execution story rather than polish around it. |
| Oct 21–26 | UI surface + execution + design polish |
| Oct 27 – Nov 2 | Deploy + reliability hardening |
| Nov 3–8 | Demo video, `LICENSE`, submission text |
| Nov 9–11 | **Submit early** — Devpost locks the submission after Nov 12 |

### The risk that was on day 1 — resolved

> **Whether transaction/activity data is programmatically readable in sandbox for the account type
> available.** Merchant-side access is solid; consumer/personal-side read access is more limited.

**Resolved Oct 17, by calling it rather than reading about it.** A merchant business account with
Transaction Search enabled reads real transactions. The answer was narrower than hoped in one
specific place: of the identity fields spendless writes into a payment, only the transaction subject
survives the round trip — `invoice_id` and `custom_field` come back from the API but do not carry
our value. So identity moves to the field that works, and the detector engine reads it from there.
The consumer narrative survives via the CSV adapter, which is read-only and does carry real payee
names.

### Human work vs Nixt
**~¼ of Nixt.** Everything expensive about Nixt is gone — no device QA, no store review, no push-on-device, no IAP sandbox. Split is roughly: 35% PayPal integration · 30% product & design · 20% demo & video · 15% deploy & reliability.

---

## Honest odds

| Target | Estimate |
|---|---|
| Some cash (HM or sponsor prize) | **10–20%** — only with a deep PayPal integration and a flawless demo |
| Grand prize | **Low single digits** — a genuine lottery at ~7k entries |

Worth playing even at those odds: the direct cost is zero, and we finish with a public repo, a demo video, and a working PayPal + AI build regardless.

**Judges judge from the video.** It must stand alone. Never assume anyone opens the live demo.

---

## Next steps

1. ✅ Public repo, `LICENSE` (MIT), docs committed.
2. ✅ PayPal sandbox spike + go/no-go — **passed Oct 17**, merchant-side.
3. ✅ Deterministic core: 9 lifted detector modules, pure, zero mocks, 471 tests green.
4. 🔜 **The agent**, then the action layer, then a real refund against a real capture.
5. 🔜 Deploy to `*.workers.dev`, rehearse cold, record under 3 minutes.