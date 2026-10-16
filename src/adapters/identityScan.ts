/**
 * Scanning every transaction for a merchant-authored identity.
 *
 * The first version of the Spike read `transactions[0]` and reported whatever
 * it found. That is wrong in precisely the situation the answer is needed: this
 * account also holds a T1900 "general account correction" for $5,000 which
 * carries no identity fields at all, and Transaction Search returns rows in an
 * order we do not control. The one seeded payment could land at index 2, and the
 * Spike would report `unknown` from the unrelated adjustment while the answer
 * sat unexamined in the same response.
 *
 * A check that can only ever look at one row answers `unknown` for the wrong
 * reason, and that is indistinguishable from the failure it is meant to detect.
 */

import type { RawTransaction } from "./AccountSource";

export type ScannableTransaction = RawTransaction;

export type IdentityScan = {
  /** Rows carrying a merchant-authored key, in the order PayPal returned them. */
  readonly identified: readonly ScannableTransaction[];
  /** Rows carrying nothing recognisable. Counted, never dropped. */
  readonly unidentified: readonly ScannableTransaction[];
  /** The row a verdict should be written about. `null` when there are none. */
  readonly subject: ScannableTransaction | null;
};

/**
 * A row counts as identified when any carrier resolved — `invoice_id`,
 * `custom_field`, `transaction_subject`, or an item name.
 *
 * `subject` is included deliberately. A row carrying only that is still a row
 * we can recognise, and classifying it as unidentified would discard the only
 * evidence available.
 */
function isIdentified(row: ScannableTransaction): boolean {
  return row.identitySource !== "unknown" || (row.subject?.trim().length ?? 0) > 0;
}

export function pickIdentitySubjects(rows: readonly ScannableTransaction[]): IdentityScan {
  const identified = rows.filter(isIdentified);
  const unidentified = rows.filter((row) => !isIdentified(row));

  return {
    identified,
    unidentified,
    // The subject has to be the row that carries the answer. Falling back to
    // the first row keeps the "what did we read at all" reporting working on a
    // fresh account, where nothing carries identity yet.
    subject: identified[0] ?? rows[0] ?? null,
  };
}
