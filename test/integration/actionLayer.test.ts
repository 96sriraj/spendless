/**
 * The action layer against real SQL and a recording executor. P6-07.
 *
 * Real SQLite, the real store, and an executor that records what it was asked
 * to do. The double is not a mock of anything under test: `ActionExecutor` is the
 * seam, the store is real, and what is being examined is the *orchestration* —
 * which refusals happen, in what order, and whether anything reaches the
 * provider that should not have.
 *
 * The ordering tests are the point. `guardrails -> killswitch -> store ->
 * executor` is a claim about consequences, and each step must be able to stop
 * the chain without leaving the ledger in a state that lies about what happened.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import { listProposals, listResults } from "@/db/actions";
import { createActionLayer, type ActionLayerDependencies } from "@/actions/actionLayer";
import { createKillSwitch } from "@/actions/killSwitch";
import type {
  ActionExecutor,
  ActionResult as ExecutorActionResult,
  RefundInput,
  RefundResult,
  DisputeMove,
} from "@/adapters/AccountSource";
import type { Proposal } from "@/agent/proposal";
import type { Recommendation } from "@/core/insights";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

const FINDING: Recommendation = {
  kind: "unused",
  subId: "sub-netflix",
  title: "Netflix unused for 91 days",
  subtitle: "Last used 91 days ago",
  savingCents: 1_599,
  displaySaving: "$47.97 wasted",
  cta: "Consider cancel",
  confidence: 0.9,
};

const AGENT_PROPOSAL: Proposal = {
  subId: "sub-netflix",
  action: "refund",
  category: "idle_subscription",
  severity: 4,
  rationale: "Idle 91 days and renewing in 3 days.",
};

let db: Database;
let refunds: RefundInput[];

/** An executor that records, so "did anything reach the provider" is answerable. */
function recordingExecutor(overrides: Partial<ActionExecutor> = {}): ActionExecutor {
  return {
    kind: "mcp",
    async refund(input: RefundInput): Promise<RefundResult> {
      refunds.push(input);
      return { refundId: "1JU-LIVE", status: "completed", amountCents: input.amountCents ?? null, currency: input.currency, raw: null };
    },
    async cancelSubscription(): Promise<ExecutorActionResult> {
      return { status: "succeeded", providerRef: "I-LIVE", message: "cancelled", raw: null };
    },
    async resolveDispute(_id: string, _move: DisputeMove): Promise<ExecutorActionResult> {
      return { status: "skipped", providerRef: null, message: "buyer namespace", raw: null };
    },
    ...overrides,
  };
}

function build(overrides: Partial<ActionLayerDependencies> = {}) {
  return createActionLayer({
    db,
    findings: [FINDING],
    executor: recordingExecutor(),
    killSwitch: createKillSwitch(),
    guardrails: { limits: { refundCapCents: 10_000, currency: "USD" } },
    now: () => NOW,
    ...overrides,
  });
}

beforeEach(() => {
  const sqlite = new BetterSqlite3(":memory:");
  db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  refunds = [];
});

/** propose -> approve, returning the proposal id. */
async function approvedProposal(
  layer = build(),
  agent: Proposal = AGENT_PROPOSAL,
): Promise<string> {
  const { ok, proposal } = await layer.propose(agent);
  if (!ok) throw new Error("propose failed");
  await layer.approve(proposal.id, "operator@merchant.test", "agreed");
  return proposal.id;
}

describe("proposal carries the core's number, never the model's", () => {
  it("resolves the amount from savingCents", async () => {
    const layer = build();
    const { ok, proposal } = await layer.propose(AGENT_PROPOSAL);

    expect(ok).toBe(true);
    if (!ok) return;
    expect(proposal.amountCents).toBe(1_599);
    expect(proposal.currency).toBe("USD");
  });

  it("records no amount for a cancellation, rather than a zero", async () => {
    // `0` reads as "refunded nothing" beside a cancelled plan. Null reads as
    // "this action moves no money", which is what it means.
    const layer = build();
    const { ok, proposal } = await layer.propose({ ...AGENT_PROPOSAL, action: "cancel" });

    expect(ok).toBe(true);
    if (!ok) return;
    expect(proposal.amountCents).toBeNull();
    expect(proposal.kind).toBe("cancel_subscription");
  });

  it("refuses rather than records a proposal for a subscription it cannot see", async () => {
    const layer = build();
    const outcome = await layer.propose({ ...AGENT_PROPOSAL, subId: "sub-invented" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === true ? "" : outcome.reason).toMatch(/no finding for sub-invented/);
    expect(await listProposals(db)).toEqual([]);
  });

  it("keeps the evidence trail beside the money figure", async () => {
    const layer = build();
    const outcome = await layer.propose(AGENT_PROPOSAL);
    expect(outcome.ok).toBe(true);

    // Read back from SQL rather than trusting the returned object: what matters
    // is what a later query will find, not what this call happened to hand back.
    const [stored] = await listProposals(db);
    expect(stored?.evidence).toContain('"severity":4');
    expect(stored?.evidence).toContain('"confidence":0.9');
  });
});

describe("a proposal cannot execute without a human saying yes", () => {
  it("refuses at the store and sends nothing to PayPal", async () => {
    const layer = build();
    const { ok, proposal } = await layer.propose(AGENT_PROPOSAL);
    expect(ok).toBe(true);
    if (!ok) return;

    const outcome = await layer.execute(proposal.id);

    expect(outcome).toMatchObject({ ok: false, at: "store" });
    expect(refunds).toHaveLength(0);
  });

  it("refuses a rejected action as firmly as an unapproved one", async () => {
    const layer = build();
    const { ok, proposal } = await layer.propose(AGENT_PROPOSAL);
    if (!ok) throw new Error("setup");
    await layer.reject(proposal.id, "operator@merchant.test", "still in use");

    const outcome = await layer.execute(proposal.id);
    expect(outcome).toMatchObject({ ok: false });
    expect(refunds).toHaveLength(0);
  });
});

describe("guardrails", () => {
  it("refuses an over-cap refund before touching the provider", async () => {
    const layer = build({ guardrails: { limits: { refundCapCents: 500, currency: "USD" } } });
    const id = await approvedProposal(layer);

    const outcome = await layer.execute(id);

    expect(outcome).toMatchObject({ ok: false, at: "guardrails" });
    expect(refunds).toHaveLength(0);
  });

  it("refuses rather than issuing a reduced amount", async () => {
    const layer = build({ guardrails: { limits: { refundCapCents: 500, currency: "USD" } } });
    const id = await approvedProposal(layer);
    await layer.execute(id);

    // The dangerous version of this guardrail clamps to the cap. Then the screen
    // showed $5.00, the human approved $5.00, and $15.99 left the account.
    expect(refunds).toHaveLength(0);
  });

  it("allows a refund inside the cap and reaches the provider", async () => {
    const layer = build();
    const id = await approvedProposal(layer);

    const outcome = await layer.execute(id);

    expect(outcome.ok).toBe(true);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amountCents).toBe(1_599);
    expect((await listResults(db, id))[0]?.status).toBe("succeeded");
  });
});

