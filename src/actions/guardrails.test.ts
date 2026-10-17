import { describe, expect, it } from "vitest";
import { checkRefundCap, type GuardrailConfig } from "./guardrails";

/**
 * The refund ceiling. P6-03.
 *
 * An unreviewed autonomous refund is a safety problem, and a safety problem with
 * no number attached is a slogan. So the cap is a real, configurable ceiling
 * with three properties worth testing separately:
 *
 * 1. **It refuses rather than clamps.** A refund of $500 against a $100 cap
 *    must be *rejected*, not quietly reduced to $100. Clamping would be safe for
 *    the merchant and useless for the product: the approval screen would show
 *    one number and the ledger another, and nobody would notice until a dispute.
 * 2. **It is config, not a constant.** The ceiling comes from configuration so
 *    an operator can lower it without a code change — and a limit nobody can
 *    change is a limit that is wrong the moment the account changes.
 * 3. **Zero is a valid cap.** "Refuse all money" is a legitimate setting, and it
 *    must not be treated as "unset" and defaulted upward. A falsy-check bug here
 *    would silently re-enable spending the moment someone set the cap to 0.
 */

const USD: GuardrailConfig["limits"] = {
  refundCapCents: 10_000, // $100
  currency: "USD",
};

describe("checkRefundCap", () => {
  it("allows a refund at or below the cap", () => {
    expect(checkRefundCap(10_000, { limits: USD }).allowed).toBe(true);
    expect(checkRefundCap(4_999, { limits: USD }).allowed).toBe(true);
  });

  it("refuses a refund above the cap", () => {
    const verdict = checkRefundCap(10_001, { limits: USD });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toMatch(/cap/i);
  });

  it("refuses rather than clamping, so the approved number is the number issued", () => {
    // The dangerous version of this guardrail quietly truncates to the cap. Then
    // the approval screen shows $100, the merchant approved $100, and a $500
    // refund is issued. Every layer would agree and the money would be wrong.
    const verdict = checkRefundCap(50_000, { limits: USD });
    expect(verdict.allowed).toBe(false);
    expect(verdict).not.toHaveProperty("clampedCents");
  });

  it("treats a zero cap as zero, not as unset", () => {
    // `if (!config.refundCapCents)` would treat 0 as "no cap", which is the
    // worst possible bug in a safety limit: disabling it silently re-enables
    // spending. The *behaviour* is `allowed: false` either way, so the assertion
    // that actually distinguishes them is the reason — "no cap is configured" is
    // a lie when one is configured, and an operator reading it would go looking
    // in the wrong place.
    const verdict = checkRefundCap(1, {
      limits: { refundCapCents: 0, currency: "USD" },
    });
    expect(verdict.allowed).toBe(false);
    const reason = verdict.allowed ? "" : verdict.reason;
    expect(reason).not.toMatch(/no refund cap is configured/i);
    expect(reason).toMatch(/cap/i);
  });

  it("says a genuinely absent cap is absent, rather than blaming the amount", () => {
    // The control for the test above. The two cases must not be able to produce
    // the same message, or the diagnostic is worse than none.
    const verdict = checkRefundCap(500, {
      limits: { refundCapCents: undefined as unknown as number, currency: "USD" },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toMatch(/no refund cap is configured/i);
  });

  it("refuses a non-positive or non-integer amount outright", () => {
    // These are not "small refunds". They are bugs, and a bug that reaches
    // PayPal as a zero or negative amount is a support ticket at best.
    for (const amount of [0, -1, -500, 1.5, Number.NaN]) {
      expect(checkRefundCap(amount, { limits: USD }).allowed).toBe(false);
    }
  });

  it("names both numbers when it refuses, so the operator can see the gap", () => {
    const verdict = checkRefundCap(25_000, { limits: USD });
    const reason = verdict.allowed ? "" : verdict.reason;
    expect(reason).toContain("250.00");
    expect(reason).toContain("100.00");
  });

  it("does not compare a cap in one currency against an amount in another", () => {
    // The config carries its own currency. A cap is a number *in a currency*,
    // and 10,000 paise is not 10,000 cents. Refusing the comparison is correct;
    // guessing an FX rate in a guardrail is not.
    const verdict = checkRefundCap(5_000, {
      limits: { refundCapCents: 10_000, currency: "INR" },
      amountCurrency: "USD",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? "" : verdict.reason).toMatch(/currenc/i);
  });

  it("allows the comparison when the currencies match", () => {
    const verdict = checkRefundCap(5_000, {
      limits: { refundCapCents: 10_000, currency: "USD" },
      amountCurrency: "USD",
    });
    expect(verdict.allowed).toBe(true);
  });
});