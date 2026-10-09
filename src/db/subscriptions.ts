/**
 * Subscriptions repository — the boundary between D1 rows and the lifted
 * detector graph.
 *
 * Raw SQL plus zod, the idiom ARCHITECTURE.md section 5 chose deliberately.
 * Every row is validated by `SubscriptionSchema` on the way in, so a malformed
 * row is dropped at the edge instead of becoming a NaN amount somewhere
 * downstream.
 */

import { SubscriptionSchema, type Subscription } from "@/core/validators";
import type { Database } from "./index";

const COLUMNS = `
  id, name, amount_cents, currency, billing_cycle, next_renewal, category,
  trial_end_date, last_used_date, annual_amount_cents, notes,
  created_at, updated_at
`;

/** Pure row -> domain mapping. Exported because it is the part worth testing. */
export function rowToSubscription(row: Record<string, unknown>): Subscription | null {
  const parsed = SubscriptionSchema.safeParse({
    id: row["id"],
    name: row["name"],
    amountCents: row["amount_cents"],
    currency: row["currency"],
    billingCycle: row["billing_cycle"],
    nextRenewal: row["next_renewal"],
    category: row["category"] ?? "other",
    trialEndDate: row["trial_end_date"] ?? null,
    lastUsedDate: row["last_used_date"] ?? null,
    annualAmountCents: row["annual_amount_cents"] ?? null,
    notes: row["notes"] ?? null,
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
  });
  return parsed.success ? parsed.data : null;
}

export function subscriptionToRow(sub: Subscription): Record<string, unknown> {
  return {
    id: sub.id,
    name: sub.name,
    amount_cents: sub.amountCents,
    currency: sub.currency,
    billing_cycle: sub.billingCycle,
    next_renewal: sub.nextRenewal,
    category: sub.category,
    trial_end_date: sub.trialEndDate ?? null,
    last_used_date: sub.lastUsedDate ?? null,
    annual_amount_cents: sub.annualAmountCents ?? null,
    notes: sub.notes ?? null,
    created_at: sub.createdAt,
    updated_at: sub.updatedAt,
  };
}

export async function insertSubscription(db: Database, sub: Subscription): Promise<void> {
  const r = subscriptionToRow(sub);
  await db.run(
    `INSERT INTO subscriptions (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r["id"],
    r["name"],
    r["amount_cents"],
    r["currency"],
    r["billing_cycle"],
    r["next_renewal"],
    r["category"],
    r["trial_end_date"],
    r["last_used_date"],
    r["annual_amount_cents"],
    r["notes"],
    r["created_at"],
    r["updated_at"],
  );
}

/**
 * Every subscription the detectors can reason about. Ordered by id so the
 * detector graph sees a stable input regardless of how rows were inserted -
 * `computeInsights` is deterministic, and this is half of why.
 */
export async function listSubscriptions(db: Database): Promise<Subscription[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM subscriptions ORDER BY id`,
  );
  const out: Subscription[] = [];
  for (const row of rows) {
    const sub = rowToSubscription(row);
    if (sub !== null) out.push(sub);
  }
  return out;
}