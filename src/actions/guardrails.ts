/**
 * The refund ceiling. P6-03.
 *
 * A cap with no number attached is a slogan, so this is a real configurable
 * ceiling with three properties that are separately load-bearing:
 *
 * 1. **Refuse, never clamp.** A $500 refund against a $100 cap is rejected, not
 *    quietly reduced to $100. Clamping would be safe for the merchant and
 *    useless for the product: the approval screen would show one number, the
 *    ledger another, and nothing would notice until a dispute.
 * 2. **Configuration, not a constant.** An operator can lower the ceiling
 *    without a code change. A limit nobody can change is a limit that is wrong
 *    the moment the account changes.
 * 3. **Zero is a real cap.** "Refuse all money" is a legitimate setting. A
 *    falsy-check bug here would silently re-enable spending the moment someone
 *    set the cap to zero, which is the worst possible bug in a safety limit.
 *
 * Pure and side-effect free, so the tier rules apply: no clock, no IO, injected
 * inputs. Every figure it compares was computed by the core — this only ever
 * decides whether a number already in hand may proceed.
 */

import type { Currency } from "@/core/validators";

export type RefundLimits = {
  /** Hard ceiling in minor units of `currency`. */
  readonly refundCapCents: number;
  readonly currency: Currency;
};

export type GuardrailConfig = {
  readonly limits: RefundLimits;
  /** Set when the action being checked is in a currency the cap is not. */
  readonly amountCurrency?: Currency;
};

export type CapVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Two decimals of a minor-unit amount, for a message a human reads.
 *
 * Hand-rolled rather than pulled from `money.ts`: that module's formatters are
 * locale-aware and this is a log line, and a guardrail should not depend on
 * locale data to be readable. `Intl` is also not available in every runtime this
 * has to run in.
 */
function minorToMajor(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function checkRefundCap(amountCents: number, config: GuardrailConfig): CapVerdict {
  // A cap is a number *in a currency*. Comparing 10,000 INR minor units against
  // a USD amount would be a unit error that reads as a real limit, so the
  // comparison is refused rather than attempted — guessing an FX rate inside a
  // safety guardrail is how money goes somewhere nobody intended.
  if (
    config.amountCurrency !== undefined &&
    config.amountCurrency !== config.limits.currency
  ) {
    return {
      allowed: false,
      reason:
        `currency mismatch: the amount is in ${config.amountCurrency} but the cap is ` +
        `in ${config.limits.currency}. No conversion is attempted here — guessing a ` +
        "rate inside a safety guardrail is how money goes somewhere nobody intended.",
    };
  }

  // Checked before the cap, and separately, because these are bugs rather than
  // large refunds. A NaN fails every comparison silently, which would let an
  // undefined amount sail past a ceiling.
  if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents) || amountCents <= 0) {
    return {
      allowed: false,
      reason: `refund amount ${String(amountCents)} is not a positive whole number of minor units`,
    };
  }

  // `=== undefined` rather than a falsy check, so a cap of 0 is honoured.
  if (config.limits.refundCapCents === undefined) {
    return {
      allowed: false,
      reason: "no refund cap is configured; refusing rather than defaulting to unlimited",
    };
  }
  if (!Number.isInteger(config.limits.refundCapCents) || config.limits.refundCapCents < 0) {
    return {
      allowed: false,
      reason: `configured refund cap ${String(config.limits.refundCapCents)} is not a non-negative whole number`,
    };
  }

  if (amountCents > config.limits.refundCapCents) {
    return {
      allowed: false,
      reason:
        `refund of ${minorToMajor(amountCents)} ${config.limits.currency} exceeds the ` +
        `${minorToMajor(config.limits.refundCapCents)} ${config.limits.currency} cap. ` +
        "Refused, not reduced — the approved amount is the amount issued.",
    };
  }

  return { allowed: true };
}