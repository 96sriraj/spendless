import { describe, expect, it } from "vitest";
import {
  buildCardPaymentSource,
  isValidPan,
  SANDBOX_TEST_CARDS,
} from "./cardFunding";
import { buildOrderPayload } from "./orderPayload";

describe("cardFunding — sandbox test cards", () => {
  it("should carry only published sandbox test numbers", () => {
    // Not secrets: these are PayPal's documented sandbox values. Asserting them
    // guards against someone substituting a real card number "to test".
    expect(SANDBOX_TEST_CARDS.map((c) => c.number)).toEqual([
      "4111111111111111",
      "5555555555554444",
    ]);
  });

  it("should pass the schema's 13-19 digit PAN rule for every card", () => {
    for (const card of SANDBOX_TEST_CARDS) {
      expect(isValidPan(card), card.number).toBe(true);
    }
  });

  it("should reject a malformed PAN rather than sending it", () => {
    expect(isValidPan({ number: "41111", expiry: "2030-12", securityCode: "123", name: "x", brand: "visa" })).toBe(false);
    expect(isValidPan({ number: "4111-1111-1111-1111", expiry: "2030-12", securityCode: "123", name: "x", brand: "visa" })).toBe(false);
  });

  it("should use an expiry in the future, in internet date format", () => {
    for (const card of SANDBOX_TEST_CARDS) {
      expect(card.expiry).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
      expect(Number(card.expiry.slice(0, 4))).toBeGreaterThan(2026);
    }
  });
});

describe("cardFunding — payment source payload", () => {
  it("should nest the card under payment_source", () => {
    const body = buildCardPaymentSource(SANDBOX_TEST_CARDS[0]!);
    expect(body.payment_source.card.number).toBe("4111111111111111");
    expect(body.payment_source.card.expiry).toBe("2030-12");
    expect(body.payment_source.card.security_code).toBe("123");
  });

  it("should name the field security_code, not cvv", () => {
    // The schema calls it security_code. A cvv key is a silent 400.
    expect(Object.keys(buildCardPaymentSource(SANDBOX_TEST_CARDS[0]!).payment_source.card).sort()).toEqual([
      "expiry",
      "name",
      "number",
      "security_code",
    ]);
  });

  it("should serialise to JSON intact", () => {
    const json = JSON.parse(JSON.stringify(buildCardPaymentSource(SANDBOX_TEST_CARDS[1]!)));
    expect(json.payment_source.card.number).toBe("5555555555554444");
  });
});

describe("orderPayload — application context", () => {
  // The hosted approval screen is unreliable without it. Not schema-required,
  // but worth pinning so a cleanup does not quietly drop it.
  it("should identify the brand and ask for a direct action", () => {
    const ctx = buildOrderPayload({ key: "k", label: "L", amountCents: 100 }).application_context;
    expect(ctx.brand_name).toBe("spendless");
    expect(ctx.user_action).toBe("PAY_NOW");
    expect(ctx.landing_page).toBe("LOGIN");
  });
});