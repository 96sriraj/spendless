/**
 * Response inspection.
 *
 * This exists for one job: answer Spike S-2-live with evidence rather than
 * inference. ARCHITECTURE.md section 11a established, from the OpenAPI spec,
 * that no PayPal response contains a merchant name. What it could not
 * establish is which field *does* come back populated once we have written one.
 *
 * So when a live call finally happens, these functions turn the raw JSON into a
 * field inventory and a verdict, and the answer gets written into the doc
 * instead of guessed at again.
 *
 * Pure functions only. Nothing here makes a network call - `scripts/spike.ts`
 * does that.
 */

import {
  type Currency,
} from "@/core/validators";
import type { IdentitySource, RawTransaction, TransactionStatus } from "./AccountSource";
import { readSeedMarker } from "./seedMarker";

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

/**
 * Every field path the response actually contains, plus the known-optional ones
 * that are *missing*. The inventory is the Spike's evidence: a list of only
 * what arrived would hide exactly the absence that matters.
 */
export function fieldInventory(body: unknown): string[] {
  const KNOWN_OPTIONAL = [
    "transaction_info.invoice_id",
    "transaction_info.custom_field",
    "transaction_info.transaction_subject",
    "payer_info.account_status",
    "cart_info.item_detail",
  ];

  const root = asRecord(body);
  if (root === null) return [];

  const details = Array.isArray(root["transaction_details"]) ? root["transaction_details"] : [];

  // With no rows there is nothing to compare against, so "these fields are
  // absent" cannot be concluded - only "there was no data". Claiming the former
  // would let a silent, empty response read as evidence about the schema.
  if (details.length === 0) return [];

  const found = new Set<string>();

  const walk = (value: unknown, prefix: string): void => {
    const record = asRecord(value);
    if (record === null) return;
    for (const [key, child] of Object.entries(record)) {
      const path = `${prefix}${key}`;
      found.add(path);
      const nested = asRecord(child);
      if (nested !== null) {
        walk(child, `${path}.`);
        continue;
      }
      if (Array.isArray(child)) {
        const first = asRecord(child[0]);
        if (first !== null) {
          for (const k of Object.keys(first)) found.add(`${path}[].${k}`);
        }
      }
    }
  };

  for (const detail of details) walk(detail, "");
  for (const path of KNOWN_OPTIONAL) found.add(path);

  return [...found].sort();
}

/**
 * The fields a merchant can author, in descending order of trustworthiness.
 *
 * Measured live 2026-10-17. `invoice_id` and `custom_field` both come back
 * **empty** from Transaction Search, even though Orders v2 accepts them and
 * `invoice_id` is documented as merchant-sent with the transaction. They are
 * kept first because they are the documented carriers and would be the better
 * answer if PayPal ever populated them - but nothing may depend on them today.
 * `transaction_subject` is what actually survives.
 */
export const IDENTITY_FIELDS: readonly { readonly field: string; source: IdentitySource }[] = [
  { field: "invoice_id", source: "seed_invoice_id" },
  { field: "custom_field", source: "seed_custom_field" },
  { field: "transaction_subject", source: "seed_marker" },
];

export type IdentityVerdict = {
  readonly merchantKey: string;
  readonly identitySource: IdentitySource;
  /** Which field decided it. Null when nothing usable was present. */
  readonly foundIn: string | null;
};

export function findMerchantIdentity(body: unknown): IdentityVerdict {
  const unknownVerdict: IdentityVerdict = {
    merchantKey: "unknown",
    identitySource: "unknown",
    foundIn: null,
  };

  const details = firstDetail(body);
  if (details === null) return unknownVerdict;
  const info = asRecord(details["transaction_info"]);
  if (info === null) return unknownVerdict;

  for (const { field, source } of IDENTITY_FIELDS) {
    const value = info[field];
    if (typeof value === "string" && value.trim().length > 0) {
      // `transaction_subject` is free text, and PayPal populates it on its own
      // system rows. It only counts as an identity when it carries our marker —
      // see seedMarker.ts, and the false POSITIVE recorded in ARCHITECTURE.md
      // §11c that this guard exists to prevent.
      if (field === "transaction_subject") {
        const seeded = readSeedMarker(value);
        if (seeded !== null) {
          return { merchantKey: seeded, identitySource: "seed_marker", foundIn: field };
        }
        continue;
      }
      return { merchantKey: value.trim(), identitySource: source, foundIn: field };
    }
  }

  // "unknown" is the honest answer. Inventing a name would put a fabricated
  // merchant into a finding the user is being asked to act on.
  return unknownVerdict;
}

