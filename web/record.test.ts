import { describe, expect, it } from "vitest";
import { recordPayloadsFor, type RecordCandidate } from "./record";
import type { LocalRefundResult } from "./localRefund";

/**
 * Which sidecar results get recorded into the store, and as what.
 *
 * The rule: a real refund that PayPal settled is recorded ONCE, with the real
 * refund id and only per successful result. A refused sidecar refund (PayPal
 * answering "already refunded", say) is never recorded — recording it would
 * write a refund that did not happen into the ledger that proves recovery.
 */

function candidate(overrides: Partial<RecordCandidate> = {}): RecordCandidate {
  return {
    id: "act-1",
    subId: "sub-netflix",
    amountCents: 1_599,
    currency: "USD",
    ...overrides,
  };
}

function result(overrides: Partial<LocalRefundResult> = {}): LocalRefundResult {
  return {
    ok: true,
    subId: "sub-netflix",
    refundId: "40551413F19556526",
    status: "COMPLETED",
    amountCents: 1_599,
    currency: "USD",
    message: "refund completed",
    ...overrides,
  };
}

describe("recordPayloadsFor", () => {
  it("produces one payload per successful COMPLETED refund", () => {
    const payloads = recordPayloadsFor([candidate()], [result()]);

    expect(payloads).toEqual([
      {
        proposalId: "act-1",
        subId: "sub-netflix",
        refundId: "40551413F19556526",
        status: "COMPLETED",
        amountCents: 1_599,
        currency: "USD",
      },
    ]);
  });

  it("never records a refused sidecar result", () => {
    // PayPal refusing a capture refunded in an earlier take returns ok:false.
    // The screen shows the message as-is; the store records nothing.
    const refused = result({ ok: false, refundId: undefined, status: undefined, message: "already refunded" });
    expect(recordPayloadsFor([candidate()], [refused])).toEqual([]);
  });

  it("records a sidecar result echoing PayPal's lowercase status", () => {
    // `McpPayPalExecutor` maps PayPal's COMPLETED to "completed" and the
    // sidecar echoes it verbatim; the ledger must accept the settled refund
    // whatever case it arrives in.
    const payloads = recordPayloadsFor([candidate()], [result({ status: "completed" })]);

    expect(payloads).toEqual([
      {
        proposalId: "act-1",
        subId: "sub-netflix",
        refundId: "40551413F19556526",
        status: "COMPLETED",
        amountCents: 1_599,
        currency: "USD",
      },
    ]);
  });

  it("records uppercase and lowercase settled results alike, once per subId", () => {
    const payloads = recordPayloadsFor(
      [candidate(), candidate({ id: "act-2", subId: "sub-figma", amountCents: 1_500 })],
      [
        result({ status: "completed" }),
        result({ subId: "sub-figma", refundId: "REF-UPPER", status: "COMPLETED" }),
        result({ subId: "sub-figma", refundId: "REF-LOWER-AGAIN", status: "Completed" }),
      ],
    );

    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(payloads.map((p) => p.subId)).toEqual(["sub-netflix", "sub-figma"]);
  });

  it("never records a result that is not settled COMPLETED", () => {
    const pending = result({ status: "PENDING" });
    expect(recordPayloadsFor([candidate()], [pending])).toEqual([]);
    // The same refusal holds whatever case the sidecar echoes.
    expect(recordPayloadsFor([candidate()], [result({ status: "pending" })])).toEqual([]);
  });

  it("never records a result without a refund id to prove it happened", () => {
    expect(recordPayloadsFor([candidate()], [result({ refundId: undefined })])).toEqual([]);
  });

  it("matches results to proposals by subId, so the right proposal is recorded", () => {
    const payloads = recordPayloadsFor(
      [candidate({ id: "act-figma", subId: "sub-figma", amountCents: 1_500 }), candidate()],
      [result({ subId: "sub-netflix" })],
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.proposalId).toBe("act-1");
  });

  it("records at most one payload per subId even when results are duplicated", () => {
    // The sidecar is called once per payable proposal, so duplicates are not
    // expected — but a duplicate row in the ledger is a double count of
    // recovered money, so the mapping dedupes rather than trusting arrival.
    const payloads = recordPayloadsFor(
      [candidate(), candidate({ id: "act-2" })],
      [result(), result()],
    );

    expect(payloads).toHaveLength(1);
  });

  it("carries the proposal's own currency, and the real refunded amount", () => {
    const payloads = recordPayloadsFor(
      [candidate({ amountCents: 1_500, currency: "USD" })],
      [result({ amountCents: 1_599 })],
    );

    // The amount the sidecar actually refunded is the amount recorded; the
    // store's own validation refuses it if it disagrees with the proposal.
    expect(payloads[0]?.amountCents).toBe(1_599);
    expect(payloads[0]?.currency).toBe("USD");
  });

  it("falls back to the proposal's amount when the sidecar did not return one", () => {
    const payloads = recordPayloadsFor([candidate({ amountCents: 1_599 })], [
      result({ amountCents: undefined }),
    ]);

    expect(payloads[0]?.amountCents).toBe(1_599);
  });
});
