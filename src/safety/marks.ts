// What the transcript marks on a stored call, so a folded step never hides it:
// a command that asked to leave the sandbox, what the permission policy rates
// high risk or the owner's alone (in the policy's own words), a write outside
// the session's own scope, a call the owner denied, and one a standing rule
// of the time allows without asking. Each call is judged as its approval card
// would be with no mode and no rule to lean on; a call that only reads has no
// mark.
//
// This runs on the read thread (src/server/read-tasks.ts): it takes a database
// connection and plain facts, and imports nothing of the daemon. A page of
// calls costs the loop the gathering of those facts and nothing else: the
// events are read here, and every command is parsed here.
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { commandOf } from "../core/command.ts";
import { contains, realOf } from "../core/paths.ts";
import type { ToolKind } from "../tools/types.ts";
import { located } from "./autonomy.ts";
import { classify, decide, ESCALATES, ownPath, pathsNamed, writesOf, type CallClass, type Facts, type Rule } from "./policy.ts";
import { isReadOnly, splitCommand } from "./shell.ts";

// A mark on a stored call. `short`: a few words, beside the call's verb;
// `why`: the sentence, read on demand.
// `within`: on a program, for a call the program made (the call carries the mark itself too).
export type CallMark = { kind: "escalated" | "risk" | "outside" | "rule" | "denied"; short: string; why: string; within?: true };

// A tool as the policy reads it, as plain facts: the names of its input's
// keys (the policy reads which of them the tool has), and whether its `shell`
// input names the interpreter.
export type MarkTool = { name: string; readOnly: boolean; kind?: ToolKind; props: string[]; appliesPatch?: true; shellInput?: true };
// A tool of an MCP server the session has now, by its full name.
export type MarkMcp = { qualified: string; name: string; readOnly: boolean };

export type MarkArgs = {
  session: string;
  // The events whose calls are asked for.
  events: string[];
  // The session's folder as it names it, and where its edits are its own (links resolved).
  workspace: string;
  scope: { workspace: string; scratch: string[] };
  // On another machine: this machine's disk says nothing of its files.
  machine: boolean;
  // What the policy's owner-only rules read of this machine (Gate.evaluate).
  home: string; config: string[]; bins: string[];
  // The session's standing rules, each with when it was made.
  rules: Rule[];
  tools: MarkTool[];
  mcp: MarkMcp[];
  // The names of the tools that run a program (run_code) and that run an MCP server's tool by name (mcp_call).
  runCode: string; mcpCall: string;
  // Where the session's commands left their records (the folder each ran in).
  jobs?: string;
  // The owner's shell: what a tool whose input may name its interpreter runs a command with when it names none.
  shell?: string;
};

// An edit is judged by where it sits (its folders' links resolved) and by
// where it lands (the file's own link followed too): a link inside the
// workspace that points out of it, or into .git, is judged as the place it
// names, and a link named like a file the repository runs (.envrc) stays that.
// Only the paths change: everything else the call was classified with (what
// its words name) goes to the rules as it was.
export const landing = (c: CallClass): CallClass =>
  c.kind === "edit" ? { ...c, paths: [...new Set(c.paths.flatMap((p) => [join(realOf(dirname(p)), basename(p)), realOf(p)]))] }
    // (What a read names, where it is: the file a tool opens.)
    : c.kind === "read" && c.paths ? { ...c, paths: [...new Set(c.paths.map((p) => realOf(p)))] } : c;

