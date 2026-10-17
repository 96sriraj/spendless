/**
 * The run log.
 *
 * ---------------------------------------------------------------------------
 * WHY `fetch` AND NOT `EventSource`
 * ---------------------------------------------------------------------------
 *
 * A run has to be *started* by a POST — it creates a run, spends a model call,
 * and costs money. `EventSource` is GET-only and cannot carry a body, so it
 * cannot start one. The stream therefore arrives as a `fetch` response body and
 * is read frame by frame here.
 *
 * That also removes the reconnect machinery `EventSource` brings: a run is not
 * resumable, so reconnection semantics would have been a second, wrong model of
 * what this endpoint does. Reading until the terminal event is simpler and is
 * the truth.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TESTED, AND WHERE
 * ---------------------------------------------------------------------------
 *
 * Every decision in here is upstream of this component and lives in `runlog.ts`,
 * which is unit-tested: ordering by `seq`, replay idempotence, keeping steps on
 * failure, and refusing to revive a finished run. This file is a `map` and a
 * button. The one thing it does own — the frame decoder — is that same parser,
 * imported rather than reimplemented, because two parsers of the same protocol is
 * how a stream works in development and silently truncates on stage.
 */

import { useCallback, useRef, useState } from "react";
import {
  applyRunEvent,
  describeStep,
  emptyRunState,
  parseRunEvent,
  statusLine,
  type RunState,
} from "./runlog";

/** A `\n\n`-delimited chunk can split a UTF-8 sequence, so decode per frame. */
const decoder = new TextDecoder();

export function RunPanel() {
  const [state, setState] = useState<RunState>(emptyRunState);
  const abort = useRef<AbortController | null>(null);

  const running = state.phase === "running";

  const start = useCallback(async () => {
    if (abort.current !== null) return;
    const controller = new AbortController();
    abort.current = controller;
    setState(emptyRunState());

    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });

      // A 503 here is a sentence, not a stream: "OPENROUTER_API_KEY is not set".
      // Rendering it as a run failure would tell the presenter their agent broke
      // when their machine is simply not configured.
      if (!response.ok || response.body === null) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({
          ...emptyRunState(),
          phase: "error",
          error: body.error ?? `The run could not start (${response.status}).`,
        });
        return;
      }

      const reader = response.body.getReader();
      let buffer = "";

      // Read to completion rather than breaking on the first `done`. The server
      // closes after the terminal event, and stopping early would leave the
      // connection open until the isolate is recycled.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseRunEvent(frame);
          if (event !== null) {
            setState((previous) => applyRunEvent(previous, event));
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch (error: unknown) {
      // An abort is the user's own doing and not a failure worth reporting.
      if (!controller.signal.aborted) {
        setState((previous) => ({
          ...previous,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      abort.current = null;
    }
  }, []);

  return (
    <section className="log" aria-label="Agent run log">
      <div className="log__bar">
        <button className="action" type="button" onClick={() => void start()} disabled={running}>
          {running ? "Running…" : "Run the agent"}
        </button>
        <span className="log__status" role="status">
          {statusLine(state)}
        </span>
      </div>

      {state.steps.length > 0 && (
        <ol className="log__steps">
          {state.steps.map((step) => (
            <li className="log__step" key={step.seq} data-kind={step.kind}>
              <span className="log__seq">{step.seq}</span>
              <span className="log__label">{describeStep(step)}</span>
            </li>
          ))}
        </ol>
      )}

      {state.error !== null && <p className="log__error">{state.error}</p>}

      {state.finalText.length > 0 && <p className="log__final">{state.finalText}</p>}
    </section>
  );
}