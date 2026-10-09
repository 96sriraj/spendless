/**
 * Confidence - the single documented 0..1 scale every detector reports on.
 *
 * Lifted from nixt with an inconsistency: `DuplicateFlag` and
 * `Recommendation` used `confidence: number` while `UnusedFlag` used the
 * literal `"possibly"`. A ranking axis cannot be a string. The reason nixt
 * reached for a word is honest, though - an unconfirmed usage signal really
 * is weaker than a computed one - so the fix is to encode that weakness as a
 * number in a named scale rather than to delete the distinction.
 *
 * This is the input the agent ranks on (todo.md P5-05), so the scale is stated
 * once here instead of being re-guessed per detector.
 */

export type Confidence = number;

export const CONFIDENCE = {
  /**
   * Derived from a quantity that was computed, not inferred: a measured price
   * delta, a worked-out annual total. Nothing about this is a judgement call.
   */
  derived: 1,

  /**
   * The two names canonicalise to the same merchant. Strong, but still a
   * string match - "Netflix" and "Netflix Family" are not proof.
   */
  exactMerchantMatch: 0.9,

  /**
   * Fuzzy string similarity above threshold. Lower than an exact match because
   * it *is* a guess, however good the guess is.
   */
  fuzzyMerchantMatch: 0.8,

  /**
   * Only a manually-supplied lastUsedDate says a subscription is unused.
   * ARCHITECTURE.md section 8: PayPal transaction history contains no usage
   * signal at all - not recurrence, not gaps, nothing that says whether
   * anyone opened the app. This is nixt's "possibly", finally as a number,
   * and it sits low on purpose.
   */
  unconfirmedUsage: 0.4,
} as const satisfies Record<string, Confidence>;

/** Keeps a computed score inside the scale, whatever arithmetic produced it. */
export function clampConfidence(value: number): Confidence {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}