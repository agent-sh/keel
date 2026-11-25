// The part of the HTTP API a script may rely on: what `keel run` itself calls
// to hold a session open (docs/headless.md). Everything else under /api is
// the workbench's and changes with it. docs/http-api.md is generated from
// this table (bun scripts/api-docs.ts), a unit test fails when the file and
// the table differ, and the command line e2e fails when a route named here is
// not in the daemon's route table or the command calls one that is not here.
//
// A stable route keeps its method, its path and the fields listed here until
// STABLE_API goes up. New fields and new routes do not move it.
export const STABLE_API = 1;

export type StableRoute = { method: string; path: string; what: string; request?: string; response: string };

export const STABLE: StableRoute[] = [
  { method: "GET", path: "/api/health", what: "Whether a daemon answers at this address.", response: "`{ ok: true, pid }`" },
  { method: "GET", path: "/api/routes", what: "The routes this daemon serves, each with the methods that are stable.", response: "`{ api_version, routes: [{ path, methods, stable }], missing }`. `missing` lists stable routes this daemon does not serve; it is empty on a sound build." },
  {
    method: "POST", path: "/api/run", what: "One prompt to a new session or an existing one. Settings are applied first; a refused request changes nothing.",
    request: "`{ text, images?, session_id? | continue?, cwd?, model?, provider?, permission_mode?, effort?, worktree?, peer?, mode?, idempotency_key? }`. `mode` is `send`, `steer` or `queue` for a session that is busy. `images` holds `{ type: \"image\", media_type, data }` blocks (base64); with one, `text` may be empty. With `idempotency_key`, a retry gets the first answer back and stores nothing.",
    response: "`201 { session_id, replayed, after_seq, event_id, queue_id?, queued? }`. `after_seq` is the last event before the prompt: read events after it. `event_id` is the prompt's event, or null when it was queued (`queue_id`).",
  },
  {
    method: "GET", path: "/api/cli/state/:id", what: "What a caller that waits needs on every tick, without the transcript.",
    response: "`{ session, state, last_seq, running, queue, held, status, approvals, questions, plans, secrets, background: { agents, waits, jobs } }`. `state.watch` is the session's one state: `need`, `work`, `wait`, `fail`, `declined`, `resume` (a turn a restart cut is about to continue), `stop`, `done` or `idle`, with `why` and `text`. The four lists are what waits on an answer in the session and its agents: `approvals` (`id`, `session_id`, `call_id`, `tool`, `input`, `summary`, `risk`, `cut`, `why`), `questions` (`session_id`, `call_id`, and the call that asks: `tool`, `input`), `plans` (`id`, `session_id`, `plan`, `title`) and `secrets` (`id`, `session_id`, `name`, `purpose`). While a daemon drains for a restart the last three are empty; the same ids are open again after it.",
  },
  { method: "GET", path: "/api/cli/resolve", what: "A session from any unique prefix of its id (`?id=PREFIX`).", response: "`{ session }`" },
  {
    method: "GET", path: "/api/sessions/:id/events", what: "The session's stored events after a seq (`?after=SEQ`), in order. Each has `id`, `session_id`, `seq`, `ts`, `kind` and `data`.",
    response: "`{ events, seq }` (`seq`: the newest of the events answered). Kinds a script reads: `user`, `assistant` (`data.blocks`: text, thinking, tool_use), `tool_result` (`data.results`), `turn_start`, `turn_end` (`data.reason`, `data.usage`), `error` (`data.message`).",
  },
  { method: "POST", path: "/api/sessions/:id/interrupt", what: "Stops the turn that runs and answers when it has ended. A session with no turn is left as it is. Body `{ \"by\": \"owner\" }` when the owner asked for it: that is their Stop, after which the queue waits for them and a goal pauses. Without it only the turn ends.", response: "`{ ok: true }`" },
  { method: "GET", path: "/api/sessions/:id/permissions", what: "The session's permission mode.", response: "`{ perm: { mode, ... }, scope, rev }`" },
  {
    method: "GET", path: "/api/sessions/:id/approvals/:aid", what: "One permission request as every client is given it: all there is to judge, and why it is read before it is allowed.",
    response: "`{ approval, card }`. `card` has `text` (the command, the paths and what an edit writes, or the tool's input: all of it up to 20,000 characters), `cut` and `total` when that is only the start (`kept` when the rest was not kept anywhere), `lines`, `chars`, `risk`, `marks` (`hidden`: characters that do not show as written, `rtl`: letters written right to left, `alike`: characters that can pass for plain ASCII letters), `machine` (`name`, `far` when the call runs on another machine, `cwd`: the folder a command starts in when that is not the session's own, `sub`: that folder as a path under the session's, `away` when it is not under the session's folder, `shell` when it is not the default one), `reason`, `choices`, `grants` (the rules a standing answer would store), `hold`: why an allow needs `seen` (`long`, `cut`, `marked`, `risk`, `where`; empty when one line shows all of it), `rule` (the class of the policy's rule that asked, when it named one), and `line` with `glance`: what a notification says of it (the tool's name with nothing hidden, a folder under the session's, the text), and whether a collapsed one shows all of that and the policy leaves it to a notification. `404`: no such request.",
  },
  {
    method: "POST", path: "/api/sessions/:id/approvals/:aid", what: "Answers one open permission request.",
    request: "`{ choice, reason?, seen?, via? }`. `choice` is `once` or `deny` (`session` and `always` store a standing grant: from a remote device they need the owner's passkey). `reason` reaches the model with a refusal. `seen: \"whole\"` is the caller's word that it showed the whole text of the request before the answer (`GET` on the same path gives it as `card.text`): an allow of a request that one line of 160 printable ASCII characters does not show whole, that is cut, that holds marked characters, that is high risk or that runs somewhere a line does not say (another machine, a folder that is not the session's, another shell) is taken only with it. `via` says what answers (`cli`, `script`, `acp`, `page`) and is kept with the answer. A standing answer settles, of the requests that wait beside it, only the ones no `hold` covers.",
    response: "`{ ok: true }`. `404` or `409` with `error`: the request is not open any more (the `error` says how it ended, who answered and how long ago). `409` with `hold`: the request is still open, and the allow needs `seen` (the `error` is the sentence to show: open the request to read it first). `503`: the daemon is restarting, answer again. `428`: the answer needs the owner's passkey.",
  },
  {
    method: "POST", path: "/api/sessions/:id/questions/:call", what: "Answers a question the model asked (`:call` is the tool call's id).",
    request: "`{ answers }`: per question id (or its index), `{ picked: [labels], other? }`. `{}` leaves the question without an answer.",
    response: "`{ ok: true }`, or `404` when no question waits for that call.",
  },
  {
    method: "POST", path: "/api/sessions/:id/plan/:pid", what: "Answers a plan put up for approval (`:pid` is its id).",
    request: "`{ approve: false, feedback? }` declines it. `{ approve: true, mode, plan?, note? }` approves it and puts the session in `mode`; from a remote device that needs the owner's passkey.",
    response: "`{ ok: true }`, or `404` when no plan waits with that id.",
  },
  {
    method: "POST", path: "/api/sessions/:id/secrets/:rid", what: "Answers a secret the model asked for (`:rid` is the request's id).",
    request: "`{ value }` gives it, `{ deny: true, reason? }` declines. The value is kept in the daemon's memory and never stored in the session.",
    response: "`{ ok: true }`, or `404` when no request is open with that id.",
  },
  { method: "PATCH", path: "/api/sessions/:id", what: "Changes a session's fields. Stable for archiving only.", request: "`{ archived: true }`", response: "The session." },
];

