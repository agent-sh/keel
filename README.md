# Keel

A coding agent harness in one binary: its own agent loop and tools, every model
your providers list, and a web UI.

```bash
bun install
bun scripts/build.ts
./dist/keel serve --bind 127.0.0.1:47960 --workspace .
```

Open http://127.0.0.1:47960.

Providers are found from the environment: `ANTHROPIC_API_KEY` for the Anthropic
API; `AWS_BEARER_TOKEN_BEDROCK`, AWS keys or `ANTHROPIC_BEDROCK_BASE_URL` for
Amazon Bedrock. Models come from each provider's own listing.

## Turn receipts

`GET /api/debug/turns/<turn_start event id>/receipt` joins the turn's input and
queue IDs, model request spans, tool spans and result events, and the terminal
event and reason. Each request has a `purpose`: `turn` for the turn's own
attempts, `summary` or `reader` for those sent while it ran, else `other`.
The Traces API lists the turn ID as `attrs.turn_event`. A
receipt follows its own branch, even after the session switches branches. It
contains metadata only: no prompts, replies, tool arguments or output, error
messages, or wire data. An `end` of `null` means no terminal event was
recorded. A null span ID means the span is not available, not that the tool
was necessarily skipped.

## Session timeline

`GET /api/sessions/<id>/timeline` is a session's story from one place: its
turns (who started each: the owner, a queued prompt, a steer, the owner's
Continue, a loop run, a wait wake, an agent report, another session, a harness
note, a daemon restart; how it ended; how long it took; its steps, tool calls
and failed tool calls; tokens and cost), the agents it started and how each
ended, waits set and fired, loop runs, compactions, model switches, restored
files, approvals asked and settled, and what failed. Rows are newest first,
`limit` at a time (50 by default, at most 200); `next` is the cursor of the
following page (`before`). `only` is `failures`, `turns` or `agents`. `since`
is a span back from now (`90s`, `30m`, `1h`, `2d`), epoch milliseconds or an
ISO time: nothing older is read or returned. `as_of` is when the page was
read. `now` says what the session is doing: the running turn's step and tool,
what waits on the owner, the waits and agents still out, what is queued. What
`now` says (the running turn, a card still open) is not a row too.

What the rows mean:

- A turn is one row, at its start. Its steps are the replies the model gave.
  Its failed tools are the calls that ran and failed. A call the owner, a
  rule or the judge denied is a denied call, and a call the turn's stop or a
  restart reached is only a tool call: neither is a failure. Its tokens and
  cost are the turn's rollup over every request made while it ran (its own, a
  reader's, a summary's), else what its end summed.
- A wait that fired or an agent that reported, when that is what started the
  next turn, is told in that turn's row ("Wait wake (a timer, after 3 s)",
  "Agent report from ...") and has no row of its own.
- A turn a daemon restart cut says so in its own row, and the turn that went
  on after it starts with "Continued after a daemon restart". A prompt the
  daemon went down on before its turn began is one row that says that.
- A turn that is not on the branch the session shows is marked
  (`turn.branch: "other"`) and says "on a branch not shown".
- A failed model request is a row per cause from the session's own failure
  record, with this session's count and its agents'. A row from the errors
  table marks only where a kind of failure last happened; its count is over
  every session and says so.
- `only=failures` reads at most 500 rows for a page (`scanned`) and gives
  `next` when it stopped there, with however many rows it found. `turns` and
  `agents` read only their own source and need no bound.

