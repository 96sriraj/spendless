import { describe, expect, it } from "vitest";
import {
  classifyEventCode,
  exclusionReason,
  isPaymentEvent,
  PAYMENT_EVENT_GROUPS,
} from "./eventCodes";

describe("eventCodes — the one the Spike actually returned", () => {
  // The sandbox shipped with exactly one transaction: T1900, $5,000. That is
  // not a payment, it is a general account correction. It is why the Spike
  // found no identity - there was nothing to have one.
  it("should classify T1900 as an account adjustment, not a payment", () => {
    expect(classifyEventCode("T1900")).toBe("account adjustment (no business event)");
    expect(isPaymentEvent("T1900")).toBe(false);
  });

  it("should explain why T1900 was excluded", () => {
    expect(exclusionReason("T1900")).toContain("not a payment");
  });
});

describe("eventCodes — payments", () => {
  it("should treat the account-to-account payment group as payments", () => {
    for (const code of ["T0001", "T0006", "T0007", "T0010", "T0019", "T0021"]) {
      expect(isPaymentEvent(code), code).toBe(true);
    }
  });

  it("should treat the general wallet group as payments", () => {
    expect(isPaymentEvent("T3000")).toBe(true);
  });

  it("should expose the payment groups it recognises", () => {
    expect(PAYMENT_EVENT_GROUPS).toEqual(["T00", "T30"]);
  });
});

describe("eventCodes — money that is not a purchase", () => {
  it("should exclude fees", () => {
    expect(classifyEventCode("T0106")).toBe("fee");
    expect(isPaymentEvent("T0106")).toBe(false);
  });

  it("should exclude reversals and chargeback holds", () => {
    expect(classifyEventCode("T1106")).toContain("reversal");
    expect(isPaymentEvent("T1106")).toBe(false);
  });

  it("should exclude transfers, withdrawals and conversions", () => {
    for (const code of ["T0200", "T1700", "T2000", "T0500", "T0600", "T0700"]) {
      expect(isPaymentEvent(code), code).toBe(false);
    }
  });
});

describe("eventCodes — the unknown", () => {
  // PayPal adds event types. A new one must leave a transaction out of a
  // recurrence series, never into one on a guess.
  it("should not classify a code it does not know", () => {
    expect(classifyEventCode("T99nn")).toBeNull();
    expect(isPaymentEvent("T99nn")).toBe(false);
  });

  it("should say an unknown code is unrecognised rather than guessing", () => {
    expect(exclusionReason("T99nn")).toContain("unrecognised");
  });

  it("should give no exclusion reason for a real payment", () => {
    expect(exclusionReason("T0001")).toBeNull();
  });

  it("should survive an empty or malformed code", () => {
    expect(isPaymentEvent("")).toBe(false);
    expect(classifyEventCode("")).toBeNull();
    expect(exclusionReason("")).toContain("unrecognised");
  });

  it("should be case-insensitive, since the wire format is uppercase", () => {
    expect(isPaymentEvent("t0001")).toBe(true);
  });
});