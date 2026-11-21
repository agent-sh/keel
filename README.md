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
reports. An agent that failed and wrote something of its own still reports
normally.

- An agent's failure that stands in for its report starts a turn, as the
  report would have. Everything else goes with the session's next input and
  never starts a turn: a tool failure an agent repeated three times or more,
  and a turn of the session itself that ended on an error.
- A cause appears once per notice. If it happens again later, the next notice
  says how many more and the total.
- What is owed is in the table, so a notice owed when the daemon stops is sent
  once after it starts.
- Text is redacted like everything stored, an entry holds at most three lines
  and twenty ids, and a notice at most eight causes.
- A session's own tool failures are counted but not sent back: it has their
  results. Failed model requests (retried ones too) and timed out waits are
  counted too.

The same rows are read at `GET /api/errors?session=<id>` (`failures`), with the
Errors rows that last happened in that session or its agents. For an agent's
session it returns the rows of its parent that name it.

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
Transcript metrics count reused versions, rebuilds, failures, elapsed
milliseconds, and bytes written by successful rebuilds. Reuse writes no bytes.
The endpoint includes no prompts, transcripts, facts, or session identifiers.
Poll it and compare counter deltas to track changes over time.

## License

MIT
