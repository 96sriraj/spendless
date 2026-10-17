import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteD1 } from "../support/sqliteD1";
import { createDatabase } from "@/db";
import { seedHistory } from "@/services/seedHistory";
import { recordUsage } from "@/core/unusedDetector";
import { createD1KvStore } from "@/db/kvStore";
import { __setCompleteForTests } from "../../worker/index";
import worker, { type Env } from "../../worker/index";
import type { Completion } from "@/agent/tools";

/**
 * `POST /api/run` as SSE.
 *
 * The interesting behaviour is in `runStream.ts` and is tested there against real
 * SQL. What is left here is the transport, and the transport has exactly one
 * interesting property: **a misconfiguration must not look like a run.** A missing
 * key that produced an empty 200 stream would leave the screen saying "running"
 * forever, which is the worst failure mode this endpoint has.
 *
 * `complete` is substituted through an explicit, documented test seam rather than
 * by mocking the module: OpenRouter is external, it sits behind the §3 seam, and
 * the alternative would be a fake that this tier is not allowed to have.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const NOW = new Date("2026-10-17T00:00:00.000Z");

function testDatabase(): D1Database {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.exec(readFileSync(path.join(REPO_ROOT, "src", "db", "schema.sql"), "utf8"));
  return createSqliteD1(sqlite) as unknown as D1Database;
}

async function seeded(): Promise<D1Database> {
  const db = testDatabase();
  await seedHistory(createDatabase(db), { now: NOW });
  await recordUsage(createD1KvStore(createDatabase(db)), "sub-netflix", "2026-07-18T00:00:00.000Z");
  return db;
}

function completion(text: string, toolCalls: Completion["toolCalls"] = []): Completion {
  return { text, toolCalls, finishReason: toolCalls.length > 0 ? "tool_calls" : "stop", usage: { totalTokens: 12 } };
}

async function run(env: Env): Promise<Response> {
  return worker.fetch(new Request("https://spendless.test/api/run", { method: "POST" }), env);
}

/** Split an SSE body into its `data:` payloads. */
function frames(body: string): string[] {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => (frame.startsWith("data:") ? frame.slice("data:".length).trim() : frame));
}

describe("POST /api/run", () => {
  it("answers with an event stream, not JSON", async () => {
    __setCompleteForTests(async () => completion("Nothing to do."));
    const response = await run({ DB: await seeded(), OPENROUTER_API_KEY: "unused" });

    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
  });

  it("frames every event as a data line and ends on the terminal event", async () => {
    __setCompleteForTests(async () => completion("Nothing to do."));
    const response = await run({ DB: await seeded(), OPENROUTER_API_KEY: "unused" });
    const body = await response.text();

    const payloads = frames(body);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(() => JSON.parse(payload)).not.toThrow();
    }
    expect(JSON.parse(payloads[payloads.length - 1]!).type).toBe("done");
  });

  it("emits the steps and the proposal the run produced", async () => {
    // The client proposes once and then answers. A script that proposed on every
    // turn produced six identical proposals before the turn cap — which is the
    // loop bounding itself correctly, but is not the shape of a real run and
    // would assert on the fixture rather than on the behaviour.
    let turn = 0;
    __setCompleteForTests(async () => {
      turn += 1;
      if (turn > 1) return completion("Proposed a refund for the idle subscription.");
      return completion("", [
        {
          id: "c1",
          name: "record_proposal",
          argsError: null,
          args: {
            subId: "sub-netflix",
            action: "refund",
            category: "idle_subscription",
            severity: 4,
            rationale: "No use recorded in three months.",
          },
        },
      ]);
    });
    const response = await run({ DB: await seeded(), OPENROUTER_API_KEY: "unused" });
    const events = frames(await response.text()).map((p) => JSON.parse(p) as { type: string });

    expect(events.filter((e) => e.type === "step").length).toBeGreaterThan(0);
    const done = events[events.length - 1] as { type: string; proposals: { subId: string }[] };
    expect(done.type).toBe("done");
    expect(done.proposals.map((p) => p.subId)).toEqual(["sub-netflix"]);
  });

  it("says so plainly when no API key is configured, rather than opening a stream that never ends", async () => {
    // The failure this prevents: a 200 `text/event-stream` that emits nothing
    // leaves the button spinning through a demo. A 503 with a reason is a
    // sentence the presenter can say out loud.
    __setCompleteForTests(null);
    const response = await run({ DB: await seeded() });

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/openrouter/i);
  });

  it("says so plainly when there is no database either", async () => {
    __setCompleteForTests(async () => completion("Nothing to do."));
    const response = await run({ OPENROUTER_API_KEY: "unused" });

    expect(response.status).toBe(503);
  });

  it("never writes the API key into the stream", async () => {
    __setCompleteForTests(async () => completion("Nothing to do."));
    const response = await run({
      DB: await seeded(),
      OPENROUTER_API_KEY: "key-marker-789",
      PAYPAL_CLIENT_SECRET: "secret-marker-456",
    });

    const raw = await response.text();
    expect(raw).not.toContain("key-marker-789");
    expect(raw).not.toContain("secret-marker-456");
  });

  it("streams an error rather than dying, so the screen keeps what it had", async () => {
    // The interesting failure is a half-finished run. A thrown error here would
    // tear down the connection and leave the log blank at the exact moment
    // something went wrong.
    __setCompleteForTests(async () => {
      throw new Error("OpenRouter 502");
    });
    const response = await run({ DB: await seeded(), OPENROUTER_API_KEY: "unused" });

    expect(response.status).toBe(200);
    const events = frames(await response.text()).map((p) => JSON.parse(p) as { type: string; message?: string });
    const last = events[events.length - 1]!;
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/OpenRouter/);
  });

  it("refuses a GET rather than spending a model call on a prefetch", async () => {
    const response = await worker.fetch(
      new Request("https://spendless.test/api/run"),
      { DB: testDatabase(), OPENROUTER_API_KEY: "unused" },
    );
    expect(response.status).toBe(404);
  });
});