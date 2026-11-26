// The trial of a rule change on the read thread (src/server/read-tasks.ts): the stored tool calls of the last
// days, what was stored of how each went, and two replays of the rules over them (trial-rules.ts): the current
// rules, and the current rules with the change. The daemon's trial is of a settings diff and runs within BUDGET_MS;
// a developer's trial of a patch runs here in `keel safety trial`'s own process, with each side's rules loaded
// from its own copy of the source (`rules`), never in the daemon. Nothing here writes; the report names calls by
// id (trial.ts).
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { locate } from "../core/git.ts";
import { artifactsDir, contains, realOf } from "../core/paths.ts";
import { hostnameOf, isTextMark, manifestIn, remotesIn, textMark } from "./looked.ts";
import { foldersOf, type MarkMcp, type MarkTool } from "./marks.ts";
import { checkoutsOf } from "./refwatch.ts";
import { workspaceBins } from "./bins.ts";
import { isMode, type Mode, type Rule } from "./policy.ts";
import { UNREVIEWED, grantsWith, namespacesWith, storedOutcome, trialReport, type RuleChange, type Ruled, type Stored, type TrialCall, type TrialReport } from "./trial.ts";
import * as own from "./trial-rules.ts";

export type TrialAsk = {
  days: number; change?: RuleChange;
  home: string; state: string; config: string[]; path: string; shell?: string;
  tools: MarkTool[]; mcp: MarkMcp[]; runCode: string; mcpCall: string;
  // The owner's namespaces as he wrote them, the mode a session has when it has none of its own, whether the
  // sandbox can run here, and the build that runs the replay.
  namespaces: string[]; defaultMode: Mode; sandbox: boolean; rev: string;
  cap?: number; now?: number;
};
export type Rules = typeof own;
// What the caller runs the trial with, never what a request says: `rules`, each side's rules (a developer's patch
// trial, trial-rules.ts loaded from two copies of the source); `budget`: the time it may take, in ms, after which
// it stops and says how far it came; `clock` (tests).
export type TrialOpts = { rules?: { base: Rules; cand: Rules }; budget?: number; clock?: () => number };

const DAY = 86_400_000;
// The daemon's trial runs on the read thread, whose reads are ended at five minutes (src/server/reads.ts): it
// stops at two, with what it replayed by then. Seven days of a busy store (127k calls) took 44 to 79 s, so the
// daemon tries up to seven days; the command line's own trial of a patch has no deadline and goes to thirty.
export const BUDGET_MS = 120_000;
export const DAYS_MAX = 7;
export const DAYS_LOCAL = 30;
const SLICE_MS = 50;
const MEMO_MAX = 20_000;
const IMPORTED = "imported from another harness or store (its rules decided it)";

const has = (db: Database, table: string) => !!db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.n;
const cols = (db: Database, table: string) => new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name));

// The disk's lasting answers (git remotes, manifests, ssh names), asked once a trial.
async function answer(key: string): Promise<unknown> {
  const [kind, arg = ""] = key.split("\0");
  if (kind === "remotes") return remotesIn(arg);
  if (kind === "manifest") return manifestIn(arg);
  if (kind === "ssh") return hostnameOf(arg);
  return "late";
}

// A file a stored decision read, read again now: its text where it hashes as the record says.
async function textNow(file: string, cache: Map<string, { text: string; sha256: string } | null>) {
  if (!cache.has(file)) {
    let got: { text: string; sha256: string } | null = null;
    try { const f = Bun.file(file); if (f.size <= 262_144) { const text = await f.text(); got = { text, sha256: textMark(text).sha256 }; } } catch {}
    cache.set(file, got);
  }
  return cache.get(file)!;
}

