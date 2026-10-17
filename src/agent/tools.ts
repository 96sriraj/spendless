/**
 * The OpenRouter edge, and nothing else that knows it exists.
 *
 * One POST, one JSON shape, no SDK. Three reasons, in order of how much they
 * matter:
 *
 * 1. **The architecture gate bans `openai` above the adapter layer**, and this
 *    file sits above it. A hand-rolled client is the compliant option, not a
 *    compromise.
 * 2. The protocol surface actually used is one endpoint and one response shape.
 *    An SDK would be a dependency to upgrade three weeks before a submission.
 * 3. The SDK's error handling is *better*, which is precisely the problem: it
 *    would absorb the two failure modes this project cares about — a provider
 *    that answers 200 with no choices, and a tool call whose arguments are not
 *    JSON — and turn them into an empty string.
 *
 * **Determinism is requested, not hoped for.** `temperature: 0` alone is not
 * enough in practice, so a fixed `seed` goes with it. A demo that reruns
 * differently is a demo whose screenshots do not match its recording, and
 * `todo.md` P5-06 makes that a gate.
 *
 * **The client is not the allowlist.** An unknown tool name survives to the
 * caller intact, because rejecting it is the loop's job and the rejection has
 * to be *recorded* — see `agent.ts`. A client that silently dropped unknown
 * tools would hide exactly the behaviour the run log exists to show.
 */

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null }
  | { readonly role: "tool"; readonly name: string; readonly content: string };

/** An OpenRouter function tool, in the shape the API expects. */
export type ToolSpec = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  /** Parsed. Never the raw JSON string — see `parseArguments`. */
  readonly args: Record<string, unknown>;
};

export type Completion = {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: string | null;
  readonly usage: { readonly totalTokens: number | null };
};

export class OpenRouterError extends Error {
  readonly status: number;
  readonly providerMessage: string | null;

  constructor(message: string, status: number, providerMessage: string | null) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.providerMessage = providerMessage;
  }
}

export type OpenRouterClientConfig = {
  readonly apiKey: string;
  /** Overridable so a test can point at a local server. */
  readonly baseUrl?: string;
  readonly model?: string;
  /**
   * Sent as `seed`. A fixed default, because a client whose reproducibility
   * depends on the caller remembering to set it is a client that will drift.
   */
  readonly seed?: number;
};

export type CompleteRequest = {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly temperature?: number;
  readonly maxTokens?: number;
};

export type OpenRouterClient = {
  complete(request: CompleteRequest): Promise<Completion>;
};

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** D2, verified against the live catalogue 2026-10-17. */
const DEFAULT_MODEL = "meta-llama/llama-3.1-8b-instruct";
const DEFAULT_SEED = 20_261_017;

export function createOpenRouterClient(config: OpenRouterClientConfig): OpenRouterClient {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = config.model ?? DEFAULT_MODEL;
  const seed = config.seed ?? DEFAULT_SEED;

  return {
    async complete(request: CompleteRequest): Promise<Completion> {
      const body: Record<string, unknown> = {
        model,
        messages: request.messages.map(toWireMessage),
        temperature: request.temperature ?? 0,
        seed,
      };
      if (request.tools !== undefined) body["tools"] = request.tools;
      if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const payload = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        // The provider's own message is the difference between "rate limited,
        // wait" and "your key is wrong, stop". Both arrive as a bare 401-shaped
        // failure from the outside, so it has to be carried through.
        const detail = readErrorMessage(payload);
        throw new OpenRouterError(
          `OpenRouter returned HTTP ${response.status}${detail === null ? "" : ` — ${detail}`}`,
          response.status,
          detail,
        );
      }

      return readCompletion(payload);
    },
  };
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "tool":
      return { role: "tool", name: message.name, content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

function readErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

function readCompletion(payload: unknown): Completion {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    // Not an empty text answer. An HTTP 200 with no choices is the provider
    // failing in a way it did not think to report, and returning "" would let
    // the agent conclude "the model had nothing to say" — a confident wrong
    // answer where a visible failure costs one retry.
    throw new OpenRouterError("OpenRouter returned no choices to read", 200, null);
  }

  const choice = choices[0] as Record<string, unknown>;
  const message = (choice?.["message"] ?? {}) as Record<string, unknown>;
  const content = typeof message["content"] === "string" ? message["content"] : "";
  const rawCalls = message["tool_calls"];
  const toolCalls = Array.isArray(rawCalls) ? rawCalls.map(parseToolCall) : [];

  const usage = (payload as { usage?: { total_tokens?: unknown } }).usage;
  const totalTokens =
    typeof usage?.total_tokens === "number" ? usage.total_tokens : null;

  return {
    text: content,
    toolCalls,
    finishReason: typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : null,
    usage: { totalTokens },
  };
}

function parseToolCall(raw: unknown): ToolCall {
  const call = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const fn = (call["function"] ?? {}) as Record<string, unknown>;
  const name = typeof fn["name"] === "string" ? fn["name"] : "";

  return {
    id: typeof call["id"] === "string" ? call["id"] : "",
    name,
    args: parseArguments(fn["arguments"], name),
  };
}

/**
 * Tool arguments arrive as a JSON *string*, nested inside JSON. The same
 * double-encoding the MCP envelope has, and the same trap.
 *
 * The dangerous failure is `{}`. A model emitting `"{oops"` is a model having a
 * bad turn; reading it as "called the tool with no arguments" runs the tool on
 * invented input and produces a plausible wrong answer. So unparseable
 * arguments throw rather than degrade.
 */
function parseArguments(raw: unknown, toolName: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;

  if (typeof raw !== "string") {
    throw new OpenRouterError(`tool ${toolName} sent arguments of an unexpected type`, 200, null);
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new OpenRouterError(
        `tool ${toolName} sent arguments that are not a JSON object`,
        200,
        null,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof OpenRouterError) throw cause;
    throw new OpenRouterError(
      `tool ${toolName} sent arguments that are not valid JSON: ${trimmed.slice(0, 120)}`,
      200,
      null,
    );
  }
}