// A program given to run_code, as the command the gate judges it as
// (src/tools/codemode.ts asShellCommand: a test holds the two to one form).
export const programCommand = (code: string) => `bun -e '${code.replace(/'/g, `'\\''`)}'`;

// The policy's reason as a sentence of its own: "the command runs as root"
// reads "It runs as root.", "the command: it writes X" reads "It writes X."
export const sentence = (why: string) => {
  const t = why.replace(/^the command: /, "").replace(/^the command /, "it ").replace(/^it /, "It ");
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

// A command that does more than read and reaches outside the session's
// folder: it names a path outside it, writes one by a redirect, or runs in a
// folder outside it. Read with the policy's own parser, its own rule for what
// only reads and its own reading of what a command's shape writes. Not a
// judgement of risk (the policy's is asked first): where the command reaches.
// A command the parser cannot split, or a part whose folder is not known, is
// not said to reach out.
export function reachesOut(command: string, cwd: string, own: string[], home: string): boolean {
  const parts = splitCommand(command);
  if (!parts) return false;
  const out = (p: string) => !own.some((d) => contains(d, p));
  const at = (w: string, dir: string) => resolve(dir, w.replace(/^(["'])(.*)\1$/s, "$2").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home));
  return located(parts, cwd, home).some(({ s, dir }) => {
    if (isReadOnly(s) || dir === null || /^(cd|pushd|popd)$/.test(s.words[0] ?? "")) return false;
    if (out(dir)) return true;
    if (s.words.slice(1).some((w) => /^(\/|~\/|\.\.(\/|$))/.test(w) && !SINKS.test(w) && out(at(w, dir)))) return true;
    return writesOf(s).some((w) => !/[$`*?\n]/.test(w) && !SINKS.test(w) && out(at(w, dir)));
  });
}
const SINKS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// The folder each of a session's commands ran in, by the call that started
// it: from the records its jobs left. Read again only when the folder of
// records changed.
const ranIn = new Map<string, { at: number; by: Map<string, string> }>();
export function foldersOf(dir: string): Map<string, string> {
  let at = 0;
  try { at = statSync(dir).mtimeMs; } catch { return new Map(); }
  const had = ranIn.get(dir);
  if (had && had.at === at) return had.by;
  const by = new Map<string, string>();
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as { call_id?: string; cwd?: string };
      if (m.call_id && typeof m.cwd === "string") by.set(m.call_id, m.cwd);
    } catch {}
  }
  if (ranIn.size > 32) ranIn.clear();
  ranIn.set(dir, { at, by });
  return by;
}

// What was worked out for a call, kept: it depends on the stored call, the
// rules of its time and how its card was settled, and on nothing else.
const kept = new Map<string, CallMark[]>();
const KEPT_MAX = 20_000;

type Use = { id: string; name: string; input: any; ts: number };

