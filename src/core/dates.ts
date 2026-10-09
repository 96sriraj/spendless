/**
 * Date helpers — renewal math for scheduler + dashboard.
 * All dates are ISO 8601 strings (UTC).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
export function daysUntilRenewal(iso: string, nowMs?: number): number {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return Number.NaN;
  }
  const now = nowMs ?? Date.now();
  const diff = target - now;
  // Ceiling so "in 2.1 days" => 3 days until
  return Math.ceil(diff / MS_PER_DAY);
}

export function isRenewalSoon(
  iso: string,
  days = 3,
  nowMs?: number,
): boolean {
  const remaining = daysUntilRenewal(iso, nowMs);
  if (Number.isNaN(remaining)) {
    return false;
  }
  return remaining >= 0 && remaining <= days;
}

export function formatDisplayDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/**
 * Offsets for the renewal scheduler — 3d, 1d, 1h before renewal.
 * Returns ISO strings; filters out past offsets (already expired).
 *
 * `nowMs` is injected like every other time-dependent helper here. Nixt's
 * version read `Date.now()` directly, which forced its tests into
 * `vi.useFakeTimers()` — and the architecture gate forbids that in `src/core`.
 * (The OneSignal scheduler it was written for is an explicit non-goal; the
 * offsets themselves are what spendless's run log is built on.)
 */
export function renewalOffsets(iso: string, nowMs?: number): readonly string[] {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return [];
  }
  const offsetsMs = [
    3 * MS_PER_DAY,
    1 * MS_PER_DAY,
    1 * 60 * 60 * 1000,
  ] as const;
  const out: string[] = [];
  const now = nowMs ?? Date.now();
  for (const off of offsetsMs) {
    const at = target - off;
    if (at > now) {
      out.push(new Date(at).toISOString());
    }
  }
  return out;
}

export function isValidIsoDateString(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/**
 * Free-trial watchdog offset (F1) — ISO instant 2 days before the trial
 * converts to paid, so the user can cancel first. Returns null when the
 * trial-end is invalid or the 2-days-before instant is already in the past.
 */
export function trialWatchOffset(
  trialEndIso: string,
  nowMs?: number,
): string | null {
  const end = Date.parse(trialEndIso);
  if (Number.isNaN(end)) {
    return null;
  }
  const at = end - 2 * MS_PER_DAY;
  const now = nowMs ?? Date.now();
  if (at <= now) {
    return null;
  }
  return new Date(at).toISOString();
}
