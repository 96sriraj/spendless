/**
 * How stale is Transaction Search, right now?
 *
 * `/v1/reporting/transactions` is served from a cache. PayPal's docs say a
 * maximum of three hours; developers report far worse in practice, and the
 * response says how bad it actually is via `last_refreshed_datetime`.
 *
 * That field is what makes the S-2-live question answerable on a schedule
 * instead of by superstition. The seed captures a payment and then immediately
 * asks whether the merchant-authored identity survived the round trip. Without a
 * freshness reading, "still not seeded" and "will never be seeded" look
 * identical, and the only way to tell them apart is to sleep and hope.
 *
 * `nowMs` is injected rather than read from the clock so the staleness
 * formatting is testable without waiting three hours — see the timing rule in
 * AGENTS.md.
 */

export type ReportingFreshness = {
  /** PayPal's own timestamp, verbatim. `null` when the field was absent. */
  readonly lastRefreshed: string | null;
  /** How far behind "now" that is. `null` when it cannot be measured. */
  readonly ageMs: number | null;
};

export function readReportingFreshness(body: unknown, nowMs: number): ReportingFreshness {
  const raw = (body as { last_refreshed_datetime?: unknown } | null)?.last_refreshed_datetime;
  const lastRefreshed = typeof raw === "string" ? raw : null;
  if (lastRefreshed === null) return { lastRefreshed: null, ageMs: null };

  // Guard rather than trust: `Date.parse` returns NaN for junk, NaN propagates
  // silently, and "NaN hours stale" at the print site is worse than no number.
  const parsed = Date.parse(lastRefreshed);
  if (Number.isNaN(parsed)) return { lastRefreshed, ageMs: null };

  return { lastRefreshed, ageMs: nowMs - parsed };
}

/** `3h 30m` — hours and minutes only, because nobody acts on seconds here. */
function formatAge(ageMs: number): string {
  const totalMinutes = Math.round(Math.abs(ageMs) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function describeFreshness(fresh: ReportingFreshness): string {
  if (fresh.lastRefreshed === null) {
    return "no freshness reported by PayPal — cannot say how current this data is";
  }
  if (fresh.ageMs === null) {
    return `last_refreshed_datetime = ${fresh.lastRefreshed} (unparseable, so staleness unknown)`;
  }

  // Clock skew between this machine and PayPal is real. A negative age would
  // render as "-0h 5m" and read as a bug in our reporting rather than in the
  // clocks, so it is clamped and called out.
  if (fresh.ageMs < 0) {
    return `last_refreshed_datetime = ${fresh.lastRefreshed} (ahead of our clock — skew, not a lag)`;
  }

  return (
    `last_refreshed_datetime = ${fresh.lastRefreshed} (${formatAge(fresh.ageMs)} of lag)\n` +
    `  Transaction Search is this far behind. A payment captured more recently\n` +
    `  than that cannot appear here yet, so "not seeded" means "too fresh", not\n` +
    `  "broken". Re-read after the lag passes rather than re-seeding.`
  );
}
