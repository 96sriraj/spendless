/**
 * The OpenRouter client, against a real HTTP server.
 *
 * This is the agent's only edge, so it is the only place that knows OpenRouter
 * exists. Everything above it asks for "a completion with these tools" and gets
 * back structured data or a typed failure.
 *
 * **Why a real server and not an injected fetch.** The failures that matter here
 * are wire-level: a 429 that arrives as a JSON body with a different shape, an
 * SSE stream where a plain body was assumed, a `tool_calls` array that is empty
 * rather than absent. A stubbed `fetch` proves the stub returns what the stub was
 * told to return. A real `node:http` server proves the request we actually send
 * is one a server can parse, which is the thing that breaks.
 *
 * Also worth stating plainly: there is no OpenRouter SDK in this project. The
 * architecture gate bans `openai` above the adapter layer, and the protocol
 * surface actually used is one POST and one JSON shape. The SDK would be a
 * dependency to upgrade three weeks before a submission.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenRouterClient, OpenRouterError, type ToolSpec } from "@/agent/tools";

/** What the server received, so assertions can be about the request we sent. */
type Received = { path: string; auth: string | undefined; body: Record<string, unknown> };

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let received: Received[] = [];
/** Set per test; the server replays it. */
let respond: (body: unknown) => { status: number; headers: Record<string, string> };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      received.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      const { status, headers } = respond(raw.length > 0 ? JSON.parse(raw) : {});
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body_of(status, headers)));
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

/** Default: echo the request's shape as a plausible completion. */
let body_of: (status: number, headers: Record<string, string>) => unknown = () => ({});

function client(apiKey = "sk-or-test") {
  return createOpenRouterClient({ apiKey, baseUrl, model: "meta-llama/llama-3.1-8b-instruct" });
}

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_findings",
      description: "List the structured findings from the detector graph.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

describe("createOpenRouterClient — the request it sends", () => {
  beforeAll(() => {
    respond = () => ({ status: 200, headers: {} });
    body_of = () => ({
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { total_tokens: 12 },
    });
  });

  it("posts to the chat completions endpoint with the bearer key", async () => {
    received = [];
    await client().complete({ messages: [{ role: "user", content: "hi" }] });

    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/api/v1/chat/completions");
    expect(received[0]?.auth).toBe("Bearer sk-or-test");
  });

  it("asks for determinism, because a demo that reruns differently is a demo that lies", async () => {
    received = [];
    await client().complete({ messages: [{ role: "user", content: "hi" }] });

    const body = received[0]?.body ?? {};
    // Temperature 0 and an explicit seed are the two halves of "same input,
    // same output". One without the other is not reproducible in practice.
    expect(body["temperature"]).toBe(0);
    expect(body["seed"]).toBe(20261017);
  });

  it("passes the tool allowlist through as function tools", async () => {
    received = [];
    await client().complete({
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
    });

    const tools = received[0]?.body["tools"] as unknown[];
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools[0])).toContain("list_findings");
  });

  it("never sends the API key anywhere but the Authorization header", async () => {
    received = [];
    await client("sk-or-secret-marker").complete({ messages: [{ role: "user", content: "hi" }] });

    // A key that appears in the body would land in the run log, which is
    // rendered on screen during the recording.
    expect(JSON.stringify(received[0]?.body)).not.toContain("sk-or-secret-marker");
  });
});

describe("createOpenRouterClient — reading the answer", () => {
  it("parses a text completion", async () => {
    respond = () => ({ status: 200, headers: {} });
    body_of = () => ({
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    });

    const result = await client().complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hello");
    expect(result.toolCalls).toEqual([]);
  });

  it("parses tool calls with their JSON arguments", async () => {
    respond = () => ({ status: 200, headers: {} });
    body_of = () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "list_findings", arguments: '{"limit":3}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const result = await client().complete({
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("list_findings");
    // Arguments arrive as a JSON *string*, the same double-encoding trap the MCP
    // envelope has. Parsed here so no caller ever sees the raw string.
    expect(result.toolCalls[0]?.args).toEqual({ limit: 3 });
  });

  it("does not throw when the model asks for a tool we do not have", async () => {
    respond = () => ({ status: 200, headers: {} });
    body_of = () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "wire_money", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    // The client is not the allowlist. Rejecting an unknown tool is the loop's
    // job, and it has to be *recorded* there - so this has to survive the trip.
    const result = await client().complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.toolCalls[0]?.name).toBe("wire_money");
  });
});

describe("createOpenRouterClient — failing loudly", () => {
  it("names the status and the provider's own message on an error", async () => {
    respond = () => ({ status: 429, headers: {} });
    body_of = () => ({
      error: { message: "Rate limit exceeded", code: 429 },
    });

    // "Rate limited" and "your key is wrong" look identical from outside unless
    // the message survives. This is the difference between retrying and giving up.
    await expect(client().complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /HTTP 429.*Rate limit exceeded/s,
    );
  });

  it("reports a completion with no choices as an error, not as empty text", async () => {
    respond = () => ({ status: 200, headers: {} });
    body_of = () => ({ choices: [] });

    // Returning "" would let the agent conclude "the model had nothing to say",
    // which is a confident wrong answer rather than a visible failure.
    await expect(client().complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      OpenRouterError,
    );
  });

  it("surfaces unparseable arguments as an error rather than an empty object", async () => {
    respond = () => ({ status: 200, headers: {} });
    body_of = () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "list_findings", arguments: "{oops" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    // `{}` would be indistinguishable from the model calling the tool with no
    // arguments, and the loop would happily run it on invented input.
    await expect(client().complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /arguments/i,
    );
  });
});