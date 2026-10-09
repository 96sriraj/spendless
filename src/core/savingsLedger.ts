/**
 * Savings ledger — durable, append-only record of money actually stopped.
 *
 * Lifted from nixt. Two changes:
 *
 *  - It imported `kvGet`/`kvSet` from `durableNotepad`; it now takes a
 *    `KVStore`.
 *  - The milestone ladder was a single flat array of rupee amounts, because
 *    nixt only had INR. spendless runs against a USD sandbox, where 100,000
 *    cents is $1,000 - a rung that means nothing in the currency being saved.
 *    The ladder is now per currency and `crossedMilestone` takes one.
 *
 * Amounts are monthly-normalised cents so the running total and the trend are
 * comparable across billing cycles.
 */

import type { KVStore } from "@/db/kvStore";
import { DEFAULT_CURRENCY, type Currency } from "./validators";

const KEY = "savings_ledger";

export type SavingKind = "cancel" | "downgrade";

export type SavingEntry = {
  readonly id: string;
  readonly subId: string;
  readonly kind: SavingKind;
  readonly amountDeltaCents: number;
  readonly confirmedAt: string;
};

export type SavingsPoint = {
  readonly date: string;
  readonly cumulativeCents: number;
};

/**
 * Milestones in cents of monthly savings.
 *
 * INR keeps nixt's 1L / 5L / 10L. USD gets $100 / $500 / $1000 - the same
 * three-decade shape, at a scale that means something to someone looking at a
 * dollar figure. One flat array could not do both: 1,00,000 cents is ₹1 lakh
 * to one account and $1,000 to the next.
 */
export const SAVINGS_MILESTONES_CENTS: Readonly<Record<Currency, readonly number[]>> =
  {
    INR: [100_000, 500_000, 1_000_000],
    USD: [10_000, 50_000, 100_000],
  };

function isSavingEntry(value: unknown): value is SavingEntry {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["subId"] === "string" &&
    (r["kind"] === "cancel" || r["kind"] === "downgrade") &&
    typeof r["amountDeltaCents"] === "number" &&
    typeof r["confirmedAt"] === "string"
  );
}

export async function readLedger(store: KVStore): Promise<SavingEntry[]> {
  const raw = await store.kvGet(KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavingEntry);
  } catch {
    return [];
  }
}

/**
 * Append one saving. Append-only: existing entries are preserved.
 * Returns the full ledger after the write.
 */
export async function recordSaving(
  store: KVStore,
  entry: Omit<SavingEntry, "id" | "confirmedAt"> & {
    readonly id?: string;
    readonly confirmedAt?: string;
  },
): Promise<SavingEntry[]> {
  const existing = await readLedger(store);
  const full: SavingEntry = {
    id: entry.id ?? genId(),
    subId: entry.subId,
    kind: entry.kind,
    amountDeltaCents: entry.amountDeltaCents,
    confirmedAt: entry.confirmedAt ?? new Date().toISOString(),
  };
  await store.kvSet(KEY, JSON.stringify([...existing, full]));
  return [...existing, full];
}

export function totalSavedMonthlyCents(ledger: readonly SavingEntry[]): number {
  let total = 0;
  for (const e of ledger) total += e.amountDeltaCents;
  return total;
}

/**
 * Cumulative savings over time, oldest → newest, optionally clipped to a
 * [from, to] ISO window. Each point's cumulative includes every entry up to
 * and including that one, so a clipped series does not reset the total.
 */
export function savingsSeries(
  ledger: readonly SavingEntry[],
  range?: { readonly from?: string; readonly to?: string },
): SavingsPoint[] {
  const fromMs = range?.from !== undefined ? Date.parse(range.from) : Number.NEGATIVE_INFINITY;
  const toMs = range?.to !== undefined ? Date.parse(range.to) : Number.POSITIVE_INFINITY;
  const sorted = [...ledger]
    .filter((e) => !Number.isNaN(Date.parse(e.confirmedAt)))
    .sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt));
  const points: SavingsPoint[] = [];
  let cumulative = 0;
  for (const e of sorted) {
    cumulative += e.amountDeltaCents;
    const ms = Date.parse(e.confirmedAt);
    if (ms >= fromMs && ms <= toMs) {
      points.push({ date: e.confirmedAt, cumulativeCents: cumulative });
    }
  }
  return points;
}

/**
 * Highest milestone newly crossed going from prev → next total, or null if
 * none. Pure; the caller decides whether to celebrate.
 */
export function crossedMilestone(
  prevCents: number,
  nextCents: number,
  currency: Currency = DEFAULT_CURRENCY,
): number | null {
  let crossed: number | null = null;
  for (const m of SAVINGS_MILESTONES_CENTS[currency]) {
    if (prevCents < m && nextCents >= m) {
      crossed = m;
    }
  }
  return crossed;
}

function genId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID
    ? g.crypto.randomUUID()
    : `sav_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}