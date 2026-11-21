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

## Auto and Full auto

**Auto** lets safe reads, in-scope edits, confined commands and standing grants
through. The configured judge reviews other ordinary calls and flagged
high-risk calls. A refusal or unavailable judge does not open an approval
card. Actions requiring explicit owner consent still ask. **Full auto** runs
ordinary work without review and retains its extra high-risk checks.
**Auto edits** still asks about ordinary work outside its safe defaults.

[Claude Code](https://code.claude.com/docs/en/permission-modes) separates
classifier-backed `auto` from `acceptEdits` and `bypassPermissions`. Keel
imports those as Auto, Auto edits and Full auto, respectively.
[Codex](https://developers.openai.com/codex/agent-approvals-security) treats
sandboxing separately from approvals and can review eligible approvals
automatically. [OpenCode](https://opencode.ai/docs/permissions/) uses
`allow`, `ask` and `deny` rules scoped by action and resource.

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
