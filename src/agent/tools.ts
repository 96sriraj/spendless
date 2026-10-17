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

/**
 * A message in the conversation, in the shape OpenRouter's chat API expects.
 *
 * The `assistant` and `tool` variants carry `tool_calls` / `tool_call_id`
 * because the protocol requires them to be paired: the assistant turn that
 * *asked* for a tool, then one tool turn per call carrying that call's id.
 * Measured live 2026-10-17 — omitting `tool_call_id` produces
 * `400 tool messages must include a non-empty string tool_call_id` on the very
 * first tool call, which would have taken the demo down at its first turn.
 */
export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      /** Echoed back verbatim; the API rejects the turn without them. */
      readonly toolCalls?: readonly {
        readonly id: string;
        readonly name: string;
        /** A JSON *string* on the wire — the same double-encoding as arguments. */
        readonly arguments: string;
      }[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

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
  /**
   * Why `args` is empty, when the model sent something unusable.
   *
   * Present rather than thrown, and that is a deliberate reversal of the first
   * version. The live 8B model emitted `{"limit":"50"}{"limit":"50"}` — the same
   * object twice, a streaming-accumulation artefact — and throwing turned one
   * bad turn into a dead run.
   *
   * The loop is where every other bad tool call is rejected and **recorded**,
   * and it should be the same path here: the run log then shows the model
   * getting it wrong and correcting, which is a better demonstration of a
   * constrained agent than a stack trace is.
   */
  readonly argsError: string | null;
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
  /**
   * Overridable so a candidate model can be tried without editing code — which
   * is how the default below was chosen against a live provider rather than
   * against a price list.
   */
  readonly model?: string;
  /**
   * Sent as `seed`. A fixed default, because a client whose reproducibility
   * depends on the caller remembering to set it is a client that will drift.
   * P5-06: same input, same proposals, which is what makes the run replayable.
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
/**
 * D2, revised 2026-10-17 by measurement rather than by catalogue.
 *
 * `meta-llama/llama-3.1-8b-instruct` is cheaper and was the original pick. It
 * **cannot be used**: on OpenRouter it emits every tool call's arguments twice,
 * concatenated — `{"limit":"50"}{"limit":"50"}` — which is not valid JSON. Six
 * consecutive turns, zero proposals, zero convergence: told its arguments were
 * malformed, it produced the identical doubled form again.
 *
 * `mistralai/mistral-small-3.2-24b-instruct` produces schema-valid tool calls on
 * the same prompt: one proposal, no rejections, answered in three turns.
 *
 * Cost difference is irrelevant at demo volume — 2.7k tokens is about $0.0007 —
 * so the choice is decided entirely by which one can actually call a tool.
 * `AGENTS.md` said "a small model with a tight schema beats a large one
 * wandering"; this one does not wander so much as it cannot emit arguments.
 */
const DEFAULT_MODEL = "mistralai/mistral-small-3.2-24b-instruct";
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
      // `tool_call_id` is what ties this result to the call that asked for it.
      // The API rejects the whole conversation without it, which is a 400 with
      // a message about a field most integrations never think about.
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            }),
      };
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
  const { args, error } = parseArguments(fn["arguments"]);

  return {
    id: typeof call["id"] === "string" ? call["id"] : "",
    name,
    args,
    argsError: error,
  };
}

/**
 * Tool arguments arrive as a JSON *string*, nested inside JSON. The same
 * double-encoding the MCP envelope has, and the same trap.
 *
 * The dangerous failure is `{}`. A model emitting `"{oops"` is a model having a
 * bad turn; reading it as "called the tool with no arguments" runs the tool on
 * invented input and produces a plausible wrong answer. So a parse failure is
 * **reported**, never silently degraded to an empty object — see
 * `ToolCall.argsError`.
 */
function parseArguments(
  raw: unknown,
): { args: Record<string, unknown>; error: string | null } {
  if (raw === undefined || raw === null) return { args: {}, error: null };
  if (typeof raw === "object") {
    return { args: raw as Record<string, unknown>, error: null };
  }
  if (typeof raw !== "string") {
    return { args: {}, error: `sent arguments of an unexpected type (${typeof raw})` };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { args: {}, error: null };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        args: {},
        error: `sent arguments that are not a JSON object: ${trimmed.slice(0, 120)}`,
      };
    }
    return { args: parsed as Record<string, unknown>, error: null };
  } catch {
    // Snippet, not the whole thing. This string reaches the run log, which is
    // rendered on screen, and a model can put anything in an argument.
    return {
      args: {},
      error: `sent arguments that are not valid JSON: ${trimmed.slice(0, 80)}`,
    };
  }
}