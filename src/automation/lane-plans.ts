// A plan of lanes, checked before any agent starts. A coordinator (keel__lane_plan) or the owner (the
// Lane plan panel) sends a list of lanes, each a brief and the files or folders it will touch; Keel
// reads the repository's tree at the base the lanes' worktrees are made from, says the files each
// lane will touch (declared, named by its brief, and their importers: src/landing/lanes.ts predict),
// marks the pairs that meet in a file, and proposes an order, or lanes to merge, that keeps them
// apart. Nothing starts until the owner or the coordinator starts all of it, some of it, or the
// proposed order.
//
// In the proposed order a unit of the first wave starts at once; a later one is owed its start and
// starts by itself when each unit it waits on is done: its agent ended and the base holds its work
// (git: its head is in the base, or the base has every patch of it). Its worktree is then made from
// a base that holds what the earlier lane changed, so the two do not meet again at landing. The
// owner can start a waiting lane at once. The owed starts are rows: a restart starts them later the
// same way. A plan starts nothing while its session is held (the owner's Stop of the coordinator, or
// of a session above it): its owed starts go on when the hold ends. A lane whose start failed is
// marked failed with the reason, and one that waits on a lane that will not land by itself (it failed,
// was stopped, never started, or ended with work not on the base) is marked blocked by it; the plan's
// session is told each once (src/automation/failures.ts), and the owner can start either at once.
// A plan is made on a named branch: the lanes land on it, and its tip is what an owed start waits on.
//
// Afterwards each lane's changed files are compared with its plan (on the panel), and a lane whose
// commits change a file the plan gave another lane is told once a file, as a note in its next model
// request (as the overlap forecast tells: src/server/routes/overlaps.ts), never as a turn of its own.
import { dirname } from "node:path";
import { git, locate } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import { compare, listOf, meetings, predict, propose, strays, type LaneFile, type LaneSpec, type Meeting, type Proposal } from "../landing/lanes.ts";
import { repoMap } from "../landing/repo-map.ts";
import * as agents from "./agents.ts";
import { heldWhy } from "./core.ts";
import * as failures from "./failures.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lane_plans (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, repo TEXT NOT NULL, top TEXT NOT NULL,
  base TEXT NOT NULL, base_tip TEXT NOT NULL, created INTEGER NOT NULL, by TEXT NOT NULL, meetings TEXT NOT NULL, proposal TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lane_plans_session ON lane_plans(session_id, created);
