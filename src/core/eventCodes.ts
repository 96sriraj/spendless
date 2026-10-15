/**
 * PayPal transaction event codes (T-codes).
 *
 * Verified 2026-10-16 against PayPal's published T-code reference after the
 * Spike returned a single transaction with code T1900. See
 * ARCHITECTURE.md section 11c.
 *
 * This file deliberately classifies by **event group**, not by specific code.
 * A hardcoded list of individual T-codes would be exactly the guessed constant
 * `recurrence.ts` refuses to contain: the reference is long, it changes, and a
 * wrong entry in the ranking path is worse than no filter at all.
 *
 * A T-code is `T` + a two-digit event group + a two-digit event type:
 *
 *   T00nn  PayPal account-to-PayPal account payment   <- payments
 *   T01nn  non-payment fees (chargeback fee, withdrawal, ATM)
 *   T02nn  currency conversion
 *   T05nn  PayPal debit card
 *   T06nn  credit card withdrawal      T07nn  credit card deposit
 *   T11nn  payment reversal / hold lifecycle for chargebacks
 *   T16nn  BML credit transfers        T17nn  withdrawal to a bank
 *   T18nn  buyer credit, BML withdrawal
 *   T19nn  general account correction - NOT a business event (this is what the
 *          sandbox shipped with: a $5,000 balance adjustment and nothing else)
 *   T20nn  intra-account transfer      T30nn  general wallet transaction
 *
 * Only T00 and T30 move money because somebody bought something. Everything
 * else is a fee, an adjustment, a transfer, or a reversal.
 */

/** Event groups that represent a real payment for something. */
export const PAYMENT_EVENT_GROUPS: readonly string[] = ["T00", "T30"];

/** Groups that represent money movement, but not a purchase. */
export const NON_PAYMENT_EVENT_GROUPS: Readonly<Record<string, string>> = {
  T01: "fee",
  T02: "currency conversion",
  T05: "debit card",
  T06: "credit card withdrawal",
  T07: "credit card deposit",
  T11: "payment reversal / chargeback hold",
  T16: "BML transfer",
  T17: "bank withdrawal",
  T18: "buyer credit / BML withdrawal",
  T19: "account adjustment (no business event)",
  T20: "intra-account transfer",
};

/**
 * What a T-code means, or null when the group is not one PayPal documents.
 *
 * Unknown codes return null rather than a guess. "I do not know what this is"
 * is a useful thing for a run log to say; "it is probably a fee" is not.
 */
export function classifyEventCode(code: string): string | null {
  const group = code.slice(0, 3).toUpperCase();
  if (group === "T00") return "payment";
  if (group === "T30") return "payment";
  return NON_PAYMENT_EVENT_GROUPS[group] ?? null;
}

/**
 * True when the event represents a payment for something.
 *
 * An unrecognised code is treated as NOT a payment. The asymmetry is
 * deliberate: a new event type that this table has not caught yet should leave
 * the transaction out of a recurrence series rather than invent one.
 */
export function isPaymentEvent(code: string): boolean {
  return classifyEventCode(code) === "payment";
}

/** Why a transaction was excluded, for the run log. */
export function exclusionReason(code: string): string | null {
  if (isPaymentEvent(code)) return null;
  const known = classifyEventCode(code);
  return known === null
    ? `unrecognised event code ${code} - excluded rather than guessed at`
    : `${code} is ${known}, not a payment`;
}