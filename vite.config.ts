import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

/**
 * One config for two runtimes: the client and the Worker.
 *
 * The `@cloudflare/vite-plugin` runs `worker/index.ts` inside **workerd** —
 * Cloudflare's own runtime — rather than in Node. That is the entire reason to
 * use it rather than a `vite build` plus a separate `wrangler deploy`: local
 * dev is the production runtime, so a Worker that works locally works deployed.
 * The class of bug where Node has an API and workerd does not stops existing.
 *
 * **Routing is the other half.** `not_found_handling = "single-page-application"`
 * means a deep link serves `index.html` rather than a 404, and
 * `run_worker_first = ["/api/*"]` means `/api/*` reaches the Worker while every
 * other path is served straight from the CDN without invoking it. The Worker
 * only runs for the two or three endpoints that genuinely need it.
 *
 * **`@` resolves to `src/`** — the existing domain code — and the client reaches
 * into it for types and pure formatting helpers. It must not reach into it for
 * anything that touches a database, a secret or a clock. That boundary is not a
 * convention here: `test/integration/architecture.test.ts` already fails the
 * build if a module above the adapter layer imports `openai`, and the same test
 * is where a client-side import of `src/db` should be added.
 *
 * **Vite 7, not 8.** `@vitejs/plugin-react@6` wants Vite 8, but vitest 5 — which
 * carries this repository's 628 tests — is built on Vite 7. Upgrading the build
 * tool to satisfy a plugin would put the entire test suite at risk on the last
 * week before a submission, so the plugin is pinned to the version that speaks
 * Vite 7 and nothing else moves.
 */

export default defineConfig({
  plugins: [react(), cloudflare()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  /**
   * The client lives in `web/`, but Vite's root stays at the repository root.
   *
   * That looks like a contradiction and cost an afternoon to find. Setting
   * `root: "./web"` makes `@cloudflare/vite-plugin` resolve the Worker entry
   * relative to the *client* root, so `main: "worker/index.ts"` points at
   * `web/worker/index.ts`, which does not exist — and the generated config
   * comes out with no `main` field at all.
   *
   * The symptom is the worst kind: the SPA serves perfectly and every `/api/*`
   * request 404s, because there is no Worker to invoke. A green build, a
   * working page, and a page that cannot talk to its own API.
   *
   * So: root at the repository, entry in `web/main.tsx`, fonts in
   * `web/public`. The client is still entirely inside `web/`, which is what
   * stops a component quietly becoming a domain module.
   */
  publicDir: path.resolve(import.meta.dirname, "./web/public"),

  build: {
    outDir: path.resolve(import.meta.dirname, "./dist"),
    emptyOutDir: true,
    // Source maps ship to nobody but the error overlay, and a judge looking at
    // the bundle should not be able to read the app's structure for free.
    sourcemap: false,
  },
});