CREATE TABLE IF NOT EXISTS plan_lanes (
  plan_id TEXT NOT NULL REFERENCES lane_plans(id) ON DELETE CASCADE, idx INTEGER NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
  type TEXT, declared TEXT, files TEXT NOT NULL, unresolved TEXT, state TEXT NOT NULL, waits_on TEXT, agent_id TEXT, session_id TEXT,
  started INTEGER, told TEXT, why TEXT, blocked TEXT, PRIMARY KEY (plan_id, idx)
);
CREATE INDEX IF NOT EXISTS plan_lanes_session ON plan_lanes(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plan_lanes_waiting ON plan_lanes(state) WHERE state = 'waiting';
`;

// planned: not started. waiting: the proposed order owes it a start once the lanes it waits on are
// done. started: an agent works it (the first lane of a merged unit, and the others of the unit with
// the same agent). failed: its agent could not be started (`why`); it can be started again.
export type LaneState = "planned" | "waiting" | "started" | "failed";
// What a waiting lane waits on that will not land by itself: the lane, and what became of it.
export type Blocker = { lane: number; why: string; ended: boolean };
type PlanRow = { id: string; session_id: string; repo: string; top: string; base: string; base_tip: string; created: number; by: string; meetings: string; proposal: string };
type LaneRow = { plan_id: string; idx: number; title: string; brief: string; type: string | null; declared: string | null; files: string; unresolved: string | null; state: LaneState; waits_on: string | null; agent_id: string | null; session_id: string | null; started: number | null; told: string | null; why: string | null; blocked: string | null };

export type LaneIn = LaneSpec & { type?: string };
export type LaneView = {
  idx: number; title: string; brief: string; type: string | null; declared: string[]; files: LaneFile[]; unresolved: string[];
  state: LaneState; unit: number; wave: number; after: number[]; waits_on: number[]; merged_with: number[];
  agent: { id: string; title: string; status: string; session_id: string; branch: string | null; landed: boolean | null } | null; started: number | null;
  // What its branch changed since it left the base, against its plan, and the files of other lanes among them.
  changed: { files: string[]; hit: string[]; missed: string[]; unplanned: string[]; strays: { file: string; lanes: number[] }[] } | null;
  told: string[];
  // failed: why its start failed. blocked: a waiting lane's predecessor that will not land by itself.
  why: string | null; blocked: Blocker | null;
};
// held: why nothing of the plan starts now (its session, or one above it, is held).
export type PlanView = { id: string; session_id: string; repo: string; base: string; base_tip: string; created: number; by: string; lanes: LaneView[]; meetings: Meeting[]; proposal: Proposal; hubs: string[]; held: string | null };

export type LanePlanDeps = {
  error: (e: unknown, at: string) => void;
  changed: (sessionId: string, planId: string) => void;
  // Tells the plan's session what it must act on, once: "wake" starts a turn for it, "ride" goes with its next input.
  tell?: (sessionId: string, cls: string, message: string, how: "wake" | "ride") => void;
  // Why the plan's session may start nothing now, if it may not: its queue is held, or the owner holds a session above it.
  held?: (sessionId: string) => string | undefined;
  agents?: Pick<typeof agents, "spawn" | "get">;
};

// The plan's session held, or one above it held by the owner (a stop goes down the tree, but a lane
// that waits has no agent to stop yet).
export function heldOf(store: Pick<Store, "session">, sessionId: string): string | undefined {
  if (agents.isHeld(sessionId)) return heldWhy(sessionId);
  let id = store.session(sessionId)?.parent_id;
  for (let n = 0; id && n < 64; n++, id = store.session(id)?.parent_id) if (agents.ownerHolds(id)) return "the owner stopped a session above this one";
  return undefined;
}

// A plan holds at most this many lanes: a session's agent slots hold far fewer at once (agent-tree.ts),
// and a plan past this is not one a person reads before it starts.
export const MAX_LANES = 24;
const BRIEF_MAX = 40_000;
// How often the owed starts of a waiting lane are looked at, while one waits, besides the moments an
// agent of a plan changes state or a landing queue moves: a base the owner moved by hand is seen
// within this.
const LOOK_MS = 15_000;
const ENDED = new Set(["completed", "incomplete", "failed", "stopped"]);
const newId = () => `lp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Stand = "done" | "pending" | { why: string; ended: boolean };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const parse = <T>(s: string | null, d: T): T => { if (!s) return d; try { return JSON.parse(s) as T; } catch { return d; } };

export class LanePlans {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private looking: Promise<void> | undefined;
  private again = false;
  private bySession = new Map<string, { plan: string; idx: number }>();
  private changes = new Map<string, string[] | null>(); // `${repo}\0${tip}\0${baseTip}`
  private owed = new Map<string, { plan: string; idx: number; files: string[]; lines: string[] }>(); // a lane's session: its stray note
  private heldOn = new Set<string>(); // plan sessions whose owed starts a hold keeps
  private planSessions = new Set<string>(); // sessions with a plan: their holds change what a panel shows
  private lastHeld = new Map<string, boolean>();
  private ag: Pick<typeof agents, "spawn" | "get">;
  private held: (sessionId: string) => string | undefined;
  private tell: NonNullable<LanePlanDeps["tell"]>;

  constructor(private store: Store, private d: LanePlanDeps) {
    store.migrate(SCHEMA);
    this.ag = d.agents ?? agents;
    this.held = d.held ?? ((id) => heldOf(store, id));
    this.tell = d.tell ?? ((sessionId, cls, message, how) => {
      if (failures.record(sessionId, { kind: "plan", cls, message, tell: how }) && how === "wake") failures.wake(sessionId);
    });
    this.claimsCut();
    for (const r of store.db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM lane_plans").all()) this.planSessions.add(r.session_id);
    for (const r of store.db.query<{ plan_id: string; idx: number; session_id: string }, []>("SELECT plan_id, idx, session_id FROM plan_lanes WHERE session_id IS NOT NULL").all()) this.bySession.set(r.session_id, { plan: r.plan_id, idx: r.idx });
    if (this.waitingCount()) this.schedule(5_000);
  }

  // A start a restart cut between its claim and its agent: the agent it made, if it made one (its
  // parent's agent made since the claim, titled as the unit's lanes joined: launch), else the lanes
  // are not started. A merged unit's lanes are one start: they all get that agent or all start again.
  private claimsCut() {
    const cut = this.store.db.query<{ plan_id: string; idx: number; started: number | null; session: string; title: string; proposal: string | null }, []>(
      "SELECT l.plan_id, l.idx, l.started, p.session_id AS session, l.title, p.proposal FROM plan_lanes l JOIN lane_plans p ON p.id = l.plan_id WHERE l.state = 'started' AND l.agent_id IS NULL ORDER BY l.plan_id, l.idx").all();
    const units = new Map<string, typeof cut>();
    for (const r of cut) {
      const k = parse<Proposal>(r.proposal, { units: [], waves: 0 }).units.findIndex((u) => u.lanes.includes(r.idx));
      const key = `${r.plan_id}\0${k < 0 ? `lane${r.idx}` : k}`;
      (units.get(key) ?? units.set(key, []).get(key)!).push(r);
    }
    for (const ls of units.values()) {
      const first = ls[0]!;
      const order = parse<Proposal>(first.proposal, { units: [], waves: 0 }).units.find((u) => u.lanes.includes(first.idx))?.lanes ?? [];
      const ranked = [...ls].sort((a, b) => order.indexOf(a.idx) - order.indexOf(b.idx));
      // The title launch gave the agent: the lanes it started, joined.
      const joined = ranked.map((r) => r.title).join(" + ").slice(0, 120);
      let made: { id: string; session_id: string } | null = null;
      try {
        made = this.store.db.query<{ id: string; session_id: string }, [string, number]>("SELECT id, session_id FROM agents WHERE parent_id = ? AND created >= ? AND id NOT IN (SELECT agent_id FROM plan_lanes WHERE agent_id IS NOT NULL) ORDER BY created LIMIT 50")
          .all(first.session, Math.min(...ls.map((r) => r.started ?? 0))).find((a) => this.ag.get(a.id)?.title.startsWith(joined.slice(0, 60))) ?? null;
      } catch { /* no agents table: no agent was made */ }
      for (const r of ls) {
        if (made) this.store.db.query("UPDATE plan_lanes SET agent_id = ?, session_id = ? WHERE plan_id = ? AND idx = ?").run(made.id, made.session_id, r.plan_id, r.idx);
        else this.store.db.query("UPDATE plan_lanes SET state = 'planned', started = NULL WHERE plan_id = ? AND idx = ?").run(r.plan_id, r.idx);
      }
    }
  }

  // ---- making a plan

  async make(sessionId: string, lanes: readonly LaneIn[], by: "owner" | "session"): Promise<PlanView> {
    const s = this.store.session(sessionId);
    if (!s) throw Object.assign(new Error("no such session"), { status: 404 });
    if (!Array.isArray(lanes) || lanes.length < 2) throw Object.assign(new Error("a plan has two lanes or more: one lane is one agent"), { status: 400 });
    if (lanes.length > MAX_LANES) throw Object.assign(new Error(`a plan holds at most ${MAX_LANES} lanes`), { status: 400 });
    const clean: LaneIn[] = lanes.map((l, i) => {
      const title = typeof l?.title === "string" ? l.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      const brief = typeof l?.brief === "string" ? l.brief.trim().slice(0, BRIEF_MAX) : "";
      if (!brief) throw Object.assign(new Error(`lane ${i + 1} has no brief`), { status: 400 });
      const files = Array.isArray(l.files) ? (l.files as unknown[]).filter((f): f is string => typeof f === "string" && !!f.trim()).map((f) => f.trim()).slice(0, 200) : [];
      if (files.some((f) => f.startsWith("/") || f.split("/").includes(".."))) throw Object.assign(new Error(`lane ${i + 1}: files are paths inside the repository (relative, no ..)`), { status: 400 });
      return { title: title || brief.split("\n")[0]!.slice(0, 80), brief, files, ...(typeof l.type === "string" && l.type.trim() ? { type: l.type.trim() } : {}) };
    });
    const at = locate(s.workspace);
    if (!at?.top) throw Object.assign(new Error("the session's folder is not in a git repository: lanes get worktrees of one"), { status: 400 });
    const top = at.top, repo = at.common.endsWith("/.git") ? dirname(at.common) : top;
    const head = await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { read: true });
    const tip = (await git(top, ["rev-parse", "--verify", "HEAD^{commit}"], { read: true })).out.trim();
    if (!/^[0-9a-f]{40}$/.test(tip)) throw Object.assign(new Error("the repository has no commit to plan on"), { status: 400 });
    // On a named branch only: the lanes land on it, and an owed start waits for its tip to hold their work.
    if (head.code !== 0 || !head.out.trim()) throw Object.assign(new Error(`HEAD is detached at ${tip.slice(0, 9)}: a plan is made on a named branch, the one its lanes land on (git switch to it first)`), { status: 400 });
    const base = head.out.trim();
    const map = await repoMap(repo, tip);
    const preds = clean.map((l) => predict(l, map, { roots: [...new Set([top, repo, s.workspace])] }));
    const ms = meetings(preds, map.hubs);
    const proposal = propose(preds, ms);
    const id = newId();
    this.store.db.transaction(() => {
      this.store.db.query("INSERT INTO lane_plans (id, session_id, repo, top, base, base_tip, created, by, meetings, proposal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, sessionId, repo, top, base, tip, Date.now(), by, JSON.stringify(ms), JSON.stringify(proposal));
      clean.forEach((l, i) => this.store.db.query("INSERT INTO plan_lanes (plan_id, idx, title, brief, type, declared, files, unresolved, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned')")
        .run(id, i, l.title, l.brief, l.type ?? null, JSON.stringify(l.files ?? []), JSON.stringify(preds[i]!.files), JSON.stringify(preds[i]!.unresolved)));
    })();
    this.planSessions.add(sessionId);
    this.d.changed(sessionId, id);
    return (await this.view(id))!;
  }

  remove(id: string): boolean {
    const p = this.planRow(id);
    if (!p) return false;
    this.store.db.query("DELETE FROM plan_lanes WHERE plan_id = ? AND state != 'started'").run(id);
    if (!this.lanes(id).length) this.store.db.query("DELETE FROM lane_plans WHERE id = ?").run(id);
    this.d.changed(p.session_id, id);
    return true;
  }

  // ---- reading

  private planRow = (id: string) => this.store.db.query<PlanRow, [string]>("SELECT * FROM lane_plans WHERE id = ?").get(id);
  private lanes = (id: string) => this.store.db.query<LaneRow, [string]>("SELECT * FROM plan_lanes WHERE plan_id = ? ORDER BY idx").all(id);
  private waitingCount = () => this.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plan_lanes WHERE state = 'waiting'").get()?.n ?? 0;

  ids(sessionId: string, max = 8): string[] {
    return this.store.db.query<{ id: string }, [string, number]>("SELECT id FROM lane_plans WHERE session_id = ? ORDER BY created DESC LIMIT ?").all(sessionId, max).map((r) => r.id);
  }
  owns = (sessionId: string, planId: string) => this.planRow(planId)?.session_id === sessionId;
  sessionOf = (planId: string) => this.planRow(planId)?.session_id;
  // The lane an agent's session works, when it works one.
  laneOf = (sessionId: string) => this.bySession.get(sessionId);
  // The same, after the starts under way: an agent's first call can end before its start returned.
  async laneSoon(sessionId: string) {
    if (!this.bySession.has(sessionId) && this.inflight.size) await Promise.allSettled([...this.inflight]);
    return this.bySession.get(sessionId);
  }
  private inflight = new Set<Promise<unknown>>();

  async view(id: string): Promise<PlanView | undefined> {
    const p = this.planRow(id);
    if (!p) return undefined;
    const rows = this.lanes(id);
    const proposal = parse<Proposal>(p.proposal, { units: [], waves: 0 });
    const unitOf = new Map<number, number>();
    proposal.units.forEach((u, k) => u.lanes.forEach((i) => unitOf.set(i, k)));
    const baseTip = await this.baseTip(p);
    const views: LaneView[] = [];
    for (const r of rows) {
      const k = unitOf.get(r.idx) ?? 0, u = proposal.units[k];
      const a = r.agent_id ? this.ag.get(r.agent_id) : undefined;
      const files = parse<LaneFile[]>(r.files, []);
      let changed: LaneView["changed"] = null;
      if (a?.branch && baseTip) {
        const got = await this.changedOf(p.repo, a.branch, baseTip, a.session_id);
        if (got) {
          const c = compare(files, got);
          const s = strays(files, got, rows.filter((o) => o.idx !== r.idx && !(o.agent_id && o.agent_id === r.agent_id)).map((o) => ({ lane: String(o.idx), files: parse<LaneFile[]>(o.files, []) })));
          changed = { files: got, ...c, strays: s.map((x) => ({ file: x.file, lanes: x.lanes.map(Number) })) };
        }
      }
      views.push({
        idx: r.idx, title: r.title, brief: r.brief, type: r.type, declared: parse<string[]>(r.declared, []), files, unresolved: parse<string[]>(r.unresolved, []),
        state: r.state, unit: k, wave: u?.wave ?? 0, after: (u?.after ?? []).flatMap((x) => proposal.units[x]?.lanes ?? []), waits_on: parse<number[]>(r.waits_on, []),
        merged_with: (u?.lanes ?? []).filter((i) => i !== r.idx),
        agent: a ? { id: a.id, title: a.title, status: a.status, session_id: a.session_id, branch: a.branch ?? null, landed: a.branch && baseTip && ENDED.has(a.status) ? await this.landed(p.repo, a.branch, baseTip) : null } : null, started: r.started,
        changed, told: parse<string[]>(r.told, []), why: r.why, blocked: r.state === "waiting" ? parse<Blocker | null>(r.blocked, null) : null,
      });
    }
    const ms = parse<Meeting[]>(p.meetings, []);
    const map = await repoMap(p.repo, p.base_tip).catch(() => undefined);
    const hubs = map ? [...new Set(views.flatMap((v) => v.files.map((f) => f.path)).filter((f) => map.hubs.has(f)))].sort() : [];
    return { id: p.id, session_id: p.session_id, repo: p.repo, base: p.base, base_tip: p.base_tip, created: p.created, by: p.by, lanes: views, meetings: ms, proposal, hubs, held: this.held(p.session_id) ?? null };
  }

  // ---- starting

  // `order`: the proposal (its first wave now, the rest owed); `all`: every lane not started, each its
  // own agent, now; a list: those lanes, each its own agent, now (a waiting one too).
  // `by`: who pressed. A failed start is told to the plan's session unless its own call asked for it
  // (the call's result says so).
  async start(id: string, how: "order" | "all" | number[], by: "owner" | "session" = "session"): Promise<{ started: number[]; waiting: number[]; failed: { idx: number; why: string }[] }> {
    const p = this.planRow(id);
    if (!p) throw Object.assign(new Error("no such plan"), { status: 404 });
    const held = this.held(p.session_id);
    if (held) throw Object.assign(new Error(`Nothing of the plan starts while its session is held (${held}): resume it first.`), { status: 409 });
    const rows = this.lanes(id);
    const out = { started: [] as number[], waiting: [] as number[], failed: [] as { idx: number; why: string }[] };
    const fresh = (r: LaneRow) => r.state === "planned" || r.state === "failed";
    const open = (r: LaneRow) => fresh(r) || (Array.isArray(how) && r.state === "waiting");
    const tell = by === "owner";
    if (how === "order") {
      const proposal = parse<Proposal>(p.proposal, { units: [], waves: 0 });
      for (const u of proposal.units) {
        const ls = u.lanes.map((i) => rows.find((r) => r.idx === i)).filter((r): r is LaneRow => !!r && fresh(r));
        if (!ls.length) continue;
        const waits = u.after.flatMap((x) => proposal.units[x]?.lanes ?? []);
        if (u.wave === 0 || !waits.length) await this.launch(p, ls, out, tell);
        else {
          for (const r of ls) this.store.db.query("UPDATE plan_lanes SET state = 'waiting', waits_on = ?, why = NULL, blocked = NULL WHERE plan_id = ? AND idx = ?").run(JSON.stringify(waits), id, r.idx);
          out.waiting.push(...ls.map((r) => r.idx));
        }
      }
    } else {
      const pick = how === "all" ? rows.filter(open) : rows.filter((r) => how.includes(r.idx) && open(r));
      if (Array.isArray(how)) for (const i of how) if (!rows.some((r) => r.idx === i)) out.failed.push({ idx: i, why: "no such lane" });
      for (const r of pick) await this.launch(p, [r], out, tell);
    }
    if (out.waiting.length) this.schedule();
    this.d.changed(p.session_id, id);
    return out;
  }

  // One agent for the lanes of a unit (one lane, or lanes proposed as one).
  // A start that fails is captured, the lanes marked failed with its reason, and (`tell`) the plan's
  // session told once.
  private async launch(p: PlanRow, ls: LaneRow[], out: { started: number[]; failed: { idx: number; why: string }[] }, tell: boolean) {
    const all = this.lanes(p.id);
    const first = ls[0]!;
    // (Claimed before the spawn awaits: a second press does not start it twice.)
    const claimed = this.store.db.query("UPDATE plan_lanes SET state = 'started', started = ?, why = NULL, blocked = NULL WHERE plan_id = ? AND idx IN (SELECT value FROM json_each(?)) AND state != 'started'").run(Date.now(), p.id, JSON.stringify(ls.map((r) => r.idx)));
    if (!claimed.changes) return;
    let done!: () => void;
    const known = new Promise<void>((r) => (done = r));
    this.inflight.add(known);
    try {
      const a = await this.ag.spawn(p.session_id, { title: ls.length > 1 ? ls.map((r) => r.title).join(" + ").slice(0, 120) : first.title, prompt: briefOf(ls, all), type: first.type ?? undefined, background: true });
      for (const r of ls) {
        this.store.db.query("UPDATE plan_lanes SET agent_id = ?, session_id = ? WHERE plan_id = ? AND idx = ?").run(a.id, a.session_id, p.id, r.idx);
        this.bySession.set(a.session_id, { plan: p.id, idx: first.idx });
      }
      out.started.push(...ls.map((r) => r.idx));
    } catch (e) {
      const why = String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 600) || "the agent could not be started";
      this.store.db.query("UPDATE plan_lanes SET state = 'failed', started = NULL, why = ? WHERE plan_id = ? AND idx IN (SELECT value FROM json_each(?))").run(why, p.id, JSON.stringify(ls.map((r) => r.idx)));
      for (const r of ls) out.failed.push({ idx: r.idx, why });
      this.d.error(e, "lane plan start");
      if (tell) {
        const which = ls.map((r) => `${r.idx + 1} "${r.title}"`).join(" and ");
        this.tell(p.session_id, "lane not started", `Lane ${which} of plan ${p.id} did not start: ${why}. Start it again with keel__lane_plan (action "start", start [${ls.map((r) => r.idx + 1).join(", ")}]) once that is fixed, or leave it.`, "wake");
      }
    } finally {
      this.inflight.delete(known);
      done();
    }
  }

  // ---- owed starts

  schedule(ms = 1_000) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.look(); }, ms);
    this.timer.unref?.();
  }
  // An agent of a plan changed state, or a landing queue moved: look at the owed starts soon.
  nudge() { if (this.waitingCount()) this.schedule(); }

  look(): Promise<void> {
    if (this.looking) { this.again = true; return this.looking; }
    this.looking = this.pass().catch((e) => this.d.error(e, "lane plan starts")).finally(() => {
      this.looking = undefined;
      if (this.again) { this.again = false; void this.look(); }
      else if (this.waitingCount()) this.schedule(LOOK_MS);
    });
    return this.looking;
  }

  private async pass() {
    const plans = this.store.db.query<{ plan_id: string }, []>("SELECT DISTINCT plan_id FROM plan_lanes WHERE state = 'waiting'").all();
    const heldNow = new Set<string>();
    for (const { plan_id } of plans) {
      const p = this.planRow(plan_id);
      if (!p) continue;
      const s = this.store.session(p.session_id);
      if (!s || s.archived) continue;
      if (this.held(p.session_id)) { heldNow.add(p.session_id); continue; }
      const rows = this.lanes(plan_id);
      const baseTip = await this.baseTip(p);
      if (!baseTip) continue;
      const stands = new Map<number, Stand>();
      const standOf = async (i: number) => stands.get(i) ?? stands.set(i, await this.stand(p, rows.find((x) => x.idx === i), baseTip)).get(i)!;
      // The units that wait, each as its lanes.
      const units = new Map<string, LaneRow[]>();
      const proposal = parse<Proposal>(p.proposal, { units: [], waves: 0 });
      for (const r of rows.filter((x) => x.state === "waiting")) {
        const k = proposal.units.findIndex((u) => u.lanes.includes(r.idx));
        (units.get(String(k)) ?? units.set(String(k), []).get(String(k))!).push(r);
      }
      let moved = false;
      for (const ls of units.values()) {
        const waits = parse<number[]>(ls[0]!.waits_on, []);
        let ready = true, blocker: Blocker | null = null;
        for (const i of waits) {
          const st = await standOf(i);
          if (st === "done") continue;
          ready = false;
          if (st !== "pending" && !blocker) blocker = { lane: i, ...st };
        }
        if (ready) {
          // (A hold made while this pass awaited git: nothing starts under it, the lanes keep waiting.)
          if (this.held(p.session_id)) { heldNow.add(p.session_id); break; }
          this.store.db.query("UPDATE plan_lanes SET state = 'planned', blocked = NULL WHERE plan_id = ? AND idx IN (SELECT value FROM json_each(?)) AND state = 'waiting'").run(plan_id, JSON.stringify(ls.map((r) => r.idx)));
          await this.launch(p, ls.map((r) => ({ ...r, state: "planned" as const })), { started: [], failed: [] }, true);
          moved = true;
          continue;
        }
        // Told once a blocker: the row keeps what was told, across restarts.
        const was = parse<Blocker | null>(ls[0]!.blocked, null);
        if (JSON.stringify(was) === JSON.stringify(blocker)) continue;
        this.store.db.query("UPDATE plan_lanes SET blocked = ? WHERE plan_id = ? AND idx IN (SELECT value FROM json_each(?))").run(blocker && JSON.stringify(blocker), plan_id, JSON.stringify(ls.map((r) => r.idx)));
        moved = true;
        if (!blocker) continue;
        const name = (i: number) => `lane ${i + 1} "${rows.find((x) => x.idx === i)?.title ?? ""}"`;
        const mine = ls.map((r) => name(r.idx)).join(" and "), nums = ls.map((r) => r.idx + 1).join(", ");
        this.tell(p.session_id, blocker.ended ? "lane waits for a branch to land" : "lane blocked",
          blocker.ended
            ? `${cap(mine)} of plan ${p.id} waits for ${name(blocker.lane)}, which ${blocker.why}: it starts by itself once that work is on ${p.base}. Land it, or start ${mine} now with keel__lane_plan (action "start", start [${nums}]).`
            : `${cap(mine)} of plan ${p.id} waits for ${name(blocker.lane)}, which ${blocker.why}: it will not start by itself. Start it now with keel__lane_plan (action "start", start [${nums}]), or start ${name(blocker.lane)} again.`,
          blocker.ended ? "ride" : "wake");
      }
      if (moved) this.d.changed(p.session_id, plan_id);
    }
    for (const id of this.heldOn) if (!heldNow.has(id)) this.heldOn.delete(id);
    for (const id of heldNow) this.heldOn.add(id);
  }

  // A session with a plan was held or released: true when that changed what its panel shows.
  heldChanged(sessionId: string, held: boolean): boolean {
    if (!this.planSessions.has(sessionId)) return false;
    const was = this.lastHeld.get(sessionId) ?? false;
    this.lastHeld.set(sessionId, held);
    return was !== held;
  }

  // A hold ended somewhere: a plan it kept may go on.
  released() { if (this.heldOn.size) this.schedule(); }

  // Where a lane a waiting lane waits on stands. done: its agent ended and the base holds its work
  // (one that failed or was stopped counts done only when work of its own landed). pending: it waits
  // or works. Else what became of it: a blocker; `ended` when it ended with work not on the base yet.
  private async stand(p: PlanRow, r: LaneRow | undefined, baseTip: string): Promise<Stand> {
    if (!r) return "done";
    if (r.state === "waiting") return "pending";
    if (r.state === "planned") return { why: "was not started", ended: false };
    if (r.state === "failed") return { why: `did not start (${r.why ?? "its start failed"})`, ended: false };
    if (!r.agent_id) return "pending"; // its start is under way
    const a = this.ag.get(r.agent_id);
    if (!a) return "done";
    if (!ENDED.has(a.status)) return "pending";
    if (!a.branch) return a.status === "completed" ? "done" : { why: a.status === "stopped" ? "was stopped" : `ended ${a.status}`, ended: false };
    const landed = await this.landed(p.repo, a.branch, baseTip);
    if (a.status === "completed") return landed ? "done" : { why: `ended with work not on ${p.base}`, ended: true };
    if (landed && (await this.ownWork(p.repo, a.branch, a.session_id))) return "done";
    return { why: a.status === "stopped" ? "was stopped" : `ended ${a.status}`, ended: false };
  }

  // Whether a branch has commits of its own: its head moved from where its worktree was made.
  private async ownWork(repo: string, branch: string, sessionId: string): Promise<boolean> {
    const tip = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { read: true })).out.trim();
    if (!tip) return false;
    const made = this.store.db.query<{ base_commit: string }, [string]>("SELECT base_commit FROM worktrees WHERE session_id = ?").get(sessionId)?.base_commit;
    return !made || made !== tip;
  }

  // The base holds a branch's work: its head is in the base, or every patch of it is (git cherry).
  private async landed(repo: string, branch: string, baseTip: string): Promise<boolean> {
    const tip = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { read: true })).out.trim();
    if (!tip) return true; // its branch went with its worktree: nothing of it was left to land (src/automation/leftovers.ts)
    if ((await git(repo, ["merge-base", "--is-ancestor", tip, baseTip], { read: true })).code === 0) return true;
    const c = await git(repo, ["cherry", baseTip, tip], { read: true });
    return c.code === 0 && !c.out.split("\n").some((l) => l.startsWith("+"));
  }

  private async baseTip(p: PlanRow): Promise<string | undefined> {
    const r = await git(p.repo, ["rev-parse", "-q", "--verify", `${p.base}^{commit}`], { read: true });
    const t = r.out.trim();
    return /^[0-9a-f]{40}$/.test(t) ? t : undefined;
  }

  // The files a branch changed since it left the base, kept by its head and the base's. A branch the
  // base holds whole is read from the commit its worktree was made from (its session's worktree row):
  // its merge base with the base is its head then, and says nothing of what it changed.
  private async changedOf(repo: string, branch: string, baseTip: string, sessionId?: string | null): Promise<string[] | null> {
    const tip = (await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], { read: true })).out.trim();
    if (!tip) return null;
    const key = `${repo}\0${tip}\0${baseTip}`;
    if (this.changes.has(key)) return this.changes.get(key)!;
    let from = (await git(repo, ["merge-base", baseTip, tip], { read: true })).out.trim();
    if (from === tip && sessionId) {
      const made = this.store.db.query<{ base_commit: string }, [string]>("SELECT base_commit FROM worktrees WHERE session_id = ?").get(sessionId)?.base_commit;
      if (made && (await git(repo, ["merge-base", "--is-ancestor", made, tip], { read: true })).code === 0) from = made;
    }
    let files: string[] | null = null;
    if (from) {
      const d = await git(repo, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", from, tip], { read: true });
      if (d.code === 0) files = d.out.split("\0").filter(Boolean);
    }
    if (this.changes.size > 2048) this.changes.clear();
    this.changes.set(key, files);
    return files;
  }

  // ---- strays

  // A lane's session moved its branch: what it changed that the plan gave another lane, not told yet,
  // is owed to it as one note.
  async moved(sessionId: string) {
    const at = this.bySession.get(sessionId);
    if (!at) return;
    const p = this.planRow(at.plan);
    if (!p) return;
    const rows = this.lanes(at.plan);
    const me = rows.find((r) => r.idx === at.idx);
    if (!me?.agent_id) return;
    const a = this.ag.get(me.agent_id);
    const baseTip = await this.baseTip(p);
    if (!a?.branch || !baseTip) return;
    const got = await this.changedOf(p.repo, a.branch, baseTip, a.session_id);
    if (!got) return;
    const mine = rows.filter((r) => r.agent_id === me.agent_id);
    const own = mine.flatMap((r) => parse<LaneFile[]>(r.files, []));
    const told = new Set(parse<string[]>(me.told, []));
    const was = this.owed.get(sessionId);
    for (const f of was?.files ?? []) told.add(f);
    const s = strays(own, got, rows.filter((r) => r.agent_id !== me.agent_id).map((r) => ({ lane: String(r.idx), files: parse<LaneFile[]>(r.files, []) })), told);
    if (!s.length) return;
    const name = (i: number) => { const r = rows.find((x) => x.idx === i); return `lane ${i + 1} "${r?.title ?? ""}"`; };
    const files = [...(was?.files ?? []), ...s.map((x) => x.file)];
    const lines = [...(was?.lines ?? []), ...s.map((x) => `- ${x.file}: the plan gives it to ${x.lanes.map(Number).map(name).join(" and ")}`)];
    this.owed.set(sessionId, { plan: p.id, idx: at.idx, files, lines });
  }

  // The note a lane's session is owed, and how to mark it told (in the write that stores the note).
  noteFor(sessionId: string): { text: string; files: string[]; settle: () => void } | undefined {
    const o = this.owed.get(sessionId);
    if (!o) return undefined;
    const text = `[harness] Your commits change files the plan of lanes gave another lane (plan ${o.plan}):\n${o.lines.join("\n")}\nKeep to your lane's files where you can. If your work needs these, keep the change small and say so in your report, so the lanes land in an order that works.`;
    return {
      text, files: o.files,
      settle: () => {
        this.owed.delete(sessionId);
        const r = this.store.db.query<{ told: string | null }, [string, number]>("SELECT told FROM plan_lanes WHERE plan_id = ? AND idx = ?").get(o.plan, o.idx);
        const told = [...new Set([...parse<string[]>(r?.told ?? null, []), ...o.files])];
        this.store.db.query("UPDATE plan_lanes SET told = ? WHERE plan_id = ? AND idx = ?").run(JSON.stringify(told), o.plan, o.idx);
        const p = this.planRow(o.plan);
        if (p) this.d.changed(p.session_id, o.plan);
      },
    };
  }
}

