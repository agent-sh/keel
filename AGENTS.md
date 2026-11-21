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
  `src/engine/prompt-store.ts`), tools and prompt pinned per session across a
  daemon upgrade and taken from the new build when the session's cache is cold
  anyway (`src/engine/build-pin.ts`; a change that must not wait is marked in
  `src/core/build.ts`, and a prompt block of the owner's data says so with a
  `SystemBlock`), long tool output spilled to a
  file (`src/tools/spill.ts`), long material (pages, files, logs, a saved output)
  read in parts by cheaper reader models and compiled into one answer
  (`src/engine/reader.ts`, `src/engine/readers.ts`), and idle compaction before a long context's cache
  expires (`src/engine/compact.ts`).
- A change to a tool or a prompt block reaches a live session late by design
  (its tools and prompt are pinned, see above): when its cache is cold, or
  after `build_pin.max_age_hours` (24 by default). Mark it urgent in `URGENT`
  (`src/core/build.ts`), by the tool's or the block's name, when waiting that
  long would be wrong. Exactly two kinds of change need the mark: a safety
  instruction (what the model must or must not do with the owner's machine,
  data or accounts), and any change of what a tool does under an unchanged
  input schema (the model would keep the old description of the new
  behaviour). A removed tool or a changed input needs none: the pinned
  definition is not offered. Rewording, a new optional parameter and a new
  tool need none either.
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
- The loop is never held by a read over a whole table. A report over the
  ledger, a ranked search or a sum over every event runs on the read thread
  (`src/server/reads.ts`: a read-only connection of its own, tasks in
  `src/server/read-tasks.ts`). A session's events are kept without their
  bodies while a turn runs in it; a body is read with its run of events when a
  reader asks for it, and the whole is held to a memory budget and given back
  two minutes after the session idles (`src/core/store.ts`). A route that
  answers with a whole session brings it in first, a part at a time
  (`store.warm`).
- The loop waits for the disk as little as SQLite allows. The write-ahead log
  is synced and checkpointed on a thread (`src/core/checkpoint.ts`): the log
  is 16 to 64 MB under load, and the daemon's connection still checkpoints in
  a commit about once per 16,000 pages. A statement's undo pages stay in
  memory (`temp_store`), so a sort over a whole table belongs on the read
  thread. A start decides a session's idle timer from facts kept with its
  head, and the owner's hooks file is read again only when its mark on disk
  changed. What guards what runs is never decided from an earlier read: a
  repository's pinned hooks file and every file it covers are read at each
  event. A new write that every step of a turn makes needs a reason to be a
  commit of its own.
- A stall of the loop says what took the time. A watcher on a thread of its
  own (`src/admin/stall-watch.ts`) reads one shared number while the loop is
  well, and samples the main thread from `/proc` while it is held: on a
  processor, waiting for one, in a system call of its own (which file, which
  child), stopped. The decision is pure (`src/admin/stall-cause.ts`), and
  stalls with one cause are one Errors row. The watcher sees no JavaScript
  frames: synchronous work that can be long is wrapped in `timed`
  (`src/admin/stall.ts`) so a stall that computed names it.
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
| `src/server/reads.ts` | the read thread: heavy reads off the loop |
| `src/core/checkpoint.ts` | the checkpoint thread: the log's syncs off the loop |
| `src/admin/stall-watch.ts` | the stall watcher's thread: what the main thread did while the loop was held |
| `ui/` | React 19 UI, bundled by Bun from `ui/index.html` |
| `test/e2e/` | Playwright e2e per feature |

## Commands

```bash
bun install
scripts/dev.sh <port>          # dev daemon with hot reload on Bedrock, scratch state of its own
                               # (scripts/dev-watch.ts is its launcher: it reloads imported stylesheets and files a rebase
                               #  brought back, follows a daemon that restarted itself, and stopping it stops the daemon)
bunx tsc --noEmit -p .          # typecheck
KEEL_URL=http://127.0.0.1:<port> bunx playwright test   # e2e against that dev daemon (required)
bun test ./test/cli              # the command line e2e (builds the binary, scripted model)
bun test ./scripts               # the dev launcher's decisions (scripts/dev-watch.ts)
bun scripts/build.ts            # dist/keel, one binary (and dist/keel-ui.tar.gz, its page as a bundle)
bun scripts/build.ts --ui dist/keel-ui.tar.gz && keel ui install dist/keel-ui.tar.gz --url URL
                               # a UI-only change on a running daemon: no restart, turns go on, pages reload;
                               # refused when src/ differs from the daemon's build (that needs a restart)
```
