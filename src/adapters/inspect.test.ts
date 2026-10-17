import { describe, expect, it } from "vitest";
import { seedMarker } from "./seedMarker";
import {
  fieldInventory,
  findMerchantIdentity,
  readTransactions,
  readAmountCents,
  IDENTITY_FIELDS,
} from "./inspect";

/**
 * A response shaped like PayPal's `search_response`, trimmed to one entry.
 * Field names are the real ones from the published OpenAPI spec - this is the
 * shape the Spike has to survive, not a convenient one.
 */
const RESPONSE = {
  account_number: "ABC123",
  start_date: "2026-09-01T00:00:00Z",
  end_date: "2026-09-30T23:59:59Z",
  total_items: 1,
  total_pages: 1,
  page: 1,
  transaction_details: [
    {
      transaction_info: {
        paypal_account_id: "MERCHANT123",
        transaction_id: "TXN0001",
        paypal_reference_id: "REF0001",
        paypal_reference_id_type: "custom_id",
        transaction_event_code: "T0001",
        transaction_initiation_date: "2026-09-03T14:22:10Z",
        transaction_updated_date: "2026-09-03T14:22:11Z",
        transaction_amount: { currency_code: "USD", value: "15.99" },
        fee_amount: { currency_code: "USD", value: "-1.32" },
        transaction_status: "S",
        transaction_subject: "Netflix Premium Monthly",
        invoice_id: "sub-netflix",
        custom_field: "",
        instrument_type: "PAYPAL",
      },
      payer_info: {
        account_id: "BUYER999",
        email_address: "buyer@example.com",
        payer_name: { given_name: "Sam", surname: "Buyer", full_name: "Sam Buyer" },
      },
      shipping_info: {},
      cart_info: { item_detail: [{ name: "Netflix Premium", quantity: "1" }] },
      store_info: {},
    },
  ],
  links: [],
};

describe("inspect — fieldInventory", () => {
  it("should list every field the response actually returned", () => {
    const inventory = fieldInventory(RESPONSE);
    expect(inventory).toContain("transaction_info.transaction_id");
    expect(inventory).toContain("transaction_info.transaction_amount.value");
    expect(inventory).toContain("payer_info.email_address");
    expect(inventory).toContain("cart_info.item_detail[].name");
  });

  it("should report what is absent as well as what is present", () => {
    // The Spike asks "does list_transactions return enough detail". An inventory
    // that only lists what arrived answers half the question: the fields that
    // matter most are the ones that are missing.
    const inventory = fieldInventory(RESPONSE);
    expect(inventory).toContain("payer_info.account_status");
  });

  it("should not explode on an empty response", () => {
    expect(fieldInventory({ transaction_details: [] })).toEqual([]);
  });

  it("should handle a null body without throwing", () => {
    expect(fieldInventory(null)).toEqual([]);
  });

  it("should return a sorted, de-duplicated inventory", () => {
    const inventory = fieldInventory(RESPONSE);
    expect([...inventory].sort()).toEqual(inventory);
    expect(new Set(inventory).size).toBe(inventory.length);
  });
});

