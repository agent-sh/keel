// What a session another harness runs says of itself, read forward from its
// own records as they are written: its state (working while a turn is open,
// waiting while it asks the owner, done when its turn ended), its usage by
// model, the files its tool calls changed, and the calls that failed. A reader
// keeps only what the next record can change (the calls still open, the
// replies whose usage may still grow), so a file is read once from its start
// and after that only by what it gained (src/integrations/outside/service.ts).
// Pure: no file is opened here.
import { isAbsolute, resolve } from "node:path";
import { addUsage, emptyUsage, type Usage } from "../../core/types.ts";
import { clip } from "../import/types.ts";

export type OutsideHarness = "claude" | "codex" | "agy";
export type OutsideState = "working" | "waiting" | "done" | "stale";
export type Failed = { tool: string; kind: "tool" | "provider"; text: string; ts: number };

export type Facts = {
  state: OutsideState;
  // What it waits for, in a few words, while it waits.
  waiting_for?: string;
  model?: string;
  // Since when the state holds (the record that set it).
  since: number;
  last_ts: number;
  // Usage by the model that spent it, as Keel counts it: `input` without the cached parts.
  usage: Record<string, Usage>;
  files: string[];
  // The newest tool call still open while it works: its tool's name and since when (a row says "Working in Claude Code: Bash").
  doing?: { tool: string; since: number };
};

// The newest call of `open` (a Map keeps the order calls opened in).
function newest(open: Map<string, { name: string; ts?: number }>): Facts["doing"] {
  let last: { name: string; ts?: number } | undefined;
  for (const c of open.values()) last = c;
  return last ? { tool: last.name, since: last.ts ?? 0 } : undefined;
}

export type Reader = {
  push(r: any): void;
  facts(): Facts;
  // The failures read since the last take, oldest first.
  takeFailures(): Failed[];
  // What the next record can change, as plain data: a reader made from it (readerOf) reads on where this one
  // stopped, so a transcript is not read again from its start after a restart (src/integrations/outside/reads.ts).
  // The failures not taken yet are not in it: a restart tells only the failures it reads.
  save(): ReaderState;
};

// A reader's state as `save` gives it: its harness's own fields, under the version of their shape.
export type ReaderState = { v: number; h: OutsideHarness; [k: string]: unknown };
// The version of the saved shape: a state of another one is not read (its transcript is read from its start).
export const READER_V = 1;

const tsOf = (r: any) => Date.parse(r?.timestamp ?? "") || 0;

// One line of what a file gained may be cut where the writer has not finished
// it: the whole lines are records, the rest waits for the next read.
export function splitGrown(rest: string, chunk: string): { records: any[]; rest: string; bad: number } {
  const lines = (rest + chunk).split("\n");
  const left = lines.pop() ?? "";
  const records: any[] = [];
  let bad = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    try { records.push(JSON.parse(l)); } catch { bad++; }
  }
  return { records, rest: left, bad };
}

// Usage of one Claude message (`message.usage`), in Keel's terms.
export function claudeUsage(u: any): Usage {
  const n = (x: any) => (typeof x === "number" && x > 0 ? x : 0);
  const hour = n(u?.cache_creation?.ephemeral_1h_input_tokens);
  return { input: n(u?.input_tokens), output: n(u?.output_tokens), cache_read: n(u?.cache_read_input_tokens), cache_write: n(u?.cache_creation_input_tokens), ...(hour ? { cache_write_1h: hour } : {}) };
}

// Codex counts cached input inside input_tokens; Keel's `input` is the part that was not cached.
export function codexUsage(u: any): Usage {
  const n = (x: any) => (typeof x === "number" && x > 0 ? x : 0);
  const cached = n(u?.cached_input_tokens);
  return { input: Math.max(0, n(u?.input_tokens) - cached), output: n(u?.output_tokens), cache_read: cached, cache_write: 0 };
}

const minus = (a: Usage, b: Usage): Usage => ({ input: Math.max(0, a.input - b.input), output: Math.max(0, a.output - b.output), cache_read: Math.max(0, a.cache_read - b.cache_read), cache_write: Math.max(0, a.cache_write - b.cache_write) });

