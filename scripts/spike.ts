/**
 * The Spike, run live. `bun run spike`.
 *
 * Everything in ARCHITECTURE.md section 11b is answered by this one script, and
 * nothing in it is guessed. It exists because the sharpest remaining question -
 * "does the merchant-authored identity we are going to write actually come back"
 * - is a five-minute test, and there is no reason to spend a day on it.
 *
 * Reads PAYPAL_ACCESS_TOKEN from the environment. Never writes a secret to
 * disk, never prints one, never puts one in a committed file. If the token is
 * missing it says so and exits 0, so it can sit in a pipeline.
 */

import { writeFileSync } from "node:fs";
import { fieldInventory, findMerchantIdentity, IDENTITY_FIELDS, readTransactions } from "../src/adapters/inspect";
import { chunkRange, mergeTransactions, PAYPAL_MAX_WINDOW_DAYS } from "../src/adapters/chunkRange";
import { describeFreshness, readReportingFreshness, type ReportingFreshness } from "../src/adapters/freshness";
import { pickIdentitySubjects } from "../src/adapters/identityScan";
import { readOAuthToken, refreshAfterSeconds, SANDBOX_BASE_URL } from "../src/adapters/token";

const SANDBOX = SANDBOX_BASE_URL;
const DAY = 86_400_000;

type Result = {
  readonly probe: string;
  readonly question: string;
  readonly verdict: string;
  readonly detail: string;
};

const results: Result[] = [];

function record(probe: string, question: string, verdict: string, detail: string): void {
  results.push({ probe, question, verdict, detail });
  console.log(`\n[${verdict}] ${probe} — ${question}`);
  console.log(`  ${detail.replace(/\n/g, "\n  ")}`);
}

