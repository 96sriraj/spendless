import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import type { KVStore } from "@/db/kvStore";
import {
  crossedMilestone,
  readLedger,
  recordSaving,
  savingsSeries,
  SAVINGS_MILESTONES_CENTS,
  totalSavedMonthlyCents,
} from "./savingsLedger";

function store(): KVStore {
  return createMemoryKvStore();
}

describe("savingsLedger — recordSaving", () => {
  it("should append and return the whole ledger", async () => {
    const kv = store();
    await recordSaving(kv, { subId: "a", kind: "cancel", amountDeltaCents: 1_599 });
    const ledger = await recordSaving(kv, {
      subId: "b",
      kind: "downgrade",
      amountDeltaCents: 800,
    });
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.subId).toBe("a");
    expect(ledger[1]?.subId).toBe("b");
  });

  it("should never drop an earlier entry, because the ledger is append-only", async () => {
    const kv = store();
    await recordSaving(kv, { subId: "a", kind: "cancel", amountDeltaCents: 1 });
    await recordSaving(kv, { subId: "b", kind: "cancel", amountDeltaCents: 2 });
    await recordSaving(kv, { subId: "c", kind: "cancel", amountDeltaCents: 3 });
    expect((await readLedger(kv)).map((e) => e.subId)).toEqual(["a", "b", "c"]);
  });

  it("should give every entry a distinct id", async () => {
    const kv = store();
    const ledger = await recordSaving(kv, {
      subId: "a",
      kind: "cancel",
      amountDeltaCents: 1,
    });
    await recordSaving(kv, { subId: "a", kind: "cancel", amountDeltaCents: 1 });
    expect(new Set((await readLedger(kv)).map((e) => e.id)).size).toBe(2);
    expect(ledger[0]?.id).toBeTruthy();
  });

  it("should default confirmedAt to now, and accept an explicit one", async () => {
    const kv = store();
    await recordSaving(kv, { subId: "a", kind: "cancel", amountDeltaCents: 1 });
    const [implicit] = await readLedger(kv);
    expect(Date.parse(implicit?.confirmedAt ?? "")).not.toBeNaN();

    await recordSaving(kv, {
      subId: "b",
      kind: "cancel",
      amountDeltaCents: 1,
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
    const [first, second] = await readLedger(kv);
    expect(first?.confirmedAt).toBe(implicit?.confirmedAt);
    expect(second?.confirmedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("savingsLedger — readLedger", () => {
  it("should return an empty ledger for an account with no savings", async () => {
    expect(await readLedger(store())).toEqual([]);
  });

  it("should return an empty ledger for corrupt JSON rather than throwing", async () => {
    const kv = store();
    await kv.kvSet("savings_ledger", "[[[");
    expect(await readLedger(kv)).toEqual([]);
  });

  it("should drop malformed entries and keep the good ones", async () => {
    const kv = store();
    await kv.kvSet(
      "savings_ledger",
      JSON.stringify([
        { id: "1", subId: "a", kind: "cancel", amountDeltaCents: 100, confirmedAt: "2026-01-01T00:00:00.000Z" },
        { id: "2", subId: "b", kind: "nonsense", amountDeltaCents: 100, confirmedAt: "2026-01-01T00:00:00.000Z" },
        { nope: true },
      ]),
    );
    expect((await readLedger(kv)).map((e) => e.id)).toEqual(["1"]);
  });

  it("should return an empty ledger when the stored value is not an array", async () => {
    const kv = store();
    await kv.kvSet("savings_ledger", JSON.stringify({ total: 1 }));
    expect(await readLedger(kv)).toEqual([]);
  });
});

describe("savingsLedger — totals", () => {
  it("should sum monthly-normalised amounts", () => {
    expect(
      totalSavedMonthlyCents([
        { id: "1", subId: "a", kind: "cancel", amountDeltaCents: 1_599, confirmedAt: "2026-01-01T00:00:00.000Z" },
        { id: "2", subId: "b", kind: "downgrade", amountDeltaCents: 800, confirmedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    ).toBe(2_399);
  });

  it("should total zero for an empty ledger", () => {
    expect(totalSavedMonthlyCents([])).toBe(0);
  });
});

describe("savingsLedger — savingsSeries", () => {
  const ledger = [
    { id: "1", subId: "a", kind: "cancel" as const, amountDeltaCents: 1_000, confirmedAt: "2026-03-01T00:00:00.000Z" },
    { id: "2", subId: "b", kind: "cancel" as const, amountDeltaCents: 2_000, confirmedAt: "2026-01-01T00:00:00.000Z" },
    { id: "3", subId: "c", kind: "cancel" as const, amountDeltaCents: 500, confirmedAt: "2026-02-01T00:00:00.000Z" },
  ];

  it("should accumulate oldest to newest regardless of input order", () => {
    // Jan 2000, Feb 500, Mar 1000 -> 2000, 2500, 3500.
    expect(savingsSeries(ledger).map((p) => p.cumulativeCents)).toEqual([
      2_000, 2_500, 3_500,
    ]);
  });

  it("should clip to a window while keeping the cumulative total honest", () => {
    const series = savingsSeries(ledger, {
      from: "2026-02-01T00:00:00.000Z",
      to: "2026-03-01T00:00:00.000Z",
    });
    expect(series.map((p) => p.cumulativeCents)).toEqual([2_500, 3_500]);
  });

  it("should return nothing for an empty ledger", () => {
    expect(savingsSeries([])).toEqual([]);
  });
});

describe("savingsLedger — milestones", () => {
  // RED on lift. nixt had one flat INR ladder (1L / 5L / 10L) because nixt
  // only had INR. spendless runs against a USD sandbox, where 100,000 cents
  // is $1,000 — a rung that means nothing in the currency being saved.
  it("should keep nixt's rupee ladder intact", () => {
    expect(SAVINGS_MILESTONES_CENTS.INR).toEqual([100_000, 500_000, 1_000_000]);
  });

  it("should define a ladder for USD, the sandbox currency", () => {
    expect(SAVINGS_MILESTONES_CENTS.USD).toEqual([10_000, 50_000, 100_000]);
  });

  it("should report the highest rung crossed", () => {
    expect(crossedMilestone(0, 1_500, "INR")).toBeNull();
    expect(crossedMilestone(99_999, 100_000, "INR")).toBe(100_000);
    // Jump across two rungs at once: the celebration is for the top one.
    expect(crossedMilestone(0, 600_000, "INR")).toBe(500_000);
  });

  it("should not report a rung the account had already passed", () => {
    expect(crossedMilestone(100_000, 200_000, "INR")).toBeNull();
  });

  it("should use the requested currency's ladder", () => {
    // 60,000 cents is past the USD $500 rung but nowhere near INR 1L.
    expect(crossedMilestone(0, 60_000, "USD")).toBe(50_000);
    expect(crossedMilestone(0, 60_000, "INR")).toBeNull();
  });

  it("should report nothing when the total went down", () => {
    expect(crossedMilestone(500_000, 10_000, "INR")).toBeNull();
  });
});