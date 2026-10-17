/**
 * Launching PayPal's own MCP server, and giving it something to authenticate as.
 *
 * `AGENTS.md` names the in-process MCP server as the primary binding, and this
 * is the single place that knows how one gets started. The read adapter and the
 * action executor both sit on top of it, so it exists to stop that knowledge
 * being written twice — and twice is how one of them ends up running against
 * the live API.
 *
 * **The token is baked into the environment at spawn, which is the whole
 * constraint this module is shaped around.** A stdio server reads
 * `PAYPAL_ACCESS_TOKEN` from its environment when it boots and never looks
 * again. So the token has to be minted *before* the spawn, exactly once, and a
 * connection cannot outlive the token it was given. `close()` therefore exists
 * so a caller can reconnect after `tokenProvider` rotates — see the note on
 * `PayPalMcpConnection`.
 *
 * **The secret is removed from the environment, not merely omitted.** The child
 * inherits `process.env`, because `npx` is unfindable on Windows without it.
 * That makes "we did not pass the secret" and "the secret is not in the
 * child" different claims, and only the second one is safe: a spawned `npx` is
 * a third-party dependency tree, and a secret in its environment is a secret in
 * a process we cannot audit.
 *
 * Sandbox is not a default, it is a refusal. `PAYPAL_ENVIRONMENT` is the only
 * thing between this demo and real money, so `LIVE` is rejected outright rather
 * than honoured with a warning that nobody reads during a recording.
 */

import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createStdioMcpClient, type StdioMcpClient } from "./stdioClient";
import type { TokenProvider } from "../tokenProvider";

/**
 * Minimal child-process shape, matching `stdioClient`'s so the two compose.
 * Narrower than Node's own type on `kill`, whose signal is `number | Signals`.
 */
export type SpawnedServer = {
  stdin: { write(chunk: string): unknown };
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  kill?(signal?: unknown): unknown;
};

/** Injectable so the connection can be proven without spawning anything. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
) => SpawnedServer;

export type PayPalMcpConnection = {
  readonly client: StdioMcpClient;
  close(): Promise<void>;
};

export type ConnectOptions = {
  readonly tokenProvider: TokenProvider;
  readonly spawn?: SpawnFn;
  readonly command?: string;
  readonly args?: readonly string[];
  /** Sandbox is the only accepted value. Present to be rejected explicitly. */
  readonly paypalEnvironment?: "SANDBOX" | "LIVE";
  readonly bootTimeoutMs?: number;
};

/**
 * `npx` is a shell script, so on Windows the only thing on disk is `npx.cmd`.
 * Spawning bare `npx` there fails with ENOENT, which reads like a missing
 * install rather than a missing extension.
 */
const DEFAULT_COMMAND = process.platform === "win32" ? "npx.cmd" : "npx";
const DEFAULT_ARGS: readonly string[] = ["-y", "@paypal/mcp", "--tools=all"];

/**
 * Credentials that must never cross into a child process.
 *
 * Matched by name rather than enumerated, because the failure this prevents is
 * someone adding `PAYPAL_CLIENT_ID` to the spawn env later and not updating a
 * list. A prefix match catches the variants too.
 */
const CREDENTIAL_ENV_PREFIX = "PAYPAL_CLIENT_";

/** The ambient environment, minus credentials, plus what the server actually needs. */
function childEnvironment(token: string, environment: string): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith(CREDENTIAL_ENV_PREFIX)) continue;
    if (key === "PAYPAL_ACCESS_TOKEN") continue;
    inherited[key] = value;
  }

  return {
    ...inherited,
    PAYPAL_ACCESS_TOKEN: token,
    PAYPAL_ENVIRONMENT: environment,
  };
}

/**
 * Whether spawning needs a shell, decided per platform.
 *
 * Windows is the only platform that needs one, and only because Node refuses to
 * spawn a `.cmd` without a shell since the CVE-2024-27980 fix. The only `npx`
 * on disk there is `npx.cmd`, so without this the connection fails with
 * `EINVAL` before any token is spent — which is exactly how it failed.
 *
 * Not a style preference on the other platforms: a shell reinterprets the
 * argument list, so requesting one where it is unnecessary widens what has to
 * be quoted for no benefit. The arguments here are a constant, never user
 * input, which is what makes opting in on Windows safe.
 */
export function spawnOptionsForPlatform(platform: string): { shell: boolean } {
  return { shell: platform === "win32" };
}

const defaultSpawn: SpawnFn = (command, args, env) =>
  spawnProcess(command, [...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...spawnOptionsForPlatform(process.platform),
  }) as ChildProcessWithoutNullStreams;

export async function connectPayPalMcp(options: ConnectOptions): Promise<PayPalMcpConnection> {
  const environment = options.paypalEnvironment ?? "SANDBOX";
  if (environment !== "SANDBOX") {
    // Thrown before anything is minted or spawned. A token exists for the live
    // API only if someone deliberately asked for one, and this is that moment.
    throw new Error(
      `Refusing to connect to the PayPal ${environment} API: spendless is sandbox-scoped, ` +
        "and a demo that can reach live money is a demo that can take it.",
    );
  }

  // Minted before the spawn, because the server reads it from its environment
  // at boot. One mint per connection, not one per call.
  const token = await options.tokenProvider.getToken();

  const spawn = options.spawn ?? defaultSpawn;
  const child = spawn(
    options.command ?? DEFAULT_COMMAND,
    options.args ?? DEFAULT_ARGS,
    childEnvironment(token, environment),
  );

  const client = await createStdioMcpClient({
    spawn: child,
    ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
  });

  return {
    client,
    close: () => client.close(),
  };
}

