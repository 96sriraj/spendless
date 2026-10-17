import { describe, expect, it } from "vitest";
import { createKillSwitch, type KillSwitchConfig } from "./killSwitch";

/**
 * The kill switch. P6-05.
 *
 * One property defines it, and it is the whole reason this module is not a
 * boolean: **it halts execution without halting the demo.**
 *
 * The obvious implementation — a flag the execute path checks — is right about
 * execution and wrong about everything else, because a flag checked at the top
 * of a handler is a flag someone eventually forgets to check. So the
 * separation is structural instead: rendering and execution ask the switch
 * different questions, and only one of them can be about money.
 *
 * Two failure modes are worth naming, because both look like working software:
 *
 * - **A kill switch that kills the demo too.** The recording is on screen; a
 *   thrown error instead of a rendered "execution halted" banner means the
 *   footage is a stack trace. The switch must leave every read path working.
 * - **A kill switch that kills rendering but not execution.** The opposite
 *   mistake, and the dangerous one: the UI says halted while a refund completes.
 *   Hence `assertNotKilled` below — the assertion is the inverse on purpose.
 */

function halted(): KillSwitchConfig {
  return { executionEnabled: false };
}

function live(): KillSwitchConfig {
  return { executionEnabled: true };
}

describe("createKillSwitch", () => {
  it("reports the configured state without needing an injected clock", () => {
    expect(createKillSwitch(halted()).isHalted()).toBe(true);
    expect(createKillSwitch(live()).isHalted()).toBe(false);
  });

  it("lets everything except execution continue while halted", () => {
    const kill = createKillSwitch(halted());

    // Reading is what makes the demo legible. A switch that took the read path
    // down with it would be a switch that deletes the evidence.
    expect(kill.canRead()).toBe(true);
    expect(kill.canRenderRunLog()).toBe(true);
    expect(kill.canRenderFindings()).toBe(true);
    expect(kill.canPropose()).toBe(true);
  });

  it("blocks execution while halted, and only execution", () => {
    expect(createKillSwitch(halted()).canExecute()).toBe(false);
    expect(createKillSwitch(live()).canExecute()).toBe(true);
  });

  it("refuses execution with an explanation rather than a thrown error", async () => {
    const kill = createKillSwitch(halted());
    // A throw here would propagate into the HTTP handler and replace a rendered
    // banner with a 500 during the recording.
    await expect(kill.assertCanExecute("refund")).resolves.toMatchObject({ ok: false });
  });

  it("allows execution silently when live", async () => {
    await expect(createKillSwitch(live()).assertCanExecute("refund")).resolves.toEqual({
      ok: true,
    });
  });

  it("states what halted it, so the UI does not have to invent a reason", async () => {
    const kill = createKillSwitch({ executionEnabled: false, reason: "operator rehearsal" });
    const verdict = await kill.assertCanExecute("refund");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.reason : "").toContain("operator rehearsal");
  });

  it("cannot be re-enabled from outside by mutating its config", () => {
    // The config is captured once. A switch whose state can be flipped by
    // holding a reference to the object it was given is not a switch.
    const config = { executionEnabled: false };
    const kill = createKillSwitch(config as KillSwitchConfig);
    config.executionEnabled = true;
    expect(kill.canExecute()).toBe(false);
  });

  it("defaults to live execution when nothing says otherwise", () => {
    // Deliberately fail-*open* on an absent flag, and the reason is worth
    // stating because it reads backwards: a forgotten environment variable
    // silently stopping the demo working is a worse failure than the reverse,
    // and the blast radius of failing open is bounded by `connectPayPalMcp`,
    // which refuses to run against live PayPal at all. The switch is an
    // operator control, not a default.
    expect(createKillSwitch().canExecute()).toBe(true);
    expect(createKillSwitch({}).canExecute()).toBe(true);
  });

  it("halts on any explicit falsy value, not only the literal false", () => {
    // An operator wiring this from a form or a query string can produce "0" or
    // "off". Reading those as truthy would mean the switch appears to work and
    // does nothing.
    for (const value of [false, 0, ""] as const) {
      const kill = createKillSwitch({ executionEnabled: value as unknown as boolean });
      expect(kill.canExecute()).toBe(false);
    }
  });
});