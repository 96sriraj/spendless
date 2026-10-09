import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import type { KVStore } from "@/db/kvStore";
import { computeInsights, type Recommendation } from "./insights";
import { recordPriceChange } from "./priceHistory";
import { recordUsage } from "./unusedDetector";
import type { Subscription } from "./validators";

const NOW = new Date("2026-10-09T00:00:00.000Z");
const DAY = 86_400_000;

function store(): KVStore {
  return createMemoryKvStore();
}

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    amountCents: 1_599,
    currency: "USD",
    billingCycle: "monthly",
    nextRenewal: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    category: "entertainment",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A subscription that both unused signals fire on, at the same saving. */
async function doublyIdle(store: KVStore): Promise<Subscription> {
  const idle = new Date(NOW.getTime() - 90 * DAY).toISOString();
  const s = sub({ lastUsedDate: idle });
  await recordUsage(store, s.id, idle);
  return s;
}

describe("insights — INVARIANT 1: detector order decides the winner", () => {
  // computeInsights upserts per subId only on a STRICTLY greater savingCents.
  // costPerUse and checkUnused both produce savingCents = monthly, so whoever
  // runs second loses the tie. costPerUse carries the richer "you wasted $X"
  // headline, so it must run FIRST.
  //
  // If someone reorders those loops, this fails. That is the whole reason the
  // comment in insights.ts is not the only defence.
  it("should keep the wasted headline when both unused signals tie", async () => {
    const kv = store();
    const s = await doublyIdle(kv);

    const [rec] = await computeInsights(kv, [s], NOW);

    expect(rec).toBeDefined();
    expect(rec?.displaySaving).toContain("wasted");
    expect(rec?.title).toContain("wasted");
  });

  it("should still be an unused recommendation, not a duplicate of it", async () => {
    const kv = store();
    const s = await doublyIdle(kv);
    const [rec] = await computeInsights(kv, [s], NOW);
    expect(rec?.kind).toBe("unused");
  });

  it("should let a strictly larger saving win the tie-break, whichever detector it came from", async () => {
    const kv = store();
    // A duplicate of a cheaper plan yields the *cheaper* monthly figure, so
    // it must not displace the richer costPerUse flag for the same subId.
    const idle = new Date(NOW.getTime() - 90 * DAY).toISOString();
    const rich = sub({ id: "sub-1", lastUsedDate: idle });
    await recordUsage(kv, rich.id, idle);

    const recs = await computeInsights(
      kv,
      [rich, sub({ id: "sub-2", name: "Netflix", amountCents: 500 })],
      NOW,
    );

    expect(recs).toHaveLength(1);
    expect(recs[0]?.savingCents).toBe(1_599);
  });
});

describe("insights — INVARIANT 2: the ranking axis and the headline are different numbers", () => {
  // savingCents ranks across detector kinds on a forward monthly figure.
  // displaySaving is what the card renders. They are allowed to disagree, and
  // collapsing them would break both the comparison and the copy. DO NOT
  // MERGE THESE INTO ONE FIELD.
  it("should rank on the monthly figure while displaying the cumulative one", async () => {
    const kv = store();
    const s = await doublyIdle(kv);

    const [rec] = await computeInsights(kv, [s], NOW);

    expect(rec?.savingCents).toBe(1_599);
    // 90 days idle => 3 months unused => 3 x 1599 = 4797.
    expect(rec?.displaySaving).toContain("$47.97");
    expect(rec?.savingCents).not.toBe(4_797);
  });

  it("should sort by the ranking axis, not by the string in the headline", async () => {
    const kv = store();
    const idle = new Date(NOW.getTime() - 90 * DAY).toISOString();

    // Small monthly figure but 12 months idle => a big cumulative headline.
    const small = sub({ id: "small", name: "Tiny", amountCents: 100, lastUsedDate: idle });
    const big = sub({ id: "big", name: "Big", amountCents: 5_000, lastUsedDate: idle });
    await recordUsage(kv, small.id, idle);
    await recordUsage(kv, big.id, idle);

    const recs = await computeInsights(kv, [small, big], NOW);
    expect(recs.map((r) => r.subId)).toEqual(["big", "small"]);
  });
});

describe("insights — detection", () => {
  it("should detect a duplicate pair", async () => {
    const recs = await computeInsights(store(), [
      sub({ id: "a", name: "Netflix" }),
      sub({ id: "b", name: "netflix", amountCents: 1_599 }),
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.kind).toBe("duplicate");
    expect(recs[0]?.title).toContain("duplicates");
  });

  it("should attribute a price hike to the subscription it belongs to", async () => {
    const kv = store();
    const s = sub({ id: "hiked" });
    await recordPriceChange(kv, s.id, 1_000, { currency: "USD", now: NOW });
    await recordPriceChange(kv, s.id, 1_500, { currency: "USD", now: NOW });

    const recs = await computeInsights(kv, [s], NOW);
    const hike = recs.find((r) => r.kind === "priceHike");
    expect(hike?.subId).toBe("hiked");
  });

  it("should surface an annual-switch saving", async () => {
    const recs = await computeInsights(store(), [
      sub({ amountCents: 1_000, annualAmountCents: 9_000 }),
    ]);
    const sw = recs.find((r) => r.kind === "annualSwitch");
    expect(sw?.displaySaving).toContain("/yr");
  });

  it("should return nothing for an empty account", async () => {
    expect(await computeInsights(store(), [], NOW)).toEqual([]);
  });

  it("should report a numeric confidence on every recommendation", async () => {
    const kv = store();
    const idle = new Date(NOW.getTime() - 90 * DAY).toISOString();
    const s = await doublyIdle(kv);
    const recs = await computeInsights(
      kv,
      [s, sub({ id: "dup", name: "Netflix" }), sub({ id: "sw", amountCents: 1_000, annualAmountCents: 9_000, lastUsedDate: idle })],
      NOW,
    );

    expect(recs.length).toBeGreaterThan(1);
    for (const rec of recs) {
      expect(typeof rec.confidence).toBe("number");
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("should emit at most one recommendation per subscription", async () => {
    const kv = store();
    const s = await doublyIdle(kv);
    await recordPriceChange(kv, s.id, 1_000, { currency: "USD", now: NOW });
    await recordPriceChange(kv, s.id, 5_000, { currency: "USD", now: NOW });

    const recs = await computeInsights(kv, [s, sub({ id: "dup", name: "Netflix" })], NOW);
    const ids = recs.map((r: Recommendation) => r.subId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});