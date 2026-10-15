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

const SANDBOX = "https://api-m.sandbox.paypal.com";
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

async function main(): Promise<void> {
  const token = process.env["PAYPAL_ACCESS_TOKEN"];
  if (token === undefined || token.length === 0) {
    console.log("PAYPAL_ACCESS_TOKEN is not set — nothing to probe.");
    console.log("See human-todo.md H1-03/H1-04. This script needs H1-03 (Transaction");
    console.log("Search enabled) or every read below returns a permission error.");
    process.exit(0);
  }

  console.log("spendless spike — sandbox");
  console.log(`token: ${token.slice(0, 6)}…${token.slice(-4)} (length ${token.length})`);

  // ---- S-0-02 / S-0-03: is the account a business account with read access? --
  {
    const { status, body } = await call("/v1/identity/v1/account/get", token);
    if (status === 200) {
      const acct = body as { legal_name?: string; country_code?: string; email?: string };
      record(
        "S-0-02",
        "Is the connected account readable at all?",
        "OK",
        `legal_name="${acct.legal_name ?? "?"}" country=${acct.country_code ?? "?"}`,
      );
    } else {
      record(
        "S-0-02",
        "Is the connected account readable at all?",
        "FAIL",
        `HTTP ${status}: ${describeError(body)}`,
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

      if (identity !== null) {
        const verdict = findMerchantIdentity({ transaction_details: [{ transaction_info: identity.raw }] });
        record(
          "S-2-live",
          "Does a merchant-authored identity survive the round trip?",
          verdict.identitySource === "unknown" ? "NEGATIVE" : "POSITIVE",
          `first transaction ${identity.id} resolved to "${identity.merchantKey}" ` +
            `via ${verdict.foundIn ?? "nothing"} (${verdict.identitySource})\n` +
            `event_code=${identity.eventCode} amount=${identity.amountCents} ` +
            `status=${identity.status}`,
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
  {
    const { status, body } = await call("/v1/customer/disputes?page_size=5", token);
    if (status === 200) {
      record(
        "S-0-04",
        "Can merchant credentials reach /v1/customer/disputes?",
        "OK",
        "It answers. ARCHITECTURE.md §11a says it is the buyer's namespace — check\n" +
          "what it actually returns before treating the dispute lane as buildable.",
      );
    } else {
      record(
        "S-0-04",
        "Can merchant credentials reach /v1/customer/disputes?",
        "NEGATIVE",
        `HTTP ${status}: ${describeError(body)}\n` +
          "This is the expected result. The dispute lane in build-order item 9 is\n" +
          "not buildable on these credentials — cut it from the demo rather than faking it.",
      );
    }
  }

  // ---- S-0-04b: can we read subscriptions? --------------------------------
  {
    const { status, body } = await call("/v1/billing/subscriptions?page=1&page_size=5", token);
    record(
      "S-0-04b",
      "Can the sandbox list subscriptions?",
      status === 200 ? "OK" : "FAIL",
      status === 200
        ? `total_items=${(body as { total_items?: number }).total_items ?? "?"}`
        : `HTTP ${status}: ${describeError(body)}`,
    );
  }

  // ---- S-0-05: token TTL, from the live clock ------------------------------
  {
    const issuedAt = Date.now();
    const ttlHours = await measureTokenTtl(token, issuedAt);
    if (ttlHours === null) {
      record("S-0-05", "How long does the sandbox token actually last?", "UNKNOWN", "token already expired");
    } else {
      record(
        "S-0-05",
        "How long does the sandbox token actually last?",
        ttlHours > 9 ? "LONG" : "OK",
        `${ttlHours.toFixed(2)}h observed. AGENTS.md says 3–8h; the OAuth response ` +
          `says expires_in. Refresh at 80% of this, never discover it mid-demo.`,
      );
    }
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