export type RouteRow = { path: string; methods: string[]; stable: string[] };

// The daemon's route table as a list, each path with its methods and the ones
// that are stable; and the stable routes it lacks.
export function routeTable(routes: Record<string, unknown>): { api_version: number; routes: RouteRow[]; missing: string[] } {
  const rows: RouteRow[] = Object.entries(routes).filter(([p]) => p.startsWith("/api/")).map(([path, h]) => {
    const methods = typeof h === "function" ? ["ALL"] : Object.keys(h as object).sort();
    const stable = STABLE.filter((s) => s.path === path && (methods.includes(s.method) || methods.includes("ALL"))).map((s) => s.method);
    return { path, methods, stable };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const missing = STABLE.filter((s) => !rows.some((r) => r.path === s.path && r.stable.includes(s.method))).map((s) => `${s.method} ${s.path}`);
  return { api_version: STABLE_API, routes: rows, missing };
}

// Whether a call (its method and its path as sent) is to a stable route.
export function isStable(method: string, pathname: string): boolean {
  return STABLE.some((s) => s.method === method && new RegExp(`^${s.path.replace(/:[a-z_]+/g, "[^/]+")}$`).test(pathname));
}

export function renderApiDoc(): string {
  const out = [
    "# HTTP API: the stable routes",
    "",
    "<!-- Generated from src/server/stable-api.ts by `bun scripts/api-docs.ts`. Do not edit by hand. -->",
    "",
    `Stable API version: ${STABLE_API}.`,
    "",
    "These are the routes `keel run` calls to hold a session open, and the ones a script may call",
    "the same way. A stable route keeps its method, its path and the fields listed here until the",
    "version goes up. New fields and new routes do not change the version, so ignore fields you do",
    "not know. Every other route under `/api` belongs to the workbench and can change in any build.",
    "`GET /api/routes` lists what a running daemon serves and marks the stable methods.",
    "",
    "## Calling",
    "",
    "- The address is the daemon's bind (`keel serve --bind`, default `127.0.0.1:47960`). The daemon",
    "  writes it to `daemon.lock` in its state folder.",
    "- A call on loopback from the daemon's own user needs no credential. Any other call sends",
    "  `Authorization: Bearer TOKEN`, with the token from `api-token` in the state folder.",
    "- Bodies and answers are JSON. A refusal is a 4xx with `{ error }`; a failure is a 500 with",
    "  `{ error, error_id }`. A daemon that is stopping answers 503 with `{ draining: true }`.",
    "- A browser page on another origin is refused. Send no `Origin` header.",
    "",
    "## Routes",
    "",
    ...STABLE.flatMap((s) => [
      `### ${s.method} ${s.path}`,
      "",
      s.what,
      "",
      ...(s.request ? [`- Request: ${s.request}`] : []),
      `- Response: ${s.response}`,
      "",
    ]),
    "## Live frames: /ws",
    "",
    "A WebSocket at `/ws` carries a session's events as they are stored and the reply as it streams.",
    "Reading events by seq (`GET /api/sessions/:id/events`) gives the same events without it.",
    "",
    "- Send `{ \"op\": \"resume\", \"cursors\": { \"SESSION_ID\": SEQ } }` after the socket opens. The daemon",
    "  sends the events after that seq, then each new one. With `\"only\": true` in the resume the",
    "  socket carries the events and the reply of the sessions it names and of no other; without",
    "  it, of every session.",
    "- `{ \"t\": \"event\", \"event\" }`: a stored event, as the events route returns it.",
    "- `{ \"t\": \"delta\", \"session_id\", \"index\", \"kind\", \"text\" }`: text of the reply that streams.",
    "  `kind` is `text`, `thinking` or `tool_input`.",
    "- Other frames are the workbench's. Ignore a frame whose `t` you do not know.",
    "",
    "## A session held open over HTTP",
    "",
    "1. `POST /api/run` with the first prompt. Keep `session_id` and `after_seq`.",
    "2. Read `GET /api/sessions/:id/events?after=SEQ` until a `turn_end` (or an `error` with no",
    "   `turn_start` before it). Read `GET /api/cli/state/:id` between reads: an entry in `approvals`",
    "   or `questions` waits for an answer.",
    "   A failed turn stores its `turn_end` (reason `error`) first and its `error` event after it: read",
    "   until `running` is false to have both. A `turn_end` with reason `restart` is a turn a daemon",
    "   restart cut: while `state.watch` is `resume` the daemon continues it.",
    "3. Answer with the approvals or questions route, or stop the turn with the interrupt route.",
    "4. `POST /api/run` with `session_id` for the next prompt.",
    "",
    "`keel run --input-format stream-json` does exactly this. See [headless.md](headless.md).",
    "",
  ];
  return out.join("\n");
}
