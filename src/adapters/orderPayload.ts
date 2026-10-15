/**
 * Order payload construction.
 *
 * Pure and tested, because getting a PayPal request body wrong is invisible
 * until a live call rejects it - and the first version of this sent
 * `category: "SUBSCRIPTION"`, which is not an Orders v2 item category at all.
 * `SUBSCRIPTION_PREPAID` comes from the *payment_preference* enum, a different
 * field entirely, and looks close enough to be a convincing mistake.
 *
 * Every value below is taken from the published Orders v2 OpenAPI spec.
 */

import { DEFAULT_CURRENCY, type Currency } from "@/core/validators";

/** `item.category` per the Orders v2 schema. Exactly three values. */
export const ORDER_ITEM_CATEGORIES = [
  "PHYSICAL_GOODS",
  "DIGITAL_GOODS",
  "DONATION",
] as const;

export type OrderItemCategory = (typeof ORDER_ITEM_CATEGORIES)[number];

/**
 * spendless sells subscriptions, which the schema models as digital goods.
 * There is no "subscription" category - that is the whole trap.
 */
export const SUBSCRIPTION_ITEM_CATEGORY: OrderItemCategory = "DIGITAL_GOODS";

export type OrderLine = {
  readonly label: string;
  readonly amountCents: number;
};

export type OrderEntry = {
  /** Stable identity the detectors key on. */
  readonly key: string;
  readonly label: string;
  readonly amountCents: number;
  /** Further lines on the same purchase unit. */
  readonly additionalLines?: readonly OrderLine[];
};

export type OrderPayload = {
  intent: "CAPTURE";
  application_context: {
    brand_name: string;
    user_action: "PAY_NOW";
    landing_page: "LOGIN";
  };
  purchase_units: {
    reference_id: string;
    invoice_id: string;
    custom_id: string;
    description: string;
    amount: {
      currency_code: string;
      value: string;
      /**
       * Required by the schema whenever `items[].unit_amount` is present:
       * "Required if the request includes purchase_units[].items[].unit_amount.
       * Must equal the sum of (unit_amount * quantity) for all items."
       */
      breakdown: { item_total: { currency_code: string; value: string } };
    };
    items: {
      name: string;
      quantity: string;
      unit_amount: { currency_code: string; value: string };
      category: OrderItemCategory;
    }[];
  }[];
};

/**
 * Build the request body for one CAPTURE order.
 *
 * All three merchant-authored identity carriers are set on every purchase unit
 * — `invoice_id`, `custom_id` and the item `name`. PayPal returns only
 * merchant-authored fields in Transaction Search, so whichever of these
 * survives the round trip is the detector graph's identity. Setting all three
 * answers the question whichever way it lands.
 *
 * The amount breakdown is derived, never hand-written: the schema requires
 * `item_total` to equal the sum of every line, and a mismatch is a 422 that
 * reads like a malformed request rather than an arithmetic one.
 */
export function buildOrderPayload(
  entry: OrderEntry,
  currency: Currency = DEFAULT_CURRENCY,
): OrderPayload {
  const lines: OrderLine[] = [
    { label: entry.label, amountCents: entry.amountCents },
    ...(entry.additionalLines ?? []),
  ];

  const itemTotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const total = (itemTotalCents / 100).toFixed(2);

  return {
    intent: "CAPTURE",
    // Not required by the schema, but the hosted checkout renders far more
    // reliably with an explicit brand and a direct action. Its absence is one
    // of the reasons a valid order can still fail at the approval screen.
    application_context: {
      brand_name: "spendless",
      user_action: "PAY_NOW",
      landing_page: "LOGIN",
    },
    purchase_units: [
      {
        reference_id: entry.key,
        invoice_id: entry.key,
        custom_id: entry.key,
        description: `${entry.label} monthly plan`,
        amount: {
          currency_code: currency,
          value: total,
          breakdown: {
            item_total: { currency_code: currency, value: total },
          },
        },
        items: lines.map((line) => ({
          name: line.label,
          quantity: "1",
          unit_amount: {
            currency_code: currency,
            value: (line.amountCents / 100).toFixed(2),
          },
          category: SUBSCRIPTION_ITEM_CATEGORY,
        })),
      },
    ],
  };
}