// The task an agent of a unit gets: its brief (each lane's, under its title, for lanes proposed as
// one), then where it stands in the plan: its files, and the files of the lanes beside it.
export function briefOf(ls: readonly Pick<LaneRow, "idx" | "title" | "brief" | "files" | "agent_id">[], all: readonly Pick<LaneRow, "idx" | "title" | "files" | "state" | "agent_id">[]): string {
  const files = (r: Pick<LaneRow, "files">) => (JSON.parse(r.files) as LaneFile[]).filter((f) => f.how !== "importer").map((f) => f.path);
  const mine = new Set(ls.map((r) => r.idx));
  const own = [...new Set(ls.flatMap(files))];
  const head = ls.length > 1
    ? `${ls.map((r) => `## Lane ${r.idx + 1}: ${r.title}\n\n${r.brief}`).join("\n\n")}\n\n---\nThis task does the work of ${ls.length} lanes of a plan, proposed as one because they share files.`
    : `${ls[0]!.brief}\n\n---\nThis task is lane ${ls[0]!.idx + 1} of a plan of ${all.length} lanes.`;
  const others = all.filter((r) => !mine.has(r.idx)).map((r) => ({ r, f: files(r) })).filter((x) => x.f.length);
  const lines = [head, own.length ? `Its files, as the plan has them: ${listOf(own, 12)}.` : "The plan names no file of it."];
  if (others.length) lines.push(`Other lanes of the plan own: ${others.slice(0, 8).map((x) => `${listOf(x.f, 5)} (lane ${x.r.idx + 1}, ${x.r.title})`).join("; ")}. Keep out of their files; if the work needs one, keep the change small and say so in your report.`);
  return lines.join("\n");
}

