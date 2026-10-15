import { describe, expect, it } from "vitest";
import {
  buildOrderPayload,
  ORDER_ITEM_CATEGORIES,
  SUBSCRIPTION_ITEM_CATEGORY,
} from "./orderPayload";

const NETFLIX = { key: "sub-netflix", label: "Netflix", amountCents: 1599 };

describe("orderPayload — item category", () => {
  // The first version of the seed sent category: "SUBSCRIPTION" and PayPal
  // rejected both orders with INVALID_PARAMETER_VALUE. This asserts the fix
  // cannot silently regress, and that the value is genuinely one of the three
  // the schema allows.
  it("should use a category that is actually in the Orders v2 enum", () => {
    const payload = buildOrderPayload(NETFLIX);
    const category = payload.purchase_units[0]?.items[0]?.category;
    expect(ORDER_ITEM_CATEGORIES).toContain(category as never);
  });

  it("should not send SUBSCRIPTION, which is not an Orders v2 category", () => {
    const category = buildOrderPayload(NETFLIX).purchase_units[0]?.items[0]?.category;
    expect(category).not.toBe("SUBSCRIPTION");
    expect(SUBSCRIPTION_ITEM_CATEGORY).toBe("DIGITAL_GOODS");
  });

  it("should name exactly the three categories the schema allows", () => {
    // Compared as a set: the order they appear in carries no meaning and
    // asserting it would make this test fail on a cosmetic reshuffle.
    expect([...ORDER_ITEM_CATEGORIES].sort()).toEqual([
      "DIGITAL_GOODS",
      "DONATION",
      "PHYSICAL_GOODS",
    ]);
  });
});

describe("orderPayload — shape", () => {
  it("should ask for a CAPTURE", () => {
    expect(buildOrderPayload(NETFLIX).intent).toBe("CAPTURE");
  });

  it("should write the identity into every merchant-authored carrier", () => {
    const unit = buildOrderPayload(NETFLIX).purchase_units[0];
    expect(unit?.invoice_id).toBe("sub-netflix");
    expect(unit?.custom_id).toBe("sub-netflix");
    expect(unit?.reference_id).toBe("sub-netflix");
    expect(unit?.items[0]?.name).toBe("Netflix");
  });

  it("should carry the amount as a 2dp string, which the schema requires", () => {
    const unit = buildOrderPayload(NETFLIX).purchase_units[0];
    expect(unit?.amount.value).toBe("15.99");
    expect(unit?.items[0]?.unit_amount.value).toBe("15.99");
  });

  it("should emit a 2dp value even for a whole-dollar amount", () => {
    // "20" is rejected where "20.00" is accepted. A silent 400 on the second
    // scenario entry would look like a flaky sandbox.
    const unit = buildOrderPayload({ key: "k", label: "L", amountCents: 2000 }).purchase_units[0];
    expect(unit?.amount.value).toBe("20.00");
  });

  it("should default to USD, the sandbox currency", () => {
    expect(buildOrderPayload(NETFLIX).purchase_units[0]?.amount.currency_code).toBe("USD");
  });

  it("should honour an explicit currency", () => {
    const unit = buildOrderPayload(NETFLIX, "INR").purchase_units[0];
    expect(unit?.amount.currency_code).toBe("INR");
    expect(unit?.items[0]?.unit_amount.currency_code).toBe("INR");
  });

  it("should serialise to JSON without losing a carrier", () => {
    const json = JSON.parse(JSON.stringify(buildOrderPayload(NETFLIX)));
    expect(json.purchase_units[0].invoice_id).toBe("sub-netflix");
    expect(json.purchase_units[0].items[0].category).toBe("DIGITAL_GOODS");
  });
});