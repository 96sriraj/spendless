/**
 * Annual-vs-monthly switch hint (F4/S17) — pure.
 * When a MONTHLY subscription records an `annualAmountCents` (the price the
 * merchant charges for a year), surface the yearly saving of switching:
 *   yearlySaving = monthly × 12 − annual   (only when positive).
 *
 * Returns null when: no annual price, the sub isn't monthly, or switching
 * wouldn't save. The recommendation carries a monthly-equivalent `savingCents`
 * so the shared ActionCard's "/mo" label stays truthful; the yearly figure is
 * in the subtitle.
 */

import { formatINR, toMonthlyCents } from "./money";
import type { Subscription } from "./validators";

export type AnnualSwitchFlag = {
  readonly kind: "annualSwitch";
  readonly subId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly savingCents: number;
  readonly displaySaving: string;
  readonly yearlySavingCents: number;
  readonly cta: string;
  readonly confidence: number;
};

export function annualSwitchFlag(sub: Subscription): AnnualSwitchFlag | null {
  if (sub.billingCycle !== "monthly") return null;
  const annual = sub.annualAmountCents;
  if (annual === null || annual === undefined || annual <= 0) return null;

  const monthlyYearTotal = sub.amountCents * 12;
  const yearlySavingCents = monthlyYearTotal - annual;
  if (yearlySavingCents <= 0) return null;

  const monthlyEquivalent = toMonthlyCents(yearlySavingCents, "yearly");
  const percent = Math.round((yearlySavingCents / monthlyYearTotal) * 100);

  return {
    kind: "annualSwitch",
    subId: sub.id,
    title: `${sub.name}: switch to annual, save ${formatINR(yearlySavingCents)}/yr`,
    subtitle: `Annual ${formatINR(annual)} vs ${formatINR(monthlyYearTotal)}/yr monthly · ${percent}% off`,
    // Rank on the monthly-equivalent (comparable axis) but display the yearly
    // saving, which is the figure that actually sells the switch.
    savingCents: monthlyEquivalent,
    displaySaving: `Save ${formatINR(yearlySavingCents)}/yr`,
    yearlySavingCents,
    cta: "Switch",
    confidence: 1,
  };
}

export function annualSwitchFlags(
  subs: readonly Subscription[],
): AnnualSwitchFlag[] {
  const out: AnnualSwitchFlag[] = [];
  for (const sub of subs) {
    const flag = annualSwitchFlag(sub);
    if (flag !== null) out.push(flag);
  }
  return out;
}
