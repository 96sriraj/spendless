import { describe, expect, it } from "vitest";
import { SubscriptionInputSchema } from "./validators";

function futureIso(daysAhead = 5): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso(daysAgo = 5): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe("validators — SubscriptionInput", () => {
  it("should accept valid monthly input with future renewal", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "Netflix",
      amountCents: 49900,
      currency: "INR",
      billingCycle: "monthly",
      nextRenewal: futureIso(3),
      category: "entertainment",
      notes: "family plan",
    });
    expect(parsed.success).toBe(true);
  });

  it("should accept yearly without explicit currency (defaults to INR)", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "Adobe CC",
      amountCents: 499900,
      billingCycle: "yearly",
      nextRenewal: futureIso(10),
      category: "productivity",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currency).toBe("INR");
    }
  });

  it("should reject missing name", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "",
      amountCents: 1000,
      billingCycle: "monthly",
      nextRenewal: futureIso(),
      category: "other",
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject zero amountCents", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "Spotify",
      amountCents: 0,
      billingCycle: "monthly",
      nextRenewal: futureIso(),
      category: "music",
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject negative amountCents and non-integer", () => {
    const neg = SubscriptionInputSchema.safeParse({
      name: "X",
      amountCents: -100,
      billingCycle: "monthly",
      nextRenewal: futureIso(),
      category: "other",
    });
    expect(neg.success).toBe(false);

    const float = SubscriptionInputSchema.safeParse({
      name: "X",
      amountCents: 10.5,
      billingCycle: "monthly",
      nextRenewal: futureIso(),
      category: "other",
    });
    expect(float.success).toBe(false);
  });

  it("should reject invalid billingCycle", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "X",
      amountCents: 1000,
      billingCycle: "quarterly" as unknown as "monthly",
      nextRenewal: futureIso(),
      category: "other",
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject past nextRenewal", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "Netflix",
      amountCents: 1000,
      billingCycle: "monthly",
      nextRenewal: pastIso(1),
      category: "other",
    });
    expect(parsed.success).toBe(false);
  });

  it("should reject non-ISO nextRenewal", () => {
    const parsed = SubscriptionInputSchema.safeParse({
      name: "Netflix",
      amountCents: 1000,
      billingCycle: "monthly",
      nextRenewal: "not-a-date",
      category: "other",
    });
    expect(parsed.success).toBe(false);
  });
});