describe("inspect — findMerchantIdentity", () => {
  it("should prefer invoice_id, which the spec says the merchant sent", () => {
    expect(findMerchantIdentity(RESPONSE)).toMatchObject({
      merchantKey: "sub-netflix",
      identitySource: "seed_invoice_id",
    });
  });

  it("should fall back to custom_field, the other merchant-authored field", () => {
    const withoutInvoice = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: {
            ...RESPONSE.transaction_details[0]!.transaction_info,
            invoice_id: "",
            custom_field: "sub-custom",
          },
        },
      ],
    };
    expect(findMerchantIdentity(withoutInvoice)).toMatchObject({
      merchantKey: "sub-custom",
      identitySource: "seed_custom_field",
    });
  });

  it("should NOT treat a bare subject as an identity, because PayPal writes those too", () => {
    // This assertion used to expect `transaction_subject: "Netflix Premium
    // Monthly"` to resolve as an identity. That is what produced the false
    // POSITIVE on the live Spike: PayPal populates `transaction_subject` on its
    // own system rows, and the T1900 adjustment reads "Initial balance". A
    // subject is free text and is only ours when it says so.
    const subjectOnly = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: {
            ...RESPONSE.transaction_details[0]!.transaction_info,
            invoice_id: "",
            custom_field: "",
          },
        },
      ],
    };
    expect(findMerchantIdentity(subjectOnly)).toMatchObject({
      merchantKey: "unknown",
      identitySource: "unknown",
    });
  });

  it("should resolve a subject that carries our seed marker, and name the source", () => {
    // The only carrier measured to survive Orders v2 → Transaction Search.
    const marked = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: {
            ...RESPONSE.transaction_details[0]!.transaction_info,
            invoice_id: "",
            custom_field: "",
            transaction_subject: `${seedMarker("sub-netflix")} — Netflix monthly plan`,
          },
        },
      ],
    };

    expect(findMerchantIdentity(marked)).toMatchObject({
      merchantKey: "sub-netflix",
      identitySource: "seed_marker",
      foundIn: "transaction_subject",
    });
  });

  it("should report unknown rather than inventing a name", () => {
    const anonymous = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: {
            ...RESPONSE.transaction_details[0]!.transaction_info,
            invoice_id: "",
            custom_field: "",
            transaction_subject: "",
          },
        },
      ],
    };
    // "unknown" is the honest answer. Inventing one would put a fabricated
    // merchant into a finding a user is asked to act on.
    expect(findMerchantIdentity(anonymous)).toMatchObject({
      merchantKey: "unknown",
      identitySource: "unknown",
    });
  });

  it("should name the fields it looks for, so the Spike can be checked against them", () => {
    expect(IDENTITY_FIELDS.map((f) => f.field)).toEqual([
      "invoice_id",
      "custom_field",
      "transaction_subject",
    ]);
  });

  it("should return unknown for an empty response", () => {
    expect(findMerchantIdentity({ transaction_details: [] })).toMatchObject({
      identitySource: "unknown",
    });
  });
});

describe("inspect — readTransactions", () => {
  it("should read every transaction in the response", () => {
    expect(readTransactions(RESPONSE)).toHaveLength(1);
  });

  it("should map the amount to integer minor units", () => {
    expect(readTransactions(RESPONSE)[0]?.amountCents).toBe(1_599);
  });

  it("should map the PayPal status codes onto the port's enum", () => {
    expect(readTransactions(RESPONSE)[0]?.status).toBe("settled");
  });

  it("should read the event code, for the recurring-payment filter MCP cannot do", () => {
    expect(readTransactions(RESPONSE)[0]?.eventCode).toBe("T0001");
  });

  it("should keep the verbatim response for later recovery", () => {
    expect(readTransactions(RESPONSE)[0]?.raw).toMatchObject({
      transaction_info: { transaction_id: "TXN0001" },
    });
  });

  it("should skip a transaction with no amount rather than emit zero", () => {
    const broken = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: { ...RESPONSE.transaction_details[0]!.transaction_info, transaction_amount: null },
        },
      ],
    };
    expect(readTransactions(broken)).toEqual([]);
  });

  // RED on a bug this account surfaced. Order creation accepts 17 currency
  // codes here, so a response can legitimately carry EUR or GBP. The old code
  // defaulted anything unrecognised to USD - which would have relabelled a euro
  // transaction as dollars, and that shows up as plausible numbers on screen
  // rather than as a crash.
  it("should carry the provider's currency code through verbatim", () => {
    const euros = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: {
            ...RESPONSE.transaction_details[0]!.transaction_info,
            transaction_amount: { currency_code: "EUR", value: "15.99" },
          },
        },
      ],
    };
    expect(readTransactions(euros)[0]?.currencyCode).toBe("EUR");
  });

  it("should drop a transaction with no currency rather than invent one", () => {
    const noCurrency = {
      ...RESPONSE,
      transaction_details: [
        {
          ...RESPONSE.transaction_details[0]!,
          transaction_info: {
            ...RESPONSE.transaction_details[0]!.transaction_info,
            transaction_amount: { value: "15.99" },
          },
        },
      ],
    };
    expect(readTransactions(noCurrency)).toEqual([]);
  });
});

describe("inspect — readAmountCents", () => {
  it("should read a money object", () => {
    expect(readAmountCents({ currency_code: "USD", value: "15.99" })).toBe(1_599);
  });

  it("should return null for a missing or unusable value", () => {
    expect(readAmountCents(null)).toBeNull();
    expect(readAmountCents({ currency_code: "USD" })).toBeNull();
    expect(readAmountCents({ currency_code: "USD", value: "n/a" })).toBeNull();
  });
});