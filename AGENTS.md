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
  (`src/engine/reader.ts`, `src/engine/readers.ts`), idle compaction before a long context's cache
  expires (`src/engine/compact.ts`), and a cache plan for a session that waits past its cache's
  lifetime, on a wait it set or a long tool step: a one-token read keeps the cache warm (where the
  provider documents that a read refreshes it), its summary is prepared while warm, or it lapses,
  whichever the model's price and the wait's length make cheapest, told in its timeline
  (`src/engine/cache-plan.ts` decides, `src/engine/cache-plans.ts` runs it). Nothing is sent
  for a session that is held, whose waits are gone (its agent stopped), or whose cache has
  lapsed; the warm reads of one wait never cost more in all than one rewrite, across restarts
  (`cache_warm`), and a warm read is tried once and moves no session in the list.
- A change to a tool or a prompt block reaches a live session late by design
  (its tools and prompt are pinned, see above): when its cache is cold, or
  after `build_pin.max_age_hours` (24 by default). Mark it urgent when waiting
  that long would be wrong: a tool with `urgent` on its own definition, a
  prompt block by its name in `URGENT` (`src/core/build.ts`), one entry a line. Exactly two kinds of change need the mark: a safety
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
- A turn or an in-turn summary waits when the driver can tell the model request
  could not be sent (`src/providers/unreachable.ts`): DNS or connection setup
  failed, or the broker explicitly reports an upstream DNS or connect failure.
  Sessions share the wait (`src/providers/outage.ts`), try one at a time, and
  spread out when the provider answers. The wait spends no counted retry and
  does not reset the retry budget. Gateway timeouts, resets and broken replies
  keep the bounded retries, even if no response headers arrived. An overloaded
  model (a 529, a 503 in the provider's own words, a stream's overloaded or
  serviceUnavailable) is at capacity, not down: it joins no wait, and a turn's
  request is tried past the count, the backoff growing to five minutes, until
  the model has room (`overloaded` in `src/engine/retry.ts`); an agent's parent
  is told once that it still waits, and its answers are one Errors row a model.
  A gateway's own 503 keeps the bounded retries. Readers, side
  answers and summaries made ahead do not join the wait. The policy judge still
  fails closed when it cannot give a verdict.
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
  bodies for as long as anything reads the session (an hour after its last
  read), from an index that holds only those columns; a body is read with
  its run of events when a reader asks for it and given back two minutes
  after the session idles; the whole is held to a memory budget
  (`src/core/store.ts`). A session that is not in memory is brought in off
  the loop before it is read (`store.warm`): every request that names a
  session does, and so does whatever sends into one (an agent's report). A
  reader that cannot wait asks for a fact, not the session (`lastSeq`,
  `hasKind`, `headEvent`). A whole-session read that still lands on the loop
  is counted with who asked (`coldReads`, in `/api/resources`), named in the
  stall row, and fails the command line e2e.
- The loop waits for the disk as little as SQLite allows. The write-ahead log
  is synced, checkpointed and started again on a thread
  (`src/core/checkpoint.ts`): while the thread works the daemon's connection
  checkpoints nothing and syncs nothing, and the log holds 16,000 pages
  (66 MB) and what is written while the thread copies and takes the write
  lock (under 17,000 pages with twelve working sessions). A write of the
  loop waits only for the write lock, for the moment the thread starts the
  log again. The connection's transactions
  begin as writers and it keeps 16 MB of pages in its own memory
  (`src/core/store.ts`). A session that is not in memory has its pages read
  by the read thread before the loop reads them (`store.warm`). A stall in
  the database is named by its statement (`src/core/statement-label.ts`: a
  label, never a value). A statement's undo pages stay in
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
- A turn ends as "interrupted" only when `Engine.interrupt` was called for it,
  and every caller says who it is with a word of `src/core/stoppers.ts`, kept
  on the turn's end (`stopped_by`). What is said of the stop and what follows
  from it are read from that one table: only the owner's own Stop holds the
  queue as theirs, pauses a goal and keeps agents' reports from waking the
  session; a message of the owner's that takes the turn's place (an edit, a
  queued prompt sent now) is not a Stop. An abort that is not the turn's own
  (a hook's or a provider's time limit) is a failure of what aborted.
- A page costs what it shows. Its socket brings a session's whole stream (its
  events, the reply as it streams, what its turn is doing, its checkpoints)
  only while a view shows the session, and of every other session what a list
  shows, one frame per change: `src/server/scope.ts` says which frame goes
  where, `ui/src/lib/scope.ts` what the page asks for and when it lets go. A
  frame that one view reads across sessions is a feed there, never a frame to
  every socket. A view that lies under another is not drawn again until it
  shows (`ui/src/lib/cover.ts`). What the page does on a beat runs on its one
  clock, which stops while the page is hidden (`ui/src/lib/clock.ts`): no
  timer of its own in a module or a component that is always there.
