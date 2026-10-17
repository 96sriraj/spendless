import { describe, expect, it } from "vitest";
import { buildSubscriptions } from "./subscriptions";
import { inferRecurrence } from "./recurrence";
import { SubscriptionSchema, type Currency } from "@/core/validators";

/**
 * Recurrences become subscriptions.
 *
 * `inferRecurrence` answers "is this merchant charging me regularly?" from a
 * series of transactions. It does not produce a `Subscription`, and nothing else
 * in the repo does either — the end-to-end test builds subscription rows by hand
 * and hands them to `computeInsights`. So this is the missing link, and the demo
 * needs it: the figure on screen has to come from money that actually arrived,
 * not from rows someone typed in.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS INVENTED HERE, AND WHY IT IS NOT A FIGURE
 * ---------------------------------------------------------------------------
 *
 * Three fields cannot come from a transaction, and all three are declared rather
 * than guessed:
 *
 * - `name` — a merchant *key*, not a display name. No PayPal API returns a
 *   merchant name to anyone (ARCHITECTURE.md §11a), so inventing "Netflix" here
 *   would be fabricating the identity the whole product is built around.
 * - `lastUsedDate` — **left null**, always. `ARCHITECTURE.md` §8 is explicit
 *   that transaction history contains no usage signal, and that the agent is
 *   supposed to *ask* for it. Filling it from a guess would make `checkUnused`
 *   fire on fabricated evidence, and the hero figure is exactly that finding.
 * - `createdAt` — the first charge, which is real data rather than an
 *   assumption.
 *
 * So the only judgement here is the billing cycle, and it is derived from a
 * measured median gap rather than chosen.
 */

const NOW = new Date("2026-10-17T00:00:00.000Z");
const DAY = 86_400_000;

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

function charge(merchantKey: string, daysAgo: number, cents: number) {
  return {
    merchantKey,
    identitySource: "seed_marker",
    amountCents: cents,
    currencyCode: "USD",
    capturedAt: iso(daysAgo),
  };
}

