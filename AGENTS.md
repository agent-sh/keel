# keel-bun

Keel rewritten in Bun and TypeScript: one process runs its own agent loop and
tools, serves a React UI, and compiles to one binary. The Rust Keel
(`~/projects/agent-sh/keel`) is the feature reference: `docs/CONTRACTS.md` there,
and the inventory under `~/.cache/keel-work/bun/inventory/`. Research per area is
under `~/.cache/keel-work/bun/research/`.

## Rules

- Lean. Few dependencies, no framework where Bun has it (`Bun.serve` routes and
  WebSocket, `bun:sqlite`, `Bun.spawn` with `terminal` for PTYs, `Bun.Glob`).
- Nothing about models is hard-coded. A model exists when its provider's listing
  returns it; name, window, output limit and efforts come from the listing or the
  models.dev catalog (`src/providers/catalog.ts`). The default model is the
  owner's configured one (`KEEL_DEFAULT_MODEL`, else `ANTHROPIC_DEFAULT_MODEL`).
- Each model family gets the tools it was trained on (`src/tools/<family>.ts`).
- Token efficiency is part of every feature: append-only history (the provider
  cache prefix never changes), cache breakpoints on tools, system and the last
  user message, a frozen system prompt per session, long tool output spilled to a
  file (`src/tools/spill.ts`).
- Every failure is captured once in the `errors` table (`ErrorTracker.capture`)
  and shown live in the UI's Errors panel. Browser errors post to `/api/errors`.
- Every feature is researched first: how Claude Code, Codex, OpenCode and the
  other leading harnesses do it today, from current primary sources.
- Tests: no over-testing. One Playwright e2e per feature in `test/e2e/`, driving
  the real UI against the real daemon, with `shoot(page, name)` screenshots in
  both themes. Unit tests (`bun test`, next to the code) only for pure logic an
  e2e cannot reach.
- UI: tokens in `ui/src/styles.css` only; components use them (`bg-raised`,
  `text-muted`, `border-line`, `text-accent`). Base UI for behavior, our own
  Tailwind styling. Check the screenshots at 1920x1040 in both themes.
- Public repo rules (agent-sh): no owner chat quotes, no hostnames or private
  project names, no em dashes in code or docs.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | CLI: `keel serve` |
| `src/core/` | types, SQLite store, bus, error tracker |
| `src/engine/turn.ts` | the turn loop, history projection, system prompt |
| `src/providers/` | provider drivers, listing registry, catalog |
| `src/tools/` | tool profiles per family, spill |
| `src/server/app.ts` | HTTP API and WebSocket |
| `ui/` | React 19 UI, bundled by Bun from `ui/index.html` |
| `test/e2e/` | Playwright e2e per feature |

## Commands

```bash
bun install
scripts/dev.sh [port]          # dev daemon with hot reload on Bedrock, scratch state
bunx tsc --noEmit -p .          # typecheck
bunx playwright test            # e2e (needs the dev daemon on 47961)
bun scripts/build.ts            # dist/keel, one binary
```