- Every failure is captured once in the `errors` table (`ErrorTracker.capture`)
  and shown live in the UI's Errors panel. Browser errors post to `/api/errors`.
- A session is told what went wrong in its scope without asking: failures of its
  turns, its agents and their tools are grouped per cause in `session_failures`
  (`src/automation/failures.ts`, the grouping in `failure-groups.ts`) and go to
  its model as one harness input, each cause once with a count, and under it
  who failed: each agent with its own count and its own latest failure (three
  named, the rest by id), never another agent's, within a budget of about
  2,500 characters a notice (`DETAIL_CHARS`, `BODY_CHARS`). An agent that
  failed with no words of its own is told there instead of in a report of its
  own. Only what a notice can name is owed; a notice never starts a session
  held after the owner's Stop. The same rows are read at
  `GET /api/errors?session=<id>`.
- Agents start agents down to a depth limit, under one budget for the whole
  tree (`src/core/agent-tree.ts` says the numbers and why). A report goes to
  the agent that started it; an agent is not finished while its own agents
  work; a stop goes down the tree, and the owner's holds every agent below as
  the owner's. Agents of one tree message each other through the same queue
  as a parent's message (`agents.send` with its sender), and a peer's message
  releases no hold.
- An input a session's sender was told is taken is stored first and delivered
  once. A message (the owner's steer or queued prompt, a parent's message to
  its agent, another session's) is a row of the session's queue or its stored
  prompt before the sender is answered (`Engine.send`, `Engine.message`), and
  leaves the queue in the write that stores its prompt: a working session
  takes a steer at its next step, a turn a restart cut takes it in the
  continued turn's first request, after the restart note. A sender's key
  stores an input once (`input_keys`; a tool call's key is the reply that
  holds the call and the call's id, and a call a restart cut after its message
  was stored says so). A wake, a report, a loop run, a monitor's batches and a
  failure notice are owed in their own tables and settled in the write that
  stores their prompt (`flush` in `src/automation/core.ts`). A stopping daemon
  starts no turn: a queue it left with a prompt owed a start is started by the
  next one (`queue_owed`), again when its model lists if it does not yet. A
  hold says who made it (`queue_holds.by`): nothing but the owner starts a
  session the owner stopped, so a message to it waits in its queue behind the
  hold and its sender is told, and a sender's message releases only a hold
  that sender's own stop made. A message read in the turn of an agent's final
  answer does not replace that answer: an agent's report holds every final it
  wrote since its task began, the newest first and the earlier ones whole as
  far as the cap allows (`collect`, `fitReport` in `src/automation/agents.ts`).
  A message whose session can no longer read it
  (deleted, archived, the row removed) is told to its sender as a failure in
  its scope (`src/automation/undelivered.ts`), never dropped in silence.
- A run of a check a repository names (`.keel/checks.json` in the tree being
  checked, or the owner's `checks.repos` setting for it; `src/checks/named.ts`)
  is kept in the check ledger by the git tree it ran on, uncommitted files
  included (`src/checks/ledger.ts`). A check is known wherever it runs in a
  command that is read to its end: behind assignments, `cd`s, waits,
  `timeout` or `nice`, with its output sent to a file or through a filter,
  beside other commands. The tree is taken before the command when nothing
  before the check changes a file, else when the command ended when nothing
  from the check on does; a check whose words hold what the ledger cannot
  know (a `$` the command does not set, a substitution) is not counted. The
  shell reports each command it runs (`src/tools/shell.ts`), so a check that
  never started (its wait gave up) records nothing and one that ran is
  known by its own status. A check that passed on the same tree is
  answered from the ledger before anything of the command runs, its wait
  included, and only after the permission gate let the call through;
  sending the same command again runs it. What the command exports is part
  of what the run is known by. What a check reads beside the tree (installed
  packages, a lock file outside it, generated files) is named in its
  `inputs`, and an answer needs them unchanged. A look hashes new and
  changed files into an object folder of Keel's own, never the
  repository's, and at most `NEW_MAX` bytes of them: a run over that is
  kept with no tree and answers nothing. A red run says whether the base is red too, or that the tree is
  flaky. An agent's report carries a proof line from the ledger, never from a
  model (`src/checks/proof.ts`). The ledger keeps the newest
  `checks.keep_runs` rows (20,000 by default) and is read at `/api/checks`
  and in the session's timeline.
- A session's agent slots are its tree's and count the agents that work. An
  agent that waits on a wait of its own holds none. Its wake, and an agent
  asked for while every slot works, wait in line as owed and take the next
  free slot in the order they parked or were asked for
  (`src/automation/slots.ts`): none is refused or dropped for a slot, and the
  limit's refusal of a finished agent asked to go on says how many work and
  how many wait.
- Reports that come while an idle parent has other agents at work are one
  input: each turn a report starts reads the parent's whole context again. A
  report waits until no other came for two seconds, at most ten after the
  first (`REPORT_SETTLE` in `src/automation/agents.ts`); a report that comes
  when no other agent works ends the wait, and a parent whose turn runs (a
  `wait_agent` included) is never held by it.
- What an agent leaves behind is settled when it ends (`src/automation/leftovers.ts`, the decisions in
  `leftover-rules.ts`). Its commands' processes are stopped by what the daemon holds them by (the job's
  cgroup, else its process group, session and mark), never anything it did not start, unless a process
  that is not the agent's own is connected to their port. Keel removes by itself only what Keel made and
  recorded when it made it: the managed worktree of the agent's session and its branch, inside Keel's
  worktree folder on a `keel/` branch, when nothing of them would be lost (no uncommitted, untracked or
  hidden edit, its HEAD on its branch, no commit of the branch on no other branch than Keel's other live
  worktrees', no stash of the branch, no repository inside it, ignored or not, nothing working in it),
  one repository at a time. Nothing the agent can write (a command line, a file, a trace, a reflog) decides a
  removal: what else is new in its repositories since it started is only listed, with what is in it, in
  its report and on Settings > Leftovers (and `keel leftovers`). There the owner removes an item, or all
  that lose nothing at once; each act names the item as it was listed and is refused when it changed since.
- Every feature is researched first: how Claude Code, Codex, OpenCode and the
  other leading harnesses do it today, from current primary sources.
- Tests: no over-testing. One Playwright e2e per feature in `test/e2e/`, driving
  the real UI against the real daemon, with `shoot(page, name)` screenshots in
  both themes. A spec passes every time on the scripted daemon or is skipped
  by a probe that says what is missing (`test.skip(cond, "needs X: why")`): it
  waits for the product's own signal, never for a time, puts back what it
  changed, and asks the stand-in for a model's part with `ask(words, script)`
  (`test/e2e/shots.ts`). Unit tests (`bun test`, next to the code) only for pure logic an
  e2e cannot reach.
- A test assumes nothing about the machine it runs on. The test files of a run
  share one process and run in the folder's order on the disk, which differs
  from one machine to the next: a file leaves nothing process-wide behind
  (turn hooks, the secrets vault's tie to a store, the environment;
  `test/preload.ts` names a file that does, `test/env.ts` sets a file's own
  environment and puts it back). A setting from the environment is read when
  it is used, not when its module loads. A test that needs what a machine may
  lack (a sandbox, a desktop bus, a program) probes for it and is skipped by
  that name; it does not pass without checking. A clean second machine is the
  check: `scripts/remote-verify.sh`.
- UI: tokens in `ui/src/styles.css` only; components use them (`bg-raised`,
  `text-muted`, `border-line`, `text-accent`). Base UI for behavior, our own
  Tailwind styling. Check the screenshots at 1920x1040 in both themes.
  Lengths are rem, in CSS and in arbitrary classes (`h-[1.125rem]`), so the
  text size the owner picks scales everything; px only for hairlines (2px or
  less), shadows and media queries. JS that measures in px multiplies by the
  scale (`ui/src/lib/rail.ts`).
- The desktop app (`desktop/`) is the same page in a native window. The page
  learns it from `window.keelShell` (`ui/src/lib/shell.ts`), never from its
  user agent, and uses it only where the app does something a tab cannot. The
  daemon knows an app is attached by its open stream (`src/server/shell.ts`):
  a desktop notification goes to the app or is shown by the daemon, never
  both. Its routes are for the machine itself. What content in the page may
  reach is decided once, in the files every engine shares (`said.rs`,
  `clip.rs`, `links.rs`; the table is in `desktop/README.md`); an engine
  decides only what it must answer at once, by the same rule
  (`desktop/test/paths.txt` holds both to it).
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
| `desktop/` | the desktop app: a native window, tray mark and notifications around the page (Rust; the page drawn by Qt WebEngine through `desktop/qt/` where it is installed, else by GTK 4 and the system web view) |

## Commands

```bash
bun install
scripts/dev.sh <port>          # dev daemon with hot reload on Bedrock, scratch state of its own
                               # (a port below 32768: above it the kernel hands ports to outgoing connections, and
                               #  one that was free can be taken before the bind; the daemon then exits and says so)
                               # (scripts/dev-watch.ts is its launcher: it reloads imported stylesheets and files a rebase
                               #  brought back, follows a daemon that restarted itself, and stopping it stops the daemon)
bunx tsc --noEmit -p .          # typecheck
KEEL_URL=http://127.0.0.1:<port> bunx playwright test   # e2e against that dev daemon (required)
scripts/smoke.sh [SPEC...]       # browser specs with no credentials and no network: a daemon of its own on the
                               # scripted provider in a throwaway folder and network namespace (default: chat.spec.ts)
bun scripts/flake.ts [--runs N] [--seed N] [SPEC...]
                               # the specs N times (3), the files in another order each time, through smoke.sh (or against
                               # KEEL_URL, or --via "CMD"): a table of the tests that did not pass every time, and for a
                               # flaky one the specs it fails after. For a review: a change's failures, or the suite's own.
                               # A run of specs ends with "Summary: N passed, N failed, N skipped (counts by reason)";
                               # spec files named out of the order by name run in the order named (playwright.config.ts)
bun test ./test/cli              # the command line e2e (builds the binary, scripted model)
bun test ./scripts               # the dev launcher's decisions (scripts/dev-watch.ts)
scripts/remote-verify.sh --host build-box [--e2e SPEC...] [COMMIT]
                               # a commit (HEAD by default; the tree must be committed) checked on another machine,
                               # any host `ssh` reaches (or KEEL_VERIFY_HOST): pushed there, installed from the lockfile
                               # in a folder of its own, then typecheck, unit, ui lib, scripts and the command line e2e
                               # (and the named browser specs through scripts/smoke.sh) at a low priority with a clean
                               # environment; one line a stage, a table at the end, the logs copied back (--out DIR).
                               # At most two runs on a host at once, none when its load is over 20; --only unit,cli
                               # runs some stages. The host needs git, Bun and ssh, nothing else of this machine.
bun scripts/build.ts            # dist/keel, one binary (and dist/keel-ui.tar.gz, its page as a bundle)
bun scripts/release.ts && scripts/release-check.sh   # a release packaged in dist/release (revision, target, checksums),
                               # then verified outside the source tree with no Bun on PATH; nothing is published
bun scripts/build.ts --ui dist/keel-ui.tar.gz && keel ui install dist/keel-ui.tar.gz --url URL
                               # a UI-only change on a running daemon: no restart, turns go on, pages reload;
                               # refused when src/ differs from the daemon's build (that needs a restart)
desktop/build.sh                # desktop/dist/keel-desktop, the desktop app (install: for this account; deb: a package);
                               # and dist/keel-desktop-qt, its Qt WebEngine engine, where Qt's development files are installed
desktop/test/e2e.sh             # its e2e, in a hidden desktop with a scratch daemon (never the owner's screen);
                               # KEEL_DESKTOP_ENGINE=qt|webkit runs it with one engine
```
