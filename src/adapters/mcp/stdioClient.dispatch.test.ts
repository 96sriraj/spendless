import { describe, expect, it } from "vitest";
import { createStdioMcpClient, McpTransportError } from "./stdioClient";

/**
 * Response dispatch, proven without a subprocess.
 *
 * This property — that a response reaches the caller that asked for it — is
 * pure bookkeeping: given a stream of lines, match each to a pending request by
 * id. It does not need a real process to be true, and testing it through one
 * made it *flaky* rather than more honest, because the fixture had to
 * manufacture the reordering with a sleep and a losing race.
 *
 * The subprocess suite still covers the transport itself: handshake,
 * `tools/list`, argument round-trip, in-band tool errors, a call that never
 * gets an answer, non-JSON on stdout, and calls after close. This covers the
 * one thing that suite could only reach by accident.
 *
 * The fake is not a mock of the code under test. It is a pipe: it records what
 * the client writes and lets the test decide what comes back. Every assertion
 * below is about the client's own dispatch decisions.
 */

/** A transport that records writes and lets the test inject replies. */
function fakePipe() {
  const written: string[] = [];
  let deliver: ((chunk: string) => void) | null = null;

  const push = (chunk: string): void => {
    if (deliver === null) throw new Error("client never attached a stdout listener");
    deliver(chunk);
  };

  return {
    written,
    /** Everything the client sent, parsed. */
    sent: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
    /** Push one complete JSON-RPC line, as a server's stdout would. */
    emit: (message: Record<string, unknown>) => push(`${JSON.stringify(message)}\n`),
    /** Push arbitrary bytes, for chunking and framing tests. */
    push,
    spawn: {
      stdin: {
        write(chunk: string) {
          written.push(chunk.trim());
          return true;
        },
      },
      stdout: {
        on(_event: "data", listener: (chunk: unknown) => void) {
          deliver = listener as (chunk: string) => void;
          return undefined;
        },
      },
    },
  };
}

/** Boot the client and answer its handshake. */
async function connected() {
  const pipe = fakePipe();
  const clientPromise = createStdioMcpClient({ spawn: pipe.spawn });
  // The client attaches its listener and writes initialize synchronously, so the
  // handshake is already outstanding by the time we get here.
  await Promise.resolve();
  const initialize = pipe.sent()[0];
  pipe.emit({
    jsonrpc: "2.0",
    id: initialize?.["id"],
    result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "0" } },
  });
  const client = await clientPromise;
  return { pipe, client };
}

const reply = (id: unknown, payload: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
});

describe("stdio response dispatch", () => {
  it("should give each caller the payload for its own request id", async () => {
    const { pipe, client } = await connected();

    const first = client.callTool("list_transactions", { merchant: "netflix" });
    const second = client.callTool("list_transactions", { merchant: "adobe" });
    const third = client.callTool("list_disputes");

    const [, , thirdRequest] = pipe.sent().filter((m) => m["method"] === "tools/call");
    const [firstRequest, secondRequest] = pipe.sent().filter((m) => m["method"] === "tools/call");

    // Arrival order deliberately reversed relative to call order.
    pipe.emit(reply(thirdRequest!["id"], { items: ["dispute"] }));
    pipe.emit(reply(secondRequest!["id"], { merchant: "adobe" }));
    pipe.emit(reply(firstRequest!["id"], { merchant: "netflix" }));

    expect(await first).toEqual({ merchant: "netflix" });
    expect(await second).toEqual({ merchant: "adobe" });
    expect(await third).toEqual({ items: ["dispute"] });
  });

  it("should ignore a response whose id matches nothing outstanding", async () => {
    // A late reply to a call that already timed out. It must not resolve some
    // other caller's promise — that is the misattribution this whole file is
    // about, and a dropped id is how it would really happen in production.
    const { pipe, client } = await connected();

    const call = client.callTool("list_transactions");
    const [request] = pipe.sent().filter((m) => m["method"] === "tools/call");

    pipe.emit(reply(9_999, { wrong: true }));
    pipe.emit(reply(request!["id"], { right: true }));

    expect(await call).toEqual({ right: true });
  });

  it("should survive two replies arriving in a single chunk", async () => {
    // Real pipes coalesce writes. A parser that assumes one message per chunk
    // passes every test written against a single-line response and then fails
    // on the first batched one.
    const { pipe, client } = await connected();

    const first = client.callTool("list_transactions");
    const second = client.callTool("list_transactions");
    const [a, b] = pipe.sent().filter((m) => m["method"] === "tools/call");

    pipe.emit(reply(b!["id"], { n: 2 }));
    pipe.emit(reply(a!["id"], { n: 1 }));

    expect(await first).toEqual({ n: 1 });
    expect(await second).toEqual({ n: 2 });
  });

  it("should reassemble a message split across two chunks", async () => {
    // The mirror image: a partial line followed by its remainder. Naive
    // line-splitting drops the head and then fails to parse the tail, which
    // only shows up against a pipe that happens to fragment.
    const { pipe, client } = await connected();

    const call = client.callTool("list_transactions");
    const [request] = pipe.sent().filter((m) => m["method"] === "tools/call");

    const line = `${JSON.stringify(reply(request!["id"], { split: true }))}\n`;
    const cut = Math.floor(line.length / 2);
    pipe.push(line.slice(0, cut));
    pipe.push(line.slice(cut));

    expect(await call).toEqual({ split: true });
  });

  it("should handle three replies coalesced into one chunk", async () => {
    // The realistic shape of a burst: three writes flushed together.
    const { pipe, client } = await connected();

    const first = client.callTool("list_transactions");
    const second = client.callTool("list_disputes");
    const third = client.callTool("list_subscriptions");

    const [a, b, c] = pipe.sent().filter((m) => m["method"] === "tools/call");

    pipe.push(
      [reply(a!["id"], { n: 1 }), reply(b!["id"], { n: 2 }), reply(c!["id"], { n: 3 })]
        .map((m) => `${JSON.stringify(m)}\n`)
        .join(""),
    );

    expect(await first).toEqual({ n: 1 });
    expect(await second).toEqual({ n: 2 });
    expect(await third).toEqual({ n: 3 });
  });

  it("should reject every outstanding call when the client is closed mid-flight", async () => {
    // One caller must not be left hanging because another call's failure was
    // swallowed. In a demo this is the difference between a clear failure and a
    // spinner that never stops.
    const { client } = await connected();

    const first = client.callTool("list_transactions");
    const second = client.callTool("list_disputes");

    await client.close();

    await expect(first).rejects.toThrow(McpTransportError);
    await expect(second).rejects.toThrow(McpTransportError);
  });

  it("should reject every outstanding call when a JSON-RPC error arrives", async () => {
    const { pipe, client } = await connected();

    const call = client.callTool("list_transactions");
    const [request] = pipe.sent().filter((m) => m["method"] === "tools/call");
    pipe.emit({ jsonrpc: "2.0", id: request!["id"], error: { code: -32603, message: "boom" } });

    await expect(call).rejects.toThrow(/boom/);
  });
});