// Tools that change a file named in their input, as Claude Code names them.
const CLAUDE_EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
// Tools that ask the owner where the harness runs.
const CLAUDE_ASKS: Record<string, string> = { AskUserQuestion: "your answer to a question", ExitPlanMode: "your approval of a plan" };
const CLAUDE_INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;
// A result the owner gave by refusing the call: not a failure of the call.
const REFUSED = /^(The user doesn't want to proceed|\[Request interrupted by user)/;

const textOf = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : "";
const absolute = (p: string, cwd?: string) => (isAbsolute(p) || !cwd ? p : resolve(cwd, p));

class Files {
  private seen = new Set<string>();
  list: string[] = [];
  constructor(had: unknown = []) { for (const p of Array.isArray(had) ? had : []) if (typeof p === "string") this.add(p); }
  add(p: string) { if (p && !this.seen.has(p)) { this.seen.add(p); this.list.push(p); } }
}

// A saved state of this harness and version, else none.
const savedOf = (h: OutsideHarness, s: ReaderState | undefined): Record<string, any> => (s && s.v === READER_V && s.h === h ? s : {});
const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const stateOf = (x: unknown): OutsideState => (x === "working" || x === "waiting" || x === "stale" ? x : "done");
const pairs = (x: unknown): [string, any][] => (Array.isArray(x) ? x.filter((p) => Array.isArray(p) && typeof p[0] === "string") : []);
const usages = (x: unknown): Record<string, Usage> => (x && typeof x === "object" && !Array.isArray(x) ? { ...(x as Record<string, Usage>) } : {});

// Claude Code: a turn opens with the owner's prompt and ends with its
// turn_duration (or stop hook) record, a reply that stopped by itself, or an
// interruption. A call is open until its tool_result; a call that asks the
// owner (a question, a plan) is a wait. One reply is written as several
// records with the same message id, each carrying the reply's usage so far:
// the last one counts.
export function claudeReader(saved?: ReaderState): Reader {
  const was = savedOf("claude", saved);
  let state: OutsideState = stateOf(was.state);
  let since = num(was.since), last = num(was.last);
  let waiting: string | undefined = str(was.waiting);
  let model: string | undefined = str(was.model);
  let cwd: string | undefined = str(was.cwd);
  const open = new Map<string, { name: string; path?: string; ts?: number }>(pairs(was.open));
  const replies = new Map<string, { model: string; usage: Usage }>(pairs(was.replies));
  const settled: Record<string, Usage> = usages(was.settled);
  const files = new Files(was.files);
  let failures: Failed[] = [];
  const set = (s: OutsideState, ts: number, w?: string) => {
    if (s !== state || w !== waiting) since = ts || since;
    state = s;
    waiting = w;
  };
  const asking = () => {
    for (const c of open.values()) if (CLAUDE_ASKS[c.name]) return CLAUDE_ASKS[c.name];
    return undefined;
  };
  // Replies are settled once a newer one began: their usage no longer changes, and the map stays small.
  const settle = (keep?: string) => {
    for (const [id, r] of replies) {
      if (id === keep) continue;
      settled[r.model] = addUsage(settled[r.model] ?? emptyUsage(), r.usage);
      replies.delete(id);
    }
  };
  return {
    push(r) {
      if (!r || typeof r !== "object") return;
      const ts = tsOf(r);
      if (ts) last = Math.max(last, ts);
      cwd = typeof r.cwd === "string" ? r.cwd : cwd;
      if (r.isSidechain) return;
      if (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "stop_hook_summary")) { open.clear(); set("done", ts); return; }
      const c = r.message?.content;
      const blocks: any[] = Array.isArray(c) ? c : [];
      if (r.type === "user") {
        const text = textOf(c).trim();
        if (CLAUDE_INTERRUPTED.test(text)) { open.clear(); set("done", ts); return; }
        for (const b of blocks) {
          if (b?.type !== "tool_result") continue;
          const call = open.get(b.tool_use_id);
          open.delete(b.tool_use_id);
          const said = textOf(b.content) || (typeof b.content === "string" ? b.content : "");
          if (b.is_error) {
            if (!REFUSED.test(said.trim())) failures.push({ tool: call?.name ?? "tool", kind: "tool", text: clip(said || "the call failed", 400), ts });
          } else if (call?.path) files.add(absolute(call.path, cwd));
        }
        if (!r.isMeta && !r.isCompactSummary) set(asking() ? "waiting" : "working", ts, asking());
        return;
      }
      if (r.type !== "assistant") return;
      const m = r.message ?? {};
      if (typeof m.model === "string" && m.model && m.model !== "<synthetic>") model = m.model;
      if (m.usage && typeof m.id === "string" && model) {
        settle(m.id);
        replies.set(m.id, { model: m.model && m.model !== "<synthetic>" ? m.model : model, usage: claudeUsage(m.usage) });
      }
      if (r.isApiErrorMessage) failures.push({ tool: "model", kind: "provider", text: clip(textOf(c) || "the model request failed", 400), ts });
      const uses = blocks.filter((b) => b?.type === "tool_use" && typeof b.id === "string");
      for (const u of uses) {
        const p = CLAUDE_EDITS.has(u.name) ? u.input?.file_path ?? u.input?.notebook_path : undefined;
        open.set(u.id, { name: String(u.name ?? "tool"), path: typeof p === "string" ? p : undefined, ts });
      }
      const stop = m.stop_reason;
      if (!uses.length && !open.size && (stop === "end_turn" || stop === "stop_sequence")) set("done", ts);
      else set(asking() ? "waiting" : "working", ts, asking());
    },
    facts() {
      const usage: Record<string, Usage> = { ...settled };
      for (const r of replies.values()) usage[r.model] = addUsage(usage[r.model] ?? emptyUsage(), r.usage);
      const doing = state === "working" ? newest(open) : undefined;
      return { state, ...(waiting ? { waiting_for: waiting } : {}), model, since, last_ts: last, usage, files: [...files.list], ...(doing ? { doing } : {}) };
    },
    takeFailures() { const f = failures; failures = []; return f; },
    save: () => ({ v: READER_V, h: "claude", state, since, last, waiting, model, cwd, open: [...open], replies: [...replies], settled: { ...settled }, files: [...files.list] }),
  };
}

