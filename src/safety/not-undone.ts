// What a rewind cannot take back, read from the calls a session stored: a change on another machine or a
// service, a git commit or push (the restore leaves refs alone), an MCP tool that does not say it only
// reads, a write outside the session's folder, a file the snapshot never held (ignored, or over the size
// cap). Each line names the call and its turn. No model is asked: the stored calls are judged the way the
// permission policy reads them (marks.ts), on the read thread (src/server/read-tasks.ts), so this file
// imports nothing of the daemon.
//
// A call whose result was an error did not change anything and is left out. A write inside the folder is
// a candidate only: whether the snapshot held it depends on the folder's ignore files, which the loop asks
// of git (`Touched`, src/server/routes/rewind-reach.ts).
import type { Database } from "bun:sqlite";
import { relative, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { classOf, type MarkArgs, type MarkMcp, type MarkTool, foldersOf } from "./marks.ts";
import { located } from "./autonomy.ts";
import { writesOf } from "./policy.ts";
import { risksOf } from "./risk.ts";
import { name as base, unwrap } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

export type UndoneKind = "remote" | "git" | "mcp" | "outside" | "ignored" | "skipped" | "agent";
// `n`: the turn's place among the session's turns (its first is 1), `turn`: its start's seq.
export type Undone = { n: number; turn: number; seq: number; call: string; tool: string; kind: UndoneKind; line: string };
// A path inside the folder a call deleted or wrote: whether it is "not undone" depends on whether the snapshot held it.
export type Touched = { n: number; turn: number; seq: number; call: string; tool: string; path: string; how: "deleted" | "wrote" };
export type McpFact = MarkMcp & { hinted?: boolean };
export type LedgerAsk = Pick<MarkArgs, "session" | "workspace" | "scope" | "machine" | "home" | "tools" | "runCode" | "mcpCall" | "shell" | "jobs"> & {
  mcp: McpFact[];
  // The calls that started an agent (the agents' records name them): each is an "agent" item, its words the caller's.
  spawned: string[];
  // The events from this seq on (inclusive).
  from: number;
};
// `through`: every event up to it belongs to a turn that ended, so what is said of it will not change.
export type Ledger = { items: Undone[]; touched: Touched[]; through: number; more: boolean };

const CALLS_MAX = 6_000;
const ITEMS_MAX = 600;
const clip = (s: string, n = 160) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const SINKS = /^\/dev\//;

// ---- a shell command ----

// The word of a git command after its global options: `git -C dir -c k=v commit -m x` is `commit`.
function gitSub(args: string[]): { sub: string; rest: string[] } | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--exec-path") { i++; continue; }
    if (a.startsWith("-")) continue;
    return { sub: a, rest: args.slice(i + 1) };
  }
  return null;
}

// What a git command changes that a restore of files leaves as it is (refs, the index's history, the stash, remotes).
function gitChange(sub: string, rest: string[]): "push" | "git" | null {
  const flags = rest.filter((a) => a.startsWith("-")), words = rest.filter((a) => !a.startsWith("-"));
  switch (sub) {
    case "push": return /(^|\s)--dry-run|^-n$/.test(flags.join(" ")) ? null : "push";
    case "commit": case "merge": case "rebase": case "cherry-pick": case "revert": case "pull": case "am": case "reset":
    case "update-ref": case "filter-branch": case "gc": case "init": case "clone": case "mv":
      return flags.includes("--abort") && sub !== "reset" ? null : "git";
    case "tag": return words.length && !flags.some((f) => /^-(l|-list|n\d*)$/.test(f)) || flags.some((f) => /^-(d|a|s|f|-delete)$/.test(f)) ? "git" : null;
    case "branch": return words.length || flags.some((f) => /^-(d|D|m|M|c|C|u|-delete|-move|-copy|-set-upstream-to|-unset-upstream)$/.test(f)) ? (flags.some((f) => /^(-l|--list|-a|-r|--show-current|-v|-vv)$/.test(f)) && !words.length ? null : "git") : null;
    case "stash": return words[0] === "list" || words[0] === "show" ? null : "git";
    case "worktree": return words[0] === "list" ? null : "git";
    case "remote": return words[0] && !/^(show|get-url|-v)$/.test(words[0]) ? "git" : null;
    case "checkout": return flags.some((f) => f === "-b" || f === "-B") ? "git" : null;
    case "switch": return flags.some((f) => f === "-c" || f === "-C" || f === "--create") ? "git" : null;
    case "submodule": return words[0] === "status" ? null : "git";
    default: return null;
  }
}