export function marksOf(db: Database, a: MarkArgs): Record<string, CallMark[]> {
  const out: Record<string, CallMark[]> = {};
  const ids = [...new Set(a.events)].slice(0, EVENTS_MAX);
  if (!ids.length) return out;
  const rows = db.query<{ ts: number; data: string }, [string, string]>("SELECT ts, data FROM events WHERE session_id = ?1 AND kind = 'assistant' AND id IN (SELECT value FROM json_each(?2))").all(a.session, JSON.stringify(ids));
  const uses: Use[] = [];
  for (const r of rows) {
    let blocks: any[] = [];
    try { blocks = JSON.parse(r.data)?.blocks ?? []; } catch {}
    for (const b of blocks) if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") uses.push({ id: b.id, name: b.name, input: b.input ?? {}, ts: r.ts });
  }
  if (!uses.length) return out;
  // The calls a program made are part of what happened: each is judged as a call of its own, and what
  // marks them marks the program too. They are read from where the daemon keeps them for the page.
  const within = new Map<string, Use[]>();
  const programs = uses.filter((u) => u.name === a.runCode).map((u) => u.id);
  if (programs.length) {
    try {
      for (const r of db.query<{ parent: string; data: string }, [string, string]>("SELECT parent, data FROM code_calls WHERE session_id = ?1 AND parent IN (SELECT value FROM json_each(?2)) ORDER BY seq").all(a.session, JSON.stringify(programs))) {
        let c: any;
        try { c = JSON.parse(r.data); } catch { continue; }
        // (An input too long for the page was kept cut: it cannot be judged.)
        if (typeof c?.id !== "string" || typeof c.tool !== "string" || c.tool === a.runCode || c.input?.clipped !== undefined) continue;
        within.set(r.parent, [...(within.get(r.parent) ?? []), { id: c.id, name: c.tool, input: c.input ?? {}, ts: typeof c.started === "number" ? c.started : 0 }]);
      }
    } catch {
      // A store that has run no program has no such table.
    }
  }
  const settled = new Map(db.query<{ call: string | null; state: string }, [string]>("SELECT data ->> '$.call_id' AS call, state FROM approvals WHERE session_id = ? AND state IN ('allowed', 'denied')").all(a.session).map((r) => [r.call ?? "", r.state]));
  const tools = new Map(a.tools.map((t) => [t.name, t]));
  const folders = a.jobs && !a.machine ? foldersOf(a.jobs) : new Map<string, string>();
  const rulesKey = a.rules.map((r) => `${r.id}@${r.created}`).join(",");
  // A tool of an MCP server is judged by what the session's servers say of it now: part of what its marks hang on.
  const mcpKey = a.mcp.length ? Bun.hash(a.mcp.map((t) => `${t.qualified}${t.readOnly ? "+" : "-"}`).join(",")).toString(36) : "";
  let own: { home: string; config: string[]; bins: string[]; land: (p: string) => string[] } | undefined;
  const facts = (cls: CallClass, name: string, rules: Rule[]): Facts => ({
    mode: "ask", workspace: cls.kind === "edit" ? a.scope.workspace : a.workspace, sandboxed: false, rules, tool: name, scratch: a.scope.scratch,
    ...(a.machine ? {} : { own: () => (own ??= { home: a.home, config: a.config, bins: a.bins, land: (x: string) => [...new Set([x, join(realOf(dirname(x)), basename(x)), realOf(x)])] }) }),
  });
  const marksFor = (u: Use): CallMark[] => {
    const key = `${a.session}\n${u.id}\n${settled.get(u.id) ?? ""}\n${rulesKey}\n${u.name === a.mcpCall || !tools.has(u.name) ? mcpKey : ""}`;
    const had = kept.get(key);
    if (had) return had;
    const marks = judge(u, a, tools, folders, settled.get(u.id), facts);
    if (kept.size >= KEPT_MAX) kept.clear();
    kept.set(key, marks);
    return marks;
  };
  for (const u of uses) {
    let marks = marksFor(u);
    // A program carries what marks the calls it made, each reason once (not the owner's denial of one of them: the program ran).
    for (const c of within.get(u.id) ?? []) {
      const inner = marksFor(c);
      if (!inner.length) continue;
      out[c.id] = inner;
      for (const m of inner) if (m.kind !== "denied" && !marks.some((x) => x.kind === m.kind && x.short === m.short)) marks = [...marks, { ...m, why: `A call it made: ${m.why}`, within: true }];
    }
    if (marks.length) out[u.id] = marks;
  }
  return out;
}
// The events one request may name: a page asks for the part it holds.
export const EVENTS_MAX = 500;

