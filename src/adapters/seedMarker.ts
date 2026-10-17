/**
 * The one identity carrier that survives a PayPal round trip.
 *
 * Measured live on 2026-10-17 against the sandbox, and the measurement is what
 * made this module necessary rather than merely tidy:
 *
 * ```text
 *   transaction_info.invoice_id         → empty
 *   transaction_info.custom_field       → empty
 *   transaction_info.transaction_subject → "Netflix monthly plan"
 * ```
 *
 * Orders v2 does not propagate `purchase_units[].invoice_id` or `custom_id`
 * into the Transaction Search reporting API, even though `invoice_id` is
 * documented as merchant-sent with the transaction. The Spike's whole purpose
 * was to find out which carrier works rather than which one sounds right, and
 * the answer was the one nobody would have guessed.
 *
 * So the identity has to live in `purchase_units[].description`, the field that
 * does survive. Two rules follow, and both are load-bearing:
 *
 * **1. The description must carry the key, not the merchant's name.** Parsing
 * `"Netflix monthly plan"` back into `sub-netflix` is a lookup table wearing a
 * disguise. It breaks on the first ambiguous name, and it cannot survive a
 * rename of the label without the detector silently starting to miss rows.
 *
 * **2. Trust must be derivable, not assumed.** `transaction_subject` is free
 * text, and PayPal populates it on its own system rows — the live T1900 reads
 * `"Initial balance"`. Treating *any* non-empty subject as an identity produced
 * a false POSITIVE on this very Spike. So the description carries an explicit
 * namespace, and only a subject matching it is seed-authored. A merchant's own
 * description, and PayPal's boilerplate, both fail the check.
 *
 * That second rule is what allows a subject-derived identity to sit in
 * `TRUSTWORTHY_IDENTITY` at all. Without it, this module would be reintroducing
 * the exact bug the namespace was added to prevent.
 */

/** Namespace on the description. Long enough to be unambiguous, short enough to read. */
export const SEED_MARKER_PREFIX = "spendless:";

/**
 * Keys become group-by keys in `recurrence.ts` and route params in the run log,
 * so the character set is restricted rather than "whatever the seed happened to
 * contain". A colon would break the prefix split; whitespace would break the
 * token read.
 */
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Build the description value written into a seeded order. */
export function seedMarker(key: string): string {
  return `${SEED_MARKER_PREFIX}${key}`;
}

/**
 * @returns the seed key when the subject is provably ours, else `null`.
 *   `null` means "not seed-authored" — which is the answer for every merchant's
 *   own description and for PayPal's system rows, and is not a failure.
 */
export function readSeedMarker(subject: string | null | undefined): string | null {
  if (typeof subject !== "string") return null;
  if (!subject.startsWith(SEED_MARKER_PREFIX)) return null;

  const rest = subject.slice(SEED_MARKER_PREFIX.length);

  // The key ends at the first *presentation* boundary — a space, or the em dash
  // used to separate it from human-facing text. A newline or a tab is not a
  // terminator: treating one as a boundary would silently truncate `a\nb` to
  // `a`, which is accepting malformed input and reporting it as a real key.
  const end = rest.search(/[ —]/);
  const key = (end === -1 ? rest : rest.slice(0, end)).trim();

  // Anything else illegal inside the key — a colon, a control character — fails
  // the pattern and is rejected outright rather than trimmed down to something
  // plausible.
  return KEY_PATTERN.test(key) ? key : null;
}
