/**
 * Recurrence inference.
 *
 * This is the module ARCHITECTURE.md section 11a says the project actually
 * needs. The lifted detectors all key on a merchant name, and no PayPal API
 * gives anyone one; what PayPal *does* give is a stream of amounts and dates.
 * Recurrence is therefore something you infer, not something you read — and
 * since it has to be inferred identically from a merchant's Transaction Search
 * output and from a consumer's CSV export, it belongs in the pure core with no
 * idea which adapter it came from.
 *
 * Deliberately NOT here: a hardcoded list of PayPal T-codes. That list was
 * never verified (Spike S-2-live is open), and a guessed constant in the
 * ranking path is worse than no constant. Recurrence is derived from the
 * transaction series itself, which is checkable without a sandbox.
 */


export const CADENCES = ["weekly", "monthly", "yearly", "irregular"] as const;
export type Cadence = (typeof CADENCES)[number];

/** How much two amounts may differ and still count as "the same charge". */
const AMOUNT_TOLERANCE = 0.02;

const DAY_MS = 86_400_000;

export type Series = {
  readonly merchantKey: string;
  readonly currencyCode: string;
  /** Ascending by capturedAt. */
  readonly amounts: readonly number[];
  /** Ascending by capturedAt, ISO 8601. */
  readonly dates: readonly string[];
};

export type Recurrence = {
  readonly merchantKey: string;
  readonly currencyCode: string;
  readonly cadence: Cadence;
  /** Median gap between charges, in days. Null for fewer than two charges. */
  readonly medianGapDays: number | null;
  /** Median amount of a charge. */
  readonly medianAmountCents: number;
  /** True when every charge in the series is within AMOUNT_TOLERANCE of the median. */
  readonly amountIsStable: boolean;
  /** False until there are enough charges to be worth acting on. */
  readonly isRecurring: boolean;
  readonly chargeCount: number;
  /**
   * When the most recent charge landed, ISO 8601. Null when the series carries
   * no parseable date.
   *
   * Present because a renewal cannot be projected without an anchor.
   * `now + medianGapDays` is right only on the day the charge arrived; for the
   * rest of the cycle it is wrong by up to a full billing period — and
   * `checkUnused` only fires inside a seven-day window, so a merchant renewing
   * in five days got reported as renewing in thirty and the finding became
   * unreachable. The anchor is data, so it travels with the inference.
   */
  readonly lastChargeAt: string | null;
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

function gapsInDays(dates: readonly string[]): number[] {
  const times = dates
    .map((d) => Date.parse(d))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const previous = times[i - 1];
    const current = times[i];
    if (previous === undefined || current === undefined) continue;
    gaps.push((current - previous) / DAY_MS);
  }
  return gaps;
}

/**
 * Bucket a gap into a calendar cadence.
 *
 * The windows are deliberately generous, because billing months are 28-31 days
 * and "monthly" for a user means roughly four weeks. A ±35% window keeps a
 * 31-day month with a 28-day February gap on the same rung.
 */
export function cadenceForGap(days: number): Cadence {
  if (!Number.isFinite(days) || days <= 0) return "irregular";
  if (days >= 21 && days <= 45) return "monthly";
  if (days >= 5 && days <= 9) return "weekly";
  if (days >= 330 && days <= 400) return "yearly";
  return "irregular";
}

/** Enough charges before an inference is worth showing a user. */
export const MIN_CHARGES_FOR_RECURRENCE = 3;

export function analyse(series: Series): Recurrence {
  const gaps = gapsInDays(series.dates);
  const medianGapDays = gaps.length > 0 ? median(gaps) : null;
  const medianAmountCents = median(series.amounts);
  const chargeCount = series.amounts.length;

  /**
   * Re-parsed rather than taken as `series.dates.at(-1)`: `dates` is sorted as
   * ISO strings, and lexical order is not chronological order across offsets
   * ("2026-01-01T00:00:00+05:00" sorts before "2025-12-31T20:00:00Z", which is
   * the later instant). An unparseable date is dropped rather than anchored to.
   */
  const times = series.dates
    .map((d) => Date.parse(d))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const lastChargeMs = times[times.length - 1];
  const lastChargeAt = lastChargeMs === undefined ? null : new Date(lastChargeMs).toISOString();

  const amountIsStable =
    series.amounts.length > 0 &&
    series.amounts.every(
      (a) =>
        medianAmountCents === 0
          ? a === 0
          : Math.abs(a - medianAmountCents) / medianAmountCents <= AMOUNT_TOLERANCE,
    );

  // Recurring means *both* a repeating interval and a repeating amount. Three
  // equal monthly charges is a subscription; three random charges is noise.
  const cadence = medianGapDays === null ? "irregular" : cadenceForGap(medianGapDays);
  const isRecurring =
    chargeCount >= MIN_CHARGES_FOR_RECURRENCE &&
    amountIsStable &&
    (cadence === "monthly" || cadence === "weekly" || cadence === "yearly");

  return {
    merchantKey: series.merchantKey,
    currencyCode: series.currencyCode,
    cadence,
    medianGapDays,
    medianAmountCents,
    amountIsStable,
    isRecurring,
    chargeCount,
    lastChargeAt,
  };
}

/**
 * Group a flat transaction stream by merchant and analyse each group.
 *
 * `amountCents` and `capturedAt` come straight off `RawTransaction`; the
 * grouping key is `merchantKey`, which the adapter resolved (see
 * AccountSource). Transactions with `identitySource: "unknown"` are dropped
 * rather than lumped into one meaningless series.
 */
export function inferRecurrence(
  transactions: readonly {
    readonly merchantKey: string;
    readonly identitySource: string;
    readonly amountCents: number;
    readonly currencyCode: string;
    readonly capturedAt: string;
  }[],
): Recurrence[] {
  const groups = new Map<string, Series>();

  for (const t of transactions) {
    if (t.identitySource === "unknown") continue;
    const existing = groups.get(t.merchantKey);
    if (existing === undefined) {
      groups.set(t.merchantKey, {
        merchantKey: t.merchantKey,
        currencyCode: t.currencyCode,
        amounts: [t.amountCents],
        dates: [t.capturedAt],
      });
      continue;
    }
    if (existing.currencyCode !== t.currencyCode) continue;
    groups.set(t.merchantKey, {
      ...existing,
      amounts: [...existing.amounts, t.amountCents],
      dates: [...existing.dates, t.capturedAt],
    });
  }

  const out: Recurrence[] = [];
  for (const series of groups.values()) {
    out.push(
      analyse({
        ...series,
        amounts: [...series.amounts].sort(),
        dates: [...series.dates].sort(),
      }),
    );
  }

  // Strongest signal first: recurring before irregular, then bigger spend first,
  // then a stable key so the ordering never depends on Map insertion order.
  return out.sort(
    (a, b) =>
      Number(b.isRecurring) - Number(a.isRecurring) ||
      b.medianAmountCents - a.medianAmountCents ||
      a.merchantKey.localeCompare(b.merchantKey),
  );
}