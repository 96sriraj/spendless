/**
 * Spending calendar (F7/S20) — pure grouping of subscription renewals by day
 * of month. Used by SpendingCalendar to render renewal dots per day.
 *
 * All date math is in UTC (matches the ISO nextRenewal storage) so a sub never
 * drifts to an adjacent day due to local timezone.
 */

import type { Subscription } from "./validators";

export type CalendarMonth = {
  /** Full year, e.g. 2026. */
  readonly year: number;
  /** 0-based month index (0 = January), matching Date UTC month. */
  readonly month: number;
};

export function monthOf(date: Date): CalendarMonth {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

/** Number of days in the given month (UTC). */
export function daysInMonth(m: CalendarMonth): number {
  // Day 0 of the next month = last day of this month.
  return new Date(Date.UTC(m.year, m.month + 1, 0)).getUTCDate();
}

/** UTC weekday (0 = Sunday) of the 1st of the month. */
export function firstWeekdayOfMonth(m: CalendarMonth): number {
  return new Date(Date.UTC(m.year, m.month, 1)).getUTCDay();
}

/**
 * Group subscriptions whose nextRenewal falls within `month` by day-of-month
 * (1-based). Subs renewing in other months, or with an unparseable date, are
 * omitted. Returns a Map keyed by day number.
 */
export function renewalsByDay(
  subs: readonly Subscription[],
  month: CalendarMonth,
): Map<number, Subscription[]> {
  const byDay = new Map<number, Subscription[]>();
  for (const sub of subs) {
    const ms = Date.parse(sub.nextRenewal);
    if (Number.isNaN(ms)) continue;
    const d = new Date(ms);
    if (d.getUTCFullYear() !== month.year || d.getUTCMonth() !== month.month) continue;
    const day = d.getUTCDate();
    const existing = byDay.get(day);
    if (existing === undefined) {
      byDay.set(day, [sub]);
    } else {
      existing.push(sub);
    }
  }
  return byDay;
}
