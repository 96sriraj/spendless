import { describe, expect, it } from "vitest";
import { connectPayPalMcp, type SpawnFn } from "./server";
import type { TokenProvider } from "../tokenProvider";

/**
 * The connection seam, proven without a subprocess.
 *
 * What this file is really about is one question: **what exactly does the child
 * process inherit?** A stdio MCP server authenticates from its environment, so
 * the token has to be in there before the process boots, and nothing after the
 * spawn can change it.
 *
 * That makes the environment the only part of this module with a security
 * consequence, so it is the part asserted on:
 *
 * - the **token** goes in, because the server needs it;
 * - the **client secret** does not, because a spawned `npx` is a dependency we
 *   do not control, and a secret in its environment is a secret in a process we
 *   cannot audit;
 * - the **environment selector** goes in, and is pinned to sandbox, because
 *   `PAYPAL_ENVIRONMENT=SANDBOX` is the only thing standing between the demo
 *   and the live API.
 *
 * The subprocess itself — real framing, real handshake, real `tools/list` — is
 * covered in `test/integration/stdioClient.test.ts`. What is *not* covered
 * there, and cannot be, is which environment this project chooses to hand it.
 */

type SpawnCall = { command: string; args: readonly string[]; env: Record<string, string> };

function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const killed: unknown[] = [];
  const written: string[] = [];
  let deliver: ((chunk: string) => void) | null = null;

  const spawn: SpawnFn = (command, args, env) => {
    calls.push({ command, args, env });
    return {
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
      kill(signal?: unknown) {
        killed.push(signal ?? null);
        return undefined;
      },
    };
  };

  return {
    calls,
    killed,
    spawn,
    sent: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
    /** Push one JSON-RPC line, as a server's stdout would. */
    emit: (message: Record<string, unknown>): void => {
      if (deliver === null) throw new Error("client never attached a stdout listener");
      deliver(`${JSON.stringify(message)}\n`);
    },
  };
}

/** A provider that counts mints, so "how many times did we authenticate" is answerable. */
function countingProvider(token = "tok-abc") {
  let mints = 0;
  const provider: TokenProvider = {
    getToken() {
      mints += 1;
      return Promise.resolve(token);
    },
    isFresh: () => mints > 0,
  };
  return { provider, count: () => mints };
}

/** Let the token mint resolve, then the client attach and write `initialize`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Boot a connection against a fake pipe and answer its handshake. */
async function connected(
  fake: ReturnType<typeof fakeSpawn>,
  token = "tok-abc",
) {
  const pending = connectPayPalMcp({
    tokenProvider: countingProvider(token).provider,
    spawn: fake.spawn,
  });
  await settle();
  fake.emit({
    jsonrpc: "2.0",
    id: fake.sent()[0]?.["id"],
    result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "0" } },
  });
  return pending;
}

describe("connectPayPalMcp - the child's environment", () => {
  it("hands the child the access token and the sandbox selector", async () => {
    const fake = fakeSpawn();
    await connected(fake);

    expect(fake.calls).toHaveLength(1);
    const env = fake.calls[0]?.env ?? {};
    expect(env["PAYPAL_ACCESS_TOKEN"]).toBe("tok-abc");
    expect(env["PAYPAL_ENVIRONMENT"]).toBe("SANDBOX");
  });

  it("never hands the child the client secret, even when it is in our own environment", async () => {
    // The secret is what mints a token; it is not what authenticates a call.
    // A spawned `npx` is a third-party dependency tree, and an environment
    // variable handed to it is not a secret we can still account for.
    //
    // The child inherits `process.env` — it has to, or `npx` is unfindable on
    // Windows — so "we did not put the secret there" is not the same as "the
    // secret is not there". It has to be actively removed, and this test seeds
    // the ambient environment to prove that it is.
    const previous = process.env["PAYPAL_CLIENT_SECRET"];
    process.env["PAYPAL_CLIENT_SECRET"] = "super-secret-value";
    try {
      const fake = fakeSpawn();
      const pending = connectPayPalMcp({
        tokenProvider: countingProvider("tok-derived").provider,
        spawn: fake.spawn,
        bootTimeoutMs: 40,
      });
      await expect(pending).rejects.toThrow();

      const env = fake.calls[0]?.env ?? {};
      expect(env["PAYPAL_CLIENT_SECRET"]).toBeUndefined();
      expect(env["PAYPAL_ACCESS_TOKEN"]).toBe("tok-derived");
    } finally {
      if (previous === undefined) delete process.env["PAYPAL_CLIENT_SECRET"];
      else process.env["PAYPAL_CLIENT_SECRET"] = previous;
    }
  });

  it("runs the official server with every tool enabled", async () => {
    const fake = fakeSpawn();
    await connected(fake);

    expect(fake.calls[0]?.args).toContain("--tools=all");
  });

  it("mints once at connect time, not once per tool call", async () => {
    // A token is baked into the environment at spawn, so it *cannot* be minted
    // later — and minting per call would put a token request in front of every
    // read, which is how you get rate-limited on the day.
    const fake = fakeSpawn();
    const { provider, count } = countingProvider();
    const pending = connectPayPalMcp({ tokenProvider: provider, spawn: fake.spawn });
    await settle();
    fake.emit({
      jsonrpc: "2.0",
      id: fake.sent()[0]?.["id"],
      result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "0" } },
    });
    const { client } = await pending;

    // Both calls are left unanswered on purpose: only the mint count is under
    // test, and a rejected promise would fail the run for an unrelated reason.
    client.listTools().catch(() => undefined);
    client.callTool("list_transactions", {}).catch(() => undefined);
    await settle();

    expect(count()).toBe(1);
  });

  it("refuses to connect to the live API", async () => {
    // The project is sandbox-scoped and the UI promises a SANDBOX badge.
    // Silently accepting LIVE would let a demo take real money, so this is a
    // hard failure rather than a warning.
    await expect(
      connectPayPalMcp({
        tokenProvider: countingProvider().provider,
        spawn: fakeSpawn().spawn,
        paypalEnvironment: "LIVE",
      }),
    ).rejects.toThrow(/sandbox/i);
  });
});

describe("connectPayPalMcp - lifecycle", () => {
  it("kills the child process on close", async () => {
    const fake = fakeSpawn();
    const { close } = await connected(fake);

    await close();
    expect(fake.killed).toHaveLength(1);
  });

  it("rejects rather than hanging when the server never answers the handshake", async () => {
    // `npx -y @paypal/mcp` can fail for reasons that produce no output at all:
    // no network, a cold npx cache, a bad flag. Silence must not become a
    // wedged demo, so the boot has its own deadline.
    const fake = fakeSpawn();
    const pending = connectPayPalMcp({
      tokenProvider: countingProvider().provider,
      spawn: fake.spawn,
      bootTimeoutMs: 40,
    });

    await expect(pending).rejects.toThrow(/timed out|closed/i);
  });

  it("reports the server it actually connected to", async () => {
    const fake = fakeSpawn();
    const { client } = await connected(fake);
    expect(client.serverInfo.name).toBe("fake");
  });
});