function firstDetail(body: unknown): Json | null {
  const root = asRecord(body);
  if (root === null) return null;
  const details = root["transaction_details"];
  if (!Array.isArray(details) || details.length === 0) return null;
  return asRecord(details[0]);
}

/** Money object -> integer minor units. Null rather than NaN. */
export function readAmountCents(money: unknown): number | null {
  const record = asRecord(money);
  if (record === null) return null;
  const value = record["value"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[$£€\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const minor = (fraction.slice(0, 2) + "00").slice(0, 2);
  const cents = Number(whole ?? "0") * 100 + Number(minor);
  return Number.isFinite(cents) ? Math.abs(cents) : null;
}

/**
 * The ISO code as the provider sent it, or null when absent.
 *
 * Kept separate from the domain mapping below because the two must not be
 * confused. Order creation accepts 17 currencies on this account, so a
 * response can legitimately carry EUR or GBP - and silently reporting those as
 * USD would corrupt every money figure in the demo while looking perfectly
 * healthy. Read the raw code; map it deliberately.
 */
export function readCurrencyCode(money: unknown): string | null {
  const record = asRecord(money);
  const code = record?.["currency_code"];
  return typeof code === "string" && code.length > 0 ? code.toUpperCase() : null;
}

/**
 * Map a provider ISO code onto a currency the product can render.
 *
 * Returns null for anything outside the supported set rather than defaulting.
 * The first version defaulted to USD, which meant a EUR transaction would be
 * labelled dollars - a bug that shows up as plausible numbers rather than as a
 * crash, and would have reached the video.
 */
export function readCurrency(money: unknown): Currency | null {
  const code = readCurrencyCode(money);
  if (code === "USD" || code === "INR") return code;
  return null;
}

/** PayPal's single-letter status codes -> the port's enum. */
const STATUS: Record<string, TransactionStatus> = {
  S: "settled",
  P: "pending",
  D: "denied",
  V: "reversed",
};

/**
 * Transaction Search response -> RawTransaction[].
 *
 * `fields=all` is not requested through the MCP tool, so `payer_info` is
 * normally absent. That is fine for the merchant-side path - the buyer is not
 * who this product is about - and it is why the identity resolution above is
 * built entirely out of merchant-authored fields.
 */
export function readTransactions(body: unknown): RawTransaction[] {
  const root = asRecord(body);
  if (root === null) return [];
  const details = root["transaction_details"];
  if (!Array.isArray(details)) return [];

  const out: RawTransaction[] = [];
  for (const detail of details) {
    const record = asRecord(detail);
    if (record === null) continue;
    const info = asRecord(record["transaction_info"]);
    if (info === null) continue;

    const id = info["transaction_id"];
    const date = info["transaction_initiation_date"];
    const amountCents = readAmountCents(info["transaction_amount"]);
    if (typeof id !== "string" || typeof date !== "string" || amountCents === null) {
      continue;
    }

    const identity = findMerchantIdentity(record);
    const currencyCode = readCurrencyCode(info["transaction_amount"]);
    // A transaction with no currency cannot be given a value honestly, and a
    // wrong currency is worse than a missing one: it corrupts every figure
    // downstream while still looking plausible on screen.
    if (currencyCode === null) continue;

    out.push({
      id,
      merchantKey: identity.merchantKey,
      identitySource: identity.identitySource,
      amountCents,
      currencyCode,
      capturedAt: new Date(date).toISOString(),
      eventCode: typeof info["transaction_event_code"] === "string" ? info["transaction_event_code"] : "",
      status: STATUS[String(info["transaction_status"])] ?? "settled",
      subject: typeof info["transaction_subject"] === "string" ? info["transaction_subject"] : null,
      raw: record,
    });
  }
  return out;
}