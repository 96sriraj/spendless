import { describe, expect, it } from "vitest";
import { pickIdentitySubjects } from "./identityScan";
import type { RawTransaction } from "./AccountSource";

/**
 * The spike asked "does a merchant-authored identity survive the round trip?"
 * by inspecting `transactions[0]` and reporting whatever it found.
 *
 * That is wrong in the exact situation the answer is needed. The account also
 * holds a T1900 "general account correction" for $5,000, which carries no
 * identity fields at all. Transaction Search returns rows in an order we do not
 * control, so the one seeded payment could land at index 2 and the spike would
 * report `unknown` from the unrelated adjustment — while the answer sat
 * unexamined in the same response.
 *
 * A Spike that can only ever look at one row answers `unknown` for the wrong
 * reason, which is indistinguishable from the failure it is meant to detect.
 */

/** A real `RawTransaction`; only the fields the scan reads are interesting. */
const row = (over: Partial<RawTransaction> = {}): RawTransaction => ({
  id: "T1",
  eventCode: "T0000",
  amountCents: 1599,
  currencyCode: "USD",
  capturedAt: "2026-10-17T00:00:00Z",
  status: "settled",
  merchantKey: "unknown",
  identitySource: "unknown",
  subject: null,
  raw: {},
  ...over,
});

describe("pickIdentitySubjects", () => {
  it("should find the seeded payment when an unrelated row comes first", () => {
    // The exact live shape: a $5,000 account correction, then our capture.
    const found = pickIdentitySubjects([
      row({ id: "647530330R035101U", eventCode: "T1900", amountCents: 500_000 }),
      row({ id: "31F89528X81443109", merchantKey: "sub-netflix", identitySource: "seed_invoice_id" }),
    ]);

    expect(found.identified).toHaveLength(1);
    expect(found.identified[0]!.merchantKey).toBe("sub-netflix");
    expect(found.unidentified).toHaveLength(1);
  });

  it("should NOT count a system adjustment's boilerplate subject as an identity", () => {
    // The real row, live, 2026-10-16. This is the false positive that made the
    // Spike report POSITIVE off a T1900 "Initial balance" row:
    //
    //   647530330R035101U  T1900  500000  "unknown" via unknown  subject="Initial balance"
    //
    // PayPal populates `transaction_subject` on its own system rows. Treating a
    // non-empty subject as an identity claims S-2-live is answered when no
    // merchant identity round-tripped at all — and a false POSITIVE is worse
    // than a false unknown, because it closes a question nobody answered.
    // TRUSTWORTHY_IDENTITY already excludes this carrier for exactly this reason.
    const found = pickIdentitySubjects([
      row({
        id: "647530330R035101U",
        eventCode: "T1900",
        amountCents: 500_000,
        merchantKey: "unknown",
        identitySource: "unknown",
        subject: "Initial balance",
      }),
    ]);

    expect(found.identified).toEqual([]);
    expect(found.weakOnly).toHaveLength(1);
    expect(found.subject?.id).toBe("647530330R035101U");
  });

  it("should separate subject-only rows from genuinely unattributable ones", () => {
    // A free-text subject is a lead worth surfacing, but not a detector key.
    // Collapsing it into "unidentified" would hide it; counting it as identified
    // would overstate what the read path can actually do.
    const found = pickIdentitySubjects([
      row({ id: "A", subject: "Netflix monthly plan" }),
      row({ id: "B" }),
    ]);

    expect(found.weakOnly.map((r) => r.id)).toEqual(["A"]);
    expect(found.unidentified.map((r) => r.id)).toEqual(["B"]);
  });

  it("should NOT let a subject-only row become the subject when a real identity exists", () => {
    const found = pickIdentitySubjects([
      row({ id: "WEAK", subject: "Initial balance" }),
      row({ id: "REAL", merchantKey: "sub-netflix", identitySource: "seed_invoice_id" }),
    ]);

    expect(found.subject?.id).toBe("REAL");
  });

  it("should treat every non-trustworthy source as untrustworthy, not just unknown", () => {
    // `transaction_subject` is the only source outside TRUSTWORTHY_IDENTITY
    // besides `unknown`, but a future source must default to untrustworthy
    // rather than silently being counted as a detector key.
    const found = pickIdentitySubjects([
      row({ id: "A", identitySource: "transaction_subject", subject: "anything" }),
    ]);

    expect(found.identified).toEqual([]);
    expect(found.weakOnly).toHaveLength(1);
  });

  it("should keep every identified row, not just the first", () => {
    // Three merchants at three different prices is the actual demo scenario.
    // Reporting one would hide the recurrence the detectors depend on.
    const found = pickIdentitySubjects([
      row({ id: "A", merchantKey: "sub-netflix", identitySource: "seed_invoice_id" }),
      row({ id: "B", merchantKey: "sub-adobe", identitySource: "seed_custom_field" }),
      row({ id: "C", merchantKey: "sub-spotify", identitySource: "seed_invoice_id" }),
    ]);

    expect(found.identified.map((r) => r.merchantKey)).toEqual([
      "sub-netflix",
      "sub-adobe",
      "sub-spotify",
    ]);
  });

  it("should count rows with nothing at all rather than dropping them", () => {
    // A row we cannot identify is not noise to be silently discarded — the
    // count is how you tell "nothing seeded yet" from "seeded and unreadable".
    const found = pickIdentitySubjects([
      row({ id: "A" }),
      row({ id: "B" }),
      row({ id: "C", merchantKey: "sub-netflix", identitySource: "seed_invoice_id" }),
    ]);

    expect(found.identified).toHaveLength(1);
    expect(found.unidentified).toHaveLength(2);
  });

  it("should handle an empty result without inventing a subject", () => {
    const found = pickIdentitySubjects([]);

    expect(found.identified).toEqual([]);
    expect(found.weakOnly).toEqual([]);
    expect(found.unidentified).toEqual([]);
    expect(found.subject).toBeNull();
  });

  it("should fall back to the first row as the subject when none are identified", () => {
    // So the existing "what did we read at all" reporting still works on a
    // fresh account, where nothing carries identity yet.
    const found = pickIdentitySubjects([
      row({ id: "647530330R035101U", eventCode: "T1900", amountCents: 500_000 }),
    ]);

    expect(found.subject?.id).toBe("647530330R035101U");
    expect(found.identified).toEqual([]);
  });

  it("should prefer an identified row as the subject over an earlier unidentified one", () => {
    // The subject is the row the verdict is written about, so it has to be the
    // row that actually carries the answer.
    const found = pickIdentitySubjects([
      row({ id: "ADJUSTMENT", eventCode: "T1900" }),
      row({ id: "SEEDED", merchantKey: "sub-netflix", identitySource: "seed_invoice_id" }),
    ]);

    expect(found.subject?.id).toBe("SEEDED");
  });
});
