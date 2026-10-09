/**
 * Price history — per-subscription amount snapshots + hike detection (>=10%).
 *
 * Lifted from nixt, with two defects fixed and one dependency inverted:
 *
 *  - It imported `kvGet`/`kvSet` straight from `durableNotepad`. It now takes
 *    a `KVStore`, which is what makes this module (and the graph above it)
 *    testable without a database. Nothing in src/core knows D1 exists.
 *  - Titles rendered raw minor units: "Price hike: ₹1200" for a ₹12 plan.
 *    Both title and subtitle now go through `formatMoney`.
 *  - `detectPriceHikes` hardcoded `subId: ""`, so every flag it produced was
 *    unattributable. insights.ts overwrote the field, which is why nobody
 *    noticed; the value is now carried through.
 */

import type { KVStore } from "@/db/kvStore";
import { formatMoney } from "./money";
import { DEFAULT_CURRENCY, type Currency } from "./validators";

const KEY_PREFIX = "priceHistory:";
export const PRICE_HIKE_THRESHOLD = 0.1;

export type PricePoint = {
  readonly amountCents: number;
  readonly recordedAt: string;
};

export type PriceHikeFlag = {
  readonly kind: "priceHike";
  readonly subId: string;
  readonly oldAmountCents: number;
  readonly newAmountCents: number;
  readonly savingCents: number;
  readonly title: string;
  readonly subtitle: string;
};

export type RecordPriceChangeResult = {
  readonly flags: readonly PriceHikeFlag[];
};

export type RecordPriceChangeOptions = {
  readonly currency?: Currency;
  /** Injected clock. Time is never read from the environment in this module. */
  readonly now?: Date;
};

function parseHistory(raw: string | null): PricePoint[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const points: PricePoint[] = [];
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PricePoint).amountCents === "number" &&
        typeof (entry as PricePoint).recordedAt === "string"
      ) {
        points.push(entry as PricePoint);
      }
    }
    return points;
  } catch {
    return [];
  }
}

function keyFor(subId: string): string {
  return `${KEY_PREFIX}${subId}`;
}

export async function readHistory(store: KVStore, subId: string): Promise<PricePoint[]> {
  return parseHistory(await store.kvGet(keyFor(subId)));
}

function hikeFlag(
  subId: string,
  previousAmountCents: number,
  newAmountCents: number,
  currency: Currency,
): PriceHikeFlag {
  const money = (cents: number): string => formatMoney(cents, currency);
  return {
    kind: "priceHike",
    subId,
    oldAmountCents: previousAmountCents,
    newAmountCents: newAmountCents,
    savingCents: newAmountCents - previousAmountCents,
    title: `Price hike: ${money(newAmountCents)}`,
    subtitle: `Renewal went from ${money(previousAmountCents)} to ${money(newAmountCents)}`,
  };
}

export async function recordPriceChange(
  store: KVStore,
  subId: string,
  amountCents: number,
  options: RecordPriceChangeOptions = {},
): Promise<RecordPriceChangeResult> {
  const currency = options.currency ?? DEFAULT_CURRENCY;
  const history = await readHistory(store, subId);
  const previous = history[history.length - 1];

  await store.kvSet(
    keyFor(subId),
    JSON.stringify([
      ...history,
      { amountCents, recordedAt: (options.now ?? new Date()).toISOString() },
    ]),
  );

  if (previous === undefined) {
    return { flags: [] };
  }

  const delta = amountCents - previous.amountCents;
  const pct = delta / previous.amountCents;
  if (pct < PRICE_HIKE_THRESHOLD) {
    return { flags: [] };
  }

  return { flags: [hikeFlag(subId, previous.amountCents, amountCents, currency)] };
}

export function detectPriceHikes(
  points: readonly PricePoint[],
  subId: string,
  currency: Currency = DEFAULT_CURRENCY,
): PriceHikeFlag[] {
  const flags: PriceHikeFlag[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (current === undefined || previous === undefined) {
      continue;
    }
    const delta = current.amountCents - previous.amountCents;
    if (delta / previous.amountCents >= PRICE_HIKE_THRESHOLD) {
      flags.push(hikeFlag(subId, previous.amountCents, current.amountCents, currency));
    }
  }
  return flags;
}