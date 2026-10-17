# UI build log

The design gate is `lint.mjs` and `inspect.mjs` from
[`.agents/skills/design-taste-frontend`](../../.agents/skills/design-taste-frontend).

```sh
node .agents/skills/design-taste-frontend/scripts/lint.mjs web worker index.html
node .agents/skills/design-taste-frontend/scripts/inspect.mjs http://localhost:5173/
```

**`inspect.mjs` needs Node 22+.** On this machine that means the nvm copy, because
`C:\Program Files\nodejs` is a standalone Node 20 install that shadows nvm (see
`AGENTS.md`):

```powershell
$env:PATH = "C:\Users\srira\AppData\Roaming\nvm\v22.14.0;$env:PATH"
```

---

## Step 0 — 2026-10-17 — the pipeline, not the design

**`lint.mjs`: 0 FAIL, 0 WARN.** No banned patterns in source.

**`inspect.mjs`: 2 FAIL, 2 WARN — and the gate is not passing.** Every one of
the four is "not built yet", none is "built badly", and each is owned by a later
step:

| Finding | Owner | Why it is not a defect yet |
|---|---|---|
| FAIL `few-pictures` — 0 pictures, 0 interface fragments | Step 2 | The skill counts a live interface fragment toward this floor. The run log is that fragment and it arrives when there is something real to stream. |
| FAIL `still-page` — 0 elements moved | Step 4 | Motion is the last step by design, so that the signature move lands on finished content. |
| WARN `first-action` — no button in the first screen | Step 3 | A button wired to nothing is worse than no button. |
| WARN `no-footage` — no video | — | Defensible. This is an application screen; stock footage of people at laptops would be exactly the generated-page tell the skill bans. |

What the inspector *did* confirm, which is the part that matters at this stage:

- **Switzer 100%** — no fallback face, so the self-hosted fonts actually resolve.
- **Four type sizes in use** (13 / 19 / 24 / 152px), under the five-step ceiling.
- **Display at 152px, 10.6vw** — above the 8.4vw median of the top-scored sites
  in the underlying study, which is the "spend the boldness in one place" rule
  being honoured rather than the calm-brand-site register the first dealt
  direction defaulted to.
- **Page ground `#ffffff`** — not the cream that passes for premium.

---

## Two bugs the screenshot caught that the code did not

**The hero figure was ten times too large.** `47_970` minor units renders as
`$479.70`, not `$47.97`. It typechecked, it looked plausible in the source, and
`lint.mjs` had no opinion. Only looking at the rendered image found it — which is
the argument for the screenshot being a build step rather than a final flourish.

**`root: "./web"` silently deleted the Worker.** The Cloudflare Vite plugin
resolves `main` relative to Vite's root, so `main: "worker/index.ts"` became
`web/worker/index.ts`, the generated config came out with **no `main` field at
all**, and the symptom was a green build serving a perfect SPA whose every
`/api/*` request 404'd — because there was no Worker to invoke. Recorded in
`vite.config.ts` where the next person will hit it.

---

## A security finding, resolved rather than noted

`@cloudflare/vite-plugin` materialises a `.dev.vars` file inside `dist/<worker>/`
**populated from `.env`** — the live PayPal client secret and OpenRouter key, in
plaintext.

Checked with `wrangler deploy --dry-run`: the upload is `index.js` and a README,
and a grep of the upload for the secret values returns nothing. So it cannot
reach Cloudflare. `.dev.vars` is now gitignored anyway, because "the build wrote
a credential to disk" should not depend on one flag in one config file staying
true.