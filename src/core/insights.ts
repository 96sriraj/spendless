/**
 * Insights — merges duplicate / price-hike / unused / annual-switch signals
 * into ranked, subId-deduped recommendations.
 *
 * Lifted from nixt. The dependency on `durableNotepad` is gone: every
 * detector that touches storage now takes the `KVStore` this function is
 * handed, which is what makes the whole graph pure.
 *
 * ---------------------------------------------------------------------------
 * TWO INVARIANTS. Both are load-bearing, both are covered by regression tests
 * in insights.test.ts that fail if either is broken. Do not "simplify" them
 * away - if a change makes one of those tests red, the change is wrong.
 * ---------------------------------------------------------------------------
 *
 * 1. ORDER DEPENDENCE. `upsert` replaces an existing recommendation only when
 *    the incoming `savingCents` is STRICTLY greater. `costPerUseFlags` and
 *    `checkUnused` both report `savingCents = monthly` for the same
 *    subscription, so they tie and the SECOND one to run loses. `costPerUse`
 *    carries the richer "you have wasted $X" headline, so it MUST run before
 *    `checkUnused`. Swap those two loops and the demo quietly starts showing
 *    the weaker copy for every idle subscription.
 *
 * 2. `savingCents` IS NOT `displaySaving`. `savingCents` is the ranking axis:
 *    a forward-looking MONTHLY figure, comparable across all four detector
 *    kinds, used for dedupe and sort. `displaySaving` is only what the card
 *    renders - often a cumulative figure ("$47.97 wasted") that is NOT
 *    comparable to a monthly number. They are allowed to differ, and that
 *    difference is what lets one contract serve both a UI and an agent. DO
 *    NOT COLLAPSE THEM INTO A SINGLE FIELD.
 */

import type { KVStore } from "@/db/kvStore";
import { annualSwitchFlags } from "./annualSwitch";
import type { Confidence } from "./confidence";
import { CONFIDENCE } from "./confidence";
import { detectDuplicates } from "./duplicateDetector";
import { detectPriceHikes, readHistory } from "./priceHistory";
import { checkUnused, costPerUseFlags } from "./unusedDetector";
import type { Subscription } from "./validators";

export type RecommendationKind = "duplicate" | "priceHike" | "unused" | "annualSwitch";

export type Recommendation = {
  readonly kind: RecommendationKind;
  readonly subId: string;
  readonly title: string;
  readonly subtitle: string;
  /**
   * Ranking axis — a forward-looking MONTHLY saving in cents, comparable
   * across all kinds. This is what dedupe (keep-larger) and sort use.
   * NOT necessarily what is shown to the user (see displaySaving).
   */
  readonly savingCents: number;
  /**
   * Optional pre-formatted headline for the card, e.g. "$47.97 wasted" or
   * "Save $12/yr". Lets a kind display a truthful figure that differs from
   * the ranking axis. See invariant 2 above — do not merge with savingCents.
   */
  readonly displaySaving?: string;
  readonly cta: string;
  readonly confidence: Confidence;
};

export async function computeInsights(
  store: KVStore,
  subs: readonly Subscription[],
  now?: Date,
): Promise<Recommendation[]> {
  const bySub = new Map<string, Recommendation>();

  const upsert = (rec: Recommendation): void => {
    const existing = bySub.get(rec.subId);
    // STRICTLY greater — see invariant 1. This is what makes the loop order
    // below meaningful, not incidental.
    if (existing === undefined || rec.savingCents > existing.savingCents) {
      bySub.set(rec.subId, rec);
    }
  };

  for (const flag of detectDuplicates(subs)) {
    upsert({
      kind: flag.kind,
      subId: flag.subId,
      title: flag.title,
      subtitle: flag.subtitle,
      savingCents: flag.savingCents,
      cta: flag.cta,
      confidence: flag.confidence,
    });
  }

  for (const sub of subs) {
    const history = await readHistory(store, sub.id);
    for (const flag of detectPriceHikes(history, sub.id, sub.currency)) {
      upsert({
        kind: "priceHike",
        subId: sub.id,
        title: flag.title,
        subtitle: flag.subtitle,
        savingCents: flag.savingCents,
        cta: "Negotiate",
        confidence: CONFIDENCE.derived,
      });
    }
  }

  // INVARIANT 1: costPerUse MUST run before checkUnused. On an equal monthly
  // saving, upsert keeps the incumbent, and the incumbent here is the flag
  // carrying the cumulative "wasted" headline. Reordering these two loops
  // makes every idle subscription fall back to the weaker copy.
  for (const flag of costPerUseFlags(subs, now)) {
    upsert({
      kind: flag.kind,
      subId: flag.subId,
      title: flag.title,
      subtitle: flag.subtitle,
      savingCents: flag.savingCents,
      displaySaving: flag.displaySaving,
      cta: flag.cta,
      confidence: flag.confidence,
    });
  }

  for (const flag of await checkUnused(store, subs, now)) {
    upsert({
      kind: flag.kind,
      subId: flag.subId,
      title: flag.title,
      subtitle: flag.subtitle,
      savingCents: flag.savingCents,
      cta: flag.cta,
      confidence: flag.confidence,
    });
  }

  // F4 annual-vs-monthly switch — ranks on the monthly-equivalent, displays
  // the yearly saving.
  for (const flag of annualSwitchFlags(subs)) {
    upsert({
      kind: flag.kind,
      subId: flag.subId,
      title: flag.title,
      subtitle: flag.subtitle,
      savingCents: flag.savingCents,
      displaySaving: flag.displaySaving,
      cta: flag.cta,
      confidence: flag.confidence,
    });
  }

  return [...bySub.values()].sort(
    (a, b) => b.savingCents - a.savingCents || a.subId.localeCompare(b.subId),
  );
}