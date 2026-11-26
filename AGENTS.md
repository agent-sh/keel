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
  `SystemBlock`; a change of that data reaches a warm session as a note at the
  tail of its history, `src/engine/prompt-note.ts`; that note and the harness's other own words, never a tool's or an agent's, go
  in the system role (developer on OpenAI Responses) after the user message they end, where the provider documents it, the
  cached prefix unchanged: `TextBlock.system`, `operatorTail` in `src/providers/wires/common.ts`), long tool output spilled to a
  file past an inline part sized by what carrying it costs the session
  (`src/tools/spill.ts`, `src/tools/carry.ts`), long material (pages, files, logs, a saved output)
  read in parts by cheaper reader models and compiled into one answer
  (`src/engine/reader.ts`, `src/engine/readers.ts`), a long text file read with a family's read form
  (Claude's Read, Gemini's read_file; a shell returns its command's output) answered by default with the
  reader model's compiled reading of the page: what the file is, its parts with their lines, what matters for
  the caller's aim (`for`, else its task and last words), and the file's own lines put by Keel where the reader
  marked them (`src/tools/reading.ts`; the file itself with `raw`, for prose, instruction files, logs, a saved tool output and a file
  the session's prompts, an agent's task or a message sent to it name unless the call says `raw: false`, a page under the carry size,
  a program's read, or when the reader fails or is slower than a minute, said once; an edit of lines a reading
  did not show is refused with the read to make first, and only that same edit sent again is applied; on for the sessions the owner talks to
  (`sessions.read_through`), off for agents until the trial of it on agent trees ends with Keep
  (`agents.read_through`), both switches in Settings > Models, and `read_through` in a session's settings for one tree), idle compaction before a long context's cache
  expires (`src/engine/compact.ts`), and a cache plan for a session that waits past its cache's
  lifetime, on a wait it set or a long tool step: a one-token read keeps the cache warm (where the
  provider documents that a read refreshes it), its summary is prepared while warm, or it lapses,
  whichever the model's price and the wait's length make cheapest, told in its timeline
  (`src/engine/cache-plan.ts` decides, `src/engine/cache-plans.ts` runs it). Nothing is sent
  for a session that is held, whose waits are gone (its agent stopped), or whose cache has
  lapsed; the warm reads of one wait never cost more in all than one rewrite, across restarts
  (`cache_warm`), and a warm read is tried once and moves no session in the list. A message to
  an agent that finished its task starts the new work where it is cheapest: in its context, from
  a summary prepared while it was idle, or fresh from a capsule of its work made from its records
  with no model call (its task and messages verbatim, every report since its last checkpoint, that
  checkpoint's statements and story, the trail of its work), with the same id, session and place in
  the tree; priced from its context, its cache (one whose wire does not time it priced between warm
  and lapsed) and the model's price over the steps its last task took (`src/engine/follow-up.ts`
  decides, `Engine.followUp` puts it in place). A start the first step acts on is stored with the
  message (`follow_up`), never in memory. One cut mid-work goes on in its context. The owner can
  choose one on the agent's card. An agent's second read-only step in a row is told once a run what a
  step of its context costs and to send the reads it knows it needs in one step (`src/engine/read-run.ts`;
  a trial decides whether it stays, and whether it also offers an Explore agent on the reader model).
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
  tool need none either. A tool's mark reaches only the sessions that used the tool: one that never did waits like an unmarked
  change, and takes the mark at the request after its first call (`used` in `src/tools/pin.ts`,
  `src/engine/build-pin.ts`). Used means a call of the tool in the session's ledger, or, for a catalog (MCP)
  deferred tool only, a loaded definition; a built-in is never loaded, so a call is its only use. A safety
  change is marked with a `!` in front (`EVERY` in `src/tools/pin.ts`), which reaches every session, or is a
  prompt block mark, which always does. The store is asked once for a session and a tool, and a call or load
  is told to the pins as it happens (`BuildPins.called`), so a request costs no query for it.
- A request counted over the model's window is never sent: the context is
  compacted first. A context no provider has counted yet (an imported history)
  is counted from its bytes at the model's own bytes a token, learned from what
  its provider reports (`token_ratios`). A history too long for one summary
  request is read as a text transcript: long tool outputs shortened oldest first,
  then in parts, each with the summary of the parts before it.
- At a cold point (the route's cache has surely lapsed, so the request writes the whole context anyway), a tree
  that runs it (`cold_clear`, a trial's arm) sends old tool results as a line each (what the call was, its size,
  the file with its full text) and leaves out the thinking of earlier turns where the wire takes the oldest run
  out (`src/engine/cold-clear.ts`). The decision is a stored note of the session, so every later request projects
  the same bytes; a warm cache is never touched, and the newest results, errors, the owner's answers, results with
  anything but text and files a later call of another tool named stay whole.
- A session the owner talks to compacts at the window's line, and by price as an agent does when he turns it on
  from its menu (`owner_compact_by_price`, `src/engine/owner-compact.ts`): the summary is written when a turn ends
  and takes the history's place only at a turn's first step (not a run that continues a turn a restart cut) or a
  cold one, never inside a running turn on a warm cache, when what it really leaves still pays, and only when its
  meaning check holds (no statement retold, every owner message, card answer and attachment kept whole within a
  quarter of the window, the probe's files and recurring identifiers at `MEANING_KEPT` or more, no identifier
  nothing it read holds); one held back is told once in its timeline (kept with the prepared row, across restarts)
  and stays for the window's line. Every compaction keeps the owner's words with his messages: his answers on question
  cards, his reasons on denied calls, his feedback, note or edit on a plan, each with what it answers (a closing
  question, the card's question, the call, the plan's start) beside it, outside his message, in the room his words
  leave (`ownerReplies`, `owner_about` in `src/engine/compact.ts`). Its dialog shows the session's own numbers before the switch and
  since (`src/admin/owner-compact-read.ts`). It is a switch, not a trial: the trials kit draws an arm once per
  session at its first turn, and the owner's long sessions are few and already running.
  `scripts/bench/compaction-replay.ts` replays a session's shape through the engine with it off and on. The saving
  is for sessions of short turns: on replays of session shapes, with one to five steps a turn, tokens read fell to
  32 to 52% and dollars to 38 to 66%; with 25 steps a turn, tokens to 56 to 66% and dollars to 63 to 79%; with 40
  steps a turn or more, little or nothing, and up to 4% more dollars. The dearer a cache write is against a read
  (the two price sets tried put it at 12.5 and 40 times), the less it saves.
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
- Every model request passes its account's line for its model
  (`src/providers/admission.ts`, in the registry's wrap): limits are counted per
  model, so a 429 holds that model's line, and the whole account only when the
  headers name a limit of the plan (a subscription that refused, a ChatGPT plan
  window used up). A request is held only on the account's own word: a 429 (its
  retry-after, else a refused plan's reset, else the earliest reset of a window
  its headers say is spent, else one retry's backoff). An answer whose headers
  say a model's requests or tokens window has nothing left holds nothing for a
  time (a bucket refills continuously; its reset is when it is full): that
  model's next request goes alone. A plan's percentage and a spent quota hold
  nothing. When a hold ends one request goes first and the rest go after its
  answer, a little apart. The order: the owner's own turns, then sessions a page
  shows, then agents by depth, then readers, titles, summaries made ahead and
  side answers; a request that waited a minute goes with the owner's turns. A
  turn's 429 that the line holds is waited out in the line, not by the turn's
  own backoff, and keeps its retry status (the provider's message, the attempt,
  the countdown) with the line's words added. A hold longer than a turn waits is
  refused unsent, as the provider's 429 would be, except one request every five
  minutes that asks the account; its answer clears the hold. A request held with
  no 429 of its own says so in its status (`limit`). The line's callbacks into
  the engine never break it.
- An image never breaks a session. It is stored within `STORE`
  (`src/providers/image-limits.ts`, the one place for image limits, each with
  its reason and source), scaled down when it is larger; a larger one already
  in a history is sent as a scaled copy, the same bytes each request
  (`src/engine/image-fit.ts`); a request the provider still refuses over an
  image is sent again with the images at the limit it stated, else without
  the damaged ones, else without any, and the owner can have them sent again.
  Decodes are four at a time across the process.
- Every session reads one chain of instruction files, whatever its model's family: the owner's Keel file, Claude
  Code's and Codex's user files, then each folder's CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, its AGENTS.md
  slot (Codex's override first) and .claude/AGENTS.md, each file once: a link, the same text, or a file of only
  imports of files the chain holds is one (`instructionChain`, `OnceSet` in `src/engine/native-memory.ts`; nested
  folders the same, `src/engine/nested.ts`). A session's prompt made in a folder lints its agent configs with agnix
  in the background, niced, bounded, one run at a time and only when their contents changed
  (`src/integrations/agnix.ts`); the findings are a line in Settings > Health and the folder's instructions view,
  and errors reach a session of the folder once as a note told to the model (`src/server/routes/agnix.ts`).
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
  `hasKind`, `headEvent`). A call's reply is looked for among its branch's
  newest replies (`replyOf` in `src/core/tree.ts`), never to the branch's
  start: a call a program made (run_code) is in none, and is asked for like
  any other. A whole-session read that still lands on the loop
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
  (`src/admin/stall.ts`) so a stall that computed names it. Work that is long
  only as many short sections (a walk over a session's history reads its
  event bodies a run at a time) gives `timed` its kind: the sections of one
  kind are summed between two ticks and named together, with how many.
- The daemon's environment holds no secret (`src/safety/closed-env.ts`, `src/safety/env-secret.ts`). A
  command a session runs as the same user can read `/proc/<daemon>/environ`, which shows what the
  daemon was started with. At start the daemon is started again once in the same process (the
  collector's exec, `src/core/relaunch.ts`, or one of its own): the names that carry a secret go
  through a pipe in the place of standard input, are put into `process.env`, and standard input
  becomes `/dev/null`. The runtime starts a program with no `env` from the environment it began
  with, so `Bun.spawn` and `Bun.spawnSync` are wrapped to give `process.env` then: what the daemon
  starts gets what it did, except a command hook and a handoff script, which get `scrubbedEnv` (the
  environment without the names that carry a secret); a hook lists the names it needs in
  `allowedEnvVars`, and a handoff script keeps the proxy variables only. An ACP agent is the owner's
  own coding agent and often signs in from the environment: it gets the whole environment, and the
  scrubbed one plus the names in `env_vars` only when its entry sets `env_vars` (as an MCP server's). A start whose pipe could not be read (another
  process's handover, standard input not a pipe, bad JSON) is logged and Health says it
  (`sandbox:environment-lost`). Memory is not closed by making the process non-dumpable (that closes
  `/proc/<daemon>` for the daemon's own readers too): Yama's ptrace_scope of 1 or more already
  limits attaching to ancestors, and Settings > Health says both facts (`sandbox:environment`,
  `sandbox:ptrace`). A daemon a client command starts in its own process is not started again; its
  row warns.
- WebFetch uses the fetch program when it is installed, and the program resolves and connects by itself. With
  a proxy in the environment (`HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY`, and `NO_PROXY` not covering the name)
  it would send the name in CONNECT and the proxy would resolve it again after the local check, so the
  built-in fetch is used then (`viaProxy`, `src/tools/pinned.ts`): it resolves once, vets every address and
  connects to a vetted one, the proxy getting that address.
- A start holds the loop for under 100 ms at any moment (`src/engine/start-hold.test.ts`). The turns a
  restart cut go on one at a time, each let go when the one before has prepared its first request
  (`src/engine/pace.ts`), and a request's preparation yields the loop between its hooks and before its
  send. What a start reads of the store for nobody in a hurry (the cut sessions, the rows of the sessions
  used in the last hour) waits behind a report on the read thread (`Reads.rowsLater`) instead of being
  read on the loop.
- One switch pauses the fleet (`src/automation/fleet-pause.ts`, the settings section `fleet_pause`, kept across a
  restart): the engine's `stepHold` makes every turn the owner did not start wait before its next model step (loop
  runs, wakes, agents' turns, follow-ups), with its reason in its status; only a top session's turn the owner's own
  words started or steered goes on. Optionally the unattended turns running now are stopped (stopper `pause`).
  Resuming frees what waits. `keel pause`, `keel resume --fleet`, a row in the pane's menu.
- Agent trees wait for the machine (`src/automation/load-hold.ts`, the pure rule in `load-rules.ts`, settings
  `load_hold`): when every reading of the last minute has the 1-minute load over the thread count, the same
  `stepHold` holds the newest trees' next model steps (as many as the load over the line is shares of a working
  tree: held trees add no load and are not counted), and a tree that starts while the machine has no room waits
  from its first step; the oldest held go first once the load plus their share fits under the line (with every
  tree held, the oldest goes once the load is under the line), one change a minute. A wait is capped at
  `MAX_WAIT_MS` (ten minutes): the tree goes on, the newest working tree takes its place while the machine is still
  over, it rests as long before it can be held again, and its parent is told once. Never held: a turn that carries
  the owner's word (`Engine.byOwner`, agents included: one his turn started, one he wrote to from its card), an
  agent an owner's turn blocks on (wait_agent), and a session whose tools run on another machine. A held step
  keeps its cache by the cache plan (`CachePlans.held`, the wait's shape from the hold). The status says the load,
  the rail has one quiet line while trees wait, and Settings > Health has the row with the day's account.
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
- An agent whose context is lost (the model declined, its context could not
  be made to fit, its provider kept failing past the retries) is taken up by a
  fresh context of itself, with no step of its parent's
  (`src/automation/successor.ts`): the same id, place and worktree, a new
  session, a brief the harness writes from its records (its task with every
  message its parent sent to any of its contexts, a declined one restated by a
  small model, and the facts of its work: files, head, checks, the last failure
  as a class). No word of a declined reply is in the brief or in any report: a
  declined reply is left out of a report as it is out of the history, and after
  a refusal the head is named by its id alone (its subject is the lost
  context's words). The restatement is used when `rewordHolds` passes, which
  checks only its length and that it does not open with an apology or a
  refusal; otherwise the brief goes as given, and a verbatim brief that is
  declined again is bounded by the family switch. A second refusal moves the
  work to a model of another family; after two successors the report says so
  and the parent decides. The parent hears one line a successor, riding its
  next input. Not a loss: a turn's step budget (the owner's or the
  definition's, which a fresh context would get whole again), an unreachable
  provider, a provider whose outage is open, or a wait the provider asked for
  past a turn's. What the task used (steps, dollars, the agents under it) is
  counted over every context it had (`usedOf`).
- Everything that leaves is a row of the `egress` table (`src/safety/egress.ts`):
  each transfer the daemon makes or carries, with its session, call, tool,
  host, port and bytes sent. A fetch of the daemon is recorded by the tap; code
  that sends another way (a helper program, a spawned git, the sandbox's proxy)
  calls `noteOutward`, and new code that sends runs inside an `outward` label
  that names what sends; a WebSocket's rows come from `socketRows` (its opening,
  each message sent). A row's reason keeps no address (`plainWhy`: no path,
  user or query), and a failed push is a class, never git's words. An export to
  a page on this machine is no row. The rows wait with the side writes and are
  kept `retention.egress_days` (30 by default); the day's report
  (Settings > Network) runs on the read thread.
- An answer the owner gives on a model's question card can be kept as a
  standing ruling for questions like it, in the asking session's tree, its
  repository or everywhere (`src/automation/rulings.ts`). A later agent of that
  scope that asks the same thing is answered from it with no card: in the same
  words (only case, spacing and a trailing `?!.` aside) with the same options,
  else by a small model of the owner's chain that reads the words, never by the
  id the asking model gave the question; a near-miss (a negation, another
  target, another time) is another question (`src/automation/ruling-match.ts`,
  pure). The answer names the ruling and
  quotes the owner's words, rides as the call's result (never a prompt edit),
  and is a row of the session's timeline; Settings > Rulings lists and revokes
  them. A permission card, a server's question and an answer marked just this
  once never reach a ruling.
- A route that is out does not hold an agent for as long as it lasts when the owner said otherwise
  (`route_change` in the settings, Settings > Models, `src/engine/route-change.ts`): a rule names an
  agent type (or every agent), a number of minutes, a listed model of another provider and optionally
  the provider it leaves. An agent whose provider has been unreachable that long (counted from when
  the outage began), or whose model has answered overloaded that long, goes on on that model in the
  same session at its next request, which is a step boundary: its history goes to the other model as
  at any model switch, with the new model's own tools and prompt. Only agents, never a session of
  the owner's; only to a model that lists, takes tools, is on a provider the session's folder allows,
  and is itself reachable, not overloaded and not shut; never back (the agent finishes where it moved);
  its transcript says so and its parent hears one line. A target that cannot take the work leaves the
  agent waiting, said once in its failures.
- A command MCP server holds no process until it is used. Its last listing (tools, instructions, whether it
  has resources or prompts, its prompts) is kept in the state keyed by a hash of its command, arguments and
  environment names (`mcp-tools.json`, `src/mcp/manager.ts` `keep`/`useKept`), and a server with one and an
  accepted pin starts asleep: its tools are in the catalog, nothing runs. Only a listing the owner already
  accepted sleeps (`accepted`), and each kept listing is signed with Keel's own key: one edited in the file,
  or differing from the pin, makes the server connect as one with no kept listing, so a change is only ever
  reviewed from what the server itself lists (a server with no process has nothing to accept: asking starts
  it). Its first call, a search that shows one of its first three servers' tools, or a read of its resources
  or prompts starts it; the listing it gives then replaces the kept one, and a changed list is a tool
  change for the owner's review as before (`settle`). With no call for `mcp_idle.stop_min` minutes it
  loses its process again (`stopIdle`); not one with a call under way, resources it is told about, a channel
  the owner takes, `keep_running` set, or a browser the owner did not choose to close when idle. A server
  with no kept listing connects at start, as before.
- The owner's helper answers only edits of plain text files and relays the
  owner's typed answers (`src/helper/relay.ts`); every command, MCP call and
  other card is the owner's. A card is the helper's only when it is on the
  allow-list in `src/safety/delegate.ts` (`offList`), which holds what Keel
  itself can see whole: an edit or a write in the session's folder on this
  machine of inert files by type (`inertFile`: .md, .markdown, .txt, .rst,
  .csv, .tsv, .log, and .json, .yaml or .toml whose name is no tool's
  configuration or manifest), with `codeFile` as a second check, not
  executable, and with one name: a file with more than one hard link is the
  owner's, checked when the card is decided and again on the descriptor the
  write goes through (`writeHeld` in `src/tools/files.ts`, which refuses a
  write whose file's link count changed since the gate's look). A command's
  effect depends on what the card does not show (its program's configuration,
  login shell startup, the session's environment), and an MCP server's hints
  are its own claim, so neither is on the list. Nothing else: every other card
  is the owner's, decided in code whatever the helper says, named by its class
  or `unseen`. A form is added to the list, never a form to a list of refusals.
  The text of a card the helper reads is escaped (`cardText`), and a card the
  helper had at a restart that the owner has not seen goes to a fresh context
  once before it goes to him (`restored` in `src/helper/cards.ts`); its row
  is cleared only when the owner's alert is stored.
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
- A failure cause that recurs across a repository's agent trees becomes one
  proposed lesson (`src/automation/lessons-mine.ts` mines, read-only, on the
  read thread; `src/automation/lessons.ts` keeps them): a tool call's failure
  class from the tool ledger, a cause of `session_failures` that is not a
  tool's, a provider's or a message's, or a review finding by its words, in
  three agent trees within two weeks. What a failure said reaches a model or
  the owner with the vault's secrets and anything key-shaped hidden and the
  machine's folders folded (`exampleOf`, `told` in `lesson-draft.ts`). The
  owner is shown five at a time, the most trees first, each drafted by a small
  model of the owner's chain (or said to be no agent's to avoid, kept apart);
  the rest wait undrafted behind them. Only a cause whose trial the
  repository's own pace of trees decides within a week is drafted by itself
  (`perArm`, `trialOf`: the sample that finds a halved class four times in
  five); each card says what its trial needs. Settings > Lessons shows each
  with its evidence; the owner accepts it (in his words), edits or drops it,
  and a dropped cause is never proposed again. An accepted lesson rides in the
  task of the repository's agents at their start, never in a system prompt.
  Its trial is a live experiment of the lesson template (unit: agent trees,
  an agent a top-level session started; only the repository's), read on
  `lesson_class`, whether a tree failed with its class (0 or 1): kept when
  the arm told it wins, dropped with the numbers when the trial shows it hurt,
  and otherwise in use, undecided, with its numbers (`fateOf`). While another
  live experiment runs, an accepted lesson goes to every agent and its trial
  waits.
- Agents start agents down to a depth limit, under one budget for the whole
  tree (`src/core/agent-tree.ts` says the numbers and why). A report goes to
  the agent that started it; an agent is not finished while its own agents
  work; a stop goes down the tree, and the owner's holds every agent below as
  the owner's. Agents of one tree message each other through the same queue
  as a parent's message (`agents.send` with its sender), and a peer's message
  releases no hold.
- The landing queue's after step (`land.after` in `.keel/checks.json`) runs in the owner's checkout after the
  base moved, so it is held like a hooks file (`src/landing/land-pin.ts`): it runs only while the owner's pin
  holds its command and the files of `.keel/` it runs, as the landed commit has them, with the land block it comes
  after (push, setup, checks and their commands, as the batch runs them). Held, the batch still lands and is
  pushed, and the outcome says why the step waited; the Trust panel shows it whole. The queue's push is read for
  private words as a session's own `git push` is (`publicSend`, `src/safety/public-send.ts`): a hit or a part it
  could not read skips the push with the words, and the step is told nothing was pushed. This repository lands
  through its own queue: the land block runs typecheck, both conventions tests, the touched tests
  (`scripts/touched-tests.ts`) and the scripts stage on the clone's verify host (`git config keel.verifyHost`),
  pushes to origin, and `.keel/land-install.sh` builds the landed commit from a checkout of its own and installs
  over the compiled daemon that landed it what changed (`scripts/install-kind.ts`): nothing when no file the
  binary is compiled from (its import graph, `src/core/api-stamp.ts`), no file of the build and no toolchain file
  changed and the built page is the one served (by digest); the page alone through `keel ui install`, with no
  restart, when only the page did; else the binary, through the daemon's own restart (which may wait for the owner to
  step away). What cannot be compared is the binary's. Its output and receipt say which; a failed install puts the previous binary back unless a new daemon runs, and is an Errors row. The
  work board takes what runs from the daemon's own revision when this repository holds it, and from the step only
  when its last line said it installed nothing or the page alone (`keel-land-installed:`, `installedOf` in
  `src/landing/rules.ts`): the engine is then the same and the landed commit's work is in place.
- A plan of lanes is checked before any of its agents starts
  (`src/automation/lane-plans.ts`, the pure part in `src/landing/lanes.ts`):
  each lane's files (declared, named by its brief, their importers), the pairs
  that meet in a file (a hub file counts: both lanes say they edit it), and a
  proposed order or merge. A later lane of the order is a stored owed start,
  taken when the lanes it waits on ended and the base holds their work, and
  never while the plan's session (or one above it, by the owner) is held. A
  plan is made on a named branch. A start that fails marks its lane failed,
  and a lane that waits on one that will not land by itself (failed, stopped,
  not started, or its work not on the base) is marked blocked by it; the
  plan's session is told each once (`failures` kind `plan`). A lane whose
  commits change another lane's files is told once a file, in its next model
  request. Briefs rarely name the files where lanes collide, so a coordinator
  declares them.
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
- Text bound for a public place under the owner's name is read for private words before it leaves
  (`src/safety/public-send.ts`, the words in `private-words.ts`): the commits a `git push` sends (messages, authors,
  file names, branch and tag names, added lines), what a commit made on the same command line will hold (its `-m`/`-F`
  messages, the index and working tree against HEAD), and the text of the `gh` writes that publish (pr, issue, release,
  gist when public, repo edit, api, with a body file the line writes itself). Public is asked of the remote (`gh repo
  view`, else an anonymous `git ls-remote`, kept ten minutes, each probe cut at its end with its process group); a
  private repository is not read. A push after the same line changes where a remote leads in a way that is not
  followed (a second address, a rename, a setting or a config of the line's own) is read as going to a public place,
  and so is one to an address written on the line (one it gives a remote, or one the push names) where a url rewrite
  is in force, the repository's or the owner's.
  Private is learned: sentences the owner typed in the session, the fleet's machines,
  ssh aliases, folders his sessions work in (live ones whose repository is not public, never the repository the text
  goes to), his home path, vault values and token shapes, and the `private.terms` setting; his login, his accounts'
  owners and a URL's owner place are never private, and a short or common word is not found inside a longer name written
  with `-`, `_` or `.`. What could not be read (a failed or cut log, a missing body file, a text past the limit) holds
  the call too, with what was not read. The text is scanned in slices with the loop free between. A hit holds the call
  in every mode, full auto included (as the provenance rule does): the owner's card quotes it and allows once, an agent
  is refused with the same words. What he allowed is his answer for the same words there until the session ends
  (`src/safety/public-allowed.ts`): a finding his card quoted, with the same repositories, file, kind, word and line,
  whatever commit carries it, is not asked about again, and the card says so. A new one, another repository, one the
  card only counted, a secret (its line is hidden, so nothing tells it from another), a line too long to show whole,
  a sentence of his that runs past the line quoted (the card does not show all of it) and whatever could not be read
  ask as before, and the card lists only what is new.
- A turn nobody started (a loop run, a wake, a monitor's batch, a watch, an agent's report to an idle
  parent, a goal's later turn) merges, approves, turns on auto-merge, force-pushes and deletes a remote
  branch or tag nothing, in every mode (`src/safety/unstarted.ts`; the owner's message to the session lifts
  it: `Engine.byOwner`). A turn started on the owner's word is a prompt they sent, or a message from their
  agent's card or a review's fix; an agent's task and its parent's or a peer's messages carry that word only
  when the sender's turn held it. This is a guard against an unattended turn doing those acts by their usual
  commands (gh, glab, git, a request to a forge's merge or approve route from any program, a gh alias or a git
  alias made to run them), not a sandbox: a program that reaches the forge by a route it does not know, or a
  script on disk, is beyond it. `--force-with-lease` and the delete of a branch are refused there by design,
  an agent's own branch included. A stored shell rule covers nothing in Read only and Plan.
- A card is the last resort, and one call opens one. A push or a gh write the owner would be asked about because the
  line spells where it goes or what it sends with a variable or a substitution (`cd "$D" && git push`,
  `git push origin $H:main`) goes back to the model once to be written out (`src/safety/written-out.ts`, the gate's
  `writeOut`): the rules place nothing by such a word, the model knows the value, and the line that comes back is read
  exactly. The same line again is judged as it is, at most `WRITE_OUT_MAX` lines of a turn are sent back, and a
  refusal stands where a card stood: nothing runs that did not. `git -C ~/folder` is read as the home folder the shell
  writes out, only when the word is unquoted and the line cannot give HOME another value; a `cd` under `~` by the same
  rule. A folder the line's own git makes (`git worktree add`, `git clone`, `git init`) is not on the disk when the
  line is read (`src/safety/line-makes.ts`): a write in it, or where a clone or a new checkout of the line may stand,
  is not placed, never no write; a push with no remote named after the line gives a remote an address there is not
  placed either, and what a push from such a repository would send is not read (it is held, unless the push says
  itself that it goes to a folder or a private repository). A
  `cd` leaves the shell nowhere else when its failing ends the shell (`|| exit`, a group that only says something and
  exits, a `set -e` that opens the script), or when it is the line's first command, on a line of its own, to a folder
  written from the root that the disk says is there, outside a sandbox (`elseOf` in `src/safety/risk-words.ts`); the
  last three only on a line with no code its words do not show (a sourced file, an eval, a trap, a command an
  expansion names). What
  the owner alone can allow for one call (private words, a target outside content named, an account beyond his) is
  said on one card.
- A repository with a land block lands through its queue, not by hand (`src/safety/land-push.ts`, the gate's
  `landBack`). A model's `git push` that moves the base of the session's own repository (a commit, a branch or HEAD to
  `main`, `--all`; the base is the local branch the queue lands, and the push goes to the land block's push remote,
  origin by default, or names none: a fork, another remote, a URL, a path or a dry run is no landing) goes back to the model once with the `keel__landing_queue` call to make and the branches at that
  commit, before what it sends is read; the same line again is judged as it is. A turn nobody started is refused it every
  time, as a merge is, when the line names its folder (one spelled with a variable is only written out). A push of the commit the base already is here (the queue landed it and its push did not go) is no
  landing, and the owner's own terminal is never judged.
- A protected file named through a name the line sets is a path the command does not spell out (`unspelt` in
  `src/safety/policy.ts`). The rules read a name as its value one step back, where the line sets it once, written out,
  in a command that always runs; a name set in steps (`q=$p/own; D=$q`), by a substitution, a loop or a `read`, or
  used in a loop, a group or a `${D%/}` is not read, and nothing is placed by one. A word that holds such a name where
  a protected path is looked for (a redirect's target, a file a writer or reader the rules know is given, the file
  `git config -f` sets something in, a relative one of those after a `cd` spelled so) is tried as the paths the words
  of the line let it be: the values they show the name given, and for a value they do not show the folder the line
  runs in, the session's and the home, with its steps back up and without. When one is a file that is the owner's
  alone to change or a credential, the line asks as high risk and says the path to write into the command. It only
  raises: it is asked of a line every other rule lets run or asks about as low risk, and a name with nothing
  protected in sight asks nobody. A name the line does not set is an unknown variable, as before.
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
- A spawn in a repository says what was tried there before: its result (once, never the system prompt) names
  the closest earlier agents of that repository, at most three, each with how it ended (landed, refused by
  review with the first finding's class, abandoned, working now), its branch and head, and the first line of
  its report (`src/automation/earlier.ts`; the ranking, task words and the files they touched, is
  `earlier-rank.ts`, the outcome words `earlier-line.ts`, the reads on the read thread `earlier-facts.ts`).
  Outcomes come from git, the review and landing rows and the agent's record, never from a model; the lookup
  takes at most four seconds and never fails a spawn.
- A session carries a dollar cap for itself and everything it starts (`cap_usd` from `cap_from` in its
  settings; an agent's own dollar budget is the same cap over its task: `src/automation/caps.ts`, the pure
  rules in `cap-rules.ts`). Its row and header show the share spent and the rate of the last ten minutes
  with the hour's forecast from it (one `caps` frame when a figure changed, a feed the views that show a
  capped session name). The pulse reads them off the loop, one statement a cap on the ledger's session
  index, every ten seconds while any cap is set, and puts its exact figure under the gate's running sum.
  The gate before a step (and a spawn, and the hold below) reads that sum: the ledger rows after the last
  one it read, so its cost does not grow with the tree. A call with no price when it ran is counted at the
  model's listed price now; the popup says when calls on a model with none ran. At 80 percent the owner (a
  top session's own failures list) or the parent (an agent) is told once with the spend and the forecast,
  again for a raised cap. At 100 percent a running step finishes and then: the agents below get the report
  step, no agent starts (a spawn, or new work for a finished agent, is refused), a goal pauses, and what is
  not the owner's own words (a loop run, a timer wake, an agent's report) waits in the session's queue, told
  once with an alert, until the cap is raised. The owner's own message runs its turn whole, with a note that
  the cap is reached and what was spent (`Engine.byOwner`). One press (doubling,
  `POST /api/sessions/:id/cap`) lets the rest go on.
- Live branches are checked together before they land (`src/landing/together.ts`; the pure part,
  which pairs and what they run, in `pairs.ts`). After each forecast pass, the pairs that merge clean
  and touch related code (a shared file, an import between their files, a test that reaches both in
  two imports) are merged on the base in a worktree of Keel's own and the repository's fast checks run
  there: its named checks that take no words, and its unit check with the tests that reach both sides,
  nearest first, at most `PAIR_TESTS` (`pairs` in `.keel/checks.json` names others, or `false`). A hub
  file (one much of the base's recent work touches, or many files import: `hubsOf`) relates a pair
  only where both change lines of it near each other; an import of a hub relates nothing. The sides
  run a failing check alone only when it failed together, and red together, green apart and red again
  is told to each agent's parent once and shown on both cards; red on both sides alone (or a setup
  that fails) is the base's or the setup's, told to the owner once, and holds the repository's pairs
  until its base or its checks change. A result is kept by the two heads; a pair whose head moves is
  dropped from the line and between its runs. A pair is due when both heads were still for
  `together.quiet_s`; at most `together.at_once` run at once, each command after a slot of the heavy
  pool with what the landing queue gives its commands (`KEEL_LAND_REPO`), niced here or on
  `together.host` while its load leaves room.
- A check a repository marks `beside` runs by itself after an agent's change
  (`src/checks/beside.ts` decides, `src/checks/beside-run.ts` runs): the steps
  of a 30 s window are one run (a turn's end runs it at once), one run at a
  time per agent, only for a tree that is not the one checked last and that
  changes something over the base, never for an agent past the owner's Stop.
  It runs on a copy of the agent's files in a folder of Keel's own (its
  installed packages linked from its `inputs`, their real places shown to the
  sandbox), in the agent's sandbox, behind every other command of the heavy
  pool (or on the owner's `checks.beside.host` when this machine has no room);
  the copy goes when the agent's turn ends with nothing running or waiting. A
  check with `tests` gets the tests the latest change touches (the tree's
  difference from the one checked last), the most direct first and at most
  `PICK_MAX`: the changed tests and the ones still red, a changed file's own
  test, the tests that walk the source tree under one, its folder's tests,
  the tests that import it. Its time limit is sized from its test files; a
  run longer than `RUN_MAX_MS` is not made. Each run is a ledger row on its
  tree (`by: "beside"`), never the base's evidence. A red is told once: to a
  working agent as a harness message (`checks_beside`, its next step takes
  it), to one that waits on its own at its next step, and of a finished one
  to its parent's failures notice (kind `check`, riding its next input): it
  never gives a finished agent new work. A green one says nothing.
- A branch head that changes the page has before and after pictures, taken
  when someone looks (`src/pictures/`): the Review panel, the tree review or a
  work board card's pictures opening a head whose tree names them
  (`.keel/pictures.json`: page folders, specs, a command, sizes, themes, the
  harness) starts its one run, and Take again another. Nothing is told to the
  agent's parent; the board's line says what it found. The fewest specs that
  reach the changed files (by the test ids they render, through importers, or a
  picture named after them; `select.ts`) run through the command on the merge
  base with the head's harness and on the head, in the agent's sandbox, after a
  heavy-pool slot that every other command goes before. The command runs with
  `KEEL_PICTURES_FIXED`: this repository's scripted daemon then fixes its ids
  and clock (`src/core/fixed-world.ts`) and each page's clock starts at the
  daemon's (`test/e2e/isolate.ts`). A pair that still differs is checked
  against a second run of the base with only the specs that took it; a pair
  that moves only where the two base runs differ is unstable, never changed,
  and a cell outside them is a change. Each side's result is kept in the row:
  a restart goes on at the unfinished side. Only tests changed, or no page
  file: no run.
- A write to a terminal is judged as what it types when the terminal runs with no sandbox
  (`src/tools/typed.ts`): a job records that it started unwrapped (its launch left the sandbox, or the
  session has none). Each line a write completes is a command to the gate, in every mode, read by the
  same rules and the provenance gate; a write that completes no line, a poll, Ctrl-C and arrow keys pass,
  and so does any write to a sandboxed terminal. The program in the terminal's foreground
  (`src/tools/foreground.ts`) decides the reading: a shell takes commands, an interpreter or remote login
  is code and asks, any other program is answered at its prompt. A line edited by keys whose result Keel
  cannot follow (history, completion) asks (`src/tools/typed-lines.ts`).
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
- A target that outside content named first is held. A host, an email address, a git remote or a branch name is
  kept per session with where it first appeared (`src/safety/provenance.ts`, read from the stored events;
  `src/safety/provenance-books.ts` for the sessions above, the agents below and the repository). Outside content is
  a page, an MCP server's answer (every server but Keel's own until servers are classed), the output of curl,
  wget or gh, a channel event, an imported transcript, and an agent's report when that agent read any of these.
  Of a session copied from the owner's own store here (Claude Code, Codex; not Antigravity, whose store does not
  say whether a person or a script entered a prompt),
  the prompts a person typed are the owner's words: the reader marks them `typed` from its format's own record
  shapes, the copy keeps the mark only for such a source, in an import the owner started, and never for words
  Keel's drive sent there (`src/drive/sent.ts`: one broad rule, a prompt that holds anywhere a run of up to six
  words a model sent is the model's, punctuation aside, checked on the read thread; losing an owner prompt's mark is
  the safe side, so a one-word send costs every prompt holding that word its mark. The history's sends are read once
  before any mark is kept, run_code's calls and `/model` commands included, a cut send by its words before the cut;
  the keys are all kept. A send is refused while the session's input box shows the owner's unsent draft
  (`src/drive/box.ts`, read from its screen); when the box cannot be read empty, and for the history's sends, a
  send's words are also kept without their first and last word, so a draft word glued to them hides nothing. A far machine's Keel is told before the send, or once it can when its build is older, and
  told on each link that nothing more waits: a Keel keeps no mark while any daemon paired with it has not said so,
  one Errors row naming it, so a pair with a Keel of a build before that word keeps every copy there unmarked), and
  the gate reads it through `src/safety/imported.ts`; the rest of
  the copy stays outside. A search result lists an address (a page fetch of that address, or of a page above it with no query, goes on;
  a path or query it did not list, a header, a cookie or a body is a send). A text is read whole, in chunks,
  with a turn of the loop between them; a text past 8 MB, or more than 50,000 targets in a session, leaves the
  session "unbounded" (an agent's report brings it up; a full book drops the model's own sightings before
  outside content's), and it then holds a send to any target it has no sighting of that is not the owner's or
  the repository's: what the model's own call spells after that is no sighting (the call is stored before the
  gate sees it). A host is any name in a URL or an ssh form (any
  top-level domain, punycode, an IPv6 literal, a trailing dot); a bare name needs a known one. Not covered: a
  subdomain or an IP of a host the page named is another target (a name that carries data in a label, or a
  host a program computed, is not followed). A call that sends to such a target (a fetch, a
  push, curl, ssh, scp, mail, an MCP tool that does not only read) asks the owner in every mode, a hook's or a
  grant's allow included, and its card says where the target first appeared; an agent is refused with the same
  words. A target the owner typed, one the repository held before the session, one the model's own call named
  first, or one the owner allowed on a card is not held; a push to a remote the repository holds is not held
  even when a page named its forge's host. A session on another machine reads no repository there: a remote
  it names by name (`git push origin`) is no target, a URL it spells is held as any other. In an unbounded
  session a branch no sighting names is not held when it goes to a remote the repository holds, or when the
  model made it here and it exists; one a page named is. The judge's input
  carries the same fact.
- A job scope that is not this daemon's job (another daemon's, or its own record's scope whose processes carry another
  daemon's mark) is never signalled by Keel. A refused record is said once for its scope and mark, across restarts
  (`foreignFirst`), as a notice row that counts toward no spike of failures (`isNotice`), and every such scope is
  listed in Settings > Leftovers with what it holds (`src/automation/foreign-scopes.ts`), where the owner stops it:
  the act names the marks it was listed with and is refused when they changed.
- A setting with a cost effect is tried before it is kept (`src/admin/setting-trials.ts`, Settings > Usage > Trials):
  half of the new agent trees (the unit is the agent a top-level session starts, with everything under it) are
  assigned the other value at their start, by the one assignment of live experiments (`src/admin/experiments.ts`);
  the card reads the one report (`src/admin/experiment-report.ts`, computed on the read thread while a trial runs):
  what a turn and a tree cost, failures and time, with intervals. A tree's figures are read once it is settled, over the
  first trees of each arm in assignment order, so the arm that finishes first is not the sample. The trial's size
  and time come from the rate new trees start at; it ends when its sample is settled, at its time limit, or when a
  guard finds harm. Keep sets the owner's setting for agents (`agents` in the settings), Drop leaves it. A new
  trial is a row of `SETTING_TRIALS` plus the session setting an agent reads up its tree (`src/engine/agent-defaults.ts`).
- A repository names a setup for the worktrees Keel makes (`.keel/worktree.json`, `src/worktree/setup.ts`):
  commands that run once in each new worktree after git made it and `.worktreeinclude` was copied in, so agents
  do not each install. It runs commands, so it is held like a hooks file: only while the owner's pin holds the
  file and the `.keel/` scripts it runs (a new or changed one is held and said on the session; the pin holds
  nothing else: what its commands read from the rest of the tree, `package.json`, `scripts/`, install scripts,
  is not held, and a link of `.keel/` or the file out of the repository is refused). The head of a pull request
  from a fork runs no setup until the owner trusts the head (`create` takes `setup: false`, the route calls
  `settleSetup` after the head's trust is decided; `headHeld` and `setupHook.headTrusted` are what the head-trust
  code fills). Each step runs in a job scope of its own (`sessionScope`, a `keel-setup-` unit; else a process
  group), stopped at the step's end and at the time limit, so a process that started a session of its own goes too. It
  runs under the session's own sandbox and network rules (nothing when its sandbox is read-only), its output is a
  file, a failure is a failure of the session and shows on its worktree chip and its agent's card. The NAME=value
  lines it writes to `$KEEL_ENV_FILE` are read once when it ends and are the environment of the session's own
  commands only (`StartOpts.vars`, the code tool: never `toolEnv`, which the daemon's own unconfined spawns read),
  and only the names the owner allows: a list of refused names cannot be complete, so a name is taken when a
  pattern of the setting `worktree_setup.env` matches it (empty by default: nothing is taken; Settings > Safety),
  and never a name on the floor (`refusedName`: `KEEL_*`, `PATH`, `LD_*`, `BASH_ENV`...) even when allowed. The
  note names what was left out, never a value. Its folder goes with the worktree.
- An instruction file the landing queue itself landed is trusted on sight (`src/safety/landed-trust.ts`): right
  after the queue fast-forwards a checkout that has the base out, the pin of each instruction file the batch
  changed moves with it, said once in the timeline of the session that queued it and shown in the Trust panel
  with the landing. Only when the pin was at the content the base held before, the file on disk is the landed
  commit's text, nobody's verdict refuses the tip that was built, and every entry that changed the file is
  vouched for at that tip: the owner queued it with their own hand at the head their page showed (`owner_tip`:
  the Branches panel, the work board, the tree review and a card send the head), or a top-level session queued
  it and its own agent, started as the branch's reviewer at that tip (its spawn's `reviews`), recorded LAND yes
  on that commit with `keel__verdict`. An agent picks no voucher: not an agent's landing, not a reviewer below
  or beside the tree, not the holder's own, not a commit the reviewer added. The queue asks for no review to
  land, so a session's unreviewed landing still asks; so does every other change (a commit made outside the
  queue, a pull, a checkout, an edit), since only the queue's own pass moves a pin. Skills, command files, the
  hooks file, the worktree setup and the MCP file are never moved this way: they run commands or grant tools.
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
  scale (`ui/src/lib/rail.ts`). A Settings section is made of the Settings kit
  (`ui/src/components/settings/kit.tsx`: Page, Group, SettingRow, List and
  Item, Status, Empty, Notice, Table): no box, status tag or capitals of its
  own, and it does not scroll sideways at 1366 or on a phone
  (`src/ui-conventions.test.ts` holds it; the sections not moved yet are named
  there and the list only shrinks).
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
| `src/board/` | the work board: each agent's branch, checks, review, landed and live, from facts; and the tree review: its agents' branches as one diff by area, landed, sent back or dropped per area (`tree.ts`, `tree-review.ts`) |
| `src/landing/` | the landing queue: branches built on the base and the entries ahead, checked on that tree, landed by fast-forward; and live branches checked together (`together.ts`, the pair choice in `pairs.ts`) |
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
                               # Its last line, a refusal's too, is "remote-verify: Summary: <outcome> (exit N)":
                               # a wait on its output matches that line.
                               # At most two runs on a host at once, none when its load is over 20; --only unit,cli
                               # runs some stages. The host needs git, Bun and ssh, nothing else of this machine.
bun scripts/build.ts            # dist/keel, one binary (and dist/keel-ui.tar.gz, its page as a bundle)
bun scripts/release.ts && scripts/release-check.sh   # a release packaged in dist/release (revision, target, checksums),
                               # then verified outside the source tree with no Bun on PATH; nothing is published
bun scripts/build.ts --ui dist/keel-ui.tar.gz && keel ui install dist/keel-ui.tar.gz --url URL
                               # a UI-only change on a running daemon: no restart, turns go on, pages reload;
                               # refused when a file the binary is compiled from differs from the daemon's build
                               # (its import graph: tests, docs and page-only modules do not count; that needs a restart)
bun scripts/icons.ts             # the icon files from the one mark (the page's icon, the installed page's PNGs, the desktop
                               # app's two icons), after a change of the mark or of the inks it reads from ui/src/styles.css
desktop/build.sh                # desktop/dist/keel-desktop, the desktop app (install: for this account; deb: a package);
                               # and dist/keel-desktop-qt, its Qt WebEngine engine, where Qt's development files are installed
desktop/qt/check.sh             # the Qt engine built in a container (no Qt needed here) and its --self-test run offscreen;
                               # remote-verify runs it as its qt stage when desktop/qt or the shared Rust files changed
desktop/test/e2e.sh             # its e2e, in a hidden desktop with a scratch daemon (never the owner's screen);
                               # KEEL_DESKTOP_ENGINE=qt|webkit runs it with one engine
```
