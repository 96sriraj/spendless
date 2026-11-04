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
import { recordUsage } from "@/core/unusedDetector";
import { createD1KvStore } from "@/db/kvStore";
import { seedHistory } from "@/services/seedHistory";
import { buildReadModel } from "@/services/readModel";

/**
 * The read model learns that money was recovered.
 *
 * Before this, an executed refund existed in the action ledger and nowhere in
 * the read path: `POST /api/actions/approve` declined (honestly) and the
 * sidecar's real refunds wrote nothing, so `totalRiskCents` stayed at the same
 * figure forever — even after real money had been returned. The recovery is
 * proven by the ledger (a proposal `executed`, a result `succeeded`, a real
 * refund id), so the read model can now read it and stop claiming the finding is
 * still at risk.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

let db: Database;

beforeEach(() => {
  const sqlite = new BetterSqlite3(":memory:");
  db = createDatabase(createSqliteD1(sqlite));
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
});

/** Write an executed refund result into the ledger, the way the store does it. */
async function recordExecutedRefund(options: {
  subId: string;
  amountCents: number;
  proposalStatus?: Parameters<typeof completeExecution>[2];
  resultStatus?: "succeeded" | "failed" | "skipped";
  providerRef?: string | null;
}): Promise<void> {
  await insertProposal(db, {
    id: `act-1-${options.subId}`,
    kind: "refund",
    targetId: options.subId,
    amountCents: options.amountCents,
    currency: "USD",
    rationale: "unused for three months",
  });
  await approveProposal(db, `act-1-${options.subId}`, "merchant");
  await claimForExecution(db, `act-1-${options.subId}`);
  if ((options.proposalStatus ?? "executed") !== "failed") {
    await completeExecution(db, `act-1-${options.subId}`, options.proposalStatus ?? "executed");
  } else {
    await completeExecution(db, `act-1-${options.subId}`, "failed");
  }
  await insertResult(db, {
    id: `res-1-${options.subId}`,
    proposalId: `act-1-${options.subId}`,
    status: options.resultStatus ?? "succeeded",
    providerRef: options.providerRef === undefined ? "40551413F19556526" : options.providerRef,
    amountCents: options.amountCents,
    message: "refund completed",
  });
}

describe("buildReadModel recovery figures", () => {
  it("starts at zero on a database with no refund ledger", async () => {
    await seedHistory(db, { now: NOW });
    const model = await buildReadModel(db, NOW);
    expect(model.recoveredCents).toBe(0);
  });

  it("stops counting a finding whose refund the ledger proves was executed", async () => {
    await seedHistory(db, { now: NOW });
    await recordUsage(createD1KvStore(db), "sub-netflix", "2026-07-18T00:00:00.000Z");

    const before = await buildReadModel(db, NOW);
    const netflix = before.findings.find((f) => f.subId === "sub-netflix");
    expect(netflix).toBeDefined();

    await recordExecutedRefund({ subId: "sub-netflix", amountCents: netflix!.savingCents });

    const after = await buildReadModel(db, NOW);
    expect(after.findings.find((f) => f.subId === "sub-netflix")).toBeUndefined();
    // Recovery is money that came back, not risk that disappeared.
    expect(after.recoveredCents).toBe(netflix!.savingCents);
    // And the escaped amount leaves the total: keeping the finding would claim
    // money is still at risk when the refund already settled.
    expect(after.totalRiskCents).toBe(0);
  });

  it("does not count a refund that failed in the ledger", async () => {
    await seedHistory(db, { now: NOW });
    await recordUsage(createD1KvStore(db), "sub-netflix", "2026-07-18T00:00:00.000Z");

    const before = await buildReadModel(db, NOW);
    const netflix = before.findings.find((f) => f.subId === "sub-netflix")!;

    await recordExecutedRefund({
      subId: "sub-netflix",
      amountCents: netflix.savingCents,
      proposalStatus: "failed",
      resultStatus: "failed",
    });

    const after = await buildReadModel(db, NOW);
    expect(after.recoveredCents).toBe(0);
    expect(after.findings.find((f) => f.subId === "sub-netflix")).toBeDefined();
  });

  it("does not count a result without a provider refund id", async () => {
    await seedHistory(db, { now: NOW });
    await recordUsage(createD1KvStore(db), "sub-netflix", "2026-07-18T00:00:00.000Z");

    const before = await buildReadModel(db, NOW);
    const netflix = before.findings.find((f) => f.subId === "sub-netflix")!;

    await recordExecutedRefund({
      subId: "sub-netflix",
      amountCents: netflix.savingCents,
      providerRef: null,
    });

    const after = await buildReadModel(db, NOW);
    expect(after.recoveredCents).toBe(0);
    expect(after.findings.find((f) => f.subId === "sub-netflix")).toBeDefined();
  });

  it("excludes the refunded finding while keeping every other finding", async () => {
    await seedHistory(db, { now: NOW });
    await recordUsage(createD1KvStore(db), "sub-netflix", "2026-07-18T00:00:00.000Z");
    await recordUsage(createD1KvStore(db), "sub-figma", "2026-10-15T00:00:00.000Z");

    const before = await buildReadModel(db, NOW);
    const netflix = before.findings.find((f) => f.subId === "sub-netflix")!;

    await recordExecutedRefund({ subId: "sub-netflix", amountCents: netflix.savingCents });

    const after = await buildReadModel(db, NOW);
    expect(after.findings.find((f) => f.subId === "sub-netflix")).toBeUndefined();
    // The healthy subscription was never a finding; the read model must not
    // invent one just because the recovery filter ran.
    expect(after.findings).toHaveLength(before.findings.length - 1);
    expect(after.lanes).toEqual(["seeded_history"]);
  });
});
