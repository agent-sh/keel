// The other harnesses' sessions on a machine reached over ssh, served by the
// helper there (src/fleet/hands-main.ts): its Claude Code and Codex
// transcripts with the readers and redaction rules a full daemon uses, whether
// the harness that wrote one still works on something, and ending that harness
// when the owner takes its conversation over. Only the list goes back; one
// transcript whole when it is imported.
//
// How a running harness is found and read (checked 2026-11-20):
// - Claude Code lists its live sessions with `claude agents --json` (pid,
//   sessionId, status busy/waiting/idle, waitingFor), the supported way to read
//   its state, from the records it keeps under <config>/sessions/<pid>.json.
//   It starts tool shells, hooks and background commands in process groups of
//   their own and gives them CLAUDE_CODE_SESSION_ID; its MCP servers stay in
//   its own group.
// - Codex keeps a session's rollout file open for as long as it runs and
//   writes task_started / task_complete records; its state is otherwise only
//   on its app-server connection. Its shell tools run in sessions of their own.
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { pidHolds } from "../core/pid.ts";
import { readText } from "../core/proc.ts";
import { classify, groupsUnder, tailReader, type Activity, type Group, type Proc, type Signals, type Tail } from "../integrations/import/activity.ts";
import { agyHome, agySessions, readAgy } from "../integrations/import/agy.ts";
import { claudeFiles, claudeFound, claudeRoot, readClaude } from "../integrations/import/claude.ts";
import { codexFiles, codexFound, codexHome, readCodex } from "../integrations/import/codex.ts";
import { linesBack } from "../integrations/import/files.ts";
import { cursorGiven, CursorError, offered, page as pageOf, scrub, tail as lastMessages } from "../integrations/import/offer.ts";
import type { Found, Harness } from "../integrations/import/types.ts";
import { ownerEnv, ownerHome } from "../core/paths";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const LABEL = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" } as const;
type Here = keyof typeof LABEL;
const isHere = (h: unknown): h is Here => h === "claude" || h === "codex" || h === "agy";
// Only Claude Code and Codex are known by a process the owner can wait for or end; Antigravity's sessions are listed and copied.
const readOf = (f: Found) => (f.harness === "claude" ? readClaude(f.path) : f.harness === "agy" ? readAgy(f) : readCodex(f.path));
const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

// ---- the transcripts: a walk of the stores, a file read again only when it
// changed. The walk yields between files: the helper also runs the sessions'
// tool calls, and a store can hold tens of thousands of transcripts.

const seen = new Map<string, { size: number; mtime: number; found: Found | null }>();
let walking: Promise<void> | null = null;
let walkedAt = 0;
let complete = false;
const REFRESH_MS = 30_000;
const pause = () => new Promise((r) => setTimeout(r, 0));

function walk(): Promise<void> {
  return (walking ??= (async () => {
    const live = new Set<string>();
    let n = 0;
    let read = 0;
    for (const [files, found] of [[claudeFiles(), claudeFound], [codexFiles(), codexFound]] as const) {
      for (const f of files) {
        if (++n % 1000 === 0) await pause();
        live.add(f.path);
        const k = seen.get(f.path);
        if (k && k.size === f.size && k.mtime === f.mtime) continue;
        let row: Found | null = null;
        try { row = found(f.path, f.size, f.mtime); } catch {}
        seen.set(f.path, { size: f.size, mtime: f.mtime, found: row });
        if (++read % 100 === 0) await pause();
      }
    }
    // Antigravity keeps its list in a database: each walk reads it whole (a few hundred rows at most).
    try {
      for (const f of agySessions()) {
        live.add(f.path);
        const k = seen.get(f.path);
        if (k && k.size === f.size_bytes && k.mtime === f.updated_ms) continue;
        seen.set(f.path, { size: f.size_bytes, mtime: f.updated_ms, found: f });
      }
    } catch {}
    for (const p of seen.keys()) if (!live.has(p)) seen.delete(p);
    complete = true;
    walkedAt = Date.now();
  })().finally(() => { walking = null; }));
}

// Up to `ms` of a walk before answering; the rest goes on in the background.
async function fresh(ms: number, force = false) {
  if (!force && complete && Date.now() - walkedAt < REFRESH_MS) return;
  await Promise.race([force && walking ? walking.then(walk) : walk(), new Promise((r) => setTimeout(r, ms))]);
}