Each row carries the IDs that open its detail: `turn_event` (the turn's
receipt and trace), `refs.child_session` (an agent's session), `refs.error_id`.
Like the receipt it holds metadata only: IDs, kinds, counts, classes,
durations and session titles, never a prompt, a tool's input or output, a
wait's note or an error's message. Turns, compactions and restarts come from
the session's events and are kept as long as the session; agents, waits, loops
and approvals come from the activity list, which keeps 30 days. An activity
row keeps the turn it happened in (`turn_event`); an agent's own session reads
its rows from its parent's list.

`format=text` gives the same story as plain text, a line a row, for a model:
`keel debug timeline SESSION --since 1h` prints it, and `--no-ids` (`ids=0`)
leaves the IDs off the lines. The Timeline side panel shows it live: it asks
only for what is newer than what it holds, and not at all from a hidden tab.

## Every session at once

`GET /api/overview` answers across sessions what the timeline answers for
one: what needs the owner, what failed and why, what runs and for how long,
and the turns and spend since a time (`since=1h`, a day by default, at most
seven days back). A
session's state is the word its row shows on the page. Like the timeline it
holds metadata only: titles, states, failure classes, counts, durations and
IDs.

`format=text` is the short form for a model or a terminal: twenty rows stay
under 1.5k tokens also when every row is heavy. The tokens are counted from
the text's shape, never under what a local BPE measured on these texts, and a
text over the bound is written again with less in each row, never with fewer
rows.
`keel status --sessions --since 1h` prints it (`--no-ids` leaves the IDs
off, `--max N` lists another number), and a session reads it with
`keel__sessions_list` and `report: true`, which lists the agents it started
first. A row names its session by the last twelve characters of its ID, which
the timeline route, the commands that name a session and
`keel__session_send` take. Twenty sessions are listed by default, the ones
that need the owner first; the rest are counted.

The turns counted are the sessions' own; how their agents ended is counted
beside them, and the spend is everyone's. A turn a daemon restart cut is not
a failure: it is continued, and one that was not shows in the session's
state.

"While you were away" is one digest of the same read: per session the turns
that ended, the failures by class, how its agents ended, the approvals that
wait, the agents parked on a wake of their own, and the spend.

- The owner is present while they do something in a page: each page reports
  how long ago its last key, pointer or wheel input was. A page that only has
  focus is not the owner. An absence is five minutes without input
  (`KEEL_AWAY_MS`).
- Absences are kept as a short list, across daemon restarts, until the digest
  is dismissed, and only what happened inside them is counted. A turn that
  ended while the owner was there between two absences is in neither.
- Time the daemon was not running (it was down, or the machine slept) is no
  absence. An absence in which nothing happened leaves no digest.
- The first line counts the sessions' own turns and, beside them, how their
  agents ended. The text form lists twenty sessions at most, within the
  report's bound, and counts the rest.

The Inbox shows the digest as one line above the alerts that opens into a row
a session, each opening its session. Opening it is seeing it: the daemon lets
it go, and the next absence starts a new one. `GET /api/away` gives it (`format=text`
for the text form, `since=` for a window you name, at most seven days back),
`keel status --away` prints it, and `DELETE /api/away` dismisses it.

## A model traces a failure by itself

The notice a session gets when an agent it started fails ends with one line
that names the tool and the agent: `keel__session_timeline with session: ID
tells what that agent did and where it failed.` It is part of an input in the
history, so no session's system prompt or cached prefix changes for it.

- `keel__session_timeline` takes `session`: an agent the session started, by
  its ID, a prefix of it or its session ID. `open` (`error=ID` or `turn=ID`,
  as a row ends) gives that one failure in full instead of the rows: what
  failed, its trace and the events before it. It holds only the session's own
  work or its agents': no other session's errors, no daemon log line that does
  not name the session, no path of the daemon's and no way to send a request
  again. An error ID that is not the session's, or no longer (a kind of
  failure keeps the last session it happened in), is refused with a pointer
  at the turn's ID, which does not move.
- `keel debug timeline`, `keel debug --session` and the other commands that
  name a session take a session's ID, a prefix that names one session, its
  last twelve characters (no shorter ending), or an agent's ID or a prefix of
  that. So does `GET /api/sessions/:id/timeline`. `keel debug ID` with an ID
  that names no error reads it as a session.

## Auto and Full auto

**Auto** keeps Keel's existing read permissions. In-scope edits, read-only
or confined commands, and standing grants run without review. The configured
judge reviews other ordinary calls and flagged high-risk calls.
A refusal or unavailable judge does not open an approval
card. Auto also refuses actions it cannot review in full, including
login shells and actions that require secret substitution. Explicit sandbox
escalation and other owner-only actions still ask. **Full auto** runs
ordinary work without review and retains its
nonblocking high-risk checks. Tools that explicitly require confirmation
still ask in both modes.
**Auto edits** still asks about ordinary work outside its safe defaults.