// What a stored call is to the policy, as the live gate classes it (gate.ts
// callClass), from the call's name and input alone.
export function classOf(u: { id: string; name: string; input: any }, a: Pick<MarkArgs, "workspace" | "mcp" | "runCode" | "mcpCall" | "shell">, tools: Map<string, MarkTool>, folders: Map<string, string>): { cls: CallClass; name: string } {
  const input = u.input ?? {};
  // The folder a command ran in: where its record says, else the folder its input names, else the session's.
  const named = typeof input.workdir === "string" ? input.workdir : typeof input.dir_path === "string" ? input.dir_path : undefined;
  const cwd = folders.get(u.id) ?? (named ? resolve(a.workspace, named) : a.workspace);
  // A program (run_code) is judged as the command it is.
  if (u.name === a.runCode) return { name: u.name, cls: { kind: "shell", command: programCommand(typeof input.code === "string" ? input.code : ""), escalate: input.sandbox_permissions === "require_escalated" || undefined, cwd: a.workspace } };
  // A tool of an MCP server, by its own name or through the dispatcher: a
  // read where the session's servers say so now, else a tool that may change
  // things, with the paths its input names.
  const viaCall = u.name === a.mcpCall;
  const t = viaCall ? undefined : tools.get(u.name);
  if (viaCall || !t) {
    const name = viaCall ? String(input.tool ?? "") : u.name;
    const args = viaCall ? input.arguments ?? {} : input;
    const known = a.mcp.find((x) => x.qualified === name || `mcp__${x.qualified}` === name) ?? (viaCall ? a.mcp.find((x) => x.name === name) : undefined);
    if (known?.readOnly) return { name, cls: { kind: "read" } };
    const paths = pathsNamed(args);
    return { name, cls: paths.length ? { kind: "other", paths } : { kind: "other" } };
  }
  const tool = {
    name: t.name, readOnly: t.readOnly, kind: t.kind, appliesPatch: t.appliesPatch,
    input_schema: { properties: Object.fromEntries(t.props.map((k) => [k, {}])) },
    ...(t.shellInput ? { interpreter: (i: any) => { const sh = (typeof i?.shell === "string" && i.shell) || a.shell || "bash"; return sh === a.shell && /(^|\/)bash$/.test(sh) ? "bash" : sh; } } : {}),
  };
  let cls = classify(tool, input, cwd);
  // A command given as a list of words (another harness's call, imported) is the command those words are.
  if (cls.kind === "refused" && t.kind === "shell") { const command = commandOf(input); if (command) cls = { kind: "shell", command, cwd }; }
  if (cls.kind === "shell") cls = { ...cls, cwd };
  // A tool the policy knows only by name is given the paths its input names.
  if (cls.kind === "other" && !cls.paths) { const paths = pathsNamed(input); if (paths.length) cls = { ...cls, paths }; }
  return { name: u.name, cls: landing(cls) };
}

function judge(u: Use, a: MarkArgs, tools: Map<string, MarkTool>, folders: Map<string, string>, how: string | undefined, facts: (cls: CallClass, name: string, rules: Rule[]) => Facts): CallMark[] {
  const marks: CallMark[] = [];
  let { cls, name } = classOf(u, a, tools, folders);
  if (cls.kind === "read" || cls.kind === "control" || cls.kind === "refused") return how === "denied" ? [DENIED] : marks;
  // A command that asked to leave the sandbox says so, whatever else it is.
  if (cls.kind === "shell" && cls.escalate) {
    marks.push({ kind: "escalated", short: ESCALATES, why: "It asked to run outside the sandbox." });
    cls = { ...cls, escalate: undefined };
  }
  const alone = decide(cls, facts(cls, name, []));
  // The rule's class in a few words, and the sentence the approval card would show.
  if ("ask" in alone && (alone.ask.risk === "high" || alone.ask.ownerOnly)) marks.push({ kind: "risk", short: alone.ask.rule ?? "high risk", why: sentence(alone.ask.why ?? "the policy rates it high risk") });
  else if (cls.kind === "edit" && cls.paths.some((p) => !ownPath(p, a.scope))) marks.push({ kind: "outside", short: "outside the folder", why: "It writes outside the session's folder." });
  else if (cls.kind === "shell" && reachesOut(cls.command, cls.cwd ?? a.workspace, [a.workspace, a.scope.workspace, ...a.scope.scratch], a.home)) marks.push({ kind: "outside", short: "reaches outside the folder", why: "It does more than read, on a path outside the session's folder, or in a folder outside it." });
  if (how === "denied") marks.push(DENIED);
  else if ("ask" in alone && !how) {
    // Only a rule that stood when the call was made: one made since says nothing of how this call ran.
    const then = a.rules.filter((r) => r.created <= u.ts);
    if (then.length && "allow" in decide(cls, facts(cls, name, then))) marks.push({ kind: "rule", short: "allowed by a rule", why: "A standing rule of yours, made before this call, allows it without asking." });
  }
  return marks;
}
const DENIED: CallMark = { kind: "denied", short: "denied by you", why: "You denied it: it did not run." };
