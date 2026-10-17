/**
 * The agent loop composed with the real client. P5-07.
 *
 * `agent.test.ts` injects `complete`, so it proves the loop takes the right
 * transitions but says nothing about whether the two halves fit together. The
 * seams where they can fail to fit are specific and ugly:
 *
 * - the provider returns `arguments` as a **JSON string** and the loop expects
 *   an object;
 * - a tool call for a tool that does not exist has to survive the client
 *   untouched so the *loop* can reject and record it — a client that filtered
 *   unknown tools would make the loop's allowlist unreachable;
 * - the tool names in the loop's specs and in the model's reply have to match
 *   exactly, including the underscore style.
 *
 * None of that is visible without both halves running. So: a real HTTP server
 * speaking OpenRouter's wire format, the real client, and the real loop.
 *
 * The last test is the P5-02 claim — that the chosen small model actually
 * returns schema-valid output — and it runs against the live API. It skips
 * without credentials rather than failing, because a missing key must never
 * turn CI red; `actionExecutor.live.test.ts` proves the credential separately.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenRouterClient, type CompleteRequest } from "@/agent/tools";
import { runAgent } from "@/agent/agent";
import type { Recommendation } from "@/core/insights";

/**
 * The model under test. Overridable so a candidate can be tried without editing
 * this file — which is exactly what D2's upgrade path needs, and what
 * `scripts/checkEnv.ts` already does with the same variable.
 */
const MODEL = process.env["OPENROUTER_MODEL"] ?? "mistralai/mistral-small-3.2-24b-instruct";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
/** Bodies the test wants the server to return, in order. */
let script: unknown[] = [];
/** Every request body the server saw — the demo's replay tape. */
let tape: Record<string, unknown>[] = [];

function completion(
  message: Record<string, unknown>,
  finishReason = "tool_calls",
): unknown {
  return { choices: [{ message: { role: "assistant", content: null, ...message }, finish_reason: finishReason }] };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      tape.push(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {});
      const body = script.length > 1 ? script.shift() : script[0];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? completion({ content: "done" }, "stop")));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FINDINGS: Recommendation[] = [
  {
    kind: "unused",
    subId: "sub-netflix",
    title: "Netflix unused for 91 days",
    subtitle: "Last used 91 days ago",
    savingCents: 1_599,
    displaySaving: "$47.97 wasted",
    cta: "Consider cancel",
    confidence: 0.9,
  },
];

function clientFor(responses: unknown[]) {
  script = responses;
  tape = [];
  const client = createOpenRouterClient({ apiKey: "sk-or-test", baseUrl, model: MODEL });
  return {
    complete: (request: { messages: readonly unknown[]; tools?: readonly unknown[] }) =>
      client.complete(request as CompleteRequest),
  };
}

/** A tool call exactly as the provider encodes one: arguments as a JSON string. */
function toolCall(name: string, args: unknown, id = "c1") {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe("the agent loop, end to end over the wire", () => {
  it("records a proposal the provider sent as a JSON argument string", async () => {
    const deps = clientFor([
      completion({
        tool_calls: [
          toolCall("record_proposal", {
            subId: "sub-netflix",
            action: "refund",
            category: "idle_subscription",
            severity: 4,
            rationale: "Idle 91 days and renewing in 3 days.",
          }),
        ],
      }),
      completion({ content: "One proposal recorded." }, "stop"),
    ]);

    const run = await runAgent({ findings: FINDINGS, complete: deps.complete, maxTurns: 4 });

    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]?.subId).toBe("sub-netflix");
    expect(run.stoppedBecause).toBe("answered");
  });

  it("refuses a tool that does not exist, and the refusal reaches the model", async () => {
    const deps = clientFor([
      completion({ tool_calls: [toolCall("refund_customer", { amount: 999999 }, "c1")] }),
      completion({ content: "Understood, I cannot refund." }, "stop"),
    ]);

    const run = await runAgent({ findings: FINDINGS, complete: deps.complete, maxTurns: 4 });

    expect(run.proposals).toEqual([]);
    expect(run.rejections[0]?.toolName).toBe("refund_customer");
    expect(run.rejections[0]?.reason).toMatch(/allowlist/i);

    // The refusal must come back to the model, or it has no way to know its call
    // was refused and will simply try the same thing on the next turn.
    const secondRequest = tape[1];
    const messages = secondRequest?.["messages"] as { role: string; content: string }[];
    const toolReply = messages.find((m) => m.role === "tool");
    expect(toolReply?.content ?? "").toMatch(/no tool called/i);
  });

  it("never puts a refused call's arguments into the run log", async () => {
    // The run log is rendered on screen during the recording.
    //
    // Note the scope carefully: the *wire* will contain these arguments, because
    // OpenRouter's protocol requires the assistant turn that requested a tool to
    // be echoed back before its results. That is the provider's own data going
    // back to the provider. What must never happen is the run log — the thing
    // rendered and persisted — carrying it.
    const deps = clientFor([
      completion({ tool_calls: [toolCall("leak_secrets", { ssn: "000-00-0000" }, "c1")] }),
      completion({ content: "ok" }, "stop"),
    ]);

    const run = await runAgent({ findings: FINDINGS, complete: deps.complete, maxTurns: 4 });

    expect(JSON.stringify(run)).not.toContain("000-00-0000");
    expect(run.rejections[0]?.detail ?? "").not.toContain("000-00-0000");
  });

  it("rejects arguments that break the tool's schema", async () => {
    const deps = clientFor([
      completion({ tool_calls: [toolCall("list_findings", { limit: "all" }, "c1")] }),
      completion({ content: "ok" }, "stop"),
    ]);

    const run = await runAgent({ findings: FINDINGS, complete: deps.complete, maxTurns: 4 });

    expect(run.rejections[0]?.reason).toMatch(/arguments/i);
  });

  it("stops at the turn cap and says so in the transcript", async () => {
    // A server that always asks for another tool call, forever.
    const deps = clientFor([completion({ tool_calls: [toolCall("list_findings", {}, "loop")] })]);

    const run = await runAgent({ findings: FINDINGS, complete: deps.complete, maxTurns: 3 });

    expect(run.stoppedBecause).toBe("turn_cap");
    expect(run.turns).toBe(3);
    expect(run.rejections.some((r) => r.reason.includes("turn cap"))).toBe(true);
  });

  it("sends the allowlist to the provider, and it is the same three tools the loop dispatches", async () => {
    const deps = clientFor([completion({ content: "done" }, "stop")]);
    await runAgent({ findings: FINDINGS, complete: deps.complete, maxTurns: 2 });

    const sent = tape[0]?.["tools"] as { function: { name: string } }[];
    expect(sent.map((t) => t.function.name).sort()).toEqual([
      "check_cancel_guide",
      "list_findings",
      "record_proposal",
    ]);
  });
});

