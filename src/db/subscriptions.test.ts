import { describe, expect, it } from "vitest";
import { SubscriptionSchema } from "@/core/validators";
import { rowToSubscription } from "./subscriptions";

const ROW = {
  id: "sub-1",
  name: "Netflix",
  amount_cents: 1599,
  currency: "USD",
  billing_cycle: "monthly",
  next_renewal: "2026-11-01T00:00:00.000Z",
  category: "entertainment",
  trial_end_date: null,
  last_used_date: null,
  annual_amount_cents: null,
  notes: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("rowToSubscription", () => {
  it("should map snake_case columns onto the camelCase shape the core expects", () => {
    expect(rowToSubscription(ROW)).toMatchObject({
      id: "sub-1",
      amountCents: 1599,
      billingCycle: "monthly",
      nextRenewal: "2026-11-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  // Validating at the DB boundary is the whole point of raw SQL + zod: a
  // malformed row must not become a NaN amount somewhere downstream.
  it("should reject a row that violates the schema rather than return a broken subscription", () => {
    expect(rowToSubscription({ ...ROW, amount_cents: "not a number" })).toBeNull();
    expect(rowToSubscription({ ...ROW, currency: "EUR" })).toBeNull();
    expect(rowToSubscription({ ...ROW, billing_cycle: "quarterly" })).toBeNull();
    expect(rowToSubscription({ ...ROW, next_renewal: "not-a-date" })).toBeNull();
    expect(rowToSubscription({ ...ROW, id: "" })).toBeNull();
  });

  it("should produce something that satisfies the canonical schema", () => {
    const sub = rowToSubscription(ROW);
    expect(sub).not.toBeNull();
    expect(() => SubscriptionSchema.parse(sub)).not.toThrow();
  });

  it("should treat a row with no renewal date as not-yet-a-subscription", () => {
    // The column is nullable because a PayPal transaction can be seen before
    // its plan is. Such a row is not something the detector graph can reason
    // about yet, so it is dropped rather than passed on with holes in it.
    expect(rowToSubscription({ ...ROW, next_renewal: null })).toBeNull();
  });

  it("should tolerate optional columns being absent entirely", () => {
    const { trial_end_date, last_used_date, annual_amount_cents, notes, ...rest } = ROW;
    expect(rowToSubscription(rest)).not.toBeNull();
  });

  it("should map an annual price, the annual-switch detector's input", () => {
    expect(
      rowToSubscription({ ...ROW, annual_amount_cents: 47_900 })?.annualAmountCents,
    ).toBe(47_900);
  });

  it("should map a last-used date - the only usage signal that exists", () => {
    expect(
      rowToSubscription({ ...ROW, last_used_date: "2026-09-01T00:00:00.000Z" })
        ?.lastUsedDate,
    ).toBe("2026-09-01T00:00:00.000Z");
  });

  it("should keep a zero/null distinction out of the optional money field", () => {
    expect(rowToSubscription({ ...ROW, annual_amount_cents: null })?.annualAmountCents).toBeNull();
  });
});