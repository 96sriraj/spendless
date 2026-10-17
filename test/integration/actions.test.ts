import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { listProposals, listResults } from "@/db/actions";
import { createActionLayer } from "@/actions/actionLayer";
import { createKillSwitch } from "@/actions/killSwitch";
import type {
  ActionExecutor,
  ActionResult as ExecutorActionResult,
  DisputeMove,
  RefundInput,
  RefundResult,
} from "@/adapters/AccountSource";
import {
  approveAndExecute,
  recordAgentProposals,
  unavailableExecutor,
} from "@/services/actions";
import type { Recommendation } from "@/core/insights";
import type { Proposal } from "@/agent/proposal";

/**
 * Turning an agent run into approvable rows, and approving them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS NECESSARY AT ALL
 * ---------------------------------------------------------------------------
 *
 * `runAgent` returns proposals and `streamAgentRun` forwards them in a `done`
 * event. Nothing was writing them anywhere — so after a run the screen had a
 * proposal and **nothing to approve**. The whole action layer sat behind a gap
 * with one missing line in it.
 *
 * ---------------------------------------------------------------------------
 * THE AMOUNT IS NOT THE MODEL'S, AND THIS IS WHERE THAT IS PROVEN
 * ---------------------------------------------------------------------------
 *
 * `ProposalSchema` is `.strict()` and has no money field, so a proposal cannot
 * carry an amount. The amount on an approvable row comes from the finding's
 * `savingCents`, resolved through the core. The tests below assert it by
 * proposing something the model *could* have asked for and showing the row's
 * figure comes from elsewhere.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

const FINDING: Recommendation = {
  kind: "unused",
  subId: "sub-netflix",
  title: "sub-netflix looks unused",
  subtitle: "Last used 91 days ago",
  savingCents: 1_599,
  cta: "Consider cancel",
  confidence: 0.4,
};

const PROPOSAL: Proposal = {
  subId: "sub-netflix",
  action: "refund",
  category: "idle_subscription",
  severity: 4,
  rationale: "No use recorded in three months.",
};

let db: Database;

beforeEach(() => {
  const sqlite = new BetterSqlite3(":memory:");
  db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
});

/** An executor that records what it was asked to do. */
function recordingExecutor(): { executor: ActionExecutor; calls: RefundInput[] } {
  const calls: RefundInput[] = [];
  return {
    calls,
    executor: {
      kind: "csv",
      async refund(input: RefundInput): Promise<RefundResult> {
        calls.push(input);
        return {
          refundId: "refund-test-1",
          status: "completed",
          amountCents: input.amountCents ?? null,
          currency: input.currency,
          raw: null,
        };
      },
      async cancelSubscription(): Promise<ExecutorActionResult> {
        throw new Error("not needed");
      },
      async resolveDispute(_id: string, _move: DisputeMove): Promise<ExecutorActionResult> {
        throw new Error("not supported by MCP");
      },
    },
  };
}

/**
 * `recordAgentProposals` needs an id discriminator, and every test here wants a
 * fresh one. A local wrapper keeps that out of each call site.
 */
let testSeq = 0;

function record(overrides: Partial<Parameters<typeof recordAgentProposals>[0]>) {
  testSeq += 1;
  return recordAgentProposals({
    db,
    agentProposals: [],
    findings: [FINDING],
    now: NOW,
    idPrefix: `t${testSeq}`,
    ...overrides,
  });
}