// The paths an apply_patch body names (added, changed, deleted or moved to).
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2]!).trim());
  return out;
}

// The exit code a Codex command's output names: its JSON metadata, or the
// "Exit code: N" line newer versions write. Undefined when it names none.
export function exitCodeOf(out: unknown): number | undefined {
  if (typeof out !== "string") return undefined;
  const line = /^Exit code: (-?\d+)/m.exec(out);
  if (line) return Number(line[1]);
  try { const j = JSON.parse(out); const c = j?.metadata?.exit_code; return typeof c === "number" ? c : undefined; } catch { return undefined; }
}

// What a command printed: the JSON's output, or the part after the header newer versions write.
const outputText = (out: unknown): string => {
  if (typeof out !== "string") return textOf(out);
  try { const j = JSON.parse(out); if (typeof j?.output === "string") return j.output; } catch {}
  const m = /^Exit code: [^\n]*\n(?:Wall time: [^\n]*\n)?Output:\n([\s\S]*)$/.exec(out);
  return m ? m[1]! : out;
};

// Codex: a turn is between task_started and task_complete (or turn_aborted);
// a call is open until its output; a request for the owner's input is a wait,
// and so is an approval the rollout records. Its token_count records carry
// the session's running total: what each adds is the model's of that turn.
export function codexReader(saved?: ReaderState): Reader {
  const was = savedOf("codex", saved);
  let state: OutsideState = stateOf(was.state);
  let since = num(was.since), last = num(was.last);
  let waiting: string | undefined = str(was.waiting);
  let model: string | undefined = str(was.model);
  let cwd: string | undefined = str(was.cwd);
  let total: Usage = was.total && typeof was.total === "object" ? { ...emptyUsage(), ...was.total } : emptyUsage();
  const usage: Record<string, Usage> = usages(was.usage);
  const open = new Map<string, { name: string; paths: string[]; ts?: number }>(pairs(was.open));
  const approvals = new Set<string>(Array.isArray(was.approvals) ? was.approvals.filter((a: unknown) => typeof a === "string") : []);
  const files = new Files(was.files);
  let failures: Failed[] = [];
  const set = (s: OutsideState, ts: number, w?: string) => {
    if (s !== state || w !== waiting) since = ts || since;
    state = s;
    waiting = w;
  };
  const working = (ts: number) => {
    const asks = [...open.values()].some((c) => c.name === "request_user_input");
    if (asks) set("waiting", ts, "your answer to a question");
    else if (approvals.size) set("waiting", ts, "your approval of a command");
    else set("working", ts);
  };
  return {
    push(r) {
      if (!r || typeof r !== "object") return;
      const ts = tsOf(r);
      if (ts) last = Math.max(last, ts);
      const p = r.payload;
      if (!p) return;
      if (r.type === "session_meta") { cwd = p.cwd ?? cwd; return; }
      if (r.type === "turn_context") { model = p.model ?? model; cwd = p.cwd ?? cwd; return; }
      if (r.type === "event_msg") {
        if (p.type === "task_started" || p.type === "turn_started" || p.type === "user_message") return working(ts);
        if (p.type === "task_complete" || p.type === "turn_complete" || p.type === "turn_aborted") { open.clear(); approvals.clear(); return set("done", ts); }
        if (typeof p.type === "string" && p.type.endsWith("_approval_request")) { approvals.add(String(p.call_id ?? p.id ?? p.type)); return working(ts); }
        if (p.type === "token_count" && p.info?.total_token_usage) {
          const now = codexUsage(p.info.total_token_usage);
          const add = minus(now, total);
          total = now;
          const by = model ?? "unknown";
          if (add.input || add.output || add.cache_read) usage[by] = addUsage(usage[by] ?? emptyUsage(), add);
          return;
        }
        if (p.type === "error" && typeof p.message === "string") { failures.push({ tool: "model", kind: "provider", text: clip(p.message, 400), ts }); return; }
        if (p.type === "patch_apply_end" && p.success && p.changes && typeof p.changes === "object") for (const k of Object.keys(p.changes)) files.add(absolute(k, cwd));
        return;
      }
      if (r.type !== "response_item") return;
      if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        const name = p.type === "local_shell_call" ? "shell" : String(p.name ?? "tool");
        let input: any = p.type === "custom_tool_call" ? p.input : p.type === "local_shell_call" ? { command: p.action?.command } : p.arguments;
        if (typeof input === "string" && p.type === "function_call") { try { input = JSON.parse(input); } catch {} }
        const cmd = Array.isArray(input?.command) ? input.command : Array.isArray(input?.cmd) ? input.cmd : undefined;
        const patch = name === "apply_patch" ? (typeof input === "string" ? input : input?.input ?? input?.patch) : cmd?.[0] === "apply_patch" ? cmd[1] : undefined;
        if (typeof p.call_id === "string") open.set(p.call_id, { name, paths: typeof patch === "string" ? patchPaths(patch) : [], ts });
        return working(ts);
      }
      if (typeof p.type === "string" && p.type.endsWith("_output") && typeof p.call_id === "string") {
        const call = open.get(p.call_id);
        open.delete(p.call_id);
        approvals.delete(p.call_id);
        const text = outputText(p.output);
        const code = exitCodeOf(p.output);
        const failed = (code !== undefined && code !== 0) || /^apply_patch verification failed/m.test(text);
        if (failed) failures.push({ tool: call?.name ?? "tool", kind: "tool", text: clip(text || `exit code ${code}`, 400), ts });
        else for (const f of call?.paths ?? []) files.add(absolute(f, cwd));
        return working(ts);
      }
      if (p.type === "message" && p.role === "assistant") return working(ts);
    },
    facts() {
      const doing = state === "working" ? newest(open) : undefined;
      return { state, ...(waiting ? { waiting_for: waiting } : {}), model, since, last_ts: last, usage: { ...usage }, files: [...files.list], ...(doing ? { doing } : {}) };
    },
    takeFailures() { const f = failures; failures = []; return f; },
    save: () => ({ v: READER_V, h: "codex", state, since, last, waiting, model, cwd, total: { ...total }, usage: { ...usage }, open: [...open], approvals: [...approvals], files: [...files.list] }),
  };
}

