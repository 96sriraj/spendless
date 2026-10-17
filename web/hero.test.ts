import { describe, expect, it } from "vitest";
import { heroFigure, type StateResponse } from "./hero";

/**
 * What the headline is allowed to claim.
 *
 * Every case below is a way the screen could tell a merchant something false
 * while looking correct. That is the failure mode this module exists to prevent,
 * and it is why the decisions were pulled out of `App.tsx` into something a test
 * can reach without a DOM.
 */

function state(overrides: Partial<StateResponse> = {}): StateResponse {
  return {
    generatedAt: "2026-10-17T00:00:00.000Z",
    totalRiskCents: 15_990,
    currency: "USD",
    findings: [],
    subscriptions: [],
    lanes: ["seeded_history"],
    transactionCount: 23,
    database: true,
    ...overrides,
  };
}

describe("heroFigure", () => {
  it("shows exactly what the API computed, with no arithmetic of its own", () => {
    // `totalRiskCents` is already the sum the server did. A client that summed
    // the findings again would agree today and disagree the day the server
    // changed its ranking — so this asserts equality, not near-equality.
    const hero = heroFigure(state({ totalRiskCents: 15_990 }));

    expect(hero.cents).toBe(15_990);
    expect(hero.currency).toBe("USD");
  });

  it("says nothing at risk when the total is zero, instead of claiming a risk", () => {
    // A zero in risk-coloured type reads as "you are losing money" wearing the
    // same visual language as "you are safe". So the tone changes *and* the
    // sentence states the absence explicitly.
    //
    // Note this test first asserted the headline did not contain the word "risk"
    // at all, which fails on "Nothing at risk right now" — a string that has to
    // name the thing it is denying. A substring check cannot tell a claim from
    // its denial, so the assertion is on the denial itself.
    const hero = heroFigure(state({ totalRiskCents: 0 }));

    expect(hero.tone).toBe("ink");
    expect(hero.cents).toBe(0);
    expect(hero.headline).toMatch(/nothing at risk/i);
    // Not a bare "at risk every month" with a zero in front of it.
    expect(hero.headline).not.toMatch(/^at risk/i);
  });

  it("uses the risk tone only when there is money at stake", () => {
    expect(heroFigure(state({ totalRiskCents: 1 })).tone).toBe("risk");
  });

  it("refuses to render a figure when the findings span currencies", () => {
    // `buildReadModel` withholds the total and sets `currency: null` rather than
    // adding euros to dollars. The client has to honour that: printing "$0.00 at
    // risk" off the back of a null currency would turn "I cannot tell you" into
    // "you have nothing to lose", which is the more dangerous of the two lies.
    const hero = heroFigure(state({ totalRiskCents: 0, currency: null }));

    expect(hero.totalled).toBe(false);
    expect(hero.headline).toMatch(/cannot/i);
  });

  it("names the lane the money came from, because history is not a payment", () => {
    // D5. The seeded-history lane is ours and it is history; a figure derived
    // from it must never be presented as revenue PayPal reported. The label is
    // not optional decoration — it is the difference between a demo and a lie.
    const hero = heroFigure(state({ lanes: ["seeded_history"] }));

    expect(hero.provenance).toBe("seeded history");
  });

  it("says the money is live when it came from the sandbox", () => {
    const hero = heroFigure(state({ lanes: ["live_sandbox"] }));

    expect(hero.provenance).toBe("live sandbox");
    expect(hero.provenance).not.toMatch(/history/i);
  });

  it("admits to mixing lanes rather than picking the flattering one", () => {
    const hero = heroFigure(state({ lanes: ["live_sandbox", "seeded_history"] }));

    expect(hero.provenance).toMatch(/live sandbox/i);
    expect(hero.provenance).toMatch(/seeded history/i);
  });

  it("claims no provenance at all when nothing has been read", () => {
    const hero = heroFigure(state({ lanes: [] }));

    expect(hero.provenance).toBeNull();
  });

  it("renders an honest placeholder before the first response arrives", () => {
    // `null` means "still loading", which is not the same as zero. It must not
    // flash a confident $0.00 — that is a figure the merchant will remember.
    const hero = heroFigure(null);

    expect(hero.loading).toBe(true);
    expect(hero.cents).toBe(0);
    expect(hero.totalled).toBe(false);
  });

  it("reports a missing database as a setup state, not as good news", () => {
    // H3 is still open, so this is the most likely state on a demo machine.
    // "Nothing at risk" would be the most reassuring possible lie.
    const hero = heroFigure(state({ database: false, totalRiskCents: 0 }));

    expect(hero.headline).toMatch(/database/i);
    expect(hero.tone).not.toBe("recovered");
  });

  it("never calls a non-negative total recovered, whatever the input", () => {
    // `recovered` is reserved for money the action layer actually moved. It is
    // the one tone that is a factual claim about a completed refund, so it can
    // only ever come from an executed result — never from a reading.
    for (const cents of [0, 1, 1_599, 10**9]) {
      expect(heroFigure(state({ totalRiskCents: cents })).tone).not.toBe("recovered");
    }
  });
});