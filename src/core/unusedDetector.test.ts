import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import type { KVStore } from "@/db/kvStore";
import { checkUnused, costPerUseFlag, costPerUseFlags, recordUsage } from "./unusedDetector";
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
    // 3 days out: inside the 7-day renewal window.
    nextRenewal: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    category: "entertainment",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("unusedDetector — checkUnused", () => {
  it("should flag an idle subscription renewing soon", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 60 * DAY).toISOString());
    const flags = await checkUnused(kv, [sub()], NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.subId).toBe("sub-1");
  });

  it("should not flag a subscription used inside the idle threshold", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 10 * DAY).toISOString());
    expect(await checkUnused(kv, [sub()], NOW)).toEqual([]);
  });

  it("should not flag a subscription renewing beyond the window", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 60 * DAY).toISOString());
    const far = sub({ nextRenewal: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    expect(await checkUnused(kv, [far], NOW)).toEqual([]);
  });

  it("should not flag a subscription whose renewal already passed", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 60 * DAY).toISOString());
    const past = sub({ nextRenewal: new Date(NOW.getTime() - DAY).toISOString() });
    expect(await checkUnused(kv, [past], NOW)).toEqual([]);
  });

  it("should not flag a subscription with no usage record at all", async () => {
    expect(await checkUnused(store(), [sub()], NOW)).toEqual([]);
  });

  it("should ignore an unparseable usage record rather than throwing", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", "not a date");
    expect(await checkUnused(kv, [sub()], NOW)).toEqual([]);
  });

  it("should flag at exactly the idle threshold being exceeded", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 31 * DAY).toISOString());
    expect(await checkUnused(kv, [sub()], NOW)).toHaveLength(1);
  });

  it("should render the saving in the subscription's own currency", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 60 * DAY).toISOString());
    const inr = sub({ currency: "INR", amountCents: 64_900 });
    const [flag] = await checkUnused(kv, [inr], NOW);
    expect(flag?.subtitle).toContain("₹");
    expect(flag?.subtitle).not.toContain("$");
  });

  // RED on lift. UnusedFlag declared `confidence: "possibly"` where every
  // sibling detector used a number. A ranking axis cannot be a string
  // literal, and this is the signal the agent ranks on (P5-05).
  it("should report a numeric confidence on the same scale as its siblings", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 60 * DAY).toISOString());
    const [flag] = await checkUnused(kv, [sub()], NOW);
    expect(typeof flag?.confidence).toBe("number");
    expect(flag?.confidence).toBeGreaterThanOrEqual(0);
    expect(flag?.confidence).toBeLessThanOrEqual(1);
  });
});

describe("unusedDetector — costPerUseFlag", () => {
  it("should return null with no lastUsedDate", () => {
    expect(costPerUseFlag(sub(), NOW)).toBeNull();
  });

  it("should return null when used inside the idle threshold", () => {
    expect(
      costPerUseFlag(sub({ lastUsedDate: new Date(NOW.getTime() - 5 * DAY).toISOString() }), NOW),
    ).toBeNull();
  });

  it("should ignore an unparseable lastUsedDate", () => {
    expect(costPerUseFlag(sub({ lastUsedDate: "yesterday" }), NOW)).toBeNull();
  });

  it("should surface the cumulative waste as the headline", () => {
    const flag = costPerUseFlag(
      sub({ lastUsedDate: new Date(NOW.getTime() - 90 * DAY).toISOString() }),
      NOW,
    );
    // 3 months unused at $15.99/mo => 3 x 1599.
    expect(flag?.displaySaving).toContain("$47.97");
    expect(flag?.displaySaving).toContain("wasted");
  });

  // Invariant 2, in miniature: the ranking axis and the displayed figure are
  // different numbers on purpose, and neither may be collapsed into the other.
  it("should rank on the forward monthly figure, not the cumulative one", () => {
    const flag = costPerUseFlag(
      sub({ lastUsedDate: new Date(NOW.getTime() - 90 * DAY).toISOString() }),
      NOW,
    );
    expect(flag?.savingCents).toBe(1_599);
    expect(flag?.savingCents).not.toBe(4_797);
  });

  it("should monthly-normalise a yearly subscription before ranking", () => {
    const flag = costPerUseFlag(
      sub({
        billingCycle: "yearly",
        amountCents: 120_000,
        lastUsedDate: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      }),
      NOW,
    );
    expect(flag?.savingCents).toBe(10_000);
  });

  it("should never report less than one month of waste", () => {
    const flag = costPerUseFlag(
      sub({ lastUsedDate: new Date(NOW.getTime() - 31 * DAY).toISOString() }),
      NOW,
    );
    expect(flag?.displaySaving).toContain("$15.99");
  });

  it("should use a numeric confidence", () => {
    const flag = costPerUseFlag(
      sub({ lastUsedDate: new Date(NOW.getTime() - 60 * DAY).toISOString() }),
      NOW,
    );
    expect(typeof flag?.confidence).toBe("number");
  });
});

describe("unusedDetector — costPerUseFlags", () => {
  it("should return one flag per eligible subscription", () => {
    const flags = costPerUseFlags(
      [
        sub({ id: "a", lastUsedDate: new Date(NOW.getTime() - 60 * DAY).toISOString() }),
        sub({ id: "b", lastUsedDate: new Date(NOW.getTime() - 60 * DAY).toISOString() }),
        sub({ id: "c" }),
      ],
      NOW,
    );
    expect(flags.map((f) => f.subId)).toEqual(["a", "b"]);
  });

  it("should return an empty list for no subscriptions", () => {
    expect(costPerUseFlags([], NOW)).toEqual([]);
  });
});

describe("unusedDetector — recordUsage", () => {
  it("should be last-write-wins, matching the lifted behaviour", async () => {
    const kv = store();
    await recordUsage(kv, "sub-1", "2026-01-01T00:00:00.000Z");
    await recordUsage(kv, "sub-1", "2026-02-01T00:00:00.000Z");
    expect(await kv.kvGet("usage:sub-1")).toBe("2026-02-01T00:00:00.000Z");
  });
});