async function call(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; raw: string }> {
  const response = await fetch(`${SANDBOX}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: response.status, body, raw };
}

function describeError(body: unknown): string {
  const b = body as { message?: string; name?: string; details?: unknown } | null;
  const message = b?.message ?? b?.name ?? "no message";
  const details = Array.isArray(b?.details)
    ? b.details.map((d) => (d as { description?: string; issue?: string })?.description ?? "").join("; ")
    : "";
  return details.length > 0 ? `${message} (${details})` : message;
}

/**
 * Get a token.
 *
 * Prefers an explicit PAYPAL_ACCESS_TOKEN. Otherwise mints one from the client
 * credentials, which is what makes this a two-credential job rather than a
 * token-management job — and the OAuth response carries `expires_in`, which is
 * most of the answer to S-0-05 without waiting for anything.
 */
async function resolveToken(): Promise<string | null> {
  const explicit = process.env["PAYPAL_ACCESS_TOKEN"];
  if (explicit !== undefined && explicit.trim().length > 0) {
    console.log("using PAYPAL_ACCESS_TOKEN from the environment");
    return explicit;
  }

  const id = process.env["PAYPAL_CLIENT_ID"];
  const secret = process.env["PAYPAL_CLIENT_SECRET"];
  if (id === undefined || secret === undefined || id.length === 0 || secret.length === 0) {
    return null;
  }

  console.log("minting a sandbox token from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET…");
  const basic = Buffer.from(`${id}:${secret}`, "utf8").toString("base64");
  const response = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }

  if (response.status !== 200) {
    console.log(`\n[FAIL] OAuth returned HTTP ${response.status}`);
    console.log(`  ${describeError(body)}`);
    console.log("\n  Check the Client ID and Secret are the SANDBOX ones, not the live ones.");
    return null;
  }

  const parsed = readOAuthToken(body);
  if (parsed === null) {
    console.log("\n[FAIL] OAuth succeeded but the response had no usable token/expiry.");
    console.log(`  ${raw.slice(0, 300)}`);
    return null;
  }

  // S-0-05, answered immediately: the server states the lifetime. The long
  // measurement is a separate, opt-in run because it takes hours.
  const hours = parsed.expiresInSeconds / 3600;
  record(
    "S-0-05",
    "How long does the sandbox token actually last?",
    hours > 9 ? "DOC-DRIFT" : "OK",
    `OAuth response says expires_in=${parsed.expiresInSeconds}s (${hours.toFixed(1)}h).\n` +
      `AGENTS.md documents 3-8h. Refresh at ${Math.floor(refreshAfterSeconds(parsed.expiresInSeconds) / 60)}m.\n` +
      `This is what the SERVER claims; confirming it by waiting for a 401 is opt-in\n` +
      `via SPIKE_MEASURE_TTL=1 and takes up to ${Math.ceil(hours)}h.`,
  );

  return parsed.accessToken;
}

async function main(): Promise<void> {
  const token = await resolveToken();
  if (token === null) {
    console.log("\nNothing to probe. This script needs either:");
    console.log("  PAYPAL_ACCESS_TOKEN, or");
    console.log("  PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET");
    console.log("\nSee human-todo.md H1-03 (Transaction Search must be enabled on the app,");
    console.log("or every read below returns a permission error) and H1-04.");
    process.exit(0);
  }

  console.log("\nspendless spike — sandbox");
  console.log(`token: ${token.slice(0, 6)}…${token.slice(-4)} (length ${token.length})`);

  // ---- S-0-02: is this a business account with read access? ----------------
  // The identity endpoint 404s on the sandbox host, so the business-account
  // signal comes from an endpoint that is unambiguously merchant-scoped.
  // Either way the RAW BODY is recorded: a verdict of "OK" with no body tells
  // nobody anything, which is exactly what the previous run produced.
  {
    const probes = [
      { path: "/v1/catalogs/products?page_size=1", label: "catalogs (merchant-only)" },
      { path: "/v1/identity/v1/account/get", label: "identity" },
    ];
    for (const probe of probes) {
      const { status, body } = await call(probe.path, token);
      record(
        "S-0-02",
        `Is this a business account? (${probe.label})`,
        status === 200 ? "OK" : status === 404 ? "N/A" : "FAIL",
        `HTTP ${status}\n${JSON.stringify(body, null, 2).slice(0, 600)}`,
      );
    }
  }

  // ---- S-2-live: the whole read path, and what identity it can recover -----
  {
    const end = new Date();
    const start = new Date(end.getTime() - 90 * DAY);
    const chunks = chunkRange({ start, end });
    const label =
      `asked for 90 days, PayPal caps a window at ${PAYPAL_MAX_WINDOW_DAYS} days, ` +
      `so this is ${chunks.length} calls`;

    const batches: Awaited<ReturnType<typeof readTransactions>>[] = [];
    const inventories: string[] = [];
    let anyOk = false;
    let failure = "";
    let lastFreshness: ReportingFreshness | null = null;

    for (const chunk of chunks) {
      const params = new URLSearchParams({
        start_date: chunk.start.toISOString(),
        end_date: chunk.end.toISOString(),
        page_size: "100",
      });
      const { status, body } = await call(`/v1/reporting/transactions?${params}`, token);
      if (status !== 200) {
        failure = `HTTP ${status}: ${describeError(body)}`;
        continue;
      }
      anyOk = true;
      batches.push(readTransactions(body));
      // Keep the most recent cache timestamp across the chunks: a chunked
      // 90-day read can straddle a refresh, and the last chunk is the freshest.
      const freshness = readReportingFreshness(body, Date.now());
      if (freshness.lastRefreshed !== null) lastFreshness = freshness;
      const inventory = fieldInventory(body);
      if (inventory.length > 0 && inventories.length === 0) inventories.push(...inventory);
    }

    if (!anyOk) {
      record(
        "S-0-03 / S-2-live",
        "Can the sandbox read transactions at all?",
        "FAIL",
        `${label}\n${failure}\n\nIf this is a permission error, Transaction Search is ` +
          `not enabled on the app — human-todo.md H1-03.`,
      );
    } else {
      const merged = mergeTransactions(batches);
      const identity = merged.length > 0 ? merged[0]! : null;

      record(
        "S-0-03",
        "Can the sandbox read transactions at all?",
        merged.length > 0 ? "OK" : "EMPTY",
        `${label}\n${merged.length} transactions in the last 90 days` +
          (merged.length === 0
            ? "\nAn empty result is a valid answer for a fresh sandbox — create a plan and capture a payment (P4-01) before concluding anything."
            : ""),
      );

      // How stale is this read? Transaction Search is cached and lags the
      // capture API, so without this an empty or partial result is
      // indistinguishable from a broken one — and the only available answer
      // would be to sleep and hope. PayPal reports the cache time directly.
      if (lastFreshness !== null) {
        record("S-0-03b", "How far behind is Transaction Search right now?", "INFO", describeFreshness(lastFreshness));
      }

      if (identity !== null) {
        // Every row is scanned, not just the first. This account holds a T1900
        // adjustment carrying no identity at all, and row order is PayPal's to
        // choose — so reading `transactions[0]` would report `unknown` from the
        // adjustment while a seeded payment sat unexamined in the same response.
        const scan = pickIdentitySubjects(merged);
        const verdict = findMerchantIdentity({
          transaction_details: [{ transaction_info: identity.raw }],
        });

        record(
          "S-2-live",
          "Does a merchant-authored identity survive the round trip?",
          scan.identified.length > 0 ? "POSITIVE" : "NOT YET SEEDED",
          `${scan.identified.length} of ${merged.length} rows carry a trustworthy identity` +
            (scan.identified.length > 0
              ? `\n\n${scan.identified
                  .map(
                    (row) =>
                      `  ${row.id}  ${row.eventCode}  ${row.amountCents}  "${row.merchantKey}"` +
                      ` via ${row.identitySource}`,
                  )
                  .join("\n")}`
              : "\n\nnone — either too fresh for the cache, or not seeded") +
            // Reported separately because it is a lead, not an answer. The live
            // T1900 adjustment carries subject="Initial balance", and counting
            // that as an identity produced a false POSITIVE once already.
            `\n\nweak (free-text subject only, NOT a detector key): ${scan.weakOnly.length}` +
            (scan.weakOnly.length > 0
              ? `\n${scan.weakOnly.map((r) => `  ${r.id}  ${r.eventCode}  subject="${r.subject}"`).join("\n")}`
              : "") +
            `\n\nreported on ${identity.id}: "${identity.merchantKey}" ` +
            `via ${verdict.foundIn ?? "nothing"} (${verdict.identitySource})\n` +
            `event_code=${identity.eventCode} amount=${identity.amountCents} ` +
            `status=${identity.status}`,
        );
        // The raw ISO code, read from the response rather than inferred. This is
        // the account's actual settlement currency, and it is the missing piece
        // behind UNSUPPORTED_PAYEE_CURRENCY: order creation accepted 17
        // currencies, but the payee can only receive one of them.
        const amountOf = identity.raw as {
          transaction_info?: { transaction_amount?: { currency_code?: unknown } };
        };
        const rawCode = amountOf.transaction_info?.transaction_amount?.currency_code;
        record(
          "CURRENCY",
          "What currency does this account actually transact in?",
          typeof rawCode === "string" ? "FOUND" : "ABSENT",
          `transaction_amount.currency_code = ${JSON.stringify(rawCode)}\n` +
            "Read from the response, not assumed. This is the currency the account\n" +
            "settles in, which is what UNSUPPORTED_PAYEE_CURRENCY is about.",
        );
        record(
          "S-2-live",
          "Fields actually present in the response",
          "INFO",
          inventories.join("\n"),
        );
        record(
          "S-2-live",
          "Fields the detectors need",
          IDENTITY_FIELDS.some((f) => f.field === verdict.foundIn) ? "OK" : "CHECK",
          IDENTITY_FIELDS.map((f) => `${f.field} → ${f.source}`).join("\n"),
        );
      }
    }
  }

  // ---- S-0-04: can MERCHANT credentials touch the buyer's dispute API? -----
  // The previous run reported "OK" and nothing else, which is not a verdict -
  // it is a shrug. Reachable-and-empty is a completely different answer from
  // reachable-and-populated, so the body is recorded this time.
  {
    const { status, body } = await call("/v1/customer/disputes?page_size=5", token);
    const b = body as { total_items?: number; items?: unknown[] } | null;
    const items = Array.isArray(b?.items) ? b.items.length : "n/a";
    record(
      "S-0-04",
      "Can merchant credentials reach /v1/customer/disputes?",
      status === 200 ? "REACHABLE" : "NEGATIVE",
      `HTTP ${status}  total_items=${String(b?.total_items ?? "n/a")}  items=${String(items)}\n` +
        `${JSON.stringify(body, null, 2).slice(0, 600)}\n\n` +
        "REACHABLE IS NOT THE SAME AS USABLE. This is the buyer's namespace: a\n" +
        "merchant reaching it does not mean it lists disputes *against* the\n" +
        "merchant. Confirm the shape before treating the dispute lane as buildable.",
    );
  }

  // ---- S-0-04b: can we read subscriptions? --------------------------------
  {
    const { status, body } = await call("/v1/billing/subscriptions?page=1&page_size=5", token);
    record(
      "S-0-04b",
      "Can the sandbox list subscriptions?",
      status === 200 ? "OK" : "FAIL",
      status === 200
        ? `HTTP 200  total_items=${String((body as { total_items?: number }).total_items ?? "n/a")}\n` +
          `${JSON.stringify(body, null, 2).slice(0, 600)}`
        : `HTTP ${status}: ${describeError(body)}`,
    );
  }

  // ---- S-0-05: the measured TTL, only if explicitly asked ----------------
  // Opt-in because it sleeps for hours. Blocking every other probe behind it
  // would mean the answers nobody is waiting for delay the ones they are.
  if (process.env["SPIKE_MEASURE_TTL"] === "1") {
    console.log("\nSPIKE_MEASURE_TTL=1 — probing until the token 401s. This takes hours.");
    const issuedAt = Date.now();
    const ttlHours = await measureTokenTtl(token, issuedAt);
    record(
      "S-0-05",
      "How long does the sandbox token actually last?",
      ttlHours === null ? "UNKNOWN" : "MEASURED",
      ttlHours === null
        ? "token expired before it could be measured"
        : `${ttlHours.toFixed(2)}h observed against the live clock.`,
    );
  } else {
    console.log(
      "\nskipping the long token-TTL measurement (set SPIKE_MEASURE_TTL=1 to run it; it takes hours)",
    );
  }

  const report = [
    "# spendless spike — live sandbox result",
    "",
    `Run at ${new Date().toISOString()}.`,
    "",
    "## Verdicts",
    "",
    ...results.map((r) => `- **${r.probe}** ${r.question} → \`${r.verdict}\``),
    "",
    "## Detail",
    "",
    ...results.map((r) => `### ${r.probe}\n\n\`\`\`\n${r.detail}\n\`\`\``),
    "",
  ].join("\n");

  writeFileSync("spike-result.md", report, "utf8");
  console.log("\n\nWrote spike-result.md");
}

/** Probes until the token stops working, so the real TTL is measured not assumed. */
async function measureTokenTtl(token: string, issuedAt: number): Promise<number | null> {
  const deadline = Date.now() + 11 * 60 * 60 * 1000;
  for (;;) {
    const remaining = (deadline - Date.now()) / (60 * 1000);
    if (remaining < 1) return null;
    await new Promise((r) => setTimeout(r, 30 * 60 * 1000));
    const { status } = await call("/v1/identity/v1/account/get", token);
    if (status === 401) return (Date.now() - issuedAt) / (60 * 60 * 1000);
  }
}

await main();