describe("recordAgentProposals", () => {
  it("writes the agent's proposal as an approvable row", async () => {
    const result = await record({
      db,
      agentProposals: [PROPOSAL],
      findings: [FINDING],
      now: NOW,
      runId: "run-1",
    });

    expect(result.recorded).toHaveLength(1);
    const stored = await listProposals(db, "run-1");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "proposed", targetId: "sub-netflix" });
  });

  it("takes the amount from the finding, never from the proposal", async () => {
    // The proposal has no amount field and the schema would reject one. The row's
    // figure is resolved from `savingCents` in the core, which is the only place a
    // refundable number is allowed to come from.
    await record({
      db,
      agentProposals: [PROPOSAL],
      findings: [FINDING],
      now: NOW,
    });

    expect((await listProposals(db))[0]?.amountCents).toBe(1_599);
  });

  it("records a cancellation with no amount, rather than a zero", async () => {
    // A cancellation moves no money. `0` would read as "refunded nothing" in the
    // run log, beside a capture that had just been charged.
    await record({
      db,
      agentProposals: [{ ...PROPOSAL, action: "cancel" }],
      findings: [FINDING],
      now: NOW,
    });

    expect((await listProposals(db))[0]?.amountCents).toBeNull();
  });

  it("refuses a proposal for a subscription no finding mentions", async () => {
    // The loop already refuses unknown subIds, so reaching here means the
    // findings moved underneath the run. It is still a refusal and not a silent
    // drop — a dropped proposal is invisible, and an invisible refusal is a lie
    // about what the agent asked for.
    const result = await record({
      db,
      agentProposals: [{ ...PROPOSAL, subId: "sub-ghost" }],
      findings: [FINDING],
      now: NOW,
    });

    expect(result.recorded).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(await listProposals(db)).toEqual([]);
  });

  it("records nothing for an empty run, rather than inventing a row", async () => {
    const result = await record({ db, agentProposals: [], findings: [FINDING], now: NOW });

    expect(result.recorded).toEqual([]);
    expect(await listProposals(db)).toEqual([]);
  });
});

/**
 * The property that actually matters on this path.
 *
 * `approveAndExecute` approving and then executing is its whole job, so asserting
 * that it "refuses an unapproved proposal" was asserting the opposite of what it
 * does. The real claim is P6-08: a disabled button is a request, a `POST /execute`
 * is not, and the enforcement lives in the store.
 *
 * So this goes straight at the layer — claim an execution on a row that was never
 * approved, and require the database to refuse.
 */
