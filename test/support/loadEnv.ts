/**
 * Make `.env` visible to the test process.
 *
 * `bun run` loads `.env` automatically. Vitest does not — it runs on Node, and
 * Node reads nothing it was not told to. So the live integration tests saw no
 * credentials and skipped, silently, while the same credentials worked from the
 * command line. A test that skips for the wrong reason is worse than one that
 * fails: it reports green while checking nothing.
 *
 * Deliberately minimal, and deliberately not a dotenv dependency:
 *
 * - **`KEY=VALUE` only.** No quoted values, no `export`, no interpolation, no
 *   multi-line. `.env` here holds exactly that shape, and a parser that guesses
 *   at the rest would be guessing at a credential.
 * - **Never overwrites.** A variable already in the real environment wins, so a
 *   CI secret beats a stale local file.
 * - **Absent file is not an error.** A clean clone with no `.env` should still
 *   run the whole suite — the live tests skip, and that is correct there.
 *
 * This file is a test helper and is exempt from the architecture gates, which
 * govern `src/` only. That exemption is the reason it may read the filesystem
 * at all.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(import.meta.dirname, "..", "..", ".env");

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return;

  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    // Blank lines and `#` comments. Leading whitespace is tolerated because a
    // hand-edited file will have some.
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    // The value is taken verbatim. Quotes are stripped only when they wrap the
    // whole value, which is the one case where leaving them would break
    // `PAYPAL_CLIENT_ID` comparisons for reasons no reader could see.
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    // Never overwrite: the real environment wins over a checked-out file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();