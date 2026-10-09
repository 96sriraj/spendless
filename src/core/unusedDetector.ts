/**
 * Unused-subscription detection — flags idles + soon-renewing subs.
 *
 * Lifted from nixt. Two changes:
 *
 *  - It imported `kvGet`/`kvSet` from `durableNotepad`; it now takes a
 *    `KVStore`. That is what makes the detector graph pure and testable
 *    without a database.
 *  - `UnusedFlag.confidence` was the literal `"possibly"` where every sibling
 *    detector used a number. It is now `CONFIDENCE.unconfirmedUsage` - the
 *    same honest weakness, encoded on the shared scale (see confidence.ts).
 */

import type { KVStore } from "@/db/kvStore";
import { CONFIDENCE, type Confidence } from "./confidence";
import { formatMoney, toMonthlyCents } from "./money";
import type { Currency, Subscription } from "./validators";

const USAGE_PREFIX = "usage:";
export const IDLE_DAYS = 30;
export const RENEWAL_WINDOW_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export type UnusedFlag = {
  readonly kind: "unused";
  readonly subId: string;
  readonly title: string;
  readonly subtitle: string;
  /**
   * Ranking axis: the forward monthly saving, comparable across every
   * detector kind. NOT necessarily the headline - see displaySaving.
   */
  readonly savingCents: number;
  /**
   * What the card renders. Allowed to differ from savingCents, on purpose;
   * see ARCHITECTURE.md section 5, invariant 2. Do not collapse these.
   */
  readonly displaySaving?: string;
  readonly cta: string;
  readonly confidence: Confidence;
};

export async function recordUsage(
  store: KVStore,
  subId: string,
  lastUsedAt: string,
): Promise<void> {
  await store.kvSet(`${USAGE_PREFIX}${subId}`, lastUsedAt);
}

function money(cents: number, currency: Currency): string {
  return formatMoney(cents, currency);
}

/**
 * Cost-per-use nudge — pure. Uses the subscription's manual `lastUsedDate` to
 * surface wasted spend: monthly cost × whole months unused. Returns null when
 * there is no lastUsedDate, or the sub was used within the idle threshold.
 * No telemetry, no inference — a field the user supplied.
 */
export function costPerUseFlag(
  sub: Subscription,
  now?: Date,
  idleDays = IDLE_DAYS,
): UnusedFlag | null {
  const lastUsed = sub.lastUsedDate;
  if (lastUsed === null || lastUsed === undefined) return null;
  const lastUsedMs = Date.parse(lastUsed);
  if (Number.isNaN(lastUsedMs)) return null;
  const nowMs = (now ?? new Date()).getTime();
  const daysSince = Math.floor((nowMs - lastUsedMs) / DAY_MS);
  if (daysSince <= idleDays) return null;

  const monthly = toMonthlyCents(sub.amountCents, sub.billingCycle);
  // Approx 30-day months. Slightly overstates over long spans versus calendar
  // months; acceptable for a "roughly N months unused" nudge.
  const monthsUnused = Math.max(1, Math.floor(daysSince / 30));
  const wastedCents = monthly * monthsUnused;

  return {
    kind: "unused",
    subId: sub.id,
    title: `${sub.name} — ${money(wastedCents, sub.currency)} wasted`,
    subtitle:
      `Last used ${daysSince} days ago · ~${money(monthly, sub.currency)}/mo` +
      ` × ${monthsUnused} mo unused`,
    // Rank on the forward monthly saving (comparable across kinds); show the
    // cumulative sunk cost as the headline so it reads truthfully.
    savingCents: monthly,
    displaySaving: `${money(wastedCents, sub.currency)} wasted`,
    cta: "Consider cancel",
    confidence: CONFIDENCE.unconfirmedUsage,
  };
}

export function costPerUseFlags(
  subs: readonly Subscription[],
  now?: Date,
): UnusedFlag[] {
  const out: UnusedFlag[] = [];
  for (const sub of subs) {
    const flag = costPerUseFlag(sub, now);
    if (flag !== null) out.push(flag);
  }
  return out;
}

export async function checkUnused(
  store: KVStore,
  subs: readonly Subscription[],
  now?: Date,
): Promise<UnusedFlag[]> {
  const nowIso = now ?? new Date();
  const nowMs = nowIso.getTime();
  const flags: UnusedFlag[] = [];

  for (const sub of subs) {
    const value = await store.kvGet(`${USAGE_PREFIX}${sub.id}`);
    if (value === null) continue;
    const lastUsedAt = Date.parse(value);
    if (Number.isNaN(lastUsedAt)) continue;
    if (Math.floor((nowMs - lastUsedAt) / DAY_MS) <= IDLE_DAYS) continue;

    const renewalIn = Date.parse(sub.nextRenewal) - nowMs;
    if (Number.isNaN(renewalIn) || renewalIn < 0 || renewalIn > RENEWAL_WINDOW_MS) continue;

    const savingCents = toMonthlyCents(sub.amountCents, sub.billingCycle);
    flags.push({
      kind: "unused",
      subId: sub.id,
      title: `${sub.name} looks unused`,
      subtitle:
        `Looks like you may not be using this — cancel to save` +
        ` ${money(savingCents, sub.currency)}/mo`,
      savingCents,
      cta: "Consider cancel",
      confidence: CONFIDENCE.unconfirmedUsage,
    });
  }

  return flags;
}