[Claude Code](https://code.claude.com/docs/en/permission-modes) separates
classifier-backed `auto` from `acceptEdits` and `bypassPermissions`. Keel
imports those as Auto, Auto edits and Full auto, respectively.
[Codex](https://developers.openai.com/codex/agent-approvals-security) treats
sandboxing separately from approvals and can review eligible approvals
automatically. [OpenCode](https://opencode.ai/docs/permissions/) uses
`allow`, `ask` and `deny` rules scoped by action and resource.

## Subagent concurrency

From the machine running the session's daemon, set a limit for that session:

```bash
curl -fsS -X PATCH http://127.0.0.1:47960/api/sessions/SESSION_ID/agents \
  -H 'Content-Type: application/json' -d '{"limit":12}'
```

`GET` on the same path shows the effective limit. Set `limit` to `null` to
return to `KEEL_MAX_SUBAGENTS` (8 when unset). The override survives a restart
and does not change other sessions. Starting, running and waiting agents
occupy slots. Lowering the limit does not stop any agents. Blocking spawns
wait for room. Background spawns and agent messages that would restart a
finished agent are refused while the session is full. A turn the owner
starts on an agent's own page is not refused. The daemon that owns
the parent counts its agents even when their tools run on another machine.

## Refresh the frontend without restarting

Build the page from the daemon's source revision, with only the UI changes
applied. Check the daemon's UI status, then install the bundle:

```bash
bun scripts/build.ts --ui dist/keel-ui.tar.gz
keel ui status --url http://127.0.0.1:47960
keel ui install dist/keel-ui.tar.gz --url http://127.0.0.1:47960
```

The daemon validates the bundle's API stamp. If the server sources differ,
rebuild against the running revision or update the binary in a planned restart.
Keel never restarts the daemon for a UI install. Idle pages reload, and a page
with a draft offers a reload and keeps the draft. `keel ui rollback` switches
back to the previous bundle, or to the embedded page.

## Automatic diagnostic notices

Off by default. To opt in, open a dedicated coordinator session, copy its ID
from its session URL, and set `KEEL_DIAGNOSTIC_SESSION=<session-id>` in the
`keel serve` process environment on its next launch. Unset it to stop sending
new notices. No additional model is configured: a notice starts a normal turn
on the destination's selected model, at its usual cost.

Keel groups new captured daemon, tool and provider failures by their
Errors ID. Each notice lists at most eight groups, with occurrence counts and
an overflow count. Keel waits at least ten seconds to batch a notice and sends
at most one per minute. It remembers up to 512 reported IDs in memory, so a
repeating error does not start another turn. Marking the error resolved lets
a later occurrence start a new incident. Browser reports stay in Errors and
never start a turn. Provider attempts with an automatic retry or known
in-place recovery also stay in Errors; a captured failure after retries are
exhausted can trigger a notice. This covers captured errors, not every tool
refusal or unsuccessful turn outcome.

Only fixed category labels, counts and opaque Errors IDs are sent. No error
message, stack, request, session title, source session ID or transcript is copied.
Errors attributed to the coordinator or its subagents are not fed back to it.
Notices wait until the destination is idle, its queue is empty and not held,
and any parked turn has had its chance to recover.
The destination must be a local, unarchived top-level session with a workspace
and incoming messages enabled. There is no fallback destination.

Delivery is best effort. Undelivered batches and the remembered IDs are
discarded on shutdown or reload. Old errors are not replayed, but new captures
can notify again; the Errors panel remains the record. A notice already written
to the coordinator's transcript is part of its normal session history and that
turn follows the usual restart behavior.

## Failures in a session's own work

A session is told what went wrong in its own scope without asking: its agents,
their tools and its own turns. Keel keeps one row per cause (the kind of
failure, its class and its first lines, with numbers, ids and paths folded) and
sends what the session has not seen yet as one harness input, built from the
table with no model call. Ten agents that failed on the same provider error
arrive as one entry with the error once and each agent's id, not as ten
reports. Folding can merge failures that differ only in a number or a path, so
an entry shows the first one.

- An agent that failed and wrote nothing of its own is told in the notice
  instead of in a report. That starts a turn, as the report would have. An
  agent that wrote something, left work in its worktree, or failed after its
  cause already named twenty agents still waiting to be told, reports normally.
- Everything else never starts a turn. It goes with the next input the harness
  delivers to the session (a report, a wake, a loop run), never with a message
  the owner types: a tool failure that one agent repeated three times or more
  since it was last told, and a turn of the session itself that ended on an
  error (dropped once a later turn gets through).
- A cause appears once per notice. If it happens again later, the next notice
  says how many more and the total.
- A session whose queue is held after the owner's Stop is not started by a
  notice. The notice goes after the owner's next turn.
- What is owed is in the table, so a notice owed when the daemon stops is sent
  once after it starts.
- Text is redacted like everything stored, an entry holds at most three lines
  and twenty ids, and a notice at most eight causes; more causes go with the
  next notice.
- A tool failure gets no line when the agent's own report is in the same
  input, and an input says once how many agents still run.
- A wait that returned an agent's report clears the failure that stood in for
  that report only. An earlier task's failure of the same agent is still told.
- Counted but never sent: the session's own tool failures (it has their
  results), the failures of a reviewer or verifier agent (their results never
  enter the conversation), failed model requests (retried ones too), timed out
  waits and a loop's failed run (the turn's own failure is what is told).

The same rows are read at `GET /api/errors?session=<id>` (`failures`, the
newest 200 causes), with the Errors rows that last happened in that session or
its agents. For an agent's session it returns the rows of its parent that name
it.

## Backups

`keel backup` writes a checked copy under `<state>/backups`: the database, the
settings files, the uploaded files, and the files of the config folder (MCP
servers, hooks, skills, plugins, agents, instructions). The daemon makes one
before a restart. `keel backups` lists them.

Config files are copied at their own mode into folders only the owner can
open. A file that did not change since the last backup is shared with that
backup, not copied again. Left out: links, `.prev` and temp files, folders
whose name starts with a dot, `node_modules`, and the sign-in file. A file
that cannot be read is skipped and named in the backup's `manifest.json`. It
never fails the backup.

`keel restore BACKUP` puts the state back. The daemon must be stopped. The
files it replaced stay beside the state. The config folder is left alone
unless asked for, because the state folder does not say which config folder
goes with it:

- `--config` puts the backup's config files into this shell's config folder,
  when that is the folder the backup was made from.
- `--config=DIR` puts them into `DIR`.

Each file put back keeps what it held as `<name>.prev`, and keeps its mode. A
file the backup does not hold stays as it is. A keel from before backups
carried config refuses such a backup and says why. The state is untouched.

## Phone

`android/` holds Keel for Android: sessions, approvals, questions and push on
the phone, paired with a one-time `keel://pair` code from Settings, then Phone.
See `android/README.md`.

## Memory observability

`GET /api/integrations/tacit/stats` reports in-memory totals since `since_ms`
(reset on restart or reload). Each hook records completed outcomes and total
and maximum elapsed milliseconds, separate from transcript rebuild time.
`hit` means the hook supplied context, not that it was relevant. `empty` means
it succeeded without context, and `ok` means pre-compaction succeeded without
requesting context. `timeout` and `failure` are counted separately.

Context bytes count UTF-8 text after Keel's cap, before its memory wrapper.
Transcript metrics count reused versions, appends (a branch that only grew
gets its new events appended), rebuilds, failures, files removed with their
session, elapsed milliseconds, and bytes written. Reuse writes no bytes.
Each hook also counts `late`: calls that did not answer within the hook's
wait. `tools` counts tool calls the store was not asked about
(`never_answered`: a call it answers with nothing whatever it holds;
`known_nothing`: a read it had nothing for in the same session within the
last 5 s), `not_held`: results of reads not held for an answer that had not
come, and `request_waits` with `request_wait_ms`: requests that waited for
such an answer, and how long in all. `degraded` says which kinds of call
had a quarter of their last 20 answers late.
`processes` counts hook processes: the most alive at once and their limit,
calls not made because one of the same session and hook was still out
unanswered, and probes. `owed_dropped` counts lines dropped because more was
waiting for a session than may wait. `out` names the kinds of call (asking,
tool) the store is not answering in time right now.
The endpoint includes no prompts, transcripts, facts, or session identifiers.
Poll it and compare counter deltas to track changes over time.

What to look at on the first day with a real store: `hooks["session-start"]`
in that report. A session's start call makes the store sync its clone, and
the first request of every new session waits for it up to 6 s.
`duration_ms.max` says how long the slowest start took (over 6,000 means a
first request went without the start block, which then followed late).
`outcomes.timeout` counts starts that ran into the store's own 15 s hook
timeout and were ended there. `context_bytes.max` is the largest start block
a session was given.

The store gives a session each fact once, so a fact it printed always reaches
the model: a block holds at most one hook's cap in whole lines (a longer line
goes in parts), and the lines it had no room for are kept in the state and
follow with the turn's next request or the next prompt. What may wait for a
session is ten blocks' worth; past it a line says how many were dropped.
A turn waits for a call only so long (6 s for a start block, 2.2 s for a
prompt, 0.9 s for a tool call), and no store process is ended before the
store's own 15 s hook timeout: what it answers after the turn went on follows
like a line that did not fit. One call a turn stopped waiting for is a late
call, counted and no more (a loaded machine makes one slow). Two of a kind in
a row are an outage of that kind: an error is recorded, the session is told
once, later calls of that kind are made but not waited for, and a probe that
asks the store nothing ends the outage when it answers within the wait again.
The probe is asked only while calls of that kind are being made. After a
summary or a clear the store is told, so what it gave before can come again;
what was owed from before a clear is not carried into the fresh context.

