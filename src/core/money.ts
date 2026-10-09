/**
 * Money helpers — INR only (per AGENTS D3/D4, single currency).
 * All amounts in integer cents/paise to avoid float errors.
 */

import type { BillingCycle } from "./validators";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function formatINR(amountCents: number): string {
  const rupees = amountCents / 100;
  // en-IN with INR symbol, no fraction override — preserve paise
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/**
 * Compact INR — uses compact notation for large values (>=1L),
 * falls back to formatINR for small amounts. Preserves paise logic.
 * e.g. 12345600 -> ₹1.2L, 15000000 -> ₹1.5L / ₹15L
 */
export function formatINRCompact(amountCents: number): string {
  const rupees = amountCents / 100;
  if (Math.abs(rupees) >= 100_000) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      notation: "compact",
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(rupees);
  }
  return formatINR(amountCents);
}

// ---------------------------------------------------------------------------
// Normalization — monthly equivalent
// ---------------------------------------------------------------------------
export function toMonthlyCents(
  amountCents: number,
  billingCycle: BillingCycle,
): number {
  switch (billingCycle) {
    case "monthly":
      return amountCents;
    case "yearly":
      return Math.round(amountCents / 12);
    case "weekly":
      // 52 weeks / 12 months ≈ 4.333...
      return Math.round((amountCents * 52) / 12);
    default: {
      const _exhaustive: never = billingCycle;
      return _exhaustive;
    }
  }
}

export function toYearlyCents(
  amountCents: number,
  billingCycle: BillingCycle,
): number {
  switch (billingCycle) {
    case "monthly":
      return amountCents * 12;
    case "yearly":
      return amountCents;
    case "weekly":
      return amountCents * 52;
    default: {
      const _exhaustive: never = billingCycle;
      return _exhaustive;
    }
  }
}

/**
 * Yearly estimate across a list of subs — sums monthly-normalized then annualizes.
 * Keeps single source for dashboard hero.
 */
export function yearlyEstimate(
  subs: readonly { amountCents: number; billingCycle: BillingCycle }[],
): number {
  let monthly = 0;
  for (const s of subs) {
    monthly += toMonthlyCents(s.amountCents, s.billingCycle);
  }
  return monthly * 12;
}

/**
 * Monthly total across subs — sums monthly-normalized.
 */
export function monthlyTotal(
  subs: readonly { amountCents: number; billingCycle: BillingCycle }[],
): number {
  let total = 0;
  for (const s of subs) {
    total += toMonthlyCents(s.amountCents, s.billingCycle);
  }
  return total;
}



export function savingsEstimate(
  subs: readonly { amountCents: number; billingCycle: BillingCycle }[],
): number {
  return monthlyTotal(subs);
}

export function yearlySavingsFromMonthly(monthlyCents: number): number {
  return monthlyCents * 12;
}

export type YearlySavings = {
  readonly monthlyYearTotalCents: number;
  readonly yearlyCents: number;
  readonly savedCents: number;
  readonly percent: number;
};

export function yearlySavingsVsMonthly(
  monthlyCents: number,
  yearlyCents?: number,
): YearlySavings {
  const monthlyYearTotalCents = monthlyCents * 12;
  const yCents = yearlyCents ?? Math.round(monthlyYearTotalCents * 0.5);
  const savedCents = Math.max(0, monthlyYearTotalCents - yCents);
  const percent =
    monthlyYearTotalCents > 0
      ? Math.round((savedCents / monthlyYearTotalCents) * 100)
      : 0;
  return {
    monthlyYearTotalCents,
    yearlyCents: yCents,
    savedCents,
    percent,
  };
}

export type LifetimeSavings = {
  readonly threeYearCents: number;
  readonly savedCents: number;
};

export function lifetimeSavingsVsYearly(
  yearlyCents: number,
  lifetimeCents: number,
): LifetimeSavings {
  const threeYearCents = yearlyCents * 3;
  const savedCents = Math.max(0, threeYearCents - lifetimeCents);
  return { threeYearCents, savedCents };
}
