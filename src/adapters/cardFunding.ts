/**
 * Card funding, so a sandbox payment can be completed without a browser.
 *
 * The Orders v2 approval screen failed on 2026-10-16 with PayPal's generic
 * "Things don't appear to be working at the moment" error. That is a hosted
 * *web checkout* failure, not an API failure — the order itself was created
 * fine, with `invoice_id` and `custom_id` intact.
 *
 * But approval is not the only route the API offers. `confirm-payment-source`
 * accepts a raw payment source, and PayPal's sandbox accepts test card numbers.
 * So the whole journey — create, fund, capture — can run unattended, which
 * matters with the kill switch days away and a browser flow that cannot be
 * automated or rehearsed.
 *
 * These are PayPal's documented sandbox test numbers. They are not real cards,
 * they are not anyone's card, and they cannot move real money. See
 * human-todo.md H1-05c.
 */

export type CardBrand = "visa" | "mastercard";

export type TestCard = {
  readonly brand: CardBrand;
  readonly number: string;
  /** Internet date format, e.g. "2030-12". */
  readonly expiry: string;
  readonly securityCode: string;
  readonly name: string;
};

/**
 * PayPal sandbox test cards.
 *
 * Deliberately constants rather than configuration: these are not secrets,
 * they are published test values that only work in a sandbox, and a configurable
 * card number is a foot-gun pointed at production.
 */
export const SANDBOX_TEST_CARDS: readonly TestCard[] = [
  { brand: "visa", number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "SPENDLESS TEST" },
  { brand: "mastercard", number: "5555555555554444", expiry: "2030-12", securityCode: "123", name: "SPENDLESS TEST" },
];

export type CardPaymentSource = {
  payment_source: {
    card: {
      number: string;
      expiry: string;
      security_code: string;
      name: string;
    };
  };
};

export function buildCardPaymentSource(card: TestCard): CardPaymentSource {
  return {
    payment_source: {
      card: {
        number: card.number,
        expiry: card.expiry,
        security_code: card.securityCode,
        name: card.name,
      },
    },
  };
}

/** The PAN must be 13-19 digits per the schema; anything else is a 400. */
export function isValidPan(card: TestCard): boolean {
  return /^[0-9]{13,19}$/.test(card.number);
}