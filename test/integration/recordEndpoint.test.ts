import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase } from "@/db";
import { getProposal, listResults } from "@/db/actions";
import { recordUsage } from "@/core/unusedDetector";
import { createD1KvStore } from "@/db/kvStore";
import { seedHistory } from "@/services/seedHistory";
import { buildReadModel } from "@/services/readModel";
import { recordAgentProposals } from "@/services/actions";
import worker, { type Env } from "../../worker/index";

/**
 * `POST /api/actions/record`.
 *
 * The Option-A path refunds real sandbox money through the local sidecar, which
 * writes nothing to the store — so the read model kept claiming the money was
 * still at risk after it had been recovered. This route closes that gap: the UI
 * calls it after a successful sidecar refund, and the store performs the same
 * proposal -> approval -> execution -> result transitions the in-process path
 * would have, recording the REAL refund id.
 *
 * Execution happened out of process. Nothing here moves money; it is bookkeeping
 * about money that already moved, proven by the ledger.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

function testDatabase(): D1Database {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return createSqliteD1(sqlite) as unknown as D1Database;
}

const REFUND_ID = "40551413F19556526";

let db: D1Database;
let proposalId: string;
let netflixCents: number;
const ENV: Env = { DB: undefined, OPENROUTER_API_KEY: "unused" };

beforeEach(async () => {
  db = testDatabase();
  await seedHistory(createDatabase(db), { now: NOW });
  await recordUsage(createD1KvStore(createDatabase(db)), "sub-netflix", "2026-07-18T00:00:00.000Z");

  const { findings } = await buildReadModel(createDatabase(db), NOW);
  const netflix = findings.find((f) => f.subId === "sub-netflix");
  expect(netflix).toBeDefined();
  netflixCents = netflix!.savingCents;

  const recorded = await recordAgentProposals({
    db: createDatabase(db),
    findings,
    idPrefix: "record",
    agentProposals: [
      {
        subId: "sub-netflix",
        action: "refund",
        category: "idle_subscription",
        severity: 4,
        rationale: "No use recorded in three months.",
      },
    ],
    now: NOW,
  });
  proposalId = recorded.recorded[0]!.id;

  ENV.DB = db;
});

function record(body: unknown, env: Env = ENV) {
  return worker.fetch(
    new Request("https://spendless.test/api/actions/record", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env,
  );
}

function requestBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    proposalId,
    subId: "sub-netflix",
    refundId: REFUND_ID,
    status: "COMPLETED",
    amountCents: netflixCents,
    currency: "USD",
    ...overrides,
  };
}

describe("POST /api/actions/record", () => {
  it("executes the proposal chain out of process and writes the real refund id", async () => {
    const response = await record(requestBody());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      outcomes: { proposalId: string; ok: boolean; message: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.outcomes).toHaveLength(1);
    expect(body.outcomes[0]?.proposalId).toBe(proposalId);
    expect(body.outcomes[0]?.ok).toBe(true);

    // The store learned what happened.
    const proposal = await getProposal(createDatabase(db), proposalId);
    expect(proposal?.status).toBe("executed");
    expect(proposal?.approvedBy).not.toBeNull();

    const results = await listResults(createDatabase(db), proposalId);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("succeeded");
    // The real refund id from PayPal, not a placeholder and not the proposal's id.
    expect(results[0]?.providerRef).toBe(REFUND_ID);
  });

  it("records the proposal's own amount, never a figure the client invented", async () => {
    await record(requestBody());

    const results = await listResults(createDatabase(db), proposalId);
    expect(results[0]?.amountCents).toBe(netflixCents);
  });

  it("refuses to record an amount that differs from the approved proposal", async () => {
    const response = await record(requestBody({ amountCents: netflixCents + 100 }));
    // A refusal is an outcome, not a throw.
    const body = (await response.json()) as {
      outcomes: { ok: boolean; message: string }[];
    };
    expect(body.outcomes[0]?.ok).toBe(false);
    expect(body.outcomes[0]?.message.length).toBeGreaterThan(0);

    const proposal = await getProposal(createDatabase(db), proposalId);
    expect(proposal?.status).toBe("proposed");
  });

  it("refuses a currency that does not match the proposal", async () => {
    const response = await record(requestBody({ currency: "INR" }));
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };

    expect(body.outcomes[0]?.ok).toBe(false);
    const proposal = await getProposal(createDatabase(db), proposalId);
    expect(proposal?.status).toBe("proposed");
  });

  it("treats a second recording as the lost race it is, with one result row", async () => {
    const first = await record(requestBody());
    expect(((await first.json()) as { outcomes: { ok: boolean }[] }).outcomes[0]?.ok).toBe(true);

    const second = await record(requestBody());
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      outcomes: { ok: boolean; message: string }[];
    };
    expect(body.outcomes[0]?.ok).toBe(false);
    expect(body.outcomes[0]?.message).toMatch(/executed/);

    // One refund, one result row. A duplicate would double-count recovery.
    expect(await listResults(createDatabase(db), proposalId)).toHaveLength(1);
  });

  it("answers an unknown proposal with an outcome sentence, not a 500", async () => {
    const response = await record(requestBody({ proposalId: "act-nope" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };
    expect(body.outcomes[0]?.ok).toBe(false);
    expect(body.outcomes[0]?.message).toMatch(/act-nope/);
  });

  it("refuses a body that is not the recording shape with a sentence", async () => {
    for (const bad of [
      null,
      {},
      { proposalId },
      requestBody({ refundId: "" }),
      requestBody({ amountCents: "not a number" }),
      requestBody({ amountCents: 0 }),
      requestBody({ status: "PENDING" }),
      requestBody({ currency: "EUR" }),
    ]) {
      const response = await record(bad);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error.length).toBeGreaterThan(0);
    }
  });

  it("says what is wrong with the database binding rather than crashing", async () => {
    const response = await record(requestBody(), { ...ENV, DB: undefined });
    expect(response.status).toBe(503);
  });
});
