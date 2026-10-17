import { describe, expect, it } from "vitest";
import { evaluateDisputeWindow, DISPUTE_WINDOW_DAYS } from "./disputeWindow";

/**
 * The dispute deadlines. P6-06.
 *
 * `AGENTS.md` encodes two: escalation requires **7 days** since payment, and a
 * dispute auto-closes at **20 days**. Both exist because PayPal will not accept
 * an action outside the window, and an agent that discovers this by getting a
 * 422 on the recording day has failed the demo at its worst moment.
 *
 * So the windows are pure functions with an injected clock, and the properties
 * worth testing are the boundaries rather than the middle:
 *
 * - **Exactly 7 days must escalate.** Off-by-one here either rejects an action
 *   PayPal would have accepted, or accepts one it will refuse.
 * - **Exactly 20 days must be closed.** The 20-day mark is the last day, or the
 *   first day past it, and the difference is a dispute lost.
 * - **A future payment date must not produce a huge negative age** that reads as
 *   "very old, eligible". A clock skew of one second must not be the reason a
 *   merchant loses a dispute.
 *
 * The dispute lane is cut from the demo (S-0-04: the tools are the buyer's
 * namespace), so none of this can reach PayPal today. It is written anyway
 * because the windows are a property of the *product*, not of the adapter, and
 * re-deriving them from documentation later is how they get wrong.
 */

const DAY = 86_400_000;
const PAID_AT = new Date("2026-10-01T00:00:00.000Z");

function daysAfterPaid(n: number): Date {
  return new Date(PAID_AT.getTime() + n * DAY);
}

describe("evaluateDisputeWindow", () => {
  it("refuses to escalate a dispute opened before seven days", () => {
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(6) });
    expect(verdict.canEscalate).toBe(false);
    expect(verdict.reason).toMatch(/7/);
  });

  it("allows escalation on exactly the seventh day", () => {
    // The boundary. Rejecting here refuses an action PayPal accepts; allowing
    // here accepts one it does not. There is no version of this that is safe by
    // being approximately right.
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(7) });
    expect(verdict.canEscalate).toBe(true);
    expect(verdict.daysSincePayment).toBe(7);
  });

  it("closes a dispute on exactly the twentieth day", () => {
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(20) });
    expect(verdict.isClosed).toBe(true);
    expect(verdict.canEscalate).toBe(false);
  });

  it("allows escalation inside the window but before it closes", () => {
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(12) });
    expect(verdict.isClosed).toBe(false);
    expect(verdict.canEscalate).toBe(true);
  });

  it("reports how long is left, because the UI has to show a deadline", () => {
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(12) });
    expect(verdict.daysRemaining).toBe(8);
  });

  it("reports no time remaining once closed, never a negative count", () => {
    // A negative "days remaining" renders as "-4 days left", which reads like a
    // bug in the product rather than a dispute that has lapsed.
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(25) });
    expect(verdict.daysRemaining).toBe(0);
    expect(verdict.daysSincePayment).toBe(25);
  });

  it("refuses a payment dated in the future rather than reading it as ancient", () => {
    // Clock skew, or a bad import. A negative age compared against the 7-day
    // floor would read as "very old, definitely eligible", which is the one
    // direction of error that loses a dispute.
    const verdict = evaluateDisputeWindow({
      paidAt: PAID_AT,
      now: new Date(PAID_AT.getTime() - 5_000),
    });
    expect(verdict.canEscalate).toBe(false);
    expect(verdict.reason).toMatch(/future|payment date/i);
  });

  it("reports a closed dispute's reason as the deadline, not the seven-day floor", () => {
    // Both rules apply at once past day 20. Saying "too soon" would be plainly
    // wrong to whoever reads it, and the fix — waiting — would not help.
    const verdict = evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(30) });
    expect(verdict.reason).toMatch(/20|closed|expired/i);
  });

  it("treats a missing payment date as ineligible, not as eligible", () => {
    const verdict = evaluateDisputeWindow({ paidAt: null, now: PAID_AT });
    expect(verdict.canEscalate).toBe(false);
    expect(verdict.daysSincePayment).toBeNull();
  });

  it("exposes the window it used, so the UI does not hard-code 20", () => {
    expect(DISPUTE_WINDOW_DAYS.escalateFrom).toBe(7);
    expect(DISPUTE_WINDOW_DAYS.autoCloseAfter).toBe(20);
  });

  it("agrees with itself about the whole boundary, day by day", () => {
    // A table rather than three examples. The boundaries are the specification,
    // and a sweep is the only way to be sure no day in between behaves oddly.
    const eligible: number[] = [];
    for (let day = 0; day <= 22; day += 1) {
      if (evaluateDisputeWindow({ paidAt: PAID_AT, now: daysAfterPaid(day) }).canEscalate) {
        eligible.push(day);
      }
    }
    expect(eligible).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
});