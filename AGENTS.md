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
  (`src/engine/reader.ts`, `src/engine/readers.ts`), idle compaction before a long context's cache
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
  private repository is not read. Private is learned: sentences the owner typed in the session, the fleet's machines,
  ssh aliases, folders his sessions work in (live ones whose repository is not public, never the repository the text
  goes to), his home path, vault values and token shapes, and the `private.terms` setting; his login, his accounts'
  owners and a URL's owner place are never private, and a short or common word is not found inside a longer name written
  with `-`, `_` or `.`. What could not be read (a failed or cut log, a missing body file, a text past the limit) holds
  the call too, with what was not read. The text is scanned in slices with the loop free between. A hit holds the call
  in every mode, full auto included (as the provenance rule does): the owner's card quotes it and allows once, an agent
  is refused with the same words.
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
  wget or gh, a channel event, an imported transcript, and an agent's report when that agent read any of these;
  a search result lists an address (a page fetch of that address, or of a page above it with no query, goes on;
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
                               # refused when src/ differs from the daemon's build (that needs a restart)
desktop/build.sh                # desktop/dist/keel-desktop, the desktop app (install: for this account; deb: a package);
                               # and dist/keel-desktop-qt, its Qt WebEngine engine, where Qt's development files are installed
desktop/test/e2e.sh             # its e2e, in a hidden desktop with a scratch daemon (never the owner's screen);
                               # KEEL_DESKTOP_ENGINE=qt|webkit runs it with one engine
```
