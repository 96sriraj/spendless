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

describe("orderPayload — the amount breakdown the schema demands", () => {
  // The second live failure: "ITEM_TOTAL_REQUIRED - If item details are
  // specified (items.unit_amount and items.quantity) corresponding
  // amount.breakdown.item_total is required."
  it("should send item_total whenever items carry a unit_amount", () => {
    const unit = buildOrderPayload(NETFLIX).purchase_units[0];
    expect(unit?.amount.breakdown.item_total.value).toBeDefined();
    expect(unit?.amount.breakdown.item_total.currency_code).toBe("USD");
  });

  // "Must equal the sum of (items[].unit_amount * items[].quantity) for all
  // items." A mismatch is a 422 that reads as malformed rather than arithmetic.
  it("should make item_total equal the sum of every line", () => {
    const unit = buildOrderPayload({
      key: "sub-bundle",
      label: "Netflix",
      amountCents: 1_599,
      additionalLines: [{ label: "Add-ons", amountCents: 401 }],
    }).purchase_units[0];

    const sum = (unit?.items ?? []).reduce((total, item) => {
      const cents = Number(item.unit_amount.value.replace(".", "")) * Number(item.quantity);
      return total + cents;
    }, 0);

    expect(unit?.amount.breakdown.item_total.value).toBe("20.00");
    expect(unit?.amount.value).toBe(unit?.amount.breakdown.item_total.value);
    expect(sum).toBe(2_000);
  });

  it("should keep amount.value and item_total in step for a single line", () => {
    const unit = buildOrderPayload(NETFLIX).purchase_units[0];
    expect(unit?.amount.value).toBe("15.99");
    expect(unit?.amount.breakdown.item_total.value).toBe(unit?.amount.value);
  });

  it("should add one item per line", () => {
    const unit = buildOrderPayload({
      key: "sub-bundle",
      label: "Netflix",
      amountCents: 1_599,
      additionalLines: [{ label: "Add-ons", amountCents: 401 }],
    }).purchase_units[0];
    expect(unit?.items).toHaveLength(2);
    expect(unit?.items.map((i) => i.name)).toEqual(["Netflix", "Add-ons"]);
  });

  it("should give every line the subscription category", () => {
    const unit = buildOrderPayload({
      key: "sub-bundle",
      label: "Netflix",
      amountCents: 1_599,
      additionalLines: [{ label: "Add-ons", amountCents: 401 }],
    }).purchase_units[0];
    for (const item of unit?.items ?? []) {
      expect(item.category).toBe("DIGITAL_GOODS");
    }
  });

  it("should honour an explicit currency in the breakdown too", () => {
    const unit = buildOrderPayload(NETFLIX, "INR").purchase_units[0];
    expect(unit?.amount.breakdown.item_total.currency_code).toBe("INR");
  });
});

describe("orderPayload — payee currency must match", () => {
  // 2026-10-16: orders were created successfully in USD, then the hosted
  // approval screen failed behind a generic error whose base64 `code`
  // decodes to UNSUPPORTED_PAYEE_CURRENCY — the sandbox merchant account is
  // India-based and settles in INR. The mismatch surfaces on the web screen and
  // never on an API response, so it reads like a broken page rather than a bad
  // currency. Hence: every money field carries the same explicit currency.
  it("should carry the requested currency on every money field", () => {
    const unit = buildOrderPayload(NETFLIX, "INR").purchase_units[0];
    expect(unit?.amount.currency_code).toBe("INR");
    expect(unit?.amount.breakdown.item_total.currency_code).toBe("INR");
    expect(unit?.items[0]?.unit_amount.currency_code).toBe("INR");
  });

  it("should make a currency mismatch visible in the payload", () => {
    expect(buildOrderPayload(NETFLIX, "INR").purchase_units[0]?.amount.currency_code).not.toBe(
      buildOrderPayload(NETFLIX, "USD").purchase_units[0]?.amount.currency_code,
    );
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