describe("the store refuses an unapproved execution", () => {
  it("refuses to execute a proposal in `proposed`, and writes no result", async () => {
    const { recorded } = await record({
      db,
      agentProposals: [PROPOSAL],
      findings: [FINDING],
      now: NOW,
    });
    const { executor } = recordingExecutor();

    const layer = createActionLayer({
      db,
      findings: [FINDING],
      executor,
      killSwitch: createKillSwitch({ executionEnabled: true }),
      guardrails: { limits: { refundCapCents: 5_000, currency: "USD" } },
      now: () => NOW,
    });

    // No `approve` call. This is the request a compromised client would send.
    const outcome = await layer.execute(recorded[0]!.id);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.at).toBe("store");
    // Nothing reached PayPal, so there is nothing recorded as having reached it.
    expect(await listResults(db, recorded[0]!.id)).toEqual([]);
  });

  it("refuses the same proposal twice, so one approval cannot move money twice", async () => {
    const { recorded } = await record({
      db,
      agentProposals: [PROPOSAL],
      findings: [FINDING],
      now: NOW,
    });
    const { executor, calls } = recordingExecutor();

    const layer = createActionLayer({
      db,
      findings: [FINDING],
      executor,
      killSwitch: createKillSwitch({ executionEnabled: true }),
      guardrails: { limits: { refundCapCents: 5_000, currency: "USD" } },
      now: () => NOW,
    });

    const id = recorded[0]!.id;
    await layer.approve(id, "merchant");
    expect((await layer.execute(id)).ok).toBe(true);

    // The replay. A second click, a retried request, a double-submitting user.
    const second = await layer.execute(id);
    expect(second.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("approveAndExecute", () => {
  async function seedProposal(): Promise<string> {
    const { recorded } = await record({
      db,
      agentProposals: [PROPOSAL],
      findings: [FINDING],
      now: NOW,
    });
    return recorded[0]!.id;
  }

  it("approves and runs in one call, because the brief is fewer interactions", async () => {
    // The surface is one click. The enforcement underneath is unchanged: the claim
    // is still a conditional update, so this is speed at the surface and
    // compare-and-set underneath.
    const id = await seedProposal();
    const { executor } = recordingExecutor();

    const outcome = await approveAndExecute({
      db,
      proposalId: id,
      findings: [FINDING],
      executor,
      killSwitch: createKillSwitch({ executionEnabled: true }),
      refundCapCents: 5_000,
      approvedBy: "merchant",
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    expect((await listProposals(db))[0]?.status).toBe("executed");
  });

  it("refuses an approval of a proposal that does not exist", async () => {
    const outcome = await approveAndExecute({
      db,
      proposalId: "act-does-not-exist",
      findings: [FINDING],
      executor: recordingExecutor().executor,
      killSwitch: createKillSwitch({ executionEnabled: true }),
      refundCapCents: 5_000,
      approvedBy: "merchant",
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
  });

  it("refuses a second click on an already-executed proposal", async () => {
    const id = await seedProposal();
    const { executor } = recordingExecutor();
    const options = {
      db,
      proposalId: id,
      findings: [FINDING],
      executor,
      killSwitch: createKillSwitch({ executionEnabled: true }),
      refundCapCents: 5_000,
      approvedBy: "merchant",
      now: NOW,
    };

    expect((await approveAndExecute(options)).ok).toBe(true);
    // A double-submitting user, or a retried request.
    expect((await approveAndExecute(options)).ok).toBe(false);
  });

  it("refuses above the cap without touching the executor", async () => {
    // The cap is checked before the claim, so an over-cap action is never marked
    // as attempted — a proposal left `proposed` is honest about what happened.
    const id = await seedProposal();
    const { executor, calls } = recordingExecutor();

    const outcome = await approveAndExecute({
      db,
      proposalId: id,
      findings: [FINDING],
      executor,
      killSwitch: createKillSwitch({ executionEnabled: true }),
      refundCapCents: 100, // finding is $15.99
      approvedBy: "merchant",
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses when the kill switch is off, and still records the refusal", async () => {
    const id = await seedProposal();
    const { executor, calls } = recordingExecutor();

    const outcome = await approveAndExecute({
      db,
      proposalId: id,
      findings: [FINDING],
      executor,
      killSwitch: createKillSwitch({ executionEnabled: false }),
      refundCapCents: 5_000,
      approvedBy: "merchant",
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
    // A halted deployment must not leave a row claiming an action is in flight —
    // and it must leave a *result*, because "execution halted" is an outcome the
    // run log shows, not an absence it silently renders.
    expect(await listResults(db, id)).toHaveLength(1);
  });
});

describe("a provider refusal has to reach the screen", () => {
  /**
   * `callExecutor` used to hardcode `message: "refund failed"`, so whatever an
   * executor said about *why* was dropped on the floor. For the unavailable
   * executor that matters more than it sounds: its entire purpose is to say "no
   * PayPal executor is wired; nothing was sent", and a run log reading "refund
   * failed" beside a button that looks like it moved money is the failure this
   * project is most worried about.
   */
  it("surfaces the executor's reason, not a generic status string", async () => {
    const { recorded } = await record({
      db,
      agentProposals: [PROPOSAL],
      findings: [FINDING],
      now: NOW,
    });

    const outcome = await approveAndExecute({
      db,
      proposalId: recorded[0]!.id,
      findings: [FINDING],
      executor: unavailableExecutor(),
      killSwitch: createKillSwitch({ executionEnabled: true }),
      refundCapCents: 5_000,
      approvedBy: "merchant",
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/no paypal executor/i);
    // And it is recorded, not just returned: the run log is the artefact a judge
    // reads, and a refusal that exists only in a response body is invisible there.
    const results = await listResults(db, recorded[0]!.id);
    expect(results[0]?.message).toMatch(/no paypal executor/i);
  });
});

/**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT FAKE-EXECUTOR-AS-A-FEATURE
 * ---------------------------------------------------------------------------
 *
 * The temptation was a "sandbox executor" that returns `completed`. That is the
 * most dangerous thing this codebase could grow: it looks identical to the real
 * one, it would pass every test, and it would ship a refund button that moves no
 * money while reporting that it did.
 *
 * So there is no pretending executor. There is an executor that **declines**, and
 * its reason says plainly that nothing was sent. The chain above it — guardrails,
 * kill switch, the store's compare-and-set claim — is still real and still
 * enforced, which is the part worth demonstrating. The money is the part that
 * honestly is not wired, and the screen says so.
 */
describe("unavailableExecutor", () => {
  it("declines rather than pretending, and names why", async () => {
    const executor = unavailableExecutor();
    const result = await executor.refund({
      captureId: "CAPTURE-1",
      amountCents: 1_599,
      currency: "USD",
      note: "test",
    });

    expect(result.status).toBe("failed");
    expect(result.amountCents).toBeNull();
    expect(result.message).toMatch(/no paypal executor/i);
    // Never a plausible-looking refund id, because something downstream might
    // render one.
    expect(result.refundId).not.toMatch(/^[A-Z0-9]{10,}$/);
  });

  it("declines disputes too, because MCP cannot reach them either", async () => {
    const result = await unavailableExecutor().resolveDispute("DISC-1", "accept_claim");
    expect(result.status).toBe("failed");
  });
});