const transcripts = () => [...seen.values()].flatMap((k) => (k.found && offered(k.found) ? [k.found] : []));
// One transcript by its id, as its file is now (a session still running grows).
async function find(harness: Here, id: string): Promise<Found | undefined> {
  const hit = () => transcripts().find((f) => f.harness === harness && f.id === id);
  let f = hit();
  if (!f) { await walk(); f = hit(); }
  if (!f) return undefined;
  if (harness === "agy") return f;
  try {
    const st = statSync(f.path);
    const k = seen.get(f.path);
    if (k && (k.size !== st.size || k.mtime !== st.mtimeMs)) {
      const row = (harness === "claude" ? claudeFound : codexFound)(f.path, st.size, st.mtimeMs);
      seen.set(f.path, { size: st.size, mtime: st.mtimeMs, found: row });
      return row?.id === id && offered(row) ? row : undefined;
    }
  } catch { return undefined; }
  return f;
}

// ---- processes

export async function processTable(): Promise<Proc[]> {
  const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,args="], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, LC_ALL: "C" } });
  const out = await readText(p.stdout);
  if (await p.exited !== 0) throw new Error("Could not read the process table. The original was not stopped.");
  const rows: Proc[] = [];
  for (const l of out.split("\n")) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started_ms: Date.parse(m[4]!) || 0, args: m[5]! });
  }
  return rows;
}

// `listed`: Claude Code's command named it (it checks the process itself); a
// record read from its folder is checked here against the process's start.
type Listed = { pid: number; sessionId: string; status?: Signals["status"]; waitingFor?: string; listed?: boolean; procStart?: string; startedAt?: number };

let listed: { at: number; rows: Promise<Listed[]> } | undefined;
function claudeListed(): Promise<Listed[]> {
  if (!Bun.which("claude")) return Promise.resolve([]);
  if (listed && Date.now() - listed.at < 5000) return listed.rows;
  const rows = (async () => {
    try {
      const p = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 5000 });
      const list = JSON.parse(await readText(p.stdout));
      return (Array.isArray(list) ? list : []).filter((r) => typeof r?.pid === "number" && typeof r.sessionId === "string").map((r) => ({ pid: r.pid, sessionId: r.sessionId, status: r.status, waitingFor: r.waitingFor }) as Listed);
    } catch { return []; }
  })();
  listed = { at: Date.now(), rows };
  return rows;
}

// Claude Code's own list of its live sessions: its command when it is on the
// PATH, joined with the records it keeps (the command reads the same ones).
// The records are read at every request: a session that started a second ago counts.
async function claudeSessions(): Promise<Listed[]> {
  {
    const by = new Map<number, Listed>();
    const dir = join(ownerEnv("CLAUDE_CONFIG_DIR") ?? join(ownerHome(), ".claude"), "sessions");
    let names: string[] = [];
    try { names = readdirSync(dir); } catch {}
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, n), "utf8"));
        if (typeof r.pid === "number" && typeof r.sessionId === "string") by.set(r.pid, { pid: r.pid, sessionId: r.sessionId, status: r.status, waitingFor: r.waitingFor, procStart: r.procStart, startedAt: r.startedAt });
      } catch {}
    }
    // A fresh record takes precedence over the cached command.
    for (const r of await claudeListed()) {
      const mine = by.get(r.pid);
      if (!mine || mine.sessionId === r.sessionId) by.set(r.pid, { ...r, ...mine, listed: !mine });
    }
    return [...by.values()];
  }
}

// The process table and the harnesses' own lists, as they are now.
type Now = { procs: Proc[]; claude: Listed[] };
const now = async (): Promise<Now> => { const [procs, claude] = await Promise.all([processTable(), claudeSessions()]); return { procs, claude }; };

// A record is of the process that has its pid now, not of an earlier one: the
// start it wrote down is this process's (clock ticks since boot, field 22 of
// /proc/<pid>/stat), or where there is no /proc the session began after it.
function sameProcess(l: Listed, p: Proc): boolean {
  if (l.listed) return true;
  try {
    const stat = readFileSync(`/proc/${p.pid}/stat`, "utf8");
    return !!l.procStart && stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === String(l.procStart);
  } catch {
    return typeof l.startedAt === "number" && l.startedAt >= p.started_ms - 1000;
  }
}

// An id in a prompt is not the identity of the session that displayed it.
function namedResume(p: Proc, harness: string, id: string): boolean {
  const [bin, flag, value] = p.args.trim().split(/\s+/);
  return bin?.split("/").at(-1) === harness && (harness === "codex" ? flag === "resume" : ["--resume", "-r", "--session-id"].includes(flag ?? "")) && value === id;
}

