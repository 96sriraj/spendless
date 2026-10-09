# spendless

**The AI agent that spends less, not more.**

An agent that reads your payment activity, works out what is quietly auto-renewing, decides what you do not actually use — and then *acts*: issues refunds, files disputes on charges you do not recognise, and executes cancellations.

> Status: **pre-build / planning**. No code yet. This README is the agreed scope.

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
| **LLM provider** | **OpenRouter** (key already held) |
| **Hosting** | Render / Cloudflare Workers free tier — `*.onrender.com` is a valid demo URL |
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
| **Oct 9–12** | **Go/no-go.** PayPal sandbox working; determine which APIs are actually reachable. |
| Oct 13–19 | Core agent working end-to-end locally |
| Oct 20–26 | Product surface + design polish |
| Oct 27 – Nov 2 | Deploy + reliability hardening |
| Nov 3–8 | Demo video, README, `LICENSE`, submission text |
| Nov 9–11 | **Submit early** — Devpost locks the submission after Nov 12 |

**Kill switch:** if by **Oct 20** the core PayPal integration is not demonstrably working end-to-end, drop it. Do not spend Nov 1–12 polishing something that cannot make a real PayPal call.

### Open risk to validate on day 1
Whether transaction/activity data is programmatically readable in sandbox for the account type available. Merchant-side access is solid; **consumer/personal-side read access is more limited.** Fallback if blocked: merchant-side demo, or import a PayPal CSV export.

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

1. Create the GitHub repo (public) and push this README.
2. Add `LICENSE` (MIT).
3. Oct 9–12: PayPal sandbox spike + go/no-go.
4. Freeze scope. Build.