# HTTP API: the stable routes

<!-- Generated from src/server/stable-api.ts by `bun scripts/api-docs.ts`. Do not edit by hand. -->

Stable API version: 1.

These are the routes `keel run` calls to hold a session open, and the ones a script may call
the same way. A stable route keeps its method, its path and the fields listed here until the
version goes up. New fields and new routes do not change the version, so ignore fields you do
not know. Every other route under `/api` belongs to the workbench and can change in any build.
`GET /api/routes` lists what a running daemon serves and marks the stable methods.

## Calling

- The address is the daemon's bind (`keel serve --bind`, default `127.0.0.1:47960`). The daemon
  writes it to `daemon.lock` in its state folder.
- A call on loopback from the daemon's own user needs no credential. Any other call sends
  `Authorization: Bearer TOKEN`, with the token from `api-token` in the state folder.
- Bodies and answers are JSON. A refusal is a 4xx with `{ error }`; a failure is a 500 with
  `{ error, error_id }`. A daemon that is stopping answers 503 with `{ draining: true }`.
- A browser page on another origin is refused. Send no `Origin` header.

## Routes

### GET /api/health

Whether a daemon answers at this address.

- Response: `{ ok: true, pid }`

### GET /api/routes

The routes this daemon serves, each with the methods that are stable.

- Response: `{ api_version, routes: [{ path, methods, stable }], missing }`. `missing` lists stable routes this daemon does not serve; it is empty on a sound build.

### POST /api/run

One prompt to a new session or an existing one. Settings are applied first; a refused request changes nothing.

- Request: `{ text, images?, session_id? | continue?, cwd?, model?, provider?, permission_mode?, effort?, worktree?, peer?, mode?, idempotency_key? }`. `mode` is `send`, `steer` or `queue` for a session that is busy. `images` holds `{ type: "image", media_type, data }` blocks (base64); with one, `text` may be empty. With `idempotency_key`, a retry gets the first answer back and stores nothing.
- Response: `201 { session_id, replayed, after_seq, event_id, queue_id?, queued? }`. `after_seq` is the last event before the prompt: read events after it. `event_id` is the prompt's event, or null when it was queued (`queue_id`).

### GET /api/cli/state/:id

What a caller that waits needs on every tick, without the transcript.

- Response: `{ session, state, last_seq, running, queue, held, status, approvals, questions, plans, secrets, background: { agents, waits, jobs } }`. `state.watch` is the session's one state: `need`, `work`, `wait`, `fail`, `declined`, `resume` (a turn a restart cut is about to continue), `stop`, `done` or `idle`, with `why` and `text`. The four lists are what waits on an answer in the session and its agents: `approvals` (`id`, `session_id`, `call_id`, `tool`, `input`, `summary`, `risk`, `cut`, `why`), `questions` (`session_id`, `call_id`, and the call that asks: `tool`, `input`), `plans` (`id`, `session_id`, `plan`, `title`) and `secrets` (`id`, `session_id`, `name`, `purpose`). While a daemon drains for a restart the last three are empty; the same ids are open again after it.

### GET /api/cli/resolve

A session from any unique prefix of its id (`?id=PREFIX`).

- Response: `{ session }`

### GET /api/sessions/:id/events

The session's stored events after a seq (`?after=SEQ`), in order. Each has `id`, `session_id`, `seq`, `ts`, `kind` and `data`.

- Response: `{ events }`. Kinds a script reads: `user`, `assistant` (`data.blocks`: text, thinking, tool_use), `tool_result` (`data.results`), `turn_start`, `turn_end` (`data.reason`, `data.usage`), `error` (`data.message`).

### POST /api/sessions/:id/interrupt

Stops the turn that runs and answers when it has ended. A session with no turn is left as it is.

- Response: `{ ok: true }`

### GET /api/sessions/:id/permissions

The session's permission mode.

- Response: `{ perm: { mode, ... }, scope, rev }`

### GET /api/sessions/:id/approvals/:aid

One permission request as every client is given it: all there is to judge, and why it is read before it is allowed.

