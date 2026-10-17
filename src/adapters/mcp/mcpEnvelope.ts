/**
 * Unwrapping what an MCP tool actually hands back.
 *
 * The PayPal MCP server returns every tool result as an envelope, not as data:
 *
 *   { content: [{ type: "text", text: "<the actual JSON, as a string>" }] }
 *
 * So the payload is a JSON *string* nested inside JSON. That is the only
 * genuinely fiddly part of talking to the server, and it fails quietly: an
 * unparsed envelope yields `undefined`, `undefined` yields zero transactions, and
 * zero transactions is indistinguishable from a fresh sandbox.
 *
 * Everything here is therefore about refusing to return an empty answer for a
 * reason the caller cannot see. "We could not read it" and "there was nothing
 * there" are different facts, and only one of them is safe to render.
 *
 * There are **two** ways for this server to report a failure, and only one of
 * them is the obvious one. `isError: true` is the MCP-standard channel. The
 * other is an ordinary successful result carrying `{ ok: false, status, code,
 * message }` — PayPal's wrapper around its own HTTP failures. Both are handled
 * here, because a caller that reads neither will confidently proceed on an
 * error object.
 *
 * Pure: no transport, no spawning, no credentials. The stdio client is a
 * separate concern, and keeping this separable is what lets it be tested at all
 * without a sandbox.
 */

export class McpToolError extends Error {
  /** Which tool failed. The caller has several and needs to know which. */
  readonly tool: string | undefined;

  constructor(message: string, tool?: string) {
    super(tool === undefined ? message : `${tool}: ${message}`);
    this.name = "McpToolError";
    this.tool = tool;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort human text out of an error payload.
 *
 * Structured errors are the dangerous shape here, because they survive JSON
 * parsing and look exactly like data — so the keys worth surfacing are checked
 * before falling back to the whole body.
 */
function describeErrorBody(body: unknown): string {
  if (!isRecord(body)) return JSON.stringify(body);
  for (const key of ["error_description", "message", "error", "name"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return JSON.stringify(body);
}

/**
 * @param result the raw `tools/call` result.
 * @param tool the tool name, for error messages only.
 * @returns the parsed payload. `null` when the tool genuinely answered `null`.
 * @throws `McpToolError` on a tool-reported error, a missing text block, or
 *   text that is not JSON. Never returns `undefined` to mean "could not read".
 */
export function readMcpToolResult(result: unknown, tool?: string): unknown {
  if (!isRecord(result)) {
    throw new McpToolError(`tool did not return an MCP result envelope`, tool);
  }

  if (result["isError"] === true) {
    // Checked before anything else. A structured error is valid JSON, so
    // parsing first would hand the caller an error object as if it were data.
    const text = firstText(result);
    if (text === null) {
      throw new McpToolError("tool reported an error with no message", tool);
    }
    // A tool error is very often *not* JSON — `UNAUTHORISED: invalid
    // credentials` is a bare string. Falling back to the raw text matters,
    // because that string is the only description of the failure available.
    const parsed = tryParse(text);
    throw new McpToolError(
      parsed === FAILED ? truncate(text) : describeErrorBody(parsed),
      tool,
    );
  }

  const content = result["content"];
  if (!Array.isArray(content)) {
    throw new McpToolError("MCP result had no content array", tool);
  }

  // Keyed by `type`, not position. Servers may attach images or resources, and
  // reading blocks[0] breaks the moment one arrives first.
  const text = firstText(result);
  if (text === null) {
    throw new McpToolError("MCP result had no text block to read", tool);
  }

  const parsed = tryParse(text);
  if (parsed === FAILED) {
    throw new McpToolError(`MCP text block was not JSON: ${truncate(text)}`, tool);
  }

  // The second failure channel, and the dangerous one.
  //
  // PayPal's server does not use `isError` for HTTP failures. It returns the
  // error inside an ordinary successful result:
  //
  //   { ok: false, status: 422, code: "PAYPAL_API_HTTP_ERROR", message: "..." }
  //
  // Measured live 2026-10-17. Left unhandled it caused two real defects: a
  // failed `list_transactions` became an **empty account** — indistinguishable
  // from a fresh sandbox, which is precisely the confusion this module exists
  // to prevent — and a failed `cancel_subscription` became **succeeded**,
  // because the success test was "we got here".
  //
  // Keyed on an explicit `ok === false` rather than on the presence of
  // `status` or `message`, because legitimate PayPal objects carry both: a
  // refund reads `{ status: "COMPLETED", message: ... }` and must stay data.
  if (isRecord(parsed) && parsed["ok"] === false) {
    throw new McpToolError(describeErrorBody(parsed), tool);
  }

  return parsed;
}

/** Sentinel, because `null` is a legitimate parsed payload. */
const FAILED = Symbol("not-json");

function tryParse(text: string): unknown | typeof FAILED {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return FAILED;
  }
}

function firstText(result: Record<string, unknown>): string | null {
  const content = result["content"];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string") return text;
  }
  return null;
}

/** Error messages carry a snippet, not a whole HTML error page. */
function truncate(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}