function harnessOf(f: Found, { procs, claude }: Now): { proc: Proc; status?: Signals["status"]; waiting_for?: string; blocked?: string } | null {
  const by = new Map(procs.map((p) => [p.pid, p]));
  if (f.harness === "claude") {
    const holders = claude.filter((r) => r.sessionId === f.id && by.has(r.pid) && sameProcess(r, by.get(r.pid)!));
    const l = holders[0];
    if (l) return { proc: by.get(l.pid)!, status: l.status, waiting_for: l.waitingFor, blocked: holders.length > 1 ? "Multiple processes hold this session. End the extra writers first." : undefined };
  } else {
    // An app-server can hold multiple threads. Ending it to take over one is not safe.
    for (const p of procs) {
      const [bin, verb] = p.args.trim().split(/\s+/);
      if (bin?.split("/").at(-1) !== "codex") continue;
      try {
        for (const fd of readdirSync(`/proc/${p.pid}/fd`)) {
          try { if (readlinkSync(`/proc/${p.pid}/fd/${fd}`) === f.path) return { proc: p, blocked: verb === "app-server" ? "This thread uses a shared app-server. End the thread there first." : undefined }; } catch {}
        }
      } catch {}
    }
  }
  const p = procs.find((p) => namedResume(p, f.harness, f.id));
  return p ? { proc: p } : null;
}

// The transcripts a harness holds open now, found from the harnesses' side: the
// sessions Claude Code lists as live, the files a Codex process has open, and
// a process started with a session's id. Only these few are then looked at
// as a transcript's own row is (harnessOf), however many a store holds.
export function runningOf(all: Found[], at: Now): Found[] {
  const mine = all.filter((f) => f.harness === "claude" || f.harness === "codex");
  const byId = new Map<string, Found[]>();
  const byPath = new Map<string, Found>();
  for (const f of mine) { byPath.set(f.path, f); (byId.get(f.id) ?? byId.set(f.id, []).get(f.id)!).push(f); }
  const found = new Set<Found>();
  for (const r of at.claude) for (const f of byId.get(r.sessionId) ?? []) if (f.harness === "claude") found.add(f);
  for (const p of at.procs) {
    const [bin, flag, value] = p.args.trim().split(/\s+/);
    const name = bin?.split("/").at(-1);
    if (name !== "claude" && name !== "codex") continue;
    if (value && (name === "codex" ? flag === "resume" : ["--resume", "-r", "--session-id"].includes(flag ?? ""))) for (const f of byId.get(value) ?? []) if (f.harness === name) found.add(f);
    if (name === "codex") {
      try {
        for (const fd of readdirSync(`/proc/${p.pid}/fd`)) {
          try { const f = byPath.get(readlinkSync(`/proc/${p.pid}/fd/${fd}`)); if (f) found.add(f); } catch {}
        }
      } catch {}
    }
  }
  return [...found].filter((f) => harnessOf(f, at)).sort((a, b) => b.updated_ms - a.updated_ms);
}

// Processes that carry a Claude Code session in their environment (Linux): a
// job that outlived the shell that started it is no longer under the harness.
function carrying(sessionId: string, procs: Proc[]): number[] {
  if (!existsSync("/proc/self/environ")) return [];
  const want = Buffer.from(`CLAUDE_CODE_SESSION_ID=${sessionId}\0`);
  const out: number[] = [];
  for (const p of procs) {
    try { if (readFileSync(`/proc/${p.pid}/environ`).includes(want)) out.push(p.pid); } catch {}
  }
  return out;
}

// What the transcript leaves open since its harness started: read from the
// end, only the kinds of record that say something, once per change of the file.
const tails = new Map<string, { key: string; tail: Tail }>();
const TAIL_MAX = 64 << 20;
const TELLING = { claude: ['"tool_use"', '"tool_result"', "task-notification", '"turn_duration"', '"stop_hook_summary"', "Request interrupted", '"end_turn"', '"type":"user"'], codex: ['"event_msg"', '"response_item"'] };
function tailSince(f: Found, since: number): Tail {
  let key = `${since}`;
  try { const st = statSync(f.path); key = `${st.size}:${st.mtimeMs}:${since}`; } catch {}
  const had = tails.get(f.path);
  if (had?.key === key) return had.tail;
  const reader = tailReader(f.harness, since);
  const telling = TELLING[f.harness as "claude" | "codex"].map((w) => Buffer.from(w));
  let read = 0;
  linesBack(f.path, (line) => {
    // A long session's old records are not read through: a job older than this still shows, as a process under it.
    if ((read += line.length) > TAIL_MAX) return true;
    if (!telling.some((w) => line.includes(w))) return false;
    try { return reader.push(JSON.parse(line.toString("utf8"))); } catch { return false; }
  });
  const tail = reader.done();
  tails.set(f.path, { key, tail });
  return tail;
}

