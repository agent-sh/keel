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

export const inspectCommands = { messages, changes, cost };