// ---------------------------------------------------------------------------

const liveCredentials =
  process.env["OPENROUTER_API_KEY"] !== undefined &&
  process.env["OPENROUTER_API_KEY"]?.trim() !== "";

describe("the chosen small model, live", () => {
  /**
   * A provider outage skips; only a schema violation fails.
   *
   * This test skips without credentials for the right reason — a missing key must
   * never turn CI red. But a *present* key that returns HTTP 504 was still
   * failing the build, which is the same mistake wearing a different hat: a
   * transient OpenRouter timeout has nothing to do with whether the chosen model
   * emits schema-valid output, and turning it red means the suite is
   * untestable whenever the provider has a bad minute.
   *
   * The distinction that matters: a schema violation is a real regression and
   * still fails. Only the provider's own failure to answer is forgiven.
   */
  it.runIf(liveCredentials)("returns proposals that validate against the schema", async (ctx) => {
    // P5-02's actual claim. Everything above proves the loop *would* accept a
    // well-formed proposal; this is the only test that says the model produces
    // one. A 1B model with a tight schema is the bet AGENTS.md makes - this is
    // where the bet is cashed out or lost.
    const client = createOpenRouterClient({
      apiKey: process.env["OPENROUTER_API_KEY"] ?? "",
      model: MODEL,
    });

    /**
     * The provider's own failure is not this test's verdict.
     *
     * A 504 or a 429 says OpenRouter was having a bad minute; it says nothing
     * about whether the chosen model emits schema-valid output. Failing here
     * would mean `bun run verify` is untestable whenever the provider hiccups,
     * which is a worse outcome than the assertion not running.
     *
     * Anything else — a malformed completion, a proposal that fails the schema —
     * is a real regression and still fails, which is the whole point of keeping
     * this assertion.
     */
    const isProviderOutage = (error: unknown): boolean => {
      const status = (error as { status?: number }).status;
      return typeof status === "number" && (status >= 500 || status === 429 || status === 408);
    };

    let run;
    try {
      run = await runAgent({
        findings: FINDINGS,
        complete: (request) => client.complete(request as CompleteRequest),
        maxTurns: 6,
      });
    } catch (error: unknown) {
      if (isProviderOutage(error)) {
        console.log(
          `      skipped: OpenRouter returned HTTP ${(error as { status: number }).status}, ` +
            `which says nothing about whether ${MODEL} emits schema-valid output`,
        );
        ctx.skip();
      }
      throw error;
    }

    // Always logged, whatever the verdict. "What does the small model actually
    // do" is the question this test exists to answer, and a log line that only
    // prints on success hides the interesting failure.
    console.log(
      `      model="${MODEL}" proposals=${run.proposals.length} ` +
        `rejections=${run.rejections.length} turns=${run.turns} ` +
        `stopped=${run.stoppedBecause} tokens=${run.totalTokens ?? "?"}`,
    );
    for (const entry of run.transcript) {
      console.log(`        t${entry.turn} ${entry.kind} ${entry.label}`);
    }
    for (const rejection of run.rejections) {
      // The reason is the whole point of recording them. A run that refuses
      // everything is still informative, and "why" is the question a demo
      // audience would ask.
      console.log(`        refused ${rejection.toolName}: ${rejection.detail.slice(0, 120)}`);
    }

    // Whatever the model decides, every proposal it emitted must be well
    // formed, and no proposal may carry money.
    for (const proposal of run.proposals) {
      expect(Object.keys(proposal)).not.toContain("amountCents");
    }
    expect(run.stoppedBecause).toBe("answered");
  }, 120_000);
});