import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/db/memoryKvStore";
import type { KVStore } from "@/db/kvStore";
import { hasCancelIntent, intentKey, recordCancelIntent } from "./cancelIntent";
import { readLedger } from "./savingsLedger";
import type { Subscription } from "./validators";

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
    nextRenewal: "2026-11-01T00:00:00.000Z",
    category: "entertainment",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("cancelIntent — intentKey", () => {
  it("should namespace the key per subscription", () => {
    expect(intentKey("abc")).toBe("cancellation_intent_abc");
    expect(intentKey("abc")).not.toBe(intentKey("def"));
  });
});

describe("cancelIntent — hasCancelIntent", () => {
  it("should be false before anything is recorded", async () => {
    expect(await hasCancelIntent(store(), "sub-1")).toBe(false);
  });

  it("should be true afterwards", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub());
    expect(await hasCancelIntent(kv, "sub-1")).toBe(true);
  });
});

describe("cancelIntent — recordCancelIntent", () => {
  it("should report the monthly figure and the running total", async () => {
    const result = await recordCancelIntent(store(), sub());
    expect(result.monthlyCents).toBe(1_599);
    expect(result.prevTotalCents).toBe(0);
    expect(result.nextTotalCents).toBe(1_599);
  });

  it("should accumulate across subscriptions", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub({ id: "a", amountCents: 1_000 }));
    const result = await recordCancelIntent(kv, sub({ id: "b", amountCents: 599 }));
    expect(result.prevTotalCents).toBe(1_000);
    expect(result.nextTotalCents).toBe(1_599);
  });

  // Idempotence is the point of the intent marker: a double-tap must not
  // inflate the total the user is shown.
  it("should be idempotent per subscription", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub());
    const second = await recordCancelIntent(kv, sub());
    expect(second.nextTotalCents).toBe(1_599);
    expect(second.prevTotalCents).toBe(1_599);
  });

  it("should append to the savings ledger exactly once per subscription", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub());
    await recordCancelIntent(kv, sub());
    const ledger = await readLedger(kv);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amountDeltaCents).toBe(1_599);
    expect(ledger[0]?.kind).toBe("cancel");
  });

  it("should monthly-normalise a yearly subscription into both the total and the ledger", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub({ billingCycle: "yearly", amountCents: 120_000 }));
    const ledger = await readLedger(kv);
    expect(ledger[0]?.amountDeltaCents).toBe(10_000);
  });

  // RED on lift. nixt fired a OneSignal push from here. OneSignal is an
  // explicit non-goal (README), and a core module importing a notifications
  // service is the impure edge ARCHITECTURE.md says to remove. The milestone
  // is returned for the caller to act on instead.
  it("should report a crossed milestone instead of pushing a notification", async () => {
    const kv = store();
    const result = await recordCancelIntent(kv, sub({ amountCents: 60_000 }));
    expect(result.crossedMilestoneCents).toBe(50_000);
  });

  it("should report no milestone when none was crossed", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub({ id: "a", amountCents: 1_000 }));
    const result = await recordCancelIntent(kv, sub({ id: "b", amountCents: 1_000 }));
    expect(result.crossedMilestoneCents).toBeNull();
  });

  it("should use the subscription's own currency for the milestone ladder", async () => {
    const kv = store();
    // 100,000 cents is the USD $1,000 rung, but only the middle INR rung.
    await recordCancelIntent(kv, sub({ id: "usd", currency: "USD", amountCents: 60_000 }));
    const inr = await recordCancelIntent(kv, sub({ id: "inr", currency: "INR", amountCents: 60_000 }));
    expect(inr.crossedMilestoneCents).toBe(100_000);
  });

  it("should persist the intent marker with the subscription's name", async () => {
    const kv = store();
    await recordCancelIntent(kv, sub({ name: "Adobe CC" }));
    const raw = await kv.kvGet(intentKey("sub-1"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}")).toMatchObject({ name: "Adobe CC" });
  });

  it("should survive a corrupt saved-estimate rather than trust NaN", async () => {
    const kv = store();
    await kv.kvSet("saved_estimate_cents", "not json");
    const result = await recordCancelIntent(kv, sub());
    expect(result.prevTotalCents).toBe(0);
    expect(result.nextTotalCents).toBe(1_599);
  });
});