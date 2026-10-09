import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import type { KVStore } from "@/db/kvStore";
import { computeInsights } from "./insights";
import { recordPriceChange } from "./priceHistory";
import { recordUsage } from "./unusedDetector";
import type { Subscription } from "./validators";

/**
 * ARCHITECTURE.md section 5: the core is pure and deterministic. The run log
 * is only worth showing if the same account produces the same reasoning every
 * time - a demo that reorders its own findings is not a demo a judge can
 * follow. This is the property that makes the video reproducible.
 */

const NOW = new Date("2026-10-09T00:00:00.000Z");
const DAY = 86_400_000;

const ACCOUNT: readonly Subscription[] = [
  {
    id: "sub-nflx",
    name: "Netflix",
    amountCents: 1_599,
    currency: "USD",
    billingCycle: "monthly",
    nextRenewal: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    category: "entertainment",
    lastUsedDate: new Date(NOW.getTime() - 91 * DAY).toISOString(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "sub-nflx-dup",
    name: "netflix",
    amountCents: 1_599,
    currency: "USD",
    billingCycle: "monthly",
    nextRenewal: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    category: "entertainment",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "sub-adobe",
    name: "Adobe CC",
    amountCents: 59_900,
    currency: "USD",
    billingCycle: "yearly",
    annualAmountCents: 47_900,
    nextRenewal: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    category: "productivity",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

async function scenario(): Promise<KVStore> {
  const store = createMemoryKvStore();
  await recordUsage(store, "sub-nflx", "2026-07-10T00:00:00.000Z");
  await recordPriceChange(store, "sub-adobe", 59_900, { currency: "USD", now: NOW });
  await recordPriceChange(store, "sub-adobe", 71_900, { currency: "USD", now: NOW });
  return store;
}

describe("determinism", () => {
  it("should produce identical output for identical input", async () => {
    const first = await computeInsights(await scenario(), ACCOUNT, NOW);
    const second = await computeInsights(await scenario(), ACCOUNT, NOW);

    expect(second).toEqual(first);
  });

  it("should hold across five consecutive runs", async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, async () =>
        computeInsights(await scenario(), ACCOUNT, NOW),
      ),
    );
    for (const run of runs) {
      expect(run).toEqual(runs[0]);
    }
  });

  it("should not depend on the order subscriptions are supplied in", async () => {
    const forward = await computeInsights(await scenario(), ACCOUNT, NOW);
    const reversed = await computeInsights(await scenario(), [...ACCOUNT].reverse(), NOW);
    expect(reversed).toEqual(forward);
  });

  it("should rank by savingCents descending, with a stable tie-break on subId", async () => {
    const recs = await computeInsights(await scenario(), ACCOUNT, NOW);
    expect(recs.length).toBeGreaterThan(1);

    for (let i = 1; i < recs.length; i += 1) {
      const previous = recs[i - 1];
      const current = recs[i];
      if (previous === undefined || current === undefined) continue;
      if (previous.savingCents === current.savingCents) {
        expect(previous.subId.localeCompare(current.subId)).toBeLessThanOrEqual(0);
      } else {
        expect(previous.savingCents).toBeGreaterThan(current.savingCents);
      }
    }
  });

  it("should consult the injected clock for renewal proximity, not the wall clock", async () => {
    const kv = createMemoryKvStore();
    const renewingIn3Days = new Date(NOW.getTime() + 3 * DAY).toISOString();
    await recordUsage(kv, "sub-1", new Date(NOW.getTime() - 60 * DAY).toISOString());

    const s: Subscription = {
      ...ACCOUNT[0]!,
      id: "sub-1",
      lastUsedDate: undefined,
      nextRenewal: renewingIn3Days,
    };

    // 3 days out: inside the 7-day window, so it is a finding.
    const insideWindow = await computeInsights(kv, [s], NOW);
    expect(insideWindow.some((r) => r.kind === "unused")).toBe(true);

    // A month later the same renewal is in the past, so it is not.
    const afterRenewal = await computeInsights(
      kv,
      [s],
      new Date(NOW.getTime() + 30 * DAY),
    );
    expect(afterRenewal.some((r) => r.kind === "unused")).toBe(false);
  });
});