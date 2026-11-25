// keel messages | changes | cost: what one session's panels show, from a
// terminal, through the routes the page reads and in the page's words: its
// messages between sessions with each one's state, what each turn changed in
// the working tree, and what it cost. (Failures per tool, by session, are
// `keel usage --tools`, src/cli/admin.ts.)
import { requestsWords, type LedgerCounts, type TurnPick } from "../admin/turn-compare.ts";
import { zoned } from "../core/clock.ts";
import { KIND_LABEL, KINDS, tokensOf } from "../../ui/src/lib/spend.ts";
import { authHeaders, clean, command, EXIT, printJson, usageError } from "./client.ts";

const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const one = (t: string, n = 80) => { const s = clean(String(t ?? "")).replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// The page's figures: the session's own cost to four places under a dollar, a part of it as the panel rounds it.
const exact = (c?: number) => (c === undefined ? "not priced" : `$${c.toFixed(c < 1 ? 4 : 2)}`);
const money = (c?: number) => (c === undefined ? "not priced" : c < 0.0001 ? (c ? "<$0.0001" : "$0") : c < 0.01 ? `$${c.toFixed(4)}` : c < 10 ? `$${c.toFixed(2)}` : `$${c.toFixed(0)}`);

// ---- keel messages

const MESSAGES_USAGE = `keel messages SESSION [--limit N] [--json]
  The messages a session sent to other sessions and received from them, newest first, each
  with its state as the session's timeline shows it (queued, delivered, handled, dropped,
  held for the owner, waiting for its daemon), when it reached it and why.
  SESSION is an id, a prefix of it or an agent's id.`;
const messages = command("messages", MESSAGES_USAGE, { limit: { type: "string", short: "n" } }, async (v, pos, c) => {
  if (!pos[0]) return usageError("messages", "name the session", MESSAGES_USAGE);
  const limit = v.limit === undefined ? 50 : Number(v.limit);
  if (!(Number.isInteger(limit) && limit > 0)) return usageError("messages", "--limit is a whole number above 0", MESSAGES_USAGE);
  const s = await c.resolve(pos[0]);
  if (v.json) return (printJson(await c.get(`/api/sessions/${s.id}/peer-messages?limit=${limit}`)), EXIT.ok);
  const r = await fetch(`${c.base}/api/sessions/${s.id}/peer-messages?limit=${limit}&format=text`, { headers: authHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  process.stdout.write(`Session "${one(s.title || "(untitled)", 60)}" (${s.id}). ${clean(text)}`);
  return EXIT.ok;
});

// ---- keel changes

type FileChange = { path: string; status: string; added: number; removed: number; outside?: boolean };
type CheckTurn = { turn: number; n?: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; incomplete?: boolean; elsewhere?: string; unavailable?: string };
const STATUS: Record<string, string> = { A: "added", D: "deleted", M: "modified" };
const CHANGES_USAGE = `keel changes SESSION [TURN] [--diff] [--json]
  What a session changed in its working tree, by turn, as its Changes panel shows it: each
  turn that changed files, with how many and the lines added and removed. With TURN (the
  number this list gives, the one keel cost gives it too), that turn's files; --diff prints its patch.`;
const changes = command("changes", CHANGES_USAGE, { diff: { type: "boolean" } }, async (v, pos, c) => {
  if (!pos[0]) return usageError("changes", "name the session", CHANGES_USAGE);
  const s = await c.resolve(pos[0]);
  const r = await c.get<{ turns: CheckTurn[]; expired: number; scope: string; reason: string | null }>(`/api/sessions/${s.id}/checkpoints`);
  const z = zoned();
  const head = `Changes of session "${one(s.title || "(untitled)", 60)}" (${s.id}). ${z.note}.${r.scope === "written" ? ` Only files the tools wrote are tracked: ${r.reason}.` : ""}`;
  if (pos[1] === undefined) {
    if (v.json) return (printJson(r), EXIT.ok);
    const lines = [...r.turns].reverse().map((t) => `  turn ${String(t.n ?? "?").padStart(3)}  ${z.stamp(t.created)}  ${plural(t.files.length, "file")}, +${t.added} -${t.removed}${t.incomplete ? " (incomplete: no end snapshot)" : ""}${t.elsewhere ? ` (in ${t.elsewhere})` : ""}${t.unavailable ? " (history unreadable)" : ""}  ${one(t.prompt || "(no prompt)", 60)}`);
    console.log([head, ...(lines.length ? lines : ["  No turn has changed files yet."]), ...(r.expired ? [`${plural(r.expired, "older turn")} can no longer be rewound.`] : [])].join("\n"));
    return EXIT.ok;
  }
  const n = Number(pos[1]);
  if (!Number.isInteger(n) || n < 1) return usageError("changes", "TURN is a turn's number from the list", CHANGES_USAGE);
  const t = r.turns.find((x) => x.n === n);
  if (!t) throw new Error(`turn ${n} of this session changed no files (keel changes ${pos[0]} lists the turns that did)`);
  const d = await c.get<{ files: FileChange[]; diff: string; truncated: boolean; incomplete?: boolean }>(`/api/sessions/${s.id}/checkpoints/diff?turn=${t.turn}`);
  if (v.json) return (printJson({ turn: t, ...d }), EXIT.ok);
  const out = [head, `Turn ${n}, ${z.stamp(t.created)}: ${one(t.prompt || "(no prompt)", 100)}`, `${plural(d.files.length, "file")}, +${t.added} -${t.removed}${d.incomplete ? ". This turn has no end snapshot: shown is its start against the files now, which may include edits made after it" : ""}.`,
    ...d.files.map((f) => `  ${(STATUS[f.status] ?? f.status).padEnd(9)} +${f.added} -${f.removed}  ${clean(f.path)}${f.outside ? " (outside the folder)" : ""}`)];
  if (v.diff) out.push("", clean(d.diff).replace(/\n$/, ""), ...(d.truncated ? ["(the patch is cut here: the page shows each file's whole diff)"] : []));
  console.log(out.join("\n"));
  return EXIT.ok;
});

// ---- keel rewind

type Rewound = { files: string[]; failed: { path: string; error: string }[]; skipped: string[]; outside: string[]; merged: string[]; conflicts: string[]; blocked: { path: string; uncaptured: string }[]; removes: string[]; uncaptured: string[]; incomplete: boolean; undo: string | null };
const REWIND_USAGE = `keel rewind SESSION TURN [--mode files|chat|both] [--preview] [--paths P...] [--include-outside] [--stop-shells] [--json]
keel rewind SESSION --undo [--stop-shells] [--json]
  Go back from a turn, as the page's Rewind does. TURN is the number keel changes gives it. --mode
  files (the default) puts the files back as they were before the turn's prompt; chat moves the
  session back to before that prompt (the files stay); both does both. --preview lists what would
  change and writes nothing. --paths limits the files to those named. A file changed outside the
  session since is kept as it is (listed as kept) unless --include-outside. A turn or a command
  of the session running refuses it (--stop-shells stops the commands). --undo takes back the
  newest rewind of the session, until a newer message is sent.`;
const list = (label: string, items: string[]) => (items.length ? [`${label} (${items.length}):`, ...items.map((p) => `  ${clean(p)}`)] : []);
const reportFiles = (r: Rewound, would: boolean) => [
  ...list(would ? "Would restore" : "Restored", r.files),
  ...list("Removed", would ? [] : r.removes),
  ...list("Kept, changed outside the session (--include-outside takes them too)", r.skipped),
  ...list("Taken back around an outside edit", r.merged),
  ...list("Kept, the session's change and an outside edit overlap", r.conflicts),
  ...list("Not touched, a file under a folder too large to capture", r.blocked.map((b) => `${b.path} (${b.uncaptured})`)),
  ...list("Not captured, so not restored", r.uncaptured),
  ...list("Failed", r.failed.map((f) => `${f.path}: ${f.error}`)),
];
const rewind = command("rewind", REWIND_USAGE, {
  mode: { type: "string" }, preview: { type: "boolean" }, paths: { type: "string", multiple: true }, undo: { type: "boolean" },
  "include-outside": { type: "boolean" }, "stop-shells": { type: "boolean" },
}, async (v, pos, c) => {
  if (!pos[0]) return usageError("rewind", "name the session", REWIND_USAGE);
  const s = await c.resolve(pos[0]);
  const path = `/api/sessions/${s.id}/rewind`;
  if (v.undo) {
    if (pos[1] !== undefined || v.preview || v.mode || v.paths) return usageError("rewind", "--undo takes the session and nothing else", REWIND_USAGE);
    const r = await c.post<{ files: Rewound | null; head?: string }>(path, { undo_rewind: "last", stop_shells: v["stop-shells"] || undefined });
    if (v.json) return (printJson(r), EXIT.ok);
    console.log([`Undid the last rewind of session "${one(s.title || "(untitled)", 60)}" (${s.id}).`, ...(r.files ? reportFiles(r.files, false) : ["No files were involved."])].join("\n"));
    return EXIT.ok;
  }
  const n = Number(pos[1]);
  if (pos[1] === undefined || !Number.isInteger(n) || n < 1) return usageError("rewind", "TURN is a turn's number from keel changes", REWIND_USAGE);
  const mode = v.mode ?? "files";
  if (!["files", "chat", "both"].includes(mode)) return usageError("rewind", "--mode is files, chat or both", REWIND_USAGE);
  if (mode === "chat" && (v.paths || v["include-outside"])) return usageError("rewind", "--paths and --include-outside are about files; --mode chat moves none", REWIND_USAGE);
  const turns = (await c.get<{ turns: CheckTurn[] }>(`/api/sessions/${s.id}/checkpoints`)).turns;
  const t = turns.find((x) => x.n === n);
  if (!t) throw new Error(`turn ${n} of this session changed no files (keel changes ${pos[0]} lists the turns that did)`);
  const body = { prompt_turn: t.turn, mode, paths: v.paths, include_outside: v["include-outside"] || undefined, stop_shells: v["stop-shells"] || undefined };
  const head = `Session "${one(s.title || "(untitled)", 60)}" (${s.id}), turn ${n}: ${one(t.prompt || "(no prompt)", 80)}`;
  if (v.preview) {
    const r = await c.post<Rewound & { turn: number | null }>(path, { ...body, preview: true });
    if (v.json) return (printJson(r), EXIT.ok);
    console.log([head, `Preview of rewinding ${mode === "chat" ? "the chat" : mode === "both" ? "the chat and the files" : "the files"} to before it; nothing was written.`, ...(mode === "chat" ? [] : r.files.length || r.skipped.length || r.merged.length ? reportFiles(r, true) : ["No file would change."])].join("\n"));
    return EXIT.ok;
  }
  const r = await c.post<{ files: Rewound | null; note: string; chat: { head?: string } | null }>(path, body);
  if (v.json) return (printJson(r), EXIT.ok);
  console.log([head, `Rewound ${mode === "chat" ? "the chat" : mode === "both" ? "the chat and the files" : "the files"} to before it.`, ...(r.files ? reportFiles(r.files, false) : []), ...(r.files?.undo || mode === "chat" ? [`Undo with: keel rewind ${s.id} --undo${r.files?.undo ? ` (undo point ${r.files.undo})` : ""}`] : [])].join("\n"));
  return EXIT.ok;
});

// ---- keel cost

const COST_USAGE = `keel cost SESSION [--turns N] [--json]
  What one session cost, as its Tokens panel says it: the cost the header shows (with what its
  agents spent, when it started any), its turns and requests, where the tokens went, and its
  turns, the dearest first (--turns N lists N, default 10).`;
const cost = command("cost", COST_USAGE, { turns: { type: "string" } }, async (v, pos, c) => {
  if (!pos[0]) return usageError("cost", "name the session", COST_USAGE);
  const top = v.turns === undefined ? 10 : Number(v.turns);
  if (!(Number.isInteger(top) && top > 0)) return usageError("cost", "--turns is a whole number above 0", COST_USAGE);
  const s = await c.resolve(pos[0]);
  const [{ session }, ledger, kids, agents] = await Promise.all([
    c.get<{ session: any }>(`/api/sessions/${s.id}?events=0`),
    c.get<{ counts: LedgerCounts; turns: TurnPick[] }>(`/api/telemetry/turns?session_id=${encodeURIComponent(s.id)}&limit=5000`),
    c.get<{ total: { calls: number; cost_usd?: number } }>(`/api/usage?group=session&children_of=${encodeURIComponent(s.id)}`),
    c.get<{ agents: unknown[] }>(`/api/sessions/${s.id}/agents`).catch(() => ({ agents: [] })),
  ]);
  const whole: number | undefined = session.usage?.cost;
  const n = agents.agents.length;
  const task = n ? (whole !== undefined && kids.total.cost_usd !== undefined ? whole + kids.total.cost_usd : undefined) : whole;
  if (v.json) return (printJson({ session_id: s.id, cost_usd: whole, task_cost_usd: task, agents: n, delegated: n ? kids.total : null, counts: ledger.counts, usage: session.usage, turns: ledger.turns }), EXIT.ok);
  const tokens = tokensOf(session.usage);
  const all = KINDS.reduce((x, k) => x + tokens[k], 0);
  const dear = [...ledger.turns].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.n - a.n).slice(0, top);
  const z = zoned();
  console.log([
    `${n ? "This task cost" : "This session cost"} ${exact(task)}${session.usage?.unpriced ? "+" : ""}: session "${one(s.title || "(untitled)", 60)}" (${s.id}).`,
    ...(n ? [`${money(whole)} in this session, ${money(kids.total.cost_usd)} in its ${plural(n, "agent")} (${plural(kids.total.calls, "request")}).`] : []),
    `${ledger.counts.turns ? `${plural(ledger.counts.turns, "turn")}, ${requestsWords(ledger.counts.requests, ledger.counts.failed)}` : "No turns yet"}.${session.usage?.unpriced ? ` ${plural(session.usage.unpriced, "request")} had no known price.` : ""}`,
    `Where the tokens went (${all.toLocaleString("en-US")}): ${KINDS.map((k) => `${KIND_LABEL[k]} ${tokens[k].toLocaleString("en-US")}${all ? ` (${Math.round((100 * tokens[k]) / all)}%)` : ""}`).join(", ")}.`,
    ...(dear.length ? [`Turns, the dearest first. ${z.note}.`, ...dear.map((t) => `  turn ${String(t.n).padStart(3)}  ${money(t.cost ?? undefined).padStart(8)}  ${z.stamp(t.ts)}  ${plural(t.requests, "request")}${t.failed_attempts ? `, ${t.failed_attempts} failed` : ""}${t.outcome && t.outcome !== "ok" ? `, ${t.outcome}` : ""}  ${one(t.prompt || "(no prompt)", 60)}`)] : []),
  ].join("\n"));
  return EXIT.ok;
});

export const inspectCommands = { messages, changes, rewind, cost };