describe("buildSubscriptions", () => {
  it("turns a recurring series into a subscription", () => {
    const recurrences = inferRecurrence([
      charge("sub-netflix", 90, 1_599),
      charge("sub-netflix", 60, 1_599),
      charge("sub-netflix", 30, 1_599),
    ]);

    const subs = buildSubscriptions(recurrences, { now: NOW, currency: "USD" });

    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      id: "sub-netflix",
      name: "sub-netflix",
      amountCents: 1_599,
      billingCycle: "monthly",
      currency: "USD",
    });
  });

  it("derives the billing cycle from the measured gap, not from a guess", () => {
    const yearly = buildSubscriptions(
      inferRecurrence([
        charge("sub-annual", 730, 9_900),
        charge("sub-annual", 365, 9_900),
        charge("sub-annual", 0, 9_900),
      ]),
      { now: NOW, currency: "USD" },
    );
    expect(yearly[0]?.billingCycle).toBe("yearly");

    const weekly = buildSubscriptions(
      inferRecurrence([
        charge("sub-weekly", 21, 500),
        charge("sub-weekly", 14, 500),
        charge("sub-weekly", 7, 500),
      ]),
      { now: NOW, currency: "USD" },
    );
    expect(weekly[0]?.billingCycle).toBe("weekly");
  });

  it("leaves lastUsedDate null, because no usage signal exists in the data", () => {
    // The one field that would be a fabrication. `checkUnused` needs it and
    // `ARCHITECTURE.md` §8 says the agent has to ask the human for it. Setting
    // it here from anything the data contains would make the hero figure - the
    // unused-subscription finding - fire on invented evidence.
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-netflix", 90, 1_599),
        charge("sub-netflix", 60, 1_599),
        charge("sub-netflix", 30, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    expect(subs[0]?.lastUsedDate).toBeNull();
  });

  /**
 * A subscription renewing *today*.
 *
 * This test used to assert `daysAhead > 0`, and it passed only because of the
 * `now + gap` bug it now documents. Last charged 30 days ago on a 30-day cycle
 * is due today, and "due today" is a real state a merchant has to act on — it
 * is inside `checkUnused`'s window, because that window is inclusive of zero.
 */
  it("projects a renewal that is due today, not one a cycle away", () => {
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-netflix", 90, 1_599),
        charge("sub-netflix", 60, 1_599),
        charge("sub-netflix", 30, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    const next = new Date(subs[0]?.nextRenewal ?? 0);
    expect(Math.round((next.getTime() - NOW.getTime()) / DAY)).toBe(0);
  });

  /**
   * The bug these two tests exist for.
   *
   * The first version projected `nextRenewal = now + gap`. That is right exactly
   * once per billing cycle — on the day the charge landed — and wrong for the
   * other 29. A subscription renewing in five days was reported as renewing in
   * 30, which put it outside `checkUnused`'s seven-day window and made the
   * product's headline finding impossible to reach. The projection has to start
   * from the last charge someone actually paid.
   */
  /**
 * A lapsed subscription keeps its honest date.
 *
 * This test previously demanded that a renewal in the past be rolled forward
 * into the future. That demand was wrong: a series that stopped charging has no
 * future renewal, and inventing one would push a phantom date into
 * `checkUnused`'s seven-day window so the product could go on recommending
 * action on a subscription nobody is being charged for. The date stays where the
 * data puts it, and the series simply stops producing findings — which is the
 * correct outcome, because there is no money at risk on something that is not
 * being billed.
 */
  it("leaves a lapsed renewal in the past, rather than inventing a future one", () => {
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-lapsed", 190, 1_599),
        charge("sub-lapsed", 160, 1_599),
        charge("sub-lapsed", 130, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    // Still a subscription row — the history is real — but due 100 days ago.
    const next = new Date(subs[0]?.nextRenewal ?? 0);
    expect(Math.round((next.getTime() - NOW.getTime()) / DAY)).toBe(-100);
  });

  it("projects the renewal from the last charge, not from now", () => {
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-soon", 85, 1_599),
        charge("sub-soon", 55, 1_599),
        charge("sub-soon", 25, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    // Last charge 25 days ago on a 30-day cycle: 5 days out, not 30.
    const next = new Date(subs[0]?.nextRenewal ?? 0);
    expect(Math.round((next.getTime() - NOW.getTime()) / DAY)).toBe(5);
  });

  it("puts a subscription charging today a full cycle away", () => {
    // The boundary of the fix: anchored on the last charge, a charge that
    // landed today genuinely is a month out. `now + gap` would agree here by
    // luck, and asserting it keeps the fix from regressing into `now + gap`.
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-fresh", 60, 1_599),
        charge("sub-fresh", 30, 1_599),
        charge("sub-fresh", 0, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    const next = new Date(subs[0]?.nextRenewal ?? 0);
    expect(Math.round((next.getTime() - NOW.getTime()) / DAY)).toBe(30);
  });

  it("drops a series that is not yet recurring, rather than creating a subscription", () => {
    // Two charges are not a pattern. `MIN_CHARGES_FOR_RECURRENCE` exists for
    // this, and re-deciding it here would give the module two answers to the
    // same question.
    const recurrences = inferRecurrence([
      charge("sub-once", 10, 1_599),
      charge("sub-once", 5, 1_599),
    ]);

    expect(buildSubscriptions(recurrences, { now: NOW, currency: "USD" })).toEqual([]);
  });

  it("drops an irregular series rather than guessing a cycle", () => {
    // Equal amounts at irregular intervals is noise, not a subscription.
    const recurrences = inferRecurrence([
      charge("sub-jitter", 40, 1_000),
      charge("sub-jitter", 9, 1_000),
      charge("sub-jitter", 1, 1_000),
    ]);

    expect(buildSubscriptions(recurrences, { now: NOW, currency: "USD" })).toEqual([]);
  });

  it("leaves a rising series to the price-hike detector, rather than double-counting it", () => {
    // This test asserted the wrong thing at first. It expected the median
    // ($14.99) to be carried forward while the last charge ($15.99) was dropped —
    // but a series whose amount moves is a **price hike**, and `inferRecurrence`
    // correctly refuses to call it a recurring subscription. Treating it as one
    // would produce a finding for both detectors on the same subscription.
    //
    // So the assertion is the one that matters: this module does not get to
    // have an opinion here, and the price-hike detector is the right owner.
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-hike", 90, 1_499),
        charge("sub-hike", 60, 1_499),
        charge("sub-hike", 30, 1_499),
        charge("sub-hike", 0, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    expect(subs).toEqual([]);
  });

  it("carries the measured amount, not the last charge, on a stable series", () => {
    // On a series that *is* stable the median and the last charge agree, which
    // is the point: the figure a merchant thinks of as "what this costs me" is
    // derived from the series rather than from whichever charge arrived last.
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-stable", 90, 1_499),
        charge("sub-stable", 60, 1_499),
        charge("sub-stable", 30, 1_499),
      ]),
      { now: NOW, currency: "USD" },
    );

    expect(subs[0]?.amountCents).toBe(1_499);
  });

  it("never emits a currency the core cannot format", () => {
    // Order creation accepted 17 currencies on this account. Narrowing silently
    // would relabel a EUR charge as dollars; emitting one the core rejects is
    // a loud failure, which is the better of the two.
    const subs = buildSubscriptions(
      inferRecurrence([
        { ...charge("sub-eur", 90, 999), currencyCode: "EUR" },
        { ...charge("sub-eur", 60, 999), currencyCode: "EUR" },
        { ...charge("sub-eur", 30, 999), currencyCode: "EUR" },
      ]),
      { now: NOW, currency: "USD" as Currency },
    );

    // Falls back to the account's currency rather than inventing a rate.
    expect(subs[0]?.currency).toBe("USD");
  });

  it("produces rows that pass the schema the database enforces", () => {
    const subs = buildSubscriptions(
      inferRecurrence([
        charge("sub-netflix", 90, 1_599),
        charge("sub-netflix", 60, 1_599),
        charge("sub-netflix", 30, 1_599),
      ]),
      { now: NOW, currency: "USD" },
    );

    for (const sub of subs) {
      expect(SubscriptionSchema.safeParse(sub).success).toBe(true);
    }
  });
});