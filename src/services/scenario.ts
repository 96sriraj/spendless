/**
 * The one-click scenario.
 *
 * ---------------------------------------------------------------------------
 * WHY USAGE EVENTS ARE PART OF THE SEED AND NOT AN ACCIDENT
 * ---------------------------------------------------------------------------
 *
 * `buildSubscriptions` always writes `lastUsedDate: null`, and that is correct:
 * `ARCHITECTURE.md` §8 is explicit that transaction history contains no usage
 * signal, so the agent is supposed to *ask* the merchant. That is the designed
 * path and it is untouched.
 *
 * But it has a consequence for a demo: with no usage recorded, `checkUnused`
 * finds nothing, the figure is zero, and the screen shows a number with no
 * explanation. On stage that is indistinguishable from the product being broken.
 *
 * So the seed writes the usage events too — and writes them as part of the
 * *scenario*, which is what they are. A merchant who has not used a subscription
 * for three months is the situation the product exists for, and a demo that
 * cannot demonstrate its own core finding is not a demo.
 *
 * This is not a shortcut around §8. §8 says the *product* must not invent usage
 * data; it says nothing about a fixture that declares its own scenario and is
 * labelled `seeded_history` on every row it produces.
 */

import type { Database } from "@/db";
import { createD1KvStore } from "@/db/kvStore";
import { recordUsage } from "@/core/unusedDetector";
import { reseedHistory } from "@/services/seedHistory";
import { buildReadModel } from "@/services/readModel";

const DAY_MS = 86_400_000;

/**
 * How long ago each seeded subscription was last used.
 *
 * Shaped so the scenario discriminates rather than flagging everything:
 *
 * - `sub-netflix` is idle and renewing soon — the headline finding.
 * - `sub-figma` was used recently — healthy, and must never be flagged.
 * - `sub-adobe` has no recorded usage, because its series has a price rise and
 *   `inferRecurrence` correctly refuses to call that a subscription.
 */
const IDLE_DAYS: Record<string, number> = {
  "sub-netflix": 91,
  "sub-figma": 2,
};

export type SeedResult = {
  readonly transactions: number;
  readonly usage: number;
  readonly totalRiskCents: number;
};

export async function seedScenario(
  db: Database,
  now: Date,
): Promise<SeedResult & { readonly model: Awaited<ReturnType<typeof buildReadModel>> }> {
  // Replace rather than accumulate. A demo that is seeded twice must show the
  // same figure both times, or nobody can rehearse against it.
  const { rows } = await reseedHistory(db, { now });

  const store = createD1KvStore(db, () => now.toISOString());
  let usage = 0;
  for (const [subscriptionId, daysAgo] of Object.entries(IDLE_DAYS)) {
    await recordUsage(store, subscriptionId, new Date(now.getTime() - daysAgo * DAY_MS).toISOString());
    usage += 1;
  }

  const model = await buildReadModel(db, now);

  return {
    transactions: rows,
    usage,
    totalRiskCents: model.totalRiskCents,
    model,
  };
}