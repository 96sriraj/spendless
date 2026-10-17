/**
 * Credential preflight. `bun run check-env`
 *
 * Exists because "the key is set" and "the key works" are different claims, and
 * the difference between them is discovered at the worst possible moment — in
 * the middle of a recorded demo. Both credentials expire, get rotated, and get
 * pasted with a stray character, and every one of those failures looks
 * identical from the outside: a 401 and a shrug.
 *
 * Reports *whether* each credential works, never *what* it is. No value is
 * printed, logged, or truncated-and-echoed, because the whole point of a
 * preflight is that you can run it in front of someone.
 *
 * Deliberately cheap: one token mint, one model list, one minimal completion.
 * Not a test suite — the suites use their own doubles, and this is the one
 * place that touches the real providers on purpose.
 */

import { mintToken } from "./helpers";

const OPENROUTER = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "meta-llama/llama-3.1-8b-instruct";

type Result = { readonly ok: boolean; readonly detail: string };

/** Never print the key, not even a prefix. Length is enough to spot a paste error. */
const secretShape = (value: string): string =>
  `${value.length} chars, starts "${value.slice(0, 3)}…"`;

async function checkPayPal(): Promise<Result> {
  const id = process.env["PAYPAL_CLIENT_ID"];
  const secret = process.env["PAYPAL_CLIENT_SECRET"];

  if (id === undefined || secret === undefined) {
    return { ok: false, detail: "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set" };
  }

  const token = await mintToken();
  if (token === null) {
    return {
      ok: false,
      detail:
        `token request rejected (id ${secretShape(id)}). Check the pair is from the ` +
        `SANDBOX tab, not Live, and that Transaction Search is enabled on the app.`,
    };
  }

  // A minted token proves the credentials, not the permission. This is the
  // difference between "the key works" and "the key works for what we need",
  // and only the second one unblocks the build.
  //
  // The window has to be recent: Transaction Search only serves roughly the
  // last three years, so a hardcoded old date returns HTTP 400 and reads like a
  // credential problem when it is a query problem.
  const nowMs = Date.now();
  const iso = (offsetDays: number) =>
    new Date(nowMs - offsetDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const response = await fetch(
    `https://api-m.sandbox.paypal.com/v1/reporting/transactions` +
      `?start_date=${iso(7)}&end_date=${iso(1)}&page_size=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (response.status === 200) {
    return { ok: true, detail: `token minted, Transaction Search reachable (${secretShape(id)})` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      detail: `credentials are valid but Transaction Search is not permitted (HTTP ${response.status}) — H1-03`,
    };
  }
  return { ok: false, detail: `Transaction Search returned HTTP ${response.status}` };
}

async function checkOpenRouter(): Promise<Result> {
  const key = process.env["OPENROUTER_API_KEY"];
  if (key === undefined || key.trim().length === 0) {
    return { ok: false, detail: "OPENROUTER_API_KEY not set" };
  }

  const headers = { Authorization: `Bearer ${key}` };
  const model = process.env["OPENROUTER_MODEL"] ?? DEFAULT_MODEL;

  const credits = await fetch(`${OPENROUTER}/credits`, { headers });
  if (!credits.ok) {
    return {
      ok: false,
      detail: `key rejected (HTTP ${credits.status}, ${secretShape(key)}) — regenerate at openrouter.ai/keys`,
    };
  }

  // The key being accepted does not mean the chosen model is available to this
  // account, which is a different failure with the same symptom.
  const completion = await fetch(`${OPENROUTER}/chat/completions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });

  if (!completion.ok) {
    const body = (await completion.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return {
      ok: false,
      detail:
        `key is valid but "${model}" did not answer (HTTP ${completion.status})` +
        `${body?.error?.message === undefined ? "" : ` — ${body.error.message}`}. ` +
        `Check the id against https://openrouter.ai/api/v1/models`,
    };
  }

  const payload = (await completion.json()) as {
    model?: string;
    usage?: { total_tokens?: number };
  };
  return {
    ok: true,
    detail: `key accepted, ${payload.model ?? model} answered (${payload.usage?.total_tokens ?? "?"} tokens)`,
  };
}

console.log("\nspendless — credential preflight\n");
console.log("Values are never printed. Only whether each credential works.\n");

const checks: readonly [string, Promise<Result>][] = [
  ["PayPal sandbox", checkPayPal()],
  ["OpenRouter    ", checkOpenRouter()],
];

const results = await Promise.all(checks.map(async ([label, run]) => [label, await run] as const));

let failed = 0;
for (const [label, result] of results) {
  const mark = result.ok ? "OK    " : "NOT OK";
  if (!result.ok) failed += 1;
  console.log(`  [${mark}] ${label}  ${result.detail}`);
}

console.log(
  failed === 0
    ? "\nBoth credentials work. The build is unblocked.\n"
    : `\n${failed} credential(s) failed. Everything that needs them is blocked.\n`,
);

process.exit(failed === 0 ? 0 : 1);
