/**
 * Cancel intent — durable "intent to cancel" tracking and savings accrual.
 *
 * Lifted from nixt. Three changes:
 *
 *  - `kvGet`/`kvSet` from `durableNotepad` become an injected `KVStore`.
 *  - It dynamically imported `../services/notifications` and fired a OneSignal
 *    push on a milestone. OneSignal is an explicit non-goal, and a dynamic
 *    import hidden in a try/catch was nixt's way of making an impure edge
 *    invisible. The crossed milestone is now *returned*; whoever is driving
 *    the run decides what to do about it. Nothing is pushed from the core.
 *  - The milestone lookup takes the subscription's currency, because the
 *    ladder is per currency (see savingsLedger).
 */

import type { KVStore } from "@/db/kvStore";
import { toMonthlyCents } from "./money";
import { crossedMilestone, recordSaving } from "./savingsLedger";
import type { Subscription } from "./validators";

export function intentKey(id: string): string {
  return `cancellation_intent_${id}`;
}

const SAVED_ESTIMATE_KEY = "saved_estimate_cents";

/** Whether a cancel intent has already been recorded for this subscription. */
export async function hasCancelIntent(store: KVStore, id: string): Promise<boolean> {
  return (await store.kvGet(intentKey(id))) !== null;
}

async function readSavedEstimateCents(store: KVStore): Promise<number> {
  const raw = await store.kvGet(SAVED_ESTIMATE_KEY);
  if (raw === null) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export type RecordIntentResult = {
  readonly monthlyCents: number;
  readonly prevTotalCents: number;
  readonly nextTotalCents: number;
  /**
   * The savings rung this action crossed, in that currency's minor units, or
   * null. Reported, not acted on: the deterministic core does not push
   * notifications or reach for a network.
   */
  readonly crossedMilestoneCents: number | null;
};

/**
 * Record a cancel intent: persist the intent marker, add the
 * monthly-normalized amount to the durable saved estimate, append to the
 * savings ledger, and report any milestone crossed. Idempotent per
 * subscription — a second call for an already-intended sub is a no-op and
 * returns the current totals.
 */
export async function recordCancelIntent(
  store: KVStore,
  sub: Subscription,
): Promise<RecordIntentResult> {
  const monthly = toMonthlyCents(sub.amountCents, sub.billingCycle);
  const prevTotal = await readSavedEstimateCents(store);

  if (await hasCancelIntent(store, sub.id)) {
    return {
      monthlyCents: monthly,
      prevTotalCents: prevTotal,
      nextTotalCents: prevTotal,
      crossedMilestoneCents: null,
    };
  }

  const nextTotal = prevTotal + monthly;
  await store.kvSet(intentKey(sub.id), JSON.stringify({ at: new Date().toISOString(), name: sub.name }));
  await store.kvSet(SAVED_ESTIMATE_KEY, JSON.stringify(nextTotal));
  await recordSaving(store, {
    subId: sub.id,
    kind: "cancel",
    amountDeltaCents: monthly,
    confirmedAt: new Date().toISOString(),
  });

  return {
    monthlyCents: monthly,
    prevTotalCents: prevTotal,
    nextTotalCents: nextTotal,
    crossedMilestoneCents: crossedMilestone(prevTotal, nextTotal, sub.currency),
  };
}