- Response: `{ approval, card }`. `card` has `text` (the command, the paths and what an edit writes, or the tool's input: all of it up to 20,000 characters), `cut` and `total` when that is only the start (`kept` when the rest was not kept anywhere), `lines`, `chars`, `risk`, `marks` (`hidden`: characters that do not show as written, `rtl`: letters written right to left, `alike`: characters that can pass for plain ASCII letters), `machine` (`name`, `far` when the call runs on another machine, `cwd`: the folder a command starts in when that is not the session's own, `away` when it is not under the session's folder either, `shell` when it is not the default one), `reason`, `choices`, `grants` (the rules a standing answer would store), `hold`: why an allow needs `seen` (`long`, `cut`, `marked`, `risk`, `where`; empty when one line shows all of it), and `line` with `glance`: what a notification says of it, and whether a collapsed one shows all of that. `404`: no such request.

### POST /api/sessions/:id/approvals/:aid

Answers one open permission request.

- Request: `{ choice, reason?, seen?, via? }`. `choice` is `once` or `deny` (`session` and `always` store a standing grant: from a remote device they need the owner's passkey). `reason` reaches the model with a refusal. `seen: "whole"` is the caller's word that it showed the whole text of the request before the answer (`GET` on the same path gives it as `card.text`): an allow of a request that one line of 160 printable ASCII characters does not show whole, that is cut, that holds marked characters, that is high risk or that runs somewhere a line does not say (another machine, a folder that is not the session's, another shell) is taken only with it. `via` says what answers (`cli`, `script`, `acp`, `page`) and is kept with the answer. A standing answer settles, of the requests that wait beside it, only the ones no `hold` covers.
- Response: `{ ok: true }`. `404` or `409` with `error`: the request is not open any more. `409` with `hold`: the request is still open, and the allow needs `seen` (the `error` is the sentence to show: open the request to read it first). `503`: the daemon is restarting, answer again. `428`: the answer needs the owner's passkey.

### POST /api/sessions/:id/questions/:call

Answers a question the model asked (`:call` is the tool call's id).

- Request: `{ answers }`: per question id (or its index), `{ picked: [labels], other? }`. `{}` leaves the question without an answer.
- Response: `{ ok: true }`, or `404` when no question waits for that call.

### POST /api/sessions/:id/plan/:pid

Answers a plan put up for approval (`:pid` is its id).

- Request: `{ approve: false, feedback? }` declines it. `{ approve: true, mode, plan?, note? }` approves it and puts the session in `mode`; from a remote device that needs the owner's passkey.
- Response: `{ ok: true }`, or `404` when no plan waits with that id.

### POST /api/sessions/:id/secrets/:rid

Answers a secret the model asked for (`:rid` is the request's id).

- Request: `{ value }` gives it, `{ deny: true, reason? }` declines. The value is kept in the daemon's memory and never stored in the session.
- Response: `{ ok: true }`, or `404` when no request is open with that id.

### PATCH /api/sessions/:id

Changes a session's fields. Stable for archiving only.

- Request: `{ archived: true }`
- Response: The session.

## Live frames: /ws

A WebSocket at `/ws` carries a session's events as they are stored and the reply as it streams.
Reading events by seq (`GET /api/sessions/:id/events`) gives the same events without it.

- Send `{ "op": "resume", "cursors": { "SESSION_ID": SEQ } }` after the socket opens. The daemon
  sends the events after that seq, then each new one.
- `{ "t": "event", "event" }`: a stored event, as the events route returns it.
- `{ "t": "delta", "session_id", "index", "kind", "text" }`: text of the reply that streams.
  `kind` is `text`, `thinking` or `tool_input`.
- Other frames are the workbench's. Ignore a frame whose `t` you do not know.

## A session held open over HTTP

1. `POST /api/run` with the first prompt. Keep `session_id` and `after_seq`.
2. Read `GET /api/sessions/:id/events?after=SEQ` until a `turn_end` (or an `error` with no
   `turn_start` before it). Read `GET /api/cli/state/:id` between reads: an entry in `approvals`
   or `questions` waits for an answer.
   A failed turn stores its `turn_end` (reason `error`) first and its `error` event after it: read
   until `running` is false to have both. A `turn_end` with reason `restart` is a turn a daemon
   restart cut: while `state.watch` is `resume` the daemon continues it.
3. Answer with the approvals or questions route, or stop the turn with the interrupt route.
4. `POST /api/run` with `session_id` for the next prompt.

`keel run --input-format stream-json` does exactly this. See [headless.md](headless.md).
