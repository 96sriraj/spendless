import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import type { KVStore } from "@/db/kvStore";
import {
  detectPriceHikes,
  readHistory,
  recordPriceChange,
} from "./priceHistory";

const NOW = new Date("2026-10-09T00:00:00.000Z");

function store(): KVStore {
  return createMemoryKvStore();
}

describe("priceHistory — recordPriceChange", () => {
  it("should flag nothing on the very first price, because there is nothing to compare against", async () => {
    const { flags } = await recordPriceChange(store(), "sub-1", 1_599, { now: NOW });
    expect(flags).toEqual([]);
  });

  it("should flag a 20% hike with the difference as the saving", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_000, { now: NOW });
    const { flags } = await recordPriceChange(kv, "sub-1", 1_200, { now: NOW });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.savingCents).toBe(200);
    expect(flags[0]?.oldAmountCents).toBe(1_000);
    expect(flags[0]?.newAmountCents).toBe(1_200);
  });

  // RED on lift. nixt's title interpolated raw minor units - "Price hike:
  // ₹1200" for a twelve-dollar plan. A headline is the one string a judge
  // reads from a screen-share; it has to be money a human recognises.
  it("should render the title as formatted money, not raw minor units", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_000, { currency: "USD", now: NOW });
    const { flags } = await recordPriceChange(kv, "sub-1", 1_200, {
      currency: "USD",
      now: NOW,
    });
    const title = flags[0]?.title ?? "";
    expect(title).toContain("$12");
    expect(title).not.toContain("1200");
  });

  it("should render the title in the subscription's own currency", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-inr", 100_000, { currency: "INR", now: NOW });
    const { flags } = await recordPriceChange(kv, "sub-inr", 120_000, {
      currency: "INR",
      now: NOW,
    });
    expect(flags[0]?.title).toContain("₹");
    expect(flags[0]?.subtitle).toContain("₹");
  });

  it("should describe the movement in the subtitle", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_000, { currency: "USD", now: NOW });
    const { flags } = await recordPriceChange(kv, "sub-1", 1_200, {
      currency: "USD",
      now: NOW,
    });
    const subtitle = flags[0]?.subtitle ?? "";
    expect(subtitle).toContain("$10");
    expect(subtitle).toContain("$12");
  });

  it("should flag exactly at the 10% threshold, not above it", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_000, { now: NOW });
    expect((await recordPriceChange(kv, "sub-1", 1_100, { now: NOW })).flags).toHaveLength(1);
  });

  it("should not flag a 9.9% rise", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_000, { now: NOW });
    expect((await recordPriceChange(kv, "sub-1", 1_099, { now: NOW })).flags).toEqual([]);
  });

  it("should not flag a price drop - that is good news", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_200, { now: NOW });
    expect((await recordPriceChange(kv, "sub-1", 1_000, { now: NOW })).flags).toEqual([]);
  });

  it("should persist the point it recorded", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-1", 1_000, { now: NOW });
    await recordPriceChange(kv, "sub-1", 1_200, { now: NOW });
    const history = await readHistory(kv, "sub-1");
    expect(history.map((p) => p.amountCents)).toEqual([1_000, 1_200]);
    expect(history[0]?.recordedAt).toBe(NOW.toISOString());
  });

  it("should keep each subscription's history separate", async () => {
    const kv = store();
    await recordPriceChange(kv, "sub-a", 1_000, { now: NOW });
    await recordPriceChange(kv, "sub-b", 5_000, { now: NOW });
    expect(await readHistory(kv, "sub-a")).toHaveLength(1);
    expect(await readHistory(kv, "sub-b")).toHaveLength(1);
  });
});

describe("priceHistory — readHistory", () => {
  it("should return an empty history for an unknown subscription", async () => {
    expect(await readHistory(store(), "never-seen")).toEqual([]);
  });

  it("should return an empty history for corrupt stored JSON rather than throwing", async () => {
    const kv = store();
    await kv.kvSet("priceHistory:sub-1", "{not json");
    expect(await readHistory(kv, "sub-1")).toEqual([]);
  });

  it("should drop malformed points and keep the well-formed ones", async () => {
    const kv = store();
    await kv.kvSet(
      "priceHistory:sub-1",
      JSON.stringify([
        { amountCents: 1_000, recordedAt: "2026-01-01T00:00:00.000Z" },
        { amountCents: "not a number", recordedAt: "2026-02-01T00:00:00.000Z" },
        { nope: true },
        { amountCents: 1_200, recordedAt: "2026-03-01T00:00:00.000Z" },
      ]),
    );
    expect((await readHistory(kv, "sub-1")).map((p) => p.amountCents)).toEqual([
      1_000, 1_200,
    ]);
  });

  it("should return an empty history when the stored value is not an array", async () => {
    const kv = store();
    await kv.kvSet("priceHistory:sub-1", JSON.stringify({ amountCents: 1 }));
    expect(await readHistory(kv, "sub-1")).toEqual([]);
  });
});

describe("priceHistory — detectPriceHikes", () => {
  const points = [
    { amountCents: 1_000, recordedAt: "2026-01-01T00:00:00.000Z" },
    { amountCents: 1_200, recordedAt: "2026-02-01T00:00:00.000Z" },
    { amountCents: 1_210, recordedAt: "2026-03-01T00:00:00.000Z" },
  ];

  it("should detect each consecutive hike", () => {
    const flags = detectPriceHikes(points, "sub-1", "USD");
    expect(flags).toHaveLength(1);
    expect(flags[0]?.oldAmountCents).toBe(1_000);
    expect(flags[0]?.newAmountCents).toBe(1_200);
  });

  // RED on lift. nixt hardcoded subId: "", which silently dropped every
  // price-hike flag's attribution. insights.ts happened to overwrite it, so
  // nothing broke visibly - but the flag was unattributable everywhere else.
  it("should attribute the flag to the subscription it came from", () => {
    expect(detectPriceHikes(points, "sub-1", "USD")[0]?.subId).toBe("sub-1");
  });

  it("should render a formatted title here too, not raw cents", () => {
    expect(detectPriceHikes(points, "sub-1", "USD")[0]?.title).not.toContain("1200");
  });

  it("should return nothing for a flat history", () => {
    expect(
      detectPriceHikes(
        [
          { amountCents: 1_000, recordedAt: "2026-01-01T00:00:00.000Z" },
          { amountCents: 1_000, recordedAt: "2026-02-01T00:00:00.000Z" },
        ],
        "sub-1",
        "USD",
      ),
    ).toEqual([]);
  });

  it("should return nothing for an empty history", () => {
    expect(detectPriceHikes([], "sub-1", "USD")).toEqual([]);
  });
});