export async function trialRead(db: Database, a: TrialAsk, o: TrialOpts = {}): Promise<TrialReport> {
  const clock = o.clock ?? (() => performance.now());
  const t0 = clock();
  const over = () => o.budget !== undefined && clock() - t0 > o.budget;
  const days = Math.min(Math.max(Math.round(a.days) || 7, 1), o.rules ? DAYS_LOCAL : DAYS_MAX);
  const now = a.now ?? Date.now();
  const since = now - days * DAY;
  const base: Rules = o.rules?.base ?? own;
  const cand: Rules = o.rules?.cand ?? base;
  const changed = !!o.rules || !!a.change;

  const sc = cols(db, "sessions");
  const parentCol = sc.has("parent_id"), machineCol = sc.has("machine");
  const sessions = db.query<{ id: string; workspace: string; parent_id: string | null; machine: string | null }, [number]>(
    `SELECT id, workspace, ${parentCol ? "parent_id" : "NULL AS parent_id"}, ${machineCol ? "machine" : "NULL AS machine"} FROM sessions WHERE updated > ?${sc.has("outside") ? " AND outside IS NULL" : ""} ORDER BY updated DESC`).all(since);
  const parents = new Map(parentCol ? db.query<{ id: string; parent_id: string }, []>("SELECT id, parent_id FROM sessions WHERE parent_id IS NOT NULL").all().map((r) => [r.id, r.parent_id]) : []);
  const treeRoot = (id: string) => { let at = id; for (let n = 0; n < 64 && parents.has(at); n++) at = parents.get(at)!; return at; };
  const perms = new Map(has(db, "perm_sessions") ? db.query<{ session_id: string; mode: string; sandbox: string }, []>("SELECT session_id, mode, sandbox FROM perm_sessions").all().map((r) => [r.session_id, r]) : []);
  const pins = new Map(has(db, "session_roots") ? db.query<{ session_id: string; workspace: string; real: string }, []>("SELECT session_id, workspace, real FROM session_roots").all().map((r) => [`${r.session_id}\0${r.workspace}`, r.real]) : []);
  const allRules = has(db, "perm_rules") ? db.query<Rule, []>("SELECT * FROM perm_rules ORDER BY created").all() : [];
  const candRules = grantsWith(allRules, a.change);
  const names = a.namespaces, candNames = namespacesWith(a.namespaces, a.change);

  // How each call went, beyond its result: a card opened for it, a review settled it without the owner.
  const carded = new Set(has(db, "approvals") ? db.query<{ call: string | null }, [number]>("SELECT data ->> '$.call_id' AS call FROM approvals WHERE created > ?").all(since - DAY).map((r) => r.call ?? "") : []);
  const reviewed = new Set<string>();
  // When this store began to keep a row for a review without the owner: a call before it has none to find.
  const reviewsFrom = has(db, "activity") ? db.query<{ ts: number | null }, [string]>("SELECT MIN(ts) AS ts FROM activity WHERE kind = 'approval' AND sub = ?").get(UNREVIEWED)?.ts ?? Infinity : Infinity;
  if (has(db, "activity")) for (const r of db.query<{ call: string | null }, [number]>("SELECT data ->> '$.call_id' AS call FROM activity WHERE kind = 'approval' AND ts > ?").all(since - DAY)) if (r.call) reviewed.add(r.call);
  if (has(db, "perm_blocked")) for (const r of db.query<{ calls: string | null }, [number]>("SELECT data -> '$.calls' AS calls FROM perm_blocked WHERE created > ?").all(since - DAY)) {
    try { for (const c of JSON.parse(r.calls ?? "[]") as string[]) reviewed.add(c); } catch {}
  }

  const common: own.CommonFacts = {
    home: a.home, state: realOf(a.state), config: a.config, bins: (root) => workspaceBins(a.path, root), shell: a.shell,
    tools: new Map(a.tools.map((t) => [t.name, t])), mcp: a.mcp, runCode: a.runCode, mcpCall: a.mcpCall,
  };
  // An agent's worktree (gate.ts sharedOf): the newest row of the session's, as git reads its checkouts now.
  const worktree = has(db, "worktrees") ? db.query<{ path: string; branch: string; base: string }, [string, string]>(
    "SELECT path, branch, base FROM worktrees WHERE session_id = ?1 OR ?2 = path OR substr(?2, 1, length(path) + 1) = path || '/' ORDER BY state = 'active' DESC, session_id = ?1 DESC, length(path) DESC LIMIT 1") : undefined;
  const sharedOf = (id: string, workspace: string) => {
    const row = worktree?.get(id, workspace);
    if (!row) return undefined;
    const base = /^[0-9a-f]{7,64}$/.test(row.base) || row.base === "HEAD" ? null : row.base.replace(/^refs\/heads\//, "");
    try { return checkoutsOf(row.path, row.branch, base); } catch { return undefined; }
  };
  const scopes = new Map<string, string>();
  const scopeOf = (w: string) => {
    let s = scopes.get(w);
    if (s === undefined) { const out = locate(w)?.common ?? ""; s = out ? (out.endsWith("/.git") ? out.slice(0, -5) : out) : w; scopes.set(w, s); }
    return s;
  };
  const lastingNow = new Map<string, unknown>();
  const texts = new Map<string, { text: string; sha256: string } | null>();
  const skipped: Record<string, number> = {};
  const calls: TrialCall[] = [];
  const uses = db.query<{ id: string; ts: number; data: string }, [string, number]>("SELECT id, ts, data FROM events WHERE session_id = ? AND kind = 'assistant' AND ts > ?");
  const results = db.query<{ call: string | null; err: number | null; verdict: string | null; ruled: string | null; denial: string | null }, [string, number]>(
    `SELECT j.value ->> 'tool_use_id' AS call, j.value ->> 'is_error' AS err, e.data ->> '$.verdict' AS verdict, e.data -> '$.ruled' AS ruled,
       CASE WHEN e.data ->> '$.verdict' = 'denied' THEN substr(j.value ->> 'content', 1, 160) END AS denial
     FROM events e, json_each(e.data, '$.results') j WHERE e.session_id = ? AND e.kind = 'tool_result' AND e.ts > ?`);

  // The thread's other reads go on beside a long trial: it gives way between sessions every SLICE_MS.
  // (The newest sessions first: a trial stopped at its budget has replayed the latest calls.)
  let slice = performance.now();
  let done = 0, stopped = false;
  outer: for (const s of sessions) {
    if (over()) { stopped = true; break; }
    if (performance.now() - slice > SLICE_MS) { await new Promise((r) => setTimeout(r, 0)); slice = performance.now(); }
    const p = perms.get(s.id);
    const modeNow: Mode = p && isMode(p.mode) ? p.mode : a.defaultMode;
    const machine = !!s.machine;
    const root = treeRoot(s.id);
    const facts: own.SessionFacts = {
      id: s.id, workspace: s.workspace, agent: !!s.parent_id, machine, mode: modeNow,
      sandboxed: !!p && p.sandbox !== "off" && a.sandbox,
      scope: { workspace: machine ? realOf(s.workspace) : pins.get(`${s.id}\0${s.workspace}`) ?? realOf(s.workspace), scratch: machine ? [] : [realOf(artifactsDir(a.state, root))] },
      folders: machine ? new Map() : foldersOf(join(a.state, "spill", s.id, "jobs")),
      ...(s.parent_id && !machine ? { shared: sharedOf(s.id, s.workspace) } : {}),
    };
    // The standing rules that held for this session (gate.ts rules), and when each was made.
    const holds = (r: Rule) => r.lifetime === "session"
      ? !!r.session_id && (r.session_id === s.id || (r.scope === scopeOf(s.workspace) && treeRoot(r.session_id) === root))
      : contains(r.scope, s.workspace) || contains(r.scope, scopeOf(s.workspace));
    const mine = allRules.filter(holds), candMine = candRules.filter(holds);
    const out = new Map<string, Stored>();
    const memo = new Map<string, own.Replayed>();
    for (const r of results.all(s.id, since)) {
      if (!r.call) continue;
      let ruled: Ruled | undefined;
      if (r.ruled) try { ruled = JSON.parse(r.ruled) as Ruled; } catch {}
      out.set(r.call, { verdict: r.verdict ?? undefined, ok: !r.err, card: carded.has(r.call), reviewed: reviewed.has(r.call), ...(r.denial ? { denial: r.denial } : {}), ...(ruled ? { ruled } : {}) });
    }
    for (const e of uses.all(s.id, since)) {
      let blocks: any[] = [], imported = false;
      try { const d = JSON.parse(e.data); blocks = d?.blocks ?? []; imported = !!d?.imported; } catch {}
      for (const b of blocks) {
        if (b?.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
        // (A call imported from another harness or store ran under that harness's rules, not these.)
        if (imported) { skipped[IMPORTED] = (skipped[IMPORTED] ?? 0) + 1; continue; }
        const st = out.get(b.id);
        // (A call with no stored result is one a stop or a restart cut: nothing is known of how it went.)
        if (!st) continue;
        if (over()) { stopped = true; break outer; }
        const ruled = st.ruled;
        const mode = ruled?.mode && isMode(ruled.mode) ? ruled.mode : modeNow;
        const u: own.ReplayCall = { id: b.id, name: b.name, input: b.input ?? {}, ruled };
        // The files its decision read, where they still hash as then; one that changed since stays not answered.
        const read: [string, string][] = [];
        let fileChanged = false;
        if (!machine) for (const [k, v] of ruled?.looked ?? []) {
          if (!isTextMark(v) || !k.startsWith("read\0")) continue;
          const t = await textNow(k.slice(5), texts);
          if (t && t.sha256 === v.sha256) read.push([k, t.text]); else fileChanged = true;
        }
        const then = (rs: Rule[]) => rs.filter((r) => r.created <= e.ts);
        // (A call made again as it was, in the same folder with the same facts, is decided as it was: a session runs
        // `git status` many times.)
        const same = `${b.name}\0${facts.folders.get(b.id) ?? ""}\0${JSON.stringify(b.input ?? {})}\0${ruled ? JSON.stringify([ruled.looked, ruled.real, ruled.named]) : ""}`;
        // (Keyed by the side: with no patch both sides run the same rules, with other facts.)
        const replay = async (side: "cur" | "cand", R: Rules, rules: Rule[], ns: string[], m: Mode) => {
          const key = `${side}\0${m}\0${rules.map((x) => x.id).join(",")}\0${same}`;
          const had = memo.get(key);
          if (had) return had;
          let r = R.replayCall(u, facts, common, { mode: m, namespaces: ns, rules, now: lastingNow, texts: read });
          const ask = R.lastingOf(r.missed).filter((k) => !lastingNow.has(k));
          if (ask.length && !machine) {
            for (const k of ask) lastingNow.set(k, await answer(k));
            r = R.replayCall(u, facts, common, { mode: m, namespaces: ns, rules, now: lastingNow, texts: read });
          }
          if (memo.size >= MEMO_MAX) memo.clear();
          memo.set(key, r);
          return r;
        };
        const cur = await replay("cur", base, then(mine), names, mode);
        // (A grant the change makes stood from the first call on: it was made at 0.)
        const next = changed ? await replay("cand", cand, then(candMine), candNames, a.change?.mode ?? mode) : cur;
        const missed = cur.missed.filter((k) => !lastingNow.has(k));
        calls.push({
          id: b.id, session: s.id, event: e.id, tool: b.name, kind: cur.kind, ts: e.ts, ok: st.verdict === undefined && st.ok,
          stored: storedOutcome(st), current: cur.judged, candidate: next.judged,
          ...(missed.length ? { asked: true as const } : {}), ...(fileChanged && missed.some((k) => k.startsWith("read\0")) ? { fileChanged: true as const } : {}), ...(cur.shims ? { shims: true as const } : {}),
          ...(!ruled && mode === "full-auto" && e.ts < reviewsFrom ? { unkept: true as const } : {}), ...(facts.shared ? { guard: true as const } : {}),
          ...(ruled?.rev && ruled.rev !== a.rev ? { rev: ruled.rev } : {}), ...(ruled?.mode ? { mode: ruled.mode } : {}), modeNow,
        });
      }
    }
    done++;
  }
  return trialReport(calls, {
    days, since, ms: Math.round(clock() - t0), cap: a.cap, skipped,
    ...(stopped ? { partial: { budgetMs: o.budget!, sessions: done, of: sessions.length } } : {}),
  });
}
