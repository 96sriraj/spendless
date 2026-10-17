/**
 * The seam. Everything above this layer depends on these two interfaces and
 * never on MCP, REST, or a CSV parser.
 *
 * Three things in here are not decorative — each exists because research into
 * PayPal's actual API forced it (ARCHITECTURE.md section 11a):
 *
 * 1. `listTransactions` accepts any range and every implementation must chunk.
 *    PayPal caps a transaction-search window at 31 days and the MCP wrapper
 *    clamps client-side *silently*. An adapter that forwards the caller's range
 *    is a data-loss bug wearing an interface.
 *
 * 2. `RawTransaction` carries `identitySource` alongside `merchantKey`, because
 *    no PayPal API returns a merchant name to anyone. Identity comes either
 *    from something the seed authored (`invoice_id`) or from a CSV export. The
 *    port is honest about which, so the UI can show it and the agent can
 *    discount a weak one.
 *
 * 3. `capabilities()` is on the interface, not in a README. The MCP dispute
 *    tools call `/v1/customer/disputes`, the buyer's namespace, and may not
 *    authenticate for a merchant at all. An adapter says so structurally
 *    instead of 403-ing on camera.
 *
 * No module above this layer may import `openai`, `@paypal/agent-toolkit`, or
 * `node:fs`. That single rule is the entire risk hedge: if MCP turns out to
 * cover everything, the other adapters can be deleted and nothing moves.
 */

import { z } from "zod";
import type { Currency } from "@/core/validators";

export type DateRange = {
  readonly start: Date;
  readonly end: Date;
};

/**
 * Where a transaction's merchant identity came from, strongest first.
 *
 * There is no `merchantName` field in PayPal's transaction response, because a
 * merchant already knows its own name and a buyer has no consumer-side read.
 * So identity is either something *we* wrote when seeding the scenario, or
 * something a consumer CSV export contained.
 */
export const IDENTITY_SOURCES = [
  /** `invoice_id` — documented as "sent by the merchant with the transaction". */
  "seed_invoice_id",
  /** `custom_field` — "the merchant-provided custom text". */
  "seed_custom_field",
  /**
   * The marker we write into `purchase_units[].description`, read back out of
   * `transaction_subject`.
   *
   * **This is the only carrier measured to survive** Orders v2 → Transaction
   * Search (2026-10-17). The two above are documented and both come back empty.
   *
   * Distinct from the raw `transaction_subject` source: a subject only counts
   * when it carries our namespace, so PayPal's own boilerplate and a merchant's
   * free text are both correctly rejected. See `seedMarker.ts`.
   */
  "seed_marker",
  /** `transaction_subject` — a free-text description, not a key. Weak. */
  "transaction_subject",
  /** The payee name in a consumer activity export. Real, but only from CSV. */
  "csv_payee",
  /** Nothing usable. The transaction is real but unattributable. */
  "unknown",
] as const;

export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

/** Strong enough to key a detector on. Below this, the transaction is orphaned. */
export const TRUSTWORTHY_IDENTITY: readonly IdentitySource[] = [
  "seed_invoice_id",
  "seed_custom_field",
  // Trustworthy *because* it is namespaced, not because the field it came from
  // is. Without the marker check this entry would reintroduce the false
  // POSITIVE on the T1900 "Initial balance" row.
  "seed_marker",
  "csv_payee",
];

export const TransactionStatusSchema = z.enum([
  "settled",
  "pending",
  "denied",
  "reversed",
]);

export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export type RawTransaction = {
  /** PayPal's own id, or a synthetic one for CSV rows. */
  readonly id: string;
  /**
   * The stable identity the detector graph keys on. Derived from
   * `identitySource` — never invented.
   */
  readonly merchantKey: string;
  readonly identitySource: IdentitySource;
  readonly amountCents: number;
  /**
   * The ISO code exactly as the provider sent it.
   *
   * Deliberately a plain string, not our `Currency` enum. This account accepts
   * 17 currency codes at order creation, so a response can legitimately carry
   * EUR or GBP — narrowing that here to USD|INR would either relabel a euro
   * transaction as dollars or silently drop it. Both are worse than carrying
   * the truth and deciding at the edge where we can say so.
   */
  readonly currencyCode: string;
  /** ISO 8601. */
  readonly capturedAt: string;
  /** PayPal's five-digit T-code, e.g. "T0001". Empty for CSV rows. */
  readonly eventCode: string;
  readonly status: TransactionStatus;
  readonly subject: string | null;
  /**
   * The verbatim provider response. Kept because Spike S-2-live is still open:
   * the answer must be recoverable from data already collected rather than by
   * re-running the sandbox later.
   */
  readonly raw: unknown;
};

