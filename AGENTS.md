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
  user message, a system prompt kept with the session (the same bytes across
  restarts, made again only when one of its blocks really changed: see
  `src/engine/prompt-store.ts`), long tool output spilled to a
  file (`src/tools/spill.ts`), long material (pages, files, logs, a saved output)
  read in parts by cheaper reader models and compiled into one answer
  (`src/engine/reader.ts`, `src/engine/readers.ts`), and idle compaction before a long context's cache
  expires (`src/engine/compact.ts`).
- A request counted over the model's window is never sent: the context is
  compacted first. A context no provider has counted yet (an imported history)
  is counted from its bytes at the model's own bytes a token, learned from what
  its provider reports (`token_ratios`). A history too long for one summary
  request is read as a text transcript: long tool outputs shortened oldest first,
  then in parts, each with the summary of the parts before it.
- An image never breaks a session. It is stored within `STORE`
  (`src/providers/image-limits.ts`, the one place for image limits, each with
  its reason and source), scaled down when it is larger; a larger one already
  in a history is sent as a scaled copy, the same bytes each request
  (`src/engine/image-fit.ts`); a request the provider still refuses over an
  image is sent again with the images at the limit it stated, else without
  the damaged ones, else without any, and the owner can have them sent again.
  Decodes are four at a time across the process.
- The owner's config folder (MCP servers, hooks, skills, plugins, agents) is
  edited only through `src/core/ownfile.ts`: whole or not at all, with what the
  file held kept as `<name>.prev`. The MCP manager reads and writes the file
  it is given (`configPath()` from the daemon's route) and merges a file that
  changed under it. `bun test` gets scratch config and state folders before
  any test loads (`test/preload.ts`, from the repository root), and the
  defaults refuse the owner's folders under a test. A probe or script that
  imports Keel source sets `KEEL_CONFIG_DIR` and a state folder first.
- Every failure is captured once in the `errors` table (`ErrorTracker.capture`)
  and shown live in the UI's Errors panel. Browser errors post to `/api/errors`.
- A session is told what went wrong in its scope without asking: failures of its
  turns, its agents and their tools are grouped per cause in `session_failures`
  (`src/automation/failures.ts`, the grouping in `failure-groups.ts`) and go to
  its model as one harness input, each cause once with a count. An agent that
  failed with no words of its own is told there instead of in a report of its
  own. Only what a notice can name is owed; a notice never starts a session
  held after the owner's Stop. The same rows are read at
  `GET /api/errors?session=<id>`.
- Every feature is researched first: how Claude Code, Codex, OpenCode and the
  other leading harnesses do it today, from current primary sources.
- Tests: no over-testing. One Playwright e2e per feature in `test/e2e/`, driving
  the real UI against the real daemon, with `shoot(page, name)` screenshots in
  both themes. Unit tests (`bun test`, next to the code) only for pure logic an
  e2e cannot reach.
- UI: tokens in `ui/src/styles.css` only; components use them (`bg-raised`,
  `text-muted`, `border-line`, `text-accent`). Base UI for behavior, our own
  Tailwind styling. Check the screenshots at 1920x1040 in both themes.
  Lengths are rem, in CSS and in arbitrary classes (`h-[1.125rem]`), so the
  text size the owner picks scales everything; px only for hairlines (2px or
  less), shadows and media queries. JS that measures in px multiplies by the
  scale (`ui/src/lib/rail.ts`).
- Public repo rules (agent-sh): no owner chat quotes, no hostnames or private
  project names, no em dashes in code or docs.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | CLI entry: `keel serve` and the client commands in `src/cli/` |
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
scripts/dev.sh <port>          # dev daemon with hot reload on Bedrock, scratch state of its own
                               # (scripts/dev-watch.ts reloads imported stylesheets and files a rebase brought back; a daemon
                               #  that restarted itself has no watcher: run dev.sh again)
bunx tsc --noEmit -p .          # typecheck
KEEL_URL=http://127.0.0.1:<port> bunx playwright test   # e2e against that dev daemon (required)
bun test ./test/cli              # the command line e2e (builds the binary, scripted model)
bun scripts/build.ts            # dist/keel, one binary (and dist/keel-ui.tar.gz, its page as a bundle)
bun scripts/build.ts --ui dist/keel-ui.tar.gz && keel ui install dist/keel-ui.tar.gz --url URL
                               # a UI-only change on a running daemon: no restart, turns go on, pages reload;
                               # refused when src/ differs from the daemon's build (that needs a restart)
```
