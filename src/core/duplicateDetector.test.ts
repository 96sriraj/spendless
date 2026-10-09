import { describe, expect, it } from "vitest";
import { detectDuplicates } from "./duplicateDetector";
import type { Subscription } from "./validators";

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-a",
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

describe("duplicateDetector", () => {
  it("should flag two subscriptions for the same merchant", () => {
    const flags = detectDuplicates([sub({ id: "a" }), sub({ id: "b" })]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.kind).toBe("duplicate");
  });

  it("should rank the saving on the cheaper of the pair, since you keep that one", () => {
    const flags = detectDuplicates([
      sub({ id: "a", amountCents: 1_599 }),
      sub({ id: "b", amountCents: 900 }),
    ]);
    expect(flags[0]?.savingCents).toBe(900);
  });

  it("should not flag unrelated merchants", () => {
    expect(detectDuplicates([sub({ id: "a", name: "Netflix" }), sub({ id: "b", name: "Spotify" })])).toEqual([]);
  });

  it("should resolve a fuzzy merchant name", () => {
    const flags = detectDuplicates([
      sub({ id: "a", name: "Netflix" }),
      sub({ id: "b", name: "Netfliks" }),
    ]);
    expect(flags).toHaveLength(1);
    // RED on lift, twice over. nixt fed a raw Jaro-Winkler score into the same
    // field as an exact match, and "Netfliks" scored 0.98 - above Netflix's
    // 0.9. A one-character typo must never be more certain than an exact
    // match, however similar the strings look.
    expect(flags[0]?.confidence).toBeLessThanOrEqual(0.9);
  });

  it("should rank an exact merchant match above a fuzzy one", () => {
    const exact = detectDuplicates([sub({ id: "a", name: "Netflix" }), sub({ id: "b", name: "netflix" })]);
    const fuzzy = detectDuplicates([sub({ id: "a", name: "Netflix" }), sub({ id: "b", name: "Netfliks" })]);
    expect(fuzzy[0]?.confidence).toBeLessThan(exact[0]?.confidence ?? 0);
  });

  // RED on lift. nixt emitted `subId: a.id` - whichever member of the pair
  // happened to come first in the input array. Feed the same account in a
  // different order and the flag jumps to the other subscription, so the
  // dashboard's "cancel this one" advice points at a different bill run to
  // run. The pair is unordered; the output must not be.
  it("should attribute the flag to the same subscription regardless of input order", () => {
    const a = sub({ id: "sub-aaa", amountCents: 1_599 });
    const b = sub({ id: "sub-bbb", amountCents: 1_599 });

    const forward = detectDuplicates([a, b]);
    const reversed = detectDuplicates([b, a]);

    expect(reversed[0]?.subId).toBe(forward[0]?.subId);
  });

  // The deterministic choice that is also the useful one: tell the user to
  // drop the pricier plan and keep the cheaper one.
  it("should attribute the flag to the more expensive subscription", () => {
    const cheap = sub({ id: "sub-cheap", amountCents: 900 });
    const dear = sub({ id: "sub-dear", amountCents: 1_599 });

    expect(detectDuplicates([cheap, dear])[0]?.subId).toBe("sub-dear");
    expect(detectDuplicates([dear, cheap])[0]?.subId).toBe("sub-dear");
  });

  it("should break a price tie on id, so the choice is still stable", () => {
    const one = sub({ id: "sub-aaa" });
    const two = sub({ id: "sub-zzz" });

    expect(detectDuplicates([two, one])[0]?.subId).toBe("sub-aaa");
    expect(detectDuplicates([one, two])[0]?.subId).toBe("sub-aaa");
  });

  it("should name both subscriptions in the title, so the advice is actionable", () => {
    const [flag] = detectDuplicates([
      sub({ id: "a", name: "Netflix" }),
      sub({ id: "b", name: "Netflix Family" }),
    ]);
    expect(flag?.title).toContain("Netflix");
    expect(flag?.title).toContain("Netflix Family");
  });

  it("should report a confidence inside the documented scale", () => {
    const [flag] = detectDuplicates([sub({ id: "a" }), sub({ id: "b" })]);
    expect(flag?.confidence).toBeGreaterThan(0);
    expect(flag?.confidence).toBeLessThanOrEqual(1);
  });
});