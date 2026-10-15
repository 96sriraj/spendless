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

export type OrderEntry = {
  /** Stable identity the detectors key on. */
  readonly key: string;
  readonly label: string;
  readonly amountCents: number;
};

export type OrderPayload = {
  intent: "CAPTURE";
  purchase_units: {
    reference_id: string;
    invoice_id: string;
    custom_id: string;
    description: string;
    amount: { currency_code: string; value: string };
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
 */
export function buildOrderPayload(
  entry: OrderEntry,
  currency: Currency = DEFAULT_CURRENCY,
): OrderPayload {
  const value = (entry.amountCents / 100).toFixed(2);
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: entry.key,
        invoice_id: entry.key,
        custom_id: entry.key,
        description: `${entry.label} monthly plan`,
        amount: { currency_code: currency, value },
        items: [
          {
            name: entry.label,
            quantity: "1",
            unit_amount: { currency_code: currency, value },
            category: SUBSCRIPTION_ITEM_CATEGORY,
          },
        ],
      },
    ],
  };
}