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
import { seedMarker } from "./seedMarker";

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
  /**
   * Present only when `modern: true`.
   *
   * Every field of the old top-level `application_context` — brand_name,
   * landing_page, user_action, locale — was **deprecated in Orders v2.9** and
   * moved under `payment_source.paypal.experience_context`. Setting the
   * deprecated form is how the first approval attempt produced an approval link
   * with an empty `merchantName=` and PayPal's generic error page.
   */
  payment_source?: {
    paypal: {
      experience_context: {
        brand_name: string;
        landing_page: "LOGIN" | "BILLING";
        user_action: "PAY_NOW";
        shipping_preference: "NO_SHIPPING";
      };
    };
  };
};

/**
 * Build the request body for one CAPTURE order.
 *
 * All three merchant-authored identity carriers are set on every purchase unit —
 * `invoice_id`, `custom_id` and the item `name`. **Measured live 2026-10-17:**
 * only the `description` survives into Transaction Search; `invoice_id` and
 * `custom_field` come back empty. The other two are still set, because they are
 * the documented carriers and would be the better answer if PayPal populated
 * them, but nothing depends on them.
 *
 * The `description` therefore leads with the seed marker, which is the one
 * carrier proven to round-trip. The human-readable label follows it, so the
 * field still reads sensibly in the PayPal dashboard and in the video:
 *
 * ```text
 *   spendless:sub-netflix — Netflix monthly plan
 * ```
 *
 * The key must come first and unparsed. Recovering `sub-netflix` from
 * `"Netflix monthly plan"` would be a lookup table wearing a disguise, and it
 * would silently start missing rows the first time a label was ambiguous.
 *
 * The amount breakdown is derived, never hand-written: the schema requires
 * `item_total` to equal the sum of every line, and a mismatch is a 422 that
 * reads like a malformed request rather than an arithmetic one.
 */
export function buildOrderPayload(
  entry: OrderEntry,
  currency: Currency = DEFAULT_CURRENCY,
  options: { readonly modern?: boolean } = {},
): OrderPayload {
  const lines: OrderLine[] = [
    { label: entry.label, amountCents: entry.amountCents },
    ...(entry.additionalLines ?? []),
  ];

  const itemTotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const total = (itemTotalCents / 100).toFixed(2);

  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: entry.key,
        invoice_id: entry.key,
        custom_id: entry.key,
        // Marker first, label second. See the note above: this field is the only
        // one measured to survive, so it has to carry the key itself.
        description: `${seedMarker(entry.key)} — ${entry.label} monthly plan`,
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
    ...(options.modern === true
      ? {
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: "spendless",
                landing_page: "LOGIN" as const,
                user_action: "PAY_NOW" as const,
                shipping_preference: "NO_SHIPPING" as const,
              },
            },
          },
        }
      : {}),
  };
}