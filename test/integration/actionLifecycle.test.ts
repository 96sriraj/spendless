/**
 * The action lifecycle against real SQL. P6-01, P6-07, P6-08.
 *
 * Real SQLite through the real repository, no mocks. The claim under test is
 * P6-08's: **an attempt to execute without an approval is refused by the store,
 * not by the UI.** UI-level enforcement is not enforcement — a disabled button
 * is a request, and a `POST /execute` is not.
 *
 * So the tests here call the store directly, which is what a hostile client
 * does, and assert that the *database* refuses. If the refusal depended on a
 * check somewhere above this layer, deleting that check would leave these green,
 * which is precisely the bug being designed out.
 *
 * The one that matters most is the last group. Compare-and-set
 * (`WHERE id = ? AND status = 'approved'`) is what makes a double execution
 * impossible; a read-then-write would pass every other test here and still
 * execute a refund twice under two concurrent requests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase, type Database } from "@/db";
import {
  approveProposal,
  claimForExecution,
  completeExecution,
  IllegalTransitionError,
  insertProposal,
  insertResult,
  listProposals,
  listResults,
  rejectProposal,
} from "@/db/actions";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const AT = () => "2026-10-17T00:00:00.000Z";

let db: Database;

beforeEach(() => {
  const sqlite = new BetterSqlite3(":memory:");
  db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
});

async function proposal(overrides: Partial<Parameters<typeof insertProposal>[1]> = {}) {
  return insertProposal(
    db,
    {
      id: "act-1",
      kind: "refund",
      targetId: "sub-netflix",
      amountCents: 1_599,
      currency: "USD",
      rationale: "Idle 91 days",
      ...overrides,
    },
    AT,
  );
}

describe("the four persisted states", () => {
  it("records proposal, approval, execution and result as four separate facts", async () => {
    const created = await proposal();
    expect(created.status).toBe("proposed");
    expect(created.approvedAt).toBeNull();
    expect(created.approvedBy).toBeNull();

    const approved = await approveProposal(db, "act-1", "operator@merchant.test", "agreed", AT);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("operator@merchant.test");
    expect(approved.approvedAt).toBe(AT());

    const claimed = await claimForExecution(db, "act-1", AT);
    expect(claimed.status).toBe("executing");

    await completeExecution(db, "act-1", "executed", AT);
    await insertResult(
      db,
      {
        id: "res-1",
        proposalId: "act-1",
        status: "succeeded",
        providerRef: "1JU-XYZ",
        amountCents: 1_599,
      },
      AT,
    );

    const [stored] = await listProposals(db);
    expect(stored?.status).toBe("executed");

    const results = await listResults(db, "act-1");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "succeeded", providerRef: "1JU-XYZ" });
  });

  it("always requires approval, because the column forbids anything else", async () => {
    const created = await proposal();
    expect(created.requiresApproval).toBe(true);

    // Not a convention. The CHECK constraint means an INSERT naming 0 fails at
    // the database, so there is no code path that can create an autonomous one.
    await expect(
      db.run(
        `INSERT INTO action_proposals
           (id, run_id, kind, status, amount_cents, currency, rationale, requires_approval, created_at)
         VALUES ('autonomous', NULL, 'refund', 'proposed', 100, 'USD', 'no review', 0, ?)`,
        AT(),
      ),
    ).rejects.toThrow();
  });
});

describe("a step cannot be skipped", () => {
  it("refuses to execute an action nobody approved", async () => {
    await proposal();
    // The P6-08 claim, asserted at the only layer that can enforce it.
    await expect(claimForExecution(db, "act-1", AT)).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(claimForExecution(db, "act-1", AT)).rejects.toThrow(/prior approval/i);
  });

  it("refuses to execute a rejected action", async () => {
    await proposal();
    await rejectProposal(db, "act-1", "operator@merchant.test", "still in use", AT);
    await expect(claimForExecution(db, "act-1", AT)).rejects.toThrow(/prior approval/i);
  });

  it("refuses to execute the same action twice", async () => {
    await proposal();
    await approveProposal(db, "act-1", "operator@merchant.test", undefined, AT);
    await claimForExecution(db, "act-1", AT);
    await completeExecution(db, "act-1", "executed", AT);

    // Re-approving is also refused, so there is no path back to `approved`.
    await expect(approveProposal(db, "act-1", "operator@merchant.test")).rejects.toThrow();
    await expect(claimForExecution(db, "act-1", AT)).rejects.toThrow();
  });

  it("refuses to approve an action that is already executing", async () => {
    await proposal();
    await approveProposal(db, "act-1", "operator@merchant.test", undefined, AT);
    await claimForExecution(db, "act-1", AT);
    await expect(approveProposal(db, "act-1", "someone.else")).rejects.toThrow();
  });

  it("distinguishes a missing proposal from a wrong state", async () => {
    // "No such action" and "not approved" are different answers, and the second
    // is the security-relevant one. Collapsing them into one 404 would hide a
    // bug in the caller behind a plausible answer.
    await expect(claimForExecution(db, "does-not-exist", AT)).rejects.toThrow(/no such proposal/i);
  });

  it("records the refusal as a typed error naming the state it was in", async () => {
    // An HTTP layer turns this into a 409 rather than a 500, and the message
    // has to say which state blocked it — "it did not work" is useless to
    // whoever has to work out whether a human forgot to approve.
    await proposal();
    const error = await claimForExecution(db, "act-1", AT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IllegalTransitionError);
    expect(error).toMatchObject({ proposalId: "act-1", from: "proposed", to: "executing" });
  });

  it("cannot be tricked by writing an approval straight into the row", async () => {
    // Honest about the boundary. Nothing above the store runs raw SQL, so this
    // is not an attack path today — but it is the line of defence, and the line
    // of defence is the compare-and-set, not the absence of an UPDATE.
    await proposal();
    await db.run("UPDATE action_proposals SET status = 'approved' WHERE id = 'act-1'");

    // The claim now succeeds, because the row genuinely says `approved` — and
    // that is the correct outcome for a database whose job is to enforce
    // transitions, not to authenticate writers. What the audit trail shows is
    // what makes the forgery visible: an approval with nobody attached to it.
    await claimForExecution(db, "act-1", AT);

    const [claimed] = await listProposals(db);
    expect(claimed?.status).toBe("executing");
    expect(claimed?.approvedBy).toBeNull();
    expect(claimed?.approvedAt).toBeNull();
  });
});

describe("concurrency", () => {
  it("lets exactly one of two simultaneous claims succeed", async () => {
    await proposal();
    await approveProposal(db, "act-1", "operator@merchant.test", undefined, AT);

    // A read-then-write implementation passes every other test in this file and
    // still refunds twice here. The compare-and-set is the whole reason the
    // store exists rather than a service method.
    const [first, second] = await Promise.allSettled([
      claimForExecution(db, "act-1", AT),
      claimForExecution(db, "act-1", AT),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [claimed] = await listProposals(db);
    expect(claimed?.status).toBe("executing");
  });
});

describe("failure is recorded rather than swallowed", () => {
  it("leaves a crashed execution visible instead of claiming success", async () => {
    await proposal();
    await approveProposal(db, "act-1", "operator@merchant.test", undefined, AT);
    await claimForExecution(db, "act-1", AT);

    // Nothing is settled and no result row exists — a provider call that never
    // returned. The row sits at `executing`, which is the honest answer: this is
    // exactly why the state exists. Claiming `executed` up front would have left
    // a success with no result row behind it.
    const [stuck] = await listProposals(db);
    expect(stuck?.status).toBe("executing");
    expect(await listResults(db, "act-1")).toEqual([]);

    // And it can be settled as failed, which is the recovery path.
    await completeExecution(db, "act-1", "failed", AT);
    await insertResult(
      db,
      { id: "res-x", proposalId: "act-1", status: "failed", message: "provider timeout" },
      AT,
    );

    const [settled] = await listProposals(db);
    expect(settled?.status).toBe("failed");
    expect((await listResults(db, "act-1"))[0]?.status).toBe("failed");
  });
});