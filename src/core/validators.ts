/**
 * Validators — zod schemas at DB boundary.
 * Strict TS, no any, exhaustive enums.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Branded id (optional use)
// ---------------------------------------------------------------------------
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

export function toSubscriptionId(raw: string): SubscriptionId {
  return raw as SubscriptionId;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const BillingCycleSchema = z.enum(["monthly", "yearly", "weekly"]);
export type BillingCycle = z.infer<typeof BillingCycleSchema>;

/**
 * USD or INR.
 *
 * nixt hardcoded INR (`z.enum(["INR"])`, en-IN formatters, rupee milestones)
 * because it was an India-first app. spendless talks to the PayPal sandbox,
 * which is USD. Both are supported and the currency is threaded per row - it
 * is already on the schema, so this is smaller than it looks.
 *
 * The default is USD, deliberately. A default that silently mislabels every
 * figure in the demo is worse than no default.
 */
export const CurrencySchema = z.enum(["USD", "INR"]);
export type Currency = z.infer<typeof CurrencySchema>;
export const DEFAULT_CURRENCY: Currency = "USD";

// ---------------------------------------------------------------------------
// ISO date helpers
// ---------------------------------------------------------------------------
function isValidIsoDate(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.toISOString() === new Date(value).toISOString();
}

function isFutureIsoDate(value: string): boolean {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return false;
  }
  return d.getTime() > Date.now();
}

// ---------------------------------------------------------------------------
// SubscriptionInput — creation / update payload (without id/createdAt)
// ---------------------------------------------------------------------------
export const SubscriptionInputSchema = z.object({
  name: z.string().min(1, "name required").max(64, "max 64 chars").trim(),
  amountCents: z.number().int().positive("amountCents > 0"),
  currency: CurrencySchema.default(DEFAULT_CURRENCY),
  billingCycle: BillingCycleSchema,
  nextRenewal: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "nextRenewal must be ISO date")
    .refine((v) => isFutureIsoDate(v), "nextRenewal must be in the future"),
  category: z.string().min(1).max(32).default("other"),
  notes: z.string().max(500).optional(),
  // Optional feature fields (all nullable; existing callers unaffected).
  // F1: date the free trial converts to paid.
  trialEndDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "trialEndDate must be ISO date")
    .nullable()
    .optional(),
  // F3: last date the user marked the sub as used.
  lastUsedDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "lastUsedDate must be ISO date")
    .nullable()
    .optional(),
  // F4: annual price when the merchant offers one (for switch savings math).
  annualAmountCents: z.number().int().positive("annualAmountCents > 0").nullable().optional(),
});

export type SubscriptionInput = z.infer<typeof SubscriptionInputSchema>;

// ---------------------------------------------------------------------------
// Subscription — persisted row
// ---------------------------------------------------------------------------
export const SubscriptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  amountCents: z.number().int().positive(),
  currency: CurrencySchema,
  billingCycle: BillingCycleSchema,
  nextRenewal: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "nextRenewal ISO"),
  category: z.string().min(1).max(32),
  notes: z.string().nullable().optional(),
  trialEndDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "trialEndDate ISO")
    .nullable()
    .optional(),
  lastUsedDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "lastUsedDate ISO")
    .nullable()
    .optional(),
  annualAmountCents: z.number().int().positive().nullable().optional(),
  createdAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "createdAt ISO"),
  updatedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "updatedAt ISO"),
});

export type Subscription = z.infer<typeof SubscriptionSchema>;

// ---------------------------------------------------------------------------
// KV helpers — safe parse for durableNotepad
// ---------------------------------------------------------------------------
export function safeParseSubscription(value: unknown): Subscription | null {
  const result = SubscriptionSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function safeParseSubscriptionArray(value: unknown): Subscription[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Subscription[] = [];
  for (const item of value) {
    const parsed = SubscriptionSchema.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

// Re-export helpers for dates/money to avoid circular deps
export { isValidIsoDate, isFutureIsoDate };