export type RawSubscription = {
  readonly id: string;
  readonly merchantKey: string;
  readonly planId: string | null;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly billingCycle: "monthly" | "yearly" | "weekly";
  readonly nextBillingAt: string | null;
  readonly status: "active" | "cancelled" | "suspended" | "expired";
  readonly raw: unknown;
};

export type RawDispute = {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly amountCents: number | null;
  readonly currency: Currency | null;
  readonly dueAt: string | null;
  readonly raw: unknown;
};

/**
 * What an adapter can actually do, discovered rather than assumed.
 *
 * The dispute lanes are the reason this exists: the MCP server exposes only
 * `/v1/customer/disputes`, which is the buyer's namespace. A merchant's
 * credentials may not reach it. The demo asks this instead of finding out
 * mid-recording.
 */
export type AccountCapabilities = {
  readonly listTransactions: boolean;
  readonly listSubscriptions: boolean;
  readonly listDisputes: boolean;
  readonly refund: boolean;
  readonly cancelSubscription: boolean;
  readonly resolveDispute: boolean;
};

export type AdapterKind = "mcp" | "rest" | "csv";

export interface AccountSource {
  /** Which binding this is. Drives the SANDBOX indicator and the run log. */
  readonly kind: AdapterKind;
  capabilities(): Promise<AccountCapabilities>;
  /**
   * MUST return every transaction in `range`. Implementations chunk internally;
   * a 31-day provider cap is the implementation's problem, not the caller's.
   */
  listTransactions(range: DateRange): Promise<RawTransaction[]>;
  listSubscriptions(): Promise<RawSubscription[]>;
  /**
   * Rejects with a typed `UnsupportedCapabilityError` when the adapter says it
   * cannot list disputes. Never returns an empty list to mean "unavailable" -
   * "no disputes" and "cannot see disputes" are different answers.
   */
  listDisputes(): Promise<RawDispute[]>;
}

export class UnsupportedCapabilityError extends Error {
  readonly capability: string;
  readonly adapter: AdapterKind;

  constructor(capability: string, adapter: AdapterKind, reason: string) {
    super(`${adapter} adapter cannot ${capability}: ${reason}`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.adapter = adapter;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ActionKindSchema = z.enum([
  "refund",
  "cancel_subscription",
  "resolve_dispute",
]);

export type ActionKind = z.infer<typeof ActionKindSchema>;

export const DisputeMoveSchema = z.enum([
  /** Merchant accepts the buyer's claim. Money returns to the buyer. */
  "accept_claim",
  /** Merchant submits evidence to contest it. */
  "provide_evidence",
  /** Merchant pays the buyer to settle without a decision. */
  "offer",
  /** Merchant appeals an arbitration decision. */
  "appeal",
]);

export type DisputeMove = z.infer<typeof DisputeMoveSchema>;

export type RefundInput = {
  readonly captureId: string;
  /** Omit for a full refund. Minor units. */
  readonly amountCents?: number;
  readonly currency: Currency;
  readonly note: string;
};

export type RefundResult = {
  readonly refundId: string;
  readonly status: "pending" | "completed" | "failed";
  /**
   * What was refunded, or `null` when the binding did not report it.
   *
   * Nullable because that is a real case, not a theoretical one: measured
   * 2026-10-17, the MCP `create_refund` response carries `{ id, status, links }`
   * and **no `amount` field**, so a full refund has nothing to echo. A partial
   * refund is known, because the caller asked for it.
   *
   * `0` is not an acceptable substitute. It reads as "refunded nothing", which
   * would put a $0.00 refund in the run log beside a capture that had just been
   * reversed — and the run log is the demo's evidence.
   */
  readonly amountCents: number | null;
  readonly currency: Currency;
  readonly raw: unknown;
};

export type ActionResult = {
  readonly status: "succeeded" | "failed" | "skipped";
  readonly providerRef: string | null;
  readonly message: string;
  readonly raw: unknown;
};

export interface ActionExecutor {
  readonly kind: AdapterKind;
  refund(input: RefundInput): Promise<RefundResult>;
  cancelSubscription(subscriptionId: string): Promise<ActionResult>;
  /**
   * Merchant-side dispute moves. The MCP server cannot do this — it only
   * exposes the buyer's `/v1/customer/disputes` namespace — so an MCP executor
   * reports this as unsupported rather than pretending.
   */
  resolveDispute(disputeId: string, move: DisputeMove): Promise<ActionResult>;
}