/**
 * Money formatting for the client.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECOND `money.ts`
 * ---------------------------------------------------------------------------
 *
 * `src/core/money.ts` already formats minor units, and it is the one that
 * matters: it is what the run log and the ledger use, so a figure rendered in
 * the UI and the same figure rendered in a proposal must be identical.
 *
 * This is the *edge* of that module, not a reimplementation. It exists for two
 * reasons and no others:
 *
 *  1. **`Intl` is heavy.** `src/core` runs in workerd and in Node, and pulling
 *     a full ICU formatter into the client bundle to print `$47.97` costs more
 *     than the formatting is worth. The arithmetic is three lines.
 *  2. **The client sometimes holds a currency the core did not narrow.** A
 *     `RawTransaction.currencyCode` is deliberately a plain string, because
 *     this account accepted 17 currencies at order creation. The core's `Currency`
 *     is `USD | INR`; a transaction can legitimately be neither.
 *
 * So this accepts any ISO code and passes it through. It does **not** guess a
 * symbol for an unknown currency — an unrecognised code renders as the code
 * next to a correctly-grouped number, which is honest, rather than a `$` that
 * is a lie.
 */

const SYMBOLS: Readonly<Record<string, string>> = {
  USD: "$",
  INR: "₹",
  EUR: "€",
  GBP: "£",
};

export function formatMinor(cents: number, currency: string): string {
  if (!Number.isFinite(cents)) return "—";

  const code = currency.trim().toUpperCase();
  // Grouped, always. "$4797" is a number you have to read left to right;
  // "$4,797" is one you read.
  const grouped = (Math.abs(cents) / 100)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const symbol = SYMBOLS[code];
  // The sign goes outside the symbol, the way a negative invoice reads. "$-
  // 15.99" looks like a typo; "-$15.99" does not.
  const sign = cents < 0 ? "-" : "";

  return symbol === undefined ? `${sign}${grouped} ${code}` : `${sign}${symbol}${grouped}`;
}