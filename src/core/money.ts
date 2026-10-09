/**
 * Money helpers — integer minor units, never floats.
 *
 * Parameterised by currency. nixt's version was INR-only with hardcoded en-IN
 * formatters; the PayPal sandbox spendless talks to is USD, so `formatMoney`
 * takes the currency and picks the locale from it. The normalisation maths
 * below is currency-free and lifted unchanged.
 */

import { DEFAULT_CURRENCY, type BillingCycle, type Currency } from "./validators";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** en-IN groups by lakh (1,23,456); en-US by thousands (123,456). */
const CURRENCY_LOCALE: Record<Currency, string> = {
  USD: "en-US",
  INR: "en-IN",
};

/**
 * Compact-notation threshold, in major units. en-US switches to K/M/B far
 * earlier than en-IN switches to L/Cr, so one hardcoded threshold cannot
 * serve both - which is the entire reason this function is parameterised.
 */
const COMPACT_THRESHOLD: Record<Currency, number> = {
  USD: 10_000,
  INR: 100_000,
};

export function formatMoney(
  amountCents: number,
  currency: Currency = DEFAULT_CURRENCY,
): string {
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}

/**
 * Compact money — compact notation above the currency's own threshold,
 * plain format below it so small figures stay exact.
 * e.g. INR 12345600 -> ₹1.2L, USD 1250000 -> $12.5K
 */
export function formatMoneyCompact(
  amountCents: number,
  currency: Currency = DEFAULT_CURRENCY,
): string {
  const major = amountCents / 100;
  if (Math.abs(major) >= COMPACT_THRESHOLD[currency]) {
    return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
      style: "currency",
      currency,
      notation: "compact",
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(major);
  }
  return formatMoney(amountCents, currency);
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
