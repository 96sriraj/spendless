import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase } from "@/db";
import { seedHistory } from "@/services/seedHistory";
import { recordUsage } from "@/core/unusedDetector";
import { createD1KvStore } from "@/db/kvStore";
import { buildReadModel } from "@/services/readModel";
import { recordAgentProposals } from "@/services/actions";
import worker, { type Env } from "../../worker/index";

/**
 * `POST /api/actions/approve`.
 *
 * The demo's final click. Three things matter more than the click itself:
 *
 * - an unknown proposal is refused, not executed;
 * - the response says **what happened**, including when nothing was sent — a
 *   200 with a bare `"ok"` beside a refund button is a lie waiting to be recorded;
 * - a refusal is still an outcome, so the screen renders a sentence rather than
 *   a stack trace.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

function testDatabase(): D1Database {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return createSqliteD1(sqlite) as unknown as D1Database;
}

let db: D1Database;
let proposalId: string;

beforeEach(async () => {
  db = testDatabase();
  await seedHistory(createDatabase(db), { now: NOW });
  await recordUsage(createD1KvStore(createDatabase(db)), "sub-netflix", "2026-07-18T00:00:00.000Z");

  const { findings } = await buildReadModel(createDatabase(db), NOW);
  const recorded = await recordAgentProposals({
    db: createDatabase(db),
    findings,
    idPrefix: "endpoint",
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
});

function approve(body: unknown, env: Env = { DB: db, OPENROUTER_API_KEY: "unused", REFUND_CAP_CENTS: "100000" }) {
  return worker.fetch(
    new Request("https://spendless.test/api/actions/approve", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env,
  );
}

/**
 * The cap is a real guardrail, so the tests that are about the *executor* have to
 * configure one. Leaving it unset means the cap refuses first — which is the
 * right order, and which would otherwise make every assertion in this file about
 * the wrong thing.
 */
describe("the refund cap default", () => {
  it("defaults to a cap a demo can actually act within, rather than to nothing", async () => {
    // An unset cap defaulting to zero is fail-safe and useless: on a machine with
    // no environment file every refund is refused with "exceeds 0.00", which reads
    // as a broken guardrail rather than as a configured one.
    const response = await approve(
      { proposalIds: [proposalId] },
      { DB: db, OPENROUTER_API_KEY: "unused" },
    );
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };

    expect(body.outcomes[0]?.message).not.toMatch(/exceeds/i);
  });

  it("honours an explicit zero as zero, because 'unset' and 'nothing' differ", async () => {
    const response = await approve(
      { proposalIds: [proposalId] },
      { DB: db, OPENROUTER_API_KEY: "unused", REFUND_CAP_CENTS: "0" },
    );
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };

    expect(body.outcomes[0]?.ok).toBe(false);
    expect(body.outcomes[0]?.message).toMatch(/exceeds/i);
  });

  it("refuses an action above a cap that is configured, before reaching any provider", async () => {
    // $15.99 against a $10 cap. The guardrail is checked before the claim, so an
    // over-cap action is never marked as attempted.
    const response = await approve(
      { proposalIds: [proposalId] },
      { DB: db, OPENROUTER_API_KEY: "unused", REFUND_CAP_CENTS: "1000" },
    );
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };

    expect(body.outcomes[0]?.message).toMatch(/exceeds/i);
  });
});

describe("POST /api/actions/approve", () => {
  it("approves the proposal and reports what actually happened", async () => {
    const response = await approve({ proposalIds: [proposalId] });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      outcomes: { proposalId: string; ok: boolean; message: string }[];
    };
    expect(body.outcomes).toHaveLength(1);
    expect(body.outcomes[0]?.proposalId).toBe(proposalId);
    // Whatever happened, it is said. The Worker has no PayPal executor, so this
    // is a refusal — and the screen must be able to show that plainly rather than
    // infer success from a 200.
    expect(body.outcomes[0]?.message.length).toBeGreaterThan(0);
  });

  it("says plainly that nothing was sent to PayPal", async () => {
    // The behaviour that makes this honest. A Worker cannot spawn the MCP stdio
    // server, so there is no executor here, and the screen must say so rather than
    // render a refund that looks like it moved money.
    const response = await approve({ proposalIds: [proposalId] });
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };

    expect(body.outcomes[0]?.ok).toBe(false);
    expect(body.outcomes[0]?.message).toMatch(/no paypal executor/i);
  });

  it("refuses an unknown proposal rather than silently doing nothing", async () => {
    const response = await approve({ proposalIds: ["act-nope"] });
    const body = (await response.json()) as { outcomes: { ok: boolean; message: string }[] };

    expect(body.outcomes[0]?.ok).toBe(false);
    expect(body.outcomes[0]?.message).toMatch(/act-nope/);
  });

  it("refuses a request with no proposal ids, rather than reporting success", async () => {
    const response = await approve({ proposalIds: [] });
    expect(response.status).toBe(400);
  });

  it("refuses a request with no database", async () => {
    const response = await approve({ proposalIds: [proposalId] }, {});
    expect(response.status).toBe(503);
  });

  it("never writes a secret into the response", async () => {
    const response = await approve(
      { proposalIds: [proposalId] },
      { DB: db, OPENROUTER_API_KEY: "key-marker-789", PAYPAL_CLIENT_SECRET: "secret-marker-456" },
    );
    const raw = await response.text();

    expect(raw).not.toContain("key-marker-789");
    expect(raw).not.toContain("secret-marker-456");
  });

  it("refuses a GET, because approving is a state change", async () => {
    const response = await worker.fetch(
      new Request("https://spendless.test/api/actions/approve"),
      { DB: db },
    );
    expect(response.status).toBe(404);
  });
});