export type Running = { pid: number; started_ms: number; status?: string };
export type Seen = Activity & { blocked?: string; revision?: string; process?: Running; groups: Group[]; checked_ms: number };

export async function activityOf(f: Found, at?: Now): Promise<Seen> {
  const none: Tail = { open: [], background: [], shells: [], turn: "unknown" };
  if (f.harness === "agy") return { ...classify({ alive: false, tail: none, groups: [] }), groups: [], checked_ms: Date.now() };
  at ??= await now();
  const { procs } = at;
  const h = harnessOf(f, at);
  if (!h) return { ...classify({ alive: false, tail: none, groups: [] }), groups: [], checked_ms: Date.now() };
  const groups = groupsUnder(procs, h.proc.pid, f.harness === "claude" ? carrying(f.id, procs) : []);
  const a = classify({ alive: true, status: h.status, waiting_for: h.waiting_for, tail: tailSince(f, h.proc.started_ms), groups });
  if (h.blocked) { a.state = "active"; a.why = h.blocked; a.brief = "shared writer"; a.in_flight.push({ kind: "turn", label: h.blocked }); }
  const revision = Bun.hash(JSON.stringify([h.proc.pid, h.proc.started_ms, a.in_flight])).toString(16);
  return { ...a, blocked: h.blocked, revision, process: { pid: h.proc.pid, started_ms: h.proc.started_ms, status: h.status }, groups, checked_ms: Date.now() };
}

// Still a process with something left that runs: not one that has ended and waits to be read by its parent.
const alive = pidHolds;
async function gone(pids: number[], ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (pids.some(alive)) {
    if (Date.now() > until) return false;
    await Bun.sleep(100);
  }
  return true;
}
const END_MS = 10_000; // what a harness gets to save and leave after it is asked to

// Ends the harness of a session the way a closed terminal or a supervisor
// ends it (SIGTERM: both harnesses write their transcript as they go and stop
// their running command), only when it is still the process the owner was
// shown. Its interrupted calls end with it; its jobs as the owner chose.
async function endHarness(f: Found, want: { pid: number; started_ms: number; revision: string; deadline_ms?: number; idle: boolean }, jobs: "keep" | "end") {
  const before = await activityOf(f);
  if (before.blocked) return { ended: false, why: before.blocked, jobs: [], calls: [] };
  const p = before.process;
  if (!p) return { ended: true, was_running: false, jobs: [], calls: [] };
  if (p.pid !== want.pid || p.started_ms !== want.started_ms) return { ended: false, why: "another process runs this session now than the one shown: look at it again", jobs: [], calls: [] };
  if (want.idle && (Date.now() >= want.deadline_ms! || before.in_flight.some((i) => i.kind !== "job") || before.revision !== want.revision)) return { ended: false, deferred: true, jobs: [], calls: [] };
  if (before.revision !== want.revision) return { ended: false, changed: true, why: "the work in flight changed: review it again", jobs: [], calls: [] };
  const started = Date.now();
  process.kill(p.pid, "SIGTERM");
  if (!(await gone([p.pid], END_MS))) return { ended: false, why: `it did not exit within ${END_MS / 1000} s of being asked to (SIGTERM)`, jobs: [], calls: [] };
  const took_ms = Date.now() - started;
  // Never signal a numeric process group after its leader has exited: the
  // group can be shared, or its number reused. Verify each original member.
  const remaining = async (item: Activity["in_flight"][number]) => {
    const g = before.groups.find((g) => g.pid === item.pid);
    if (!g?.members) return [];
    const live = await processTable();
    return g.members.filter((m) => live.some((p) => p.pid === m.pid && p.started_ms === m.started_ms && p.pgid === g.pgid)).map((m) => m.pid);
  };
  const after = async (item: Activity["in_flight"][number], stop: boolean) => {
    const pids = await remaining(item);
    if (!stop) return pids.length > 0;
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
    return !(await gone(pids, 5000));
  };
  type Outcome = Activity["in_flight"][number] & { running: boolean };
  const calls: Outcome[] = [];
  const left: Outcome[] = [];
  for (const item of before.in_flight) {
    const job = item.kind === "job";
    (job ? left : calls).push({ ...item, running: await after(item, !job || jobs === "end") });
  }
  return { ended: true, was_running: true, how: "SIGTERM", took_ms, in_flight: before.in_flight, jobs: left, calls };
}