describe("the kill switch", () => {
  it("halts execution without halting the ledger", async () => {
    const layer = build({
      killSwitch: createKillSwitch({ executionEnabled: false, reason: "rehearsal" }),
    });
    const id = await approvedProposal(layer);

    const outcome = await layer.execute(id);

    expect(outcome).toMatchObject({ ok: false, at: "killswitch" });
    expect(refunds).toHaveLength(0);
    // The run must stay inspectable: the proposal is still there, and it is
    // honestly marked failed rather than left claiming to be approved.
    const [stored] = await listProposals(db);
    expect(stored?.id).toBe(id);
    expect(stored?.status).toBe("failed");
  });

  it("says why it halted", async () => {
    const layer = build({
      killSwitch: createKillSwitch({ executionEnabled: false, reason: "operator rehearsal" }),
    });
    const id = await approvedProposal(layer);
    const outcome = await layer.execute(id);

    expect(outcome.ok === false ? outcome.reason : "").toContain("operator rehearsal");
    expect(outcome.ok === false ? outcome.reason : "").toContain("Nothing was sent");
  });
});

describe("a failing provider is recorded, not swallowed", () => {
  it("settles the action as failed and writes a result row", async () => {
    const layer = build({
      executor: recordingExecutor({
        refund: async () => {
          throw new Error("PAYPAL_API_HTTP_ERROR 422");
        },
      }),
    });
    const id = await approvedProposal(layer);

    const outcome = await layer.execute(id);

    expect(outcome).toMatchObject({ ok: false, at: "executor" });
    const [stored] = await listProposals(db);
    expect(stored?.status).toBe("failed");

    const results = await listResults(db, id);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.message).toContain("422");
  });

  it("records a provider that reports failure rather than throwing", async () => {
    // The subtle one: a 201 with `status: FAILED` is a refusal that looks like
    // a success unless someone reads the body. The action is marked failed, not
    // executed, because it did not do what it said.
    const layer = build({
      executor: recordingExecutor({
        refund: async (input) => ({
          refundId: "1JU-FAILED",
          status: "failed",
          amountCents: input.amountCents ?? null,
          currency: input.currency,
          raw: null,
        }),
      }),
    });
    const id = await approvedProposal(layer);

    const outcome = await layer.execute(id);

    expect(outcome).toMatchObject({ ok: false, at: "executor" });
    expect((await listProposals(db))[0]?.status).toBe("failed");
    expect((await listResults(db, id))[0]?.status).toBe("failed");
  });
});

describe("actions that move no money", () => {
  it("never calls the provider for an investigation, and does not call it a failure", async () => {
    const layer = build();
    const id = await approvedProposal(layer, { ...AGENT_PROPOSAL, action: "investigate" });

    const outcome = await layer.execute(id);

    expect(outcome).toMatchObject({ ok: false, at: "executor" });
    expect(refunds).toHaveLength(0);
    // `ask_usage` is a question for a human, not an action that went wrong. It
    // is refused before the claim, so it stays `approved` rather than being
    // marked failed for something nobody tried.
    expect((await listProposals(db))[0]?.status).toBe("approved");
    expect(await listResults(db, id)).toEqual([]);
  });
});

describe("the whole chain, in order", () => {
  it("leaves four persisted facts and nothing else", async () => {
    const layer = build();
    const id = await approvedProposal(layer);

    await layer.execute(id);

    const [stored] = await listProposals(db);
    expect(stored).toMatchObject({
      id,
      status: "executed",
      approvedBy: "operator@merchant.test",
      amountCents: 1_599,
      requiresApproval: true,
    });
    expect(stored?.approvedAt).toBe(NOW.toISOString());
    expect(stored?.decidedAt).not.toBeNull();
    expect((await listResults(db, id))[0]?.providerRef).toBe("1JU-LIVE");
  });
});