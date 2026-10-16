/**
 * Scanning every transaction for a merchant-authored identity.
 *
 * The first version of the Spike read `transactions[0]` and reported whatever
 * it found. That is wrong in precisely the situation the answer is needed: this
 * account also holds a T1900 "general account correction" for $5,000 which
 * carries no identity fields at all, and Transaction Search returns rows in an
 * order we do not control. The seeded payment could land at index 2, and the
 * Spike would report `unknown` from the unrelated adjustment while the answer
 * sat unexamined in the same response.
 *
 * The second version then over-corrected into a false POSITIVE, by treating any
 * non-empty `transaction_subject` as an identity. PayPal populates that field on
 * its own system rows — the live T1900 reads `subject="Initial balance"` — so
 * the Spike reported S-2-live as POSITIVE while `"unknown" via unknown` was the
 * actual answer. `TRUSTWORTHY_IDENTITY` already existed and already excluded
 * this carrier. This module uses it instead of inventing a criterion.
 *
 * The general lesson, and the reason both mistakes were the same mistake: a
 * check that cannot report `unknown` correctly will eventually report a
 * confident wrong answer, and a confident wrong answer about whether identity
 * survives a round trip is the one failure this Spike cannot afford.
 */

import { TRUSTWORTHY_IDENTITY, type RawTransaction } from "./AccountSource";

export type ScannableTransaction = RawTransaction;

export type IdentityScan = {
  /** Rows carrying a trustworthy identity — strong enough to key a detector on. */
  readonly identified: readonly ScannableTransaction[];
  /** Rows carrying only free-text `transaction_subject`. A lead, not a key. */
  readonly weakOnly: readonly ScannableTransaction[];
  /** Rows carrying nothing recognisable at all. Counted, never dropped. */
  readonly unidentified: readonly ScannableTransaction[];
  /** The row a verdict should be written about. `null` when there are none. */
  readonly subject: ScannableTransaction | null;
};

/**
 * Strong enough to key a detector on.
 *
 * Membership, not a hand-written list, and deliberately not "has a subject".
 * Anything outside `TRUSTWORTHY_IDENTITY` is untrustworthy by default, so a
 * source added later cannot silently become a detector key.
 */
function isIdentified(row: ScannableTransaction): boolean {
  return TRUSTWORTHY_IDENTITY.includes(row.identitySource);
}

/** A free-text subject with no trustworthy key alongside it. */
function isWeakOnly(row: ScannableTransaction): boolean {
  return !isIdentified(row) && (row.subject?.trim().length ?? 0) > 0;
}

export function pickIdentitySubjects(rows: readonly ScannableTransaction[]): IdentityScan {
  const identified = rows.filter(isIdentified);
  const weakOnly = rows.filter(isWeakOnly);
  const unidentified = rows.filter((row) => !isIdentified(row) && !isWeakOnly(row));

  return {
    identified,
    weakOnly,
    unidentified,
    // The subject has to be the row that carries the answer. A trustworthy row
    // always wins over a weak one, because writing the verdict about the
    // stronger evidence is the whole point. Falling back to the first row keeps
    // the "what did we read at all" reporting working on a fresh account.
    subject: identified[0] ?? rows[0] ?? null,
  };
}
