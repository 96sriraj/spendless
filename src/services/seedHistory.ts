/**
 * The seeded-history lane. `AGENTS.md` / D5, middle lane.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, STATED AS EVIDENCE RATHER THAN PREFERENCE
 * ---------------------------------------------------------------------------
 *
 * `recurrence.ts` needs a **date gap**:
 *
 *     if (!Number.isFinite(days) || days <= 0) return "irregular";
 *
 * Every sandbox transaction is stamped at the moment of capture and PayPal
 * offers no way to backdate one. Three charges in the same minute produce gaps
 * of `[0, 0]` → `irregular` → `isRecurring: false`. **No amount of seeding makes
 * recurrence fire on live merchant data.** That is not a limitation of this
 * module; it is a property of the sandbox, and it is why the figure on the
 * first screen cannot come from the live lane alone.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND THE RULE THAT GOVERNS IT
 * ---------------------------------------------------------------------------
 *
 * These rows are **ours**, and they are **history**. They are not payments. A
 * merchant's real account looks like this only after months of running, which
 * is exactly what a sandbox cannot show you.
 *
 * So this module writes rows that are *labelled as ours* — every `custom_id`
 * carries the `spendless:` marker, which is the same marker and the same
 * provenance a real seeded payment carries — and the UI is required to say which
 * lane a figure came from. That requirement is not optional. The one thing this
 * project will not do is present invented data as observed data, and a
 * recurring subscription that the detector found *here* must never be rendered
 * as though PayPal reported it.
 *
 * This is a deliberate departure from `todo.md` P4-01's "real API calls, not
 * hand-inserted rows", which was written before anyone knew PayPal cannot
 * backdate. The departure is recorded rather than absorbed quietly.
 */

import type { Database } from "@/db";
import { clearTransactions, insertTransaction } from "@/db/transactions";
import { seedMarker } from "@/adapters/seedMarker";
import type { Currency } from "@/core/validators";

/**
 * Provenance stamped on every row this module writes.
 *
 * Not inferred from the `spendless:` marker: a live sandbox capture carries that
 * marker too, so it would label real payments as history. This is the declared
 * lane, and the UI reads it to say which of D5's three lanes a figure came from.
 */
export const HISTORY_LANE = "seeded_history" as const;

export type HistorySubscription = {
  readonly key: string;
  readonly amountCents: number;
  /** Gap between charges, in days. */
  readonly gapDays: number;
  /** How many charges to write, oldest first. */
  readonly charges: number;
  /**
   * How long ago the most recent charge landed.
   *
   * This is the knob that decides whether the detectors have anything to say.
   * `checkUnused` only fires for a subscription renewing within seven days
   * (`RENEWAL_WINDOW_MS`), so a subscription whose last charge landed *today* is
   * a month away from being actionable. A merchant is usually a few days before
   * a renewal, not on the day — which is exactly when the nudge is worth acting
   * on.
   */
  readonly lastChargeDaysAgo?: number;
};

/**
 * The scenario.
 *
 * Shaped to make the detectors *discriminate* rather than flag everything:
 *
 * - `sub-netflix` is idle and **renewing in five days** — the finding this
 *   product exists to produce, and the hero figure on the first screen.
 * - `sub-adobe` renews far out and its amount rises, so the price-hike detector
 *   has something the recurrence detector must not also claim.
 * - `sub-figma` is healthy: recurring, current, never flagged.
 */
export const SCENARIO: readonly HistorySubscription[] = [
  { key: "sub-netflix", amountCents: 1_599, gapDays: 30, charges: 8, lastChargeDaysAgo: 25 },
  { key: "sub-adobe", amountCents: 5_499, gapDays: 30, charges: 8 },
  { key: "sub-figma", amountCents: 1_500, gapDays: 30, charges: 7 },
];

/**
 * Adobe's last three charges rise. `inferRecurrence` refuses a series whose
 * amount moves — it is a price hike, and letting both detectors claim the same
 * subscription would double-count it.
 */
const PRICE_HIKE_KEY = "sub-adobe";
const PRICE_HIKE_FROM_CENTS = 4_999;
const PRICE_HIKE_ON_LAST = 3;

const DAY_MS = 86_400_000;

/**
 * @param now fixed clock, so the seeded scenario is reproducible on any day.
 *   A history that moves with the wall clock makes the demo's figures different
 *   every run, which is the opposite of what a recorded video needs.
 */
export async function seedHistory(
  db: Database,
  options: { readonly now: Date; readonly currency?: Currency },
): Promise<{ readonly rows: number }> {
  const currency = options.currency ?? "USD";
  let rows = 0;

  for (const sub of SCENARIO) {
    const lead = sub.lastChargeDaysAgo ?? 0;

    for (let i = 0; i < sub.charges; i += 1) {
      // Oldest first, so `i === 0` is the earliest charge. Counting forward
      // from the oldest is what makes the gap exact rather than approximate.
      const daysAgo = lead + (sub.charges - 1 - i) * sub.gapDays;

      const rising =
        sub.key === PRICE_HIKE_KEY && sub.charges - i <= PRICE_HIKE_ON_LAST;
      const amountCents = rising ? PRICE_HIKE_FROM_CENTS : sub.amountCents;

      await insertTransaction(db, {
        // Stable and derived from the charge's own position, so re-running with
        // a different `now` does not collide with rows from a previous seed.
        id: `${sub.key}-${i}`,
        merchantName: sub.key,
        amountCents,
        currency,
        capturedAt: new Date(options.now.getTime() - daysAgo * DAY_MS).toISOString(),
        customId: seedMarker(sub.key),
        lane: HISTORY_LANE,
      });
      rows += 1;
    }
  }

  return { rows };
}

/** Replace whatever is there. Used by the demo's "reset the scenario" control. */
export async function reseedHistory(
  db: Database,
  options: { readonly now: Date; readonly currency?: Currency },
): Promise<{ readonly rows: number }> {
  await clearTransactions(db);
  return seedHistory(db, options);
}