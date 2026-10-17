import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = import.meta.dirname;

/**
 * Three test tiers, one vitest run. See AGENTS.md -> Test-driven development.
 *
 * The tier decides what a test is allowed to fake, so the tier decides which
 * file a test belongs in. Running one tier is `vitest --project <name>`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  test: {
    projects: [
      {
        // Pure modules. One file per module, colocated. ZERO mocks.
        //
        // `web/` is in scope because `web/hero.ts` is a pure function deciding
        // what the headline *claims* — the one place on the client where a
        // mistake costs real money. It is deliberately separate from `App.tsx`,
        // which is untestable without a DOM and too thin to be worth one:
        // fetching a response and putting it on screen has no logic in it. CSS
        // imports are avoided here, which is why only pure modules are picked up.
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "web/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // Real collaborators: real SQL on real SQLite, real filesystem, a real
        // local HTTP server. Only PayPal and OpenRouter may be substituted,
        // and only behind the ARCHITECTURE.md section 3 seam.
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          // `bun run` loads `.env`; Node does not. Without this the live tests
          // skip for the wrong reason - silently green while checking nothing.
          setupFiles: ["test/support/loadEnv.ts"],
          testTimeout: 30_000,
        },
      },
      {
        // The demo journey end to end: seed -> detect -> rank -> propose ->
        // approve -> execute -> replay. Nothing inside the repo is faked.
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});