// A request that sends something (a body, a form, an upload, a method that changes) to an address that is not this machine.
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)(:\d+)?$/i;
function sentTo(prog: string, args: string[]): string | null {
  if (!/^(curl|wget|http|https|xh)$/.test(prog)) return null;
  const url = args.find((a) => /^https?:\/\//i.test(a)) ?? args.find((a) => /^[\w.-]+\.[a-z]{2,}(:\d+)?\/?/i.test(a) && !a.startsWith("-") && !a.includes("="));
  if (!url) return null;
  const host = url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0]!;
  if (LOCAL.test(host)) return null;
  const sends = args.some((a, k) =>
    /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|--body-file)$/.test(a) || /^--(data|json|form|post-data)[=-]/.test(a)
    || /^(-[a-zA-Z]*X|--request|--method)$/.test(args[k - 1] ?? "") && /^(POST|PUT|PATCH|DELETE)$/i.test(a)
    || /^(-[a-zA-Z]*X(POST|PUT|PATCH|DELETE)|--request=(POST|PUT|PATCH|DELETE)|--method=(POST|PUT|PATCH|DELETE))$/i.test(a)
    || (/^(http|https|xh)$/.test(prog) && /^(POST|PUT|PATCH|DELETE)$/i.test(a) && k === 0));
  return sends ? host : null;
}

const DELETES = /^(rm|rmdir|unlink|shred|mv|trash|trash-put)$/;
const tilde = (w: string, home: string) => w.replace(/^(["'])(.*)\1$/s, "$2").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
const shown = (p: string, home: string) => (contains(home, p) && p !== home ? `~/${relative(home, p)}` : p);

type Reach = { kind: UndoneKind; line: string };
export function shellReach(command: string, cwd: string, a: { workspace: string; own: string[]; home: string; scratch: string[] }): { out: Reach[]; touched: { path: string; how: "deleted" | "wrote" }[] } {
  const out: Reach[] = [], touched: { path: string; how: "deleted" | "wrote" }[] = [];
  const parts = splitCommand(command);
  if (!parts) return { out, touched };
  try {
    for (const r of risksOf(parts, { cwd, home: a.home, workspace: a.workspace, scratch: a.scratch })) if (r.rule === "remote") out.push({ kind: "remote", line: clip(r.why) });
  } catch { /* a line the rules cannot read is not said to reach anywhere */ }
  for (const { s, dir } of located(parts, cwd, a.home)) {
    const run = unwrap(s.words);
    const prog = base(run.words[0]), args = run.words.slice(1);
    if (prog === "git") {
      const g = gitSub(args);
      const change = g ? gitChange(g.sub, g.rest) : null;
      if (g && change === "push") out.push({ kind: "remote", line: clip(`git ${g.sub} ${g.rest.filter((x) => !x.startsWith("-")).slice(0, 2).map((x) => (x.startsWith("/") ? `…/${x.split("/").pop()}` : x)).join(" ")}`) });
      else if (g && change) out.push({ kind: "git", line: clip(`git ${g.sub} ${g.rest.join(" ")}`) });
      if (g?.sub === "clean" && g.rest.some((f) => /^-[a-zA-Z]*[xX]/.test(f))) out.push({ kind: "ignored", line: "git clean -x removes files the folder's ignore list names" });
    }
    const to = sentTo(prog, args);
    if (to) out.push({ kind: "remote", line: `sent a request to ${to}` });
    if (dir === null || /^(cd|pushd|popd)$/.test(prog)) continue;
    let writes: string[] = [];
    try { writes = writesOf(s, run); } catch { /* the same */ }
    const how = DELETES.test(prog) ? "deleted" : "wrote";
    for (const w of writes) {
      if (!w || /[$`*?\n]/.test(w) || SINKS.test(w)) continue;
      const p = resolve(dir, tilde(w, a.home));
      if (!a.own.some((d) => contains(d, p))) out.push({ kind: "outside", line: `${how} ${shown(p, a.home)}` });
      else if (contains(a.workspace, p) && p !== a.workspace) {
        const rel = relative(a.workspace, p);
        if (!rel.startsWith(".git/") && rel !== ".git") touched.push({ path: rel, how });
      }
    }
  }
  return { out, touched };
}

// ---- the stored calls ----

type Row = { seq: number; kind: string; data: string };

export function ledgerOf(db: Database, a: LedgerAsk): Ledger {
  const empty: Ledger = { items: [], touched: [], through: a.from - 1, more: false };
  const rows = db.query<Row, [string, number]>("SELECT seq, kind, data FROM events WHERE session_id = ? AND seq >= ? AND kind IN ('turn_start', 'turn_end', 'assistant', 'tool_result') ORDER BY seq").all(a.session, a.from);
  if (!rows.length) return empty;
  // The turn's place among the session's turns.
  let n = db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM events INDEXED BY events_bare WHERE session_id = ? AND kind = 'turn_start' AND seq < ?").get(a.session, a.from)?.n ?? 0;
  type Use = { id: string; name: string; input: any; seq: number; turn: number; n: number };
  const uses: Use[] = [];
  const failed = new Set<string>();
  let turn = 0, lastStart = 0, closed = true, last = a.from - 1, more = false;
  for (const r of rows) {
    last = r.seq;
    if (r.kind === "turn_start") { turn = r.seq; lastStart = r.seq; n++; closed = false; continue; }
    if (r.kind === "turn_end") { closed = true; continue; }
    let data: any;
    try { data = JSON.parse(r.data); } catch { continue; }
    if (r.kind === "tool_result") {
      for (const x of data?.results ?? []) if (x?.is_error && typeof x.tool_use_id === "string") failed.add(x.tool_use_id);
    } else if (turn) {
      for (const b of data?.blocks ?? []) if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        if (uses.length >= CALLS_MAX) { more = true; break; }
        uses.push({ id: b.id, name: b.name, input: b.input ?? {}, seq: r.seq, turn, n });
      }
    }
    if (more) break;
  }
  const tools = new Map(a.tools.map((t) => [t.name, t]));
  const folders = a.jobs && !a.machine ? foldersOf(a.jobs) : new Map<string, string>();
  const own = [a.workspace, a.scope.workspace, ...a.scope.scratch];
  const items: Undone[] = [], touched: Touched[] = [];
  const spawned = new Set(a.spawned);
  for (const u of uses) {
    const at = { n: u.n, turn: u.turn, seq: u.seq, call: u.id };
    // (An agent exists whatever its call's result said: its record is the fact.)
    if (spawned.has(u.id)) items.push({ ...at, tool: u.name, kind: "agent", line: "" });
    if (failed.has(u.id) || items.length >= ITEMS_MAX) continue;
    const { cls, name } = classOf(u, a, tools, folders);
    const say = (kind: UndoneKind, line: string) => { if (!items.some((i) => i.call === u.id && i.line === line)) items.push({ ...at, tool: name, kind, line }); };
    if (cls.kind === "shell") {
      const r = shellReach(cls.command, cls.cwd ?? a.workspace, { workspace: a.workspace, own, home: a.home, scratch: a.scope.scratch });
      for (const x of r.out) say(x.kind, x.line);
      for (const t of r.touched) touched.push({ ...at, tool: name, ...t });
    } else if (cls.kind === "edit") {
      for (const p of cls.paths) {
        if (!own.some((d) => contains(d, p))) say("outside", `wrote ${shown(p, a.home)}`);
        else if (contains(a.workspace, p) && p !== a.workspace) touched.push({ ...at, tool: name, path: relative(a.workspace, p), how: "wrote" });
      }
    } else if (cls.kind === "other" && (u.name === a.mcpCall || (!tools.has(u.name) && u.name.startsWith("mcp__")))) {
      const known = a.mcp.find((x) => x.qualified === name || `mcp__${x.qualified}` === name) ?? (u.name === a.mcpCall ? a.mcp.find((x) => x.name === name) : undefined);
      if (!known?.hinted && !known?.readOnly) say("mcp", `${name.replace(/^mcp__/, "")}${known ? "" : " (its server does not say it only reads)"}`);
    }
  }
  return { items, touched, through: closed ? last : lastStart - 1, more };
}

// What a candidate path is when the snapshot never held it.
export const ignoredLine = (t: Touched): string => `${t.how} ${t.path}, which the checkpoint does not hold`;