// The plan as the coordinator reads it: a few lines a lane, the meetings, the proposal, and how to start.
export function planText(v: PlanView): string {
  const n = (i: number) => `${i + 1}`;
  const fileWord = (f: LaneFile) => f.how === "importer" ? `${f.path} (imports ${f.via})` : f.how === "new" ? `${f.path} (new)` : f.path;
  const lines = [`Plan ${v.id}: ${v.lanes.length} lanes on ${v.base}@${v.base_tip.slice(0, 9)}.${v.held ? ` Held: ${v.held}; nothing of it starts until that ends.` : ""}`];
  for (const l of v.lanes) {
    const strong = l.files.filter((f) => f.how !== "importer"), weak = l.files.filter((f) => f.how === "importer");
    const state = l.state === "started" ? ` [started: agent ${l.agent?.id ?? "?"}, ${l.agent?.status ?? "?"}]`
      : l.state === "failed" ? ` [did not start: ${l.why ?? "?"}]`
      : l.state === "waiting" ? (l.blocked ? ` [blocked: lane ${n(l.blocked.lane)} ${l.blocked.why}]` : ` [waits for lane ${l.waits_on.map(n).join(", ")} to land]`) : "";
    lines.push(`${n(l.idx)}. ${l.title}${state}: ${strong.length ? listOf(strong.map(fileWord), 8) : "no file known (declare its files: it may meet any lane)"}${weak.length ? `; may reach ${listOf(weak.map(fileWord), 4)}` : ""}${l.unresolved.length ? `; not found: ${listOf(l.unresolved, 4)}` : ""}`);
    if (l.changed?.strays.length) lines.push(`   changed files of other lanes: ${l.changed.strays.map((s) => `${s.file} (lane ${s.lanes.map(n).join(", ")})`).join(", ")}`);
  }
  const kind = { file: "both name", hub: "both name the hub file", near: "near: one reaches as an importer" } as const;
  lines.push("");
  lines.push(v.meetings.length ? `Lanes that meet: ${v.meetings.map((m) => `${n(m.a)} and ${n(m.b)} (${kind[m.kind]} ${listOf(m.files, 3)})`).join("; ")}.` : "No two lanes meet in a file.");
  const units = v.proposal.units;
  const unitWord = (k: number) => units[k]!.lanes.map(n).join("+");
  const merges = units.filter((u) => u.lanes.length > 1);
  const steps = Array.from({ length: v.proposal.waves }, (_, w) => units.map((u, k) => ({ u, k })).filter((x) => x.u.wave === w));
  lines.push(`Proposed: ${steps.map((xs, w) => (w === 0 ? `start ${xs.map((x) => unitWord(x.k)).join(", ")} now` : xs.map((x) => `${unitWord(x.k)} after ${x.u.after.map(unitWord).join(" and ")} land${x.u.after.length === 1 && !units[x.u.after[0]!]!.lanes[1] ? "s" : ""}`).join("; "))).join("; then ")}.${merges.length ? ` Merged: ${merges.map((u) => `${u.lanes.map(n).join("+")} as one lane (${u.why})`).join("; ")}.` : ""}`);
  return lines.join("\n");
}