// Antigravity (src/integrations/import/agy.ts): a step a line. A prompt opens a turn; a reply with calls works on,
// and its calls are answered in order by the steps that follow; a reply with none and no call open ends the turn.
// A call that asks the owner is a wait. Each reply carries its own usage (input without the cached part).
// Antigravity also keeps a run status of each conversation in its list: withOwnWord takes it as its word.
const AGY_EDITS = new Set(["edit_file", "write_file", "replace_file_content", "write_to_file", "multi_replace_file_content"]);
const AGY_ASKS: Record<string, string> = { ask_question: "your answer to a question" };
const agyTs = (r: any) => {
  const m = typeof r?.created_at === "string" ? /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?/.exec(r.created_at) : null;
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}${m[4] ?? "Z"}`) || 0 : 0;
};
export function agyReader(saved?: ReaderState): Reader {
  const was = savedOf("agy", saved);
  let state: OutsideState = stateOf(was.state);
  let since = num(was.since), last = num(was.last);
  let waiting: string | undefined = str(was.waiting);
  let model: string | undefined = str(was.model);
  const usage: Record<string, Usage> = usages(was.usage);
  const open: { name: string; path?: string; ts: number }[] = Array.isArray(was.open) ? was.open.filter((c: any) => c && typeof c.name === "string") : [];
  const files = new Files(was.files);
  let failures: Failed[] = [];
  const set = (s: OutsideState, ts: number, w?: string) => {
    if (s !== state || w !== waiting) since = ts || since;
    state = s;
    waiting = w;
  };
  const working = (ts: number) => {
    const asks = open.find((c) => AGY_ASKS[c.name]);
    set(asks ? "waiting" : "working", ts, asks ? AGY_ASKS[asks.name] : undefined);
  };
  return {
    push(r) {
      if (!r || typeof r !== "object") return;
      const ts = agyTs(r);
      if (ts) last = Math.max(last, ts);
      const n = (x: any) => (typeof x === "number" && x > 0 ? x : 0);
      switch (r.type) {
        case "USER_INPUT":
          open.length = 0;
          return working(ts);
        case "PLANNER_RESPONSE": {
          if (typeof r.model === "string" && r.model) model = r.model;
          const by = model ?? "unknown";
          const u = { input: n(r.input_tokens), output: n(r.output_tokens), cache_read: n(r.cache_read_tokens), cache_write: 0 };
          if (u.input || u.output || u.cache_read) usage[by] = addUsage(usage[by] ?? emptyUsage(), u);
          if (r.status === "ERROR" && typeof r.error === "string") failures.push({ tool: "model", kind: "provider", text: clip(r.error, 400), ts });
          open.length = 0;
          for (const c of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
            if (!c?.name) continue;
            const p = AGY_EDITS.has(c.name) ? c.args?.Path ?? c.args?.TargetFile ?? c.args?.AbsolutePath : undefined;
            open.push({ name: String(c.name), path: typeof p === "string" ? p : undefined, ts });
          }
          if (!open.length && r.status !== "ERROR") return set("done", ts);
          return working(ts);
        }
        case "ERROR_MESSAGE":
          if (typeof r.error === "string" && r.error.trim()) failures.push({ tool: "model", kind: "provider", text: clip(r.error, 400), ts });
          return;
        case "SYSTEM_MESSAGE":
        case "CHECKPOINT":
          return;
        default: {
          // A step that answers the oldest open call.
          const call = open.shift();
          if (!call) return;
          const failed = r.status === "ERROR" || (r.type === "RUN_COMMAND" && Number.isInteger(r.exit_code) && r.exit_code !== 0);
          if (failed) failures.push({ tool: call.name, kind: "tool", text: clip(String(r.error || r.content || "the call failed"), 400), ts });
          else if (call.path) files.add(call.path);
          return working(ts);
        }
      }
    },
    facts() {
      const c = state === "working" ? open[open.length - 1] : undefined;
      return { state, ...(waiting ? { waiting_for: waiting } : {}), model, since, last_ts: last, usage: { ...usage }, files: [...files.list], ...(c ? { doing: { tool: c.name, since: c.ts } } : {}) };
    },
    takeFailures() { const f = failures; failures = []; return f; },
    save: () => ({ v: READER_V, h: "agy", state, since, last, waiting, model, usage: { ...usage }, open: open.map((c) => ({ ...c })), files: [...files.list] }),
  };
}

// `saved`: a state a reader of the same harness saved (Reader.save), to read on from where it stopped.
export const readerOf = (h: OutsideHarness, saved?: ReaderState): Reader => (h === "codex" ? codexReader(saved) : h === "agy" ? agyReader(saved) : claudeReader(saved));

// Antigravity's run status of a conversation (its list's `status`) as the word withOwnWord takes: idle is a turn
// that ended, running or busy one at work. A word it may add later says nothing.
export const agyWord = (status: string | undefined): { status?: string } | undefined =>
  status === "CASCADE_RUN_STATUS_IDLE" ? { status: "idle" } : status === "CASCADE_RUN_STATUS_RUNNING" || status === "CASCADE_RUN_STATUS_BUSY" || status === "CASCADE_RUN_STATUS_CANCELING" ? { status: "busy" } : undefined;

// Claude Code keeps a record of each running session (<config>/sessions/<pid>.json)
// with its own word for its state: busy, waiting (on a permission prompt or
// another ask, `waitingFor`), idle. While that process runs, its word wins over
// what the transcript leaves open: a permission prompt writes nothing to it.
export function withOwnWord(f: Facts, own: { status?: string; waitingFor?: string } | undefined, at = Date.now()): Facts {
  if (!own?.status) return f;
  const s: OutsideState | undefined = own.status === "busy" ? "working" : own.status === "waiting" ? "waiting" : own.status === "idle" ? "done" : undefined;
  if (!s) return f;
  const waiting_for = s === "waiting" ? (own.waitingFor ? clip(own.waitingFor, 120) : f.waiting_for ?? "your answer") : undefined;
  if (s === f.state && waiting_for === f.waiting_for) return f;
  const { waiting_for: _w, ...rest } = f;
  return { ...rest, state: s, ...(waiting_for ? { waiting_for } : {}), since: at };
}

// The whole usage of a session, and its cost where every model's price is known.
export function total(usage: Record<string, Usage>, price: (model: string) => ((u: Usage) => number | undefined)): Usage {
  let sum = emptyUsage();
  let cost = 0, priced = 0, unpriced = 0;
  for (const [model, u] of Object.entries(usage)) {
    sum = addUsage(sum, u);
    const c = price(model)(u);
    if (c === undefined) unpriced++;
    else { cost += c; priced++; }
  }
  // An unknown cost is never shown as zero.
  const { cost: _c, unpriced: _u, ...counts } = sum;
  return { ...counts, ...(priced ? { cost } : {}), ...(unpriced ? { unpriced } : {}) };
}

// A session that works or waits with no record for `staleMs`, and no running process that vouches
// for it, is stale: its harness may have ended without a word (a closed terminal, a killed run).
// `seen`: its last record or the file's last change, whichever is later. The next record makes it
// what that record says again.
export function aged(f: Facts, seen: number, staleMs: number, vouched: boolean, now = Date.now()): Facts {
  if (vouched || (f.state !== "working" && f.state !== "waiting") || now - seen < staleMs) return f;
  const { waiting_for: _w, ...rest } = f;
  return { ...rest, state: "stale", since: seen };
}
