/**
 * Recurrences become subscriptions — the missing link.
 *
 * `inferRecurrence` answers "is this merchant charging me regularly?" from a
 * series of transactions. It does not produce a `Subscription`, and until this
 * module existed nothing else did either: the end-to-end test builds
 * subscription rows by hand and hands them to `computeInsights`.
 *
 * That is fine for a test and useless for a demo. The figure on screen has to
 * come from money that actually arrived, which means this module has to exist
 * between "PayPal told me about three charges" and "here is a subscription".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS INVENTED HERE, AND WHY NONE OF IT IS A MONEY FIGURE
 * ---------------------------------------------------------------------------
 *
 * Three fields cannot come out of a transaction, and all three are *declared*
 * rather than guessed:
 *
 * - `name` is the merchant **key**, not a display name. No PayPal API returns a
 *   merchant name to anyone (`ARCHITECTURE.md` §11a), so writing "Netflix" here
 *   would be fabricating the exact identity the product is built around.
 * - `lastUsedDate` is **always null**. `ARCHITECTURE.md` §8 is explicit that
 *   transaction history contains no usage signal and that the agent is meant to
 *   *ask* the human for it. Filling it in from anything the data contains would
 *   make `checkUnused` fire on invented evidence — and the unused-subscription
 *   finding *is* the hero figure on the first screen.
 * - `createdAt` is the first charge, which is observed rather than assumed.
 *
 * So the only judgement in this file is the billing cycle, and it is derived
 * from a measured median gap rather than chosen.
 */

import type { Recurrence } from "./recurrence";
import { SubscriptionSchema, type Currency, type Subscription } from "./validators";

const DAY_MS = 86_400_000;

/** Which measured cadence maps onto which billing cycle. */
const CYCLE_FOR: Record<Recurrence["cadence"], Subscription["billingCycle"]> = {
  weekly: "weekly",
  monthly: "monthly",
  yearly: "yearly",
  // Unreachable: `inferRecurrence` never reports `irregular` with
  // `isRecurring: true`, because an irregular series is noise by definition.
  // Mapped rather than left as `undefined` so a future change to that rule
  // fails here instead of producing an invalid row.
  irregular: "monthly",
};

const CURRENCY_CODES: readonly Currency[] = ["USD", "INR"];

export type BuildOptions = {
  readonly now: Date;
  /** The account's settlement currency, used when a series carries an unknown one. */
  readonly currency: Currency;
};

export function buildSubscriptions(
  recurrences: readonly Recurrence[],
  options: BuildOptions,
): Subscription[] {
  const out: Subscription[] = [];

  for (const recurrence of recurrences) {
    // `isRecurring` is `inferRecurrence`'s answer and this module does not
    // re-decide it. Two answers to one question would eventually disagree.
    if (!recurrence.isRecurring) continue;

    const cycle = CYCLE_FOR[recurrence.cadence];

    /**
     * Narrowed rather than carried through.
     *
     * Order creation accepted 17 currencies on this account, so a response can
     * legitimately carry EUR or GBP. Emitting one the schema rejects would be a
     * loud failure at insert time — which is better than silently relabelling a
     * euro charge as dollars, but a demo should not fall over on data PayPal
     * itself produced. So an unsupported code falls back to the account's
     * currency, which is a stated fact rather than an invented rate.
     */
    const currency = CURRENCY_CODES.includes(recurrence.currencyCode as Currency)
      ? (recurrence.currencyCode as Currency)
      : options.currency;

    const lastGapDays = recurrence.medianGapDays ?? 30;
    const createdAt = new Date(
      options.now.getTime() - recurrence.chargeCount * lastGapDays * DAY_MS,
    ).toISOString();

    const candidate = {
      id: recurrence.merchantKey,
      /**
       * The key, not a display name. Deliberate, and the reason the demo says
       * `sub-netflix` rather than `Netflix` until a human supplies the rest.
       */
      name: recurrence.merchantKey,
      amountCents: recurrence.medianAmountCents,
      currency,
      billingCycle: cycle,
      nextRenewal: new Date(options.now.getTime() + lastGapDays * DAY_MS).toISOString(),
      category: "other",
      /** Always null. See the header — this is the one field that would lie. */
      lastUsedDate: null,
      createdAt,
      updatedAt: options.now.toISOString(),
    };

    // Parsed rather than cast. A row this module invents that the database
    // would reject is a bug worth failing on here, where the cause is visible.
    const parsed = SubscriptionSchema.safeParse(candidate);
    if (!parsed.success) continue;
    out.push(parsed.data);
  }

  return out;
}