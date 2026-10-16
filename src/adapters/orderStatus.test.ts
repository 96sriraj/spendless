import { describe, expect, it } from "vitest";
import { describeBlocker, readOrderState } from "./orderStatus";

/**
 * The hosted approval screen hangs at "Pay Now" and never resolves. That is a
 * symptom with at least three different causes, and they are indistinguishable
 * from the browser: the page shows a spinner either way.
 *
 * The order's own status is not. Reading it tells us which of the three we are
 * looking at, and in one of them it removes the browser from the critical path
 * entirely — an APPROVED order can be captured server-side, so a spin that never
 * redirects can still produce a real payment.
 */

const order = (over: Record<string, unknown> = {}) => ({
  id: "6F060014AL5057822",
  status: "CREATED",
  links: [],
  ...over,
});

describe("readOrderState", () => {
  it("should report the order id and status verbatim", () => {
    expect(readOrderState(order())!).toMatchObject({
      id: "6F060014AL5057822",
      status: "CREATED",
    });
  });

  it("should mark an APPROVED order as capturable, because the browser is then unnecessary", () => {
    expect(readOrderState(order({ status: "APPROVED" }))!.capturable).toBe(true);
  });

  it("should not mark a CREATED order as capturable", () => {
    // The trap: PayPal answers 422 on capture, and the 422 is about state, not
    // credentials, so it reads like a permissions problem and sends you looking
    // in the wrong place.
    expect(readOrderState(order({ status: "CREATED" }))!.capturable).toBe(false);
  });

  it("should not mark an already-captured order as capturable", () => {
    expect(readOrderState(order({ status: "COMPLETED" }))!.capturable).toBe(false);
  });

  it("should find the payer-action link by rel, and return it verbatim", () => {
    const href = "https://www.sandbox.paypal.com/checkoutnow?token=6F060014AL5057822";
    const state = readOrderState(
      order({
        links: [
          { href: "https://api.sandbox.paypal.com/v2/checkout/orders/1/self", rel: "self" },
          { href, rel: "payer-action" },
          { href: "https://api.sandbox.paypal.com/v2/checkout/orders/1/capture", rel: "capture" },
        ],
      }),
    )!;

    expect(state.payerActionHref).toBe(href);
  });

  it("should survive a response with no links array at all", () => {
    // Order lookups return `links`; capture responses return
    // `purchase_units[].payments.captures`. Neither shape is guaranteed.
    expect(readOrderState({ id: "X", status: "COMPLETED" })!.payerActionHref).toBeNull();
  });

  it("should surface PayPal's error name when the response is a failure", () => {
    // The one piece of information that has unblocked this repeatedly is the
    // machine-readable failure. Losing it in a parse is how a two-minute
    // diagnosis turns into an afternoon of guessing.
    const state = readOrderState({ name: "UNSUPPORTED_PAYEE_CURRENCY", message: "nope" })!;

    expect(state.status).toBe("ERROR");
    expect(state.problem).toBe("UNSUPPORTED_PAYEE_CURRENCY");
  });

  it("should return null for a body that is not an order at all", () => {
    expect(readOrderState({ debug_id: "abc" })).toBeNull();
    expect(readOrderState("not an object")).toBeNull();
  });
});

describe("describeBlocker", () => {
  it("should say the order is ready to capture, and not ask for browser work", () => {
    // This is the payoff case: the buyer approved, the page just never
    // redirected. Telling them to click again would be actively harmful — a
    // second click on an APPROVED order invalidates the first.
    expect(describeBlocker(readOrderState(order({ status: "APPROVED" }))!!)).toBe(
      "APPROVED - capture it server-side. Do not re-open the approval link.",
    );
  });

  it("should say the payment already landed, so no action is needed", () => {
    expect(describeBlocker(readOrderState(order({ status: "COMPLETED" }))!!)).toBe(
      "COMPLETED - already captured. No action needed.",
    );
  });

  it("should point at the buyer when the order is still waiting on them", () => {
    const text = describeBlocker(readOrderState(order({ status: "PAYER_ACTION_REQUIRED" }))!);

    expect(text).toContain("PAYER_ACTION_REQUIRED");
    expect(text).toMatch(/buyer/i);
  });

  it("should name PayPal's error code when the order failed outright", () => {
    const text = describeBlocker(
      readOrderState({ name: "UNSUPPORTED_PAYEE_CURRENCY", message: "nope" })!!,
    );

    expect(text).toContain("UNSUPPORTED_PAYEE_CURRENCY");
  });

  it("should fall back to the raw status for one it has never seen", () => {
    // A status we do not recognise must still be reported. Silently mapping it
    // to a known state is how a new PayPal state gets misdiagnosed as an old
    // familiar problem.
    expect(describeBlocker(readOrderState(order({ status: "SOMETHING_NEW" }))!)).toBe(
      "SOMETHING_NEW - unrecognised status, report it rather than guessing.",
    );
  });
});