Before a tool the store is asked unless its answer is known to be nothing,
and a rule it gives is in the request the model answers by acting. An edit
of a file in no checkout (by the file's real path) and an empty command are
never asked about: the store answers them with nothing whatever it holds. A
call that changes something (an edit, a write, a shell command that is not a
read or has an output redirect, an MCP tool its server does not call
read-only) is always asked, and its result is held for the answer, so the
rule is in that result. A read is asked too, without holding its result: the
session's next request waits for the answer (what is left of the hook's
wait), so a rule that came with a read is there before the model acts on
what it read. A read's empty answer is remembered per session for 5 s (the
store's follower merges a change within 1 to 5 s) and only when it took as
long as the store's searches do; a summary, a clear or a new start forgets
it. Calls the store records as steps in themselves (its own tools, its
command line in a shell) are always passed to it. A store that is late now
and then without ever missing twice in a row is said once per session
("Memory is answering slowly") while a quarter of its last 20 answers of a
kind were late.

`GET /api/telemetry/memory?since_ms=&until_ms=&session_id=` reports what memory
cost the turns and whether they used it, kept across restarts for 90 days: per
recall path (the memory store's blocks at a session's start, with a prompt,
with a tool call and carried to a later step; the helper's records) how often
it was asked and how that ended, the facts and tokens it added, the facts the
turn's reply or tool calls named (an estimate that reads low: a fact can shape
a reply without being named), the lines not added again because the context
held them, the lines carried to a later step, and the time turns waited;
and under `store`, the kinds of call the store is not answering in time or
answers slowly right now. Counts, tokens and times only. Settings, then Usage, shows it as the Memory
panel.

`bun scripts/bench/memory.ts` measures the same on generated data, with a
stand-in store and a scripted model: tokens added per turn, facts used,
repeats, facts the store gave that never reached a request (this must be 0),
the cache prefix, time before the first request, a store that is slow or
failing, and whether the helper recalls the record a prompt is about.

## License

MIT
