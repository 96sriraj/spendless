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
  insertProposal,
  insertResult,
} from "@/db/actions";
import { seedScenario } from "@/services/scenario";
import { buildReadModel } from "@/services/readModel";

/**
 * The seed resets the action seam.
 *
 * `seedScenario` already replaces history rather than accumulating it, for one
 * reason: a demo that is seeded twice must show the same figure both times, or
 * nobody can rehearse against it. The action ledger joined that invariant's
 * blast radius the moment the read model started reading it: a refund recorded
 * against take one permanently suppresses the Netflix finding on every later
 * take. So the seed clears the ledger with the history.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

let db: Database;
let d1: D1Database;

beforeEach(() => {
  const sqlite = new BetterSqlite3(":memory:");
  d1 = createSqliteD1(sqlite) as unknown as D1Database;
  db = createDatabase(d1);
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
});

/** Record an executed refund against sub-netflix, the way Option A now does. */
async function recordNetflixRefund(amountCents: number): Promise<void> {
  await insertProposal(db, {
    id: "act-take-1",
    kind: "refund",
    targetId: "sub-netflix",
    amountCents,
    currency: "USD",
    rationale: "unused for three months",
  });
  await approveProposal(db, "act-take-1", "merchant");
  await claimForExecution(db, "act-take-1");
  await completeExecution(db, "act-take-1", "executed");
  await insertResult(db, {
    id: "res-take-1",
    proposalId: "act-take-1",
    status: "succeeded",
    providerRef: "40551413F19556526",
    amountCents,
    message: "refund completed",
  });
}

describe("seedScenario resetting the action ledger", () => {
  it("restores a finding that a recorded refund had suppressed", async () => {
    const take1 = await seedScenario(db, NOW);
    const netflix = take1.model.findings.find((f) => f.subId === "sub-netflix");
    expect(netflix).toBeDefined();

    await recordNetflixRefund(netflix!.savingCents);

    // Sanity: the recovery is visible before the reseed, the same way the read
    // model will present it during the demo.
    const afterRefund = await buildReadModel(db, NOW);
    expect(afterRefund.recoveredCents).toBe(netflix!.savingCents);
    expect(afterRefund.findings.find((f) => f.subId === "sub-netflix")).toBeUndefined();

    const take2 = await seedScenario(db, NOW);
    expect(take2.model.findings.find((f) => f.subId === "sub-netflix")).toBeDefined();
    expect(take2.model.recoveredCents).toBe(0);
    // And the headline figure matches what take 1 showed, which is the whole
    // property a reseed exists for.
    expect(take2.model.totalRiskCents).toBe(take1.model.totalRiskCents);
  });

  it("leaves the ledger empty after a reseed, so nothing stale can survive", async () => {
    await seedScenario(db, NOW);
    const netflix = (await buildReadModel(db, NOW)).findings.find((f) => f.subId === "sub-netflix")!;
    await recordNetflixRefund(netflix.savingCents);

    await seedScenario(db, NOW);

    const raw = createDatabase(d1);
    const proposals = await raw.all("SELECT * FROM action_proposals");
    const results = await raw.all("SELECT * FROM action_results");
    const steps = await raw.all("SELECT * FROM run_steps");
    expect(proposals).toEqual([]);
    expect(results).toEqual([]);
    expect(steps).toEqual([]);
  });
});
