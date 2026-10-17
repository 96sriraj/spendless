/**
 * The dispute deadlines. P6-06.
 *
 * `AGENTS.md` encodes two: escalation requires **7 days** since payment, and a
 * dispute auto-closes at **20 days**. Both exist because PayPal accepts an
 * action only inside its window, and an agent that discovers that by getting a
 * rejection on the recording day has failed the demo at its worst moment.
 *
 * Pure functions with an injected clock, so the tier rules hold — no `Date.now`,
 * nothing to fake. The parts worth being careful about are the boundaries:
 *
 * - **Day 7 escalates, day 6 does not.** Off by one in either direction either
 *   refuses an action PayPal accepts or attempts one it will reject.
 * - **Day 20 is closed.** The twentieth day is the last day or the first day
 *   past it, and the difference is a dispute that is lost rather than won.
 * - **A payment dated in the future is refused.** Clock skew reads as a very
 *   negative age, which satisfies "at least 7 days ago" — the one direction of
 *   error that loses a dispute outright.
 *
 * The dispute lane is cut from the demo (S-0-04: the MCP tools address the
 * buyer's namespace, not the merchant's), so none of this can reach PayPal
 * today. It is written anyway because the windows are a property of the
 * *product*, not of the adapter — and re-deriving them from documentation in
 * October is how they end up wrong.
 */

export const DISPUTE_WINDOW_DAYS = {
  /** A merchant cannot escalate before the buyer has had a chance to complain. */
  escalateFrom: 7,
  /** PayPal closes the claim itself after this long. */
  autoCloseAfter: 20,
} as const;

const DAY_MS = 86_400_000;

export type DisputeWindowInput = {
  /** When the payment was captured. `null` when we do not know. */
  readonly paidAt: Date | null;
  readonly now: Date;
};

export type DisputeWindowVerdict = {
  readonly canEscalate: boolean;
  readonly isClosed: boolean;
  /** Whole days since payment, or `null` when unknown. Never negative. */
  readonly daysSincePayment: number | null;
  /** Whole days left before auto-close. `0` once closed — never negative. */
  readonly daysRemaining: number;
  /** Always populated. Never a rejection with no explanation. */
  readonly reason: string;
};

export function evaluateDisputeWindow(input: DisputeWindowInput): DisputeWindowVerdict {
  const { paidAt, now } = input;

  if (paidAt === null) {
    return {
      canEscalate: false,
      isClosed: false,
      daysSincePayment: null,
      daysRemaining: DISPUTE_WINDOW_DAYS.autoCloseAfter,
      reason:
        "no payment date is recorded, so the dispute window cannot be evaluated. " +
        "Refusing rather than assuming it is open.",
    };
  }

  const elapsedMs = now.getTime() - paidAt.getTime();

  // Checked before the comparison it feeds. A negative age satisfies "at least
  // 7 days ago", so a clock skew one second the wrong way would report a
  // dispute as comfortably eligible when it has not opened at all.
  if (elapsedMs < 0) {
    return {
      canEscalate: false,
      isClosed: false,
      daysSincePayment: null,
      daysRemaining: DISPUTE_WINDOW_DAYS.autoCloseAfter,
      reason:
        "the recorded payment date is in the future, so the dispute window cannot be " +
        "trusted. Refusing rather than treating it as ancient.",
    };
  }

  const daysSincePayment = Math.floor(elapsedMs / DAY_MS);
  const daysRemaining = Math.max(0, DISPUTE_WINDOW_DAYS.autoCloseAfter - daysSincePayment);

  if (daysSincePayment >= DISPUTE_WINDOW_DAYS.autoCloseAfter) {
    // Says "closed", not "too soon". Both rules apply past day 20, and telling
    // a merchant to wait is advice that cannot possibly help.
    return {
      canEscalate: false,
      isClosed: true,
      daysSincePayment,
      daysRemaining: 0,
      reason:
        `the ${DISPUTE_WINDOW_DAYS.autoCloseAfter}-day dispute window closed ` +
        `${daysSincePayment} days after the payment. The claim can no longer be escalated.`,
    };
  }

  if (daysSincePayment < DISPUTE_WINDOW_DAYS.escalateFrom) {
    return {
      canEscalate: false,
      isClosed: false,
      daysSincePayment,
      daysRemaining,
      reason:
        `only ${daysSincePayment} of the ${DISPUTE_WINDOW_DAYS.escalateFrom} days needed ` +
        "have passed since the payment. Escalating now would be rejected.",
    };
  }

  return {
    canEscalate: true,
    isClosed: false,
    daysSincePayment,
    daysRemaining,
    reason:
      `${daysSincePayment} days since payment; ${daysRemaining} of the ` +
      `${DISPUTE_WINDOW_DAYS.autoCloseAfter}-day window remain.`,
  };
}