export function sessionRoutes() {
  const target = async (req: Request): Promise<Found | Response> => {
    const u = new URL(req.url).searchParams;
    const h = u.get("harness");
    if (!isHere(h) || !u.get("id")) return bad("give harness and id");
    return (await find(h, u.get("id")!)) ?? bad(`${h} has no session ${u.get("id")}`, 404);
  };
  return {
    "/api/fleet/hands/transcripts": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const harness = u.get("harness") || undefined;
        // `peek`: a look at what runs now (asked every few seconds); the stores are not walked again for it.
        await fresh(u.has("refresh") ? 10_000 : 1000, !u.has("peek") && (u.has("refresh") || !cursorGiven(u.get("cursor"))));
        const index = { complete, building: !!walking };
        if (harness && !isHere(harness)) return json({ sessions: [], total: 0, index, harnesses: harnesses(transcripts()), tools_present: tools() });
        const all = transcripts();
        // `running`: only what a harness holds open now (the sheet's running list, asked every few seconds).
        if (u.has("running")) {
          const at = await now();
          const held = runningOf(all, at).slice(0, Math.min(Number(u.get("limit") ?? 50) || 50, 200));
          const page = [];
          for (const f of held) {
            const a = await activityOf(f, at);
            page.push({ ...scrub(f), ...(a.state === "ended" ? {} : { original: { state: a.state, why: a.why, brief: a.brief, in_flight: a.in_flight.length, jobs: a.in_flight.filter((i) => i.kind === "job").length } }) });
          }
          return json({ sessions: page.filter((r) => r.original), total: page.length, index, harnesses: [], tools_present: tools() });
        }
        let rows;
        try {
          rows = pageOf(all, { harness: harness as Harness | undefined, q: u.get("q") ?? undefined, show: u.get("show") ?? undefined, sort: (u.get("sort") as any) || undefined, limit: Number(u.get("limit") ?? 50) || 50, cursor: u.get("cursor") ?? undefined }, { max: 200, scope: "offered" });
        } catch (e) {
          if (e instanceof CursorError) return bad(e.message);
          throw e;
        }
        const running = await now();
        const page = [];
        for (const f of rows.sessions) {
          const a = await activityOf(f, running);
          page.push({ ...scrub(f), ...(a.state === "ended" ? {} : { original: { state: a.state, why: a.why, brief: a.brief, in_flight: a.in_flight.length, jobs: a.in_flight.filter((i) => i.kind === "job").length } }) });
        }
        return json({ sessions: page, total: rows.total, next_cursor: rows.next_cursor, changed: rows.changed, index, harnesses: harnesses(all), tools_present: tools() });
      },
    },
    "/api/fleet/hands/transcript": {
      GET: async (req: Request) => {
        const f = await target(req);
        if (f instanceof Response) return f;
        const r = await readOf(f);
        const full = new URL(req.url).searchParams.has("full");
        return json({ session: { ...scrub(f), cwd_exists: isDir(f.cwd) }, read: full ? r : { counts: r.counts, notes: r.notes, events: [] }, tail: lastMessages(r.events) });
      },
    },
    "/api/fleet/hands/activity": {
      GET: async (req: Request) => {
        const f = await target(req);
        if (f instanceof Response) return f;
        const { groups: _, ...a } = await activityOf(f);
        return json(a);
      },
    },
    "/api/fleet/hands/harness/end": {
      POST: async (req: Request) => {
        const received = Date.now();
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (!isHere(b.harness) || typeof b.id !== "string") return bad("give harness and id");
        if (typeof b.revision !== "string" || typeof b.pid !== "number" || typeof b.started_ms !== "number") return bad("give the process that was shown: pid and started_ms");
        const f = await find(b.harness, b.id);
        if (!f) return bad(`${b.harness} has no session ${b.id}`, 404);
        return json(await endHarness(f, { pid: b.pid, started_ms: b.started_ms, revision: b.revision, idle: typeof b.idle_ms === "number", deadline_ms: received + b.idle_ms }, b.jobs === "end" ? "end" : "keep"));
      },
    },
  } satisfies Record<string, Record<string, (req: Request) => Promise<Response>>>;
}

const tools = () => ["claude", "codex", "agy"].filter((t) => Bun.which(t));
const harnesses = (all: Found[]) => (["claude", "codex", "agy"] as const).map((h) => {
  const mine = all.filter((f) => f.harness === h);
  return { harness: h, label: LABEL[h], installed: existsSync(h === "claude" ? claudeRoot() : h === "agy" ? agyHome() : codexHome()), total: mine.length, interactive: mine.filter((f) => f.kind === "interactive").length };
});
