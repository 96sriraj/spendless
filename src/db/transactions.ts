/**
 * Transactions, as stored.
 *
 * Separate from the `AccountSource` that produced them: an adapter reads
 * transactions from PayPal or a CSV, and this is where they land so that
 * recurrence inference and the detectors have something to work from twice.
 *
 * `custom_id` carries the marker `seedMarker` wrote, which is the **only**
 * identity carrier measured to survive Orders v2 → Transaction Search. The
 * column is named after PayPal's field and holds ours; see `seedMarker.ts` for
 * why `invoice_id` and `custom_field` cannot be relied on instead.
 */

import type { Database } from "./index";
import type { Currency } from "@/core/validators";

export type StoredTransaction = {
  readonly id: string;
  readonly subscriptionId: string | null;
  readonly merchantName: string;
  readonly merchantId: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly billingCycle: string | null;
  readonly direction: "sale" | "refund";
  readonly status: "completed" | "pending" | "denied" | "refunded";
  readonly capturedAt: string;
  readonly customId: string | null;
  readonly raw: string | null;
};

export type NewTransaction = {
  readonly id: string;
  readonly merchantName: string;
  readonly amountCents: number;
  readonly currency: Currency | string;
  readonly capturedAt: string;
  readonly customId?: string | null;
  readonly direction?: "sale" | "refund";
  readonly status?: "completed" | "pending" | "denied" | "refunded";
  readonly raw?: unknown;
};

function toStored(row: Record<string, unknown>): StoredTransaction {
  return {
    id: String(row["id"]),
    subscriptionId:
      row["subscription_id"] === null || row["subscription_id"] === undefined
        ? null
        : String(row["subscription_id"]),
    merchantName: String(row["merchant_name"]),
    merchantId: row["merchant_id"] === null ? null : String(row["merchant_id"]),
    amountCents: Number(row["amount_cents"]),
    currency: String(row["currency"]),
    billingCycle: row["billing_cycle"] === null ? null : String(row["billing_cycle"]),
    direction: String(row["direction"]) as StoredTransaction["direction"],
    status: String(row["status"]) as StoredTransaction["status"],
    capturedAt: String(row["captured_at"]),
    customId: row["custom_id"] === null ? null : String(row["custom_id"]),
    raw: row["raw"] === null ? null : String(row["raw"]),
  };
}

/**
 * Insert, ignoring a duplicate id.
 *
 * `INSERT OR IGNORE` rather than `INSERT` because the demo re-seeds freely, and
 * a second seed run failing on a primary-key collision would be a support
 * ticket rather than a no-op. The alternative — `ON CONFLICT DO UPDATE` — was
 * rejected deliberately: overwriting a row silently would let a re-seed change
 * history that the run log already described.
 */
export async function insertTransaction(
  db: Database,
  tx: NewTransaction,
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO transactions
       (id, subscription_id, merchant_name, merchant_id, amount_cents, currency,
        billing_cycle, direction, status, captured_at, custom_id, raw)
     VALUES (?, NULL, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    tx.id,
    tx.merchantName,
    tx.amountCents,
    tx.currency,
    tx.direction ?? "sale",
    tx.status ?? "completed",
    tx.capturedAt,
    tx.customId ?? null,
    tx.raw === undefined ? null : JSON.stringify(tx.raw),
  );
}

export async function listTransactions(db: Database): Promise<StoredTransaction[]> {
  const rows = await db.all<Record<string, unknown>>(
    "SELECT * FROM transactions ORDER BY captured_at, id",
  );
  return rows.map(toStored);
}

export async function countTransactions(db: Database): Promise<number> {
  const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions");
  return row?.n ?? 0;
}

export async function clearTransactions(db: Database): Promise<void> {
  await db.run("DELETE FROM transactions");
}