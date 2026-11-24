// PR Steward: a watch on a session's own pull request.
//
// The owner turns it on from the pull request in the worktree chip. The daemon
// then looks at the pull request on a clock (src/core/pulse.ts), at the pace
// `gh pr checks --watch` polls, with the same reading of the checks as the
// pr_checks wait (src/automation/waits.ts): a look costs no model request,
// and a watch that has nothing to do costs nothing but those looks.
//
// When a check fails, the branch conflicts, or a comment comes from someone
// the owner can trust, one turn of the branch's own session starts in its own
// worktree, given the failure text (src/steward/rules.ts says when, and the
// caps). That turn pushes to the pull request's branch and nowhere else, and
// never merges, approves or turns on auto-merge: the gate refuses those in
// it (src/steward/guard.ts) whatever the permission mode. When the checks
// pass, the watch ends with a note; at its caps, a Stop of the turn, a closed
// pull request or the seven days it ends too, and a cap says so in the inbox.
//
// What Claude Code does that this does not: it answers comments and resolves
// threads (here the turn may reply with `gh pr comment`; resolving a thread
// is left to the people), and it re-requests reviews.
import type { Store } from "../core/store.ts";
import type { Bus } from "../core/bus.ts";
import type { StoredEvent } from "../core/types.ts";
import { ownerStop } from "../core/stoppers.ts";
import * as gh from "./github.ts";
import { POLL_MS, PUSHES, QUIET_MS, SEEN_MAX, TRIES, TURNS, UNREADABLE, WATCH_MS, decide, endWords, readFacts, task, trustOf, type End, type Facts, type Step, type Watch, type Why } from "./rules.ts";

export type Io = {
  worktree(sessionId: string): { path: string; branch: string; state: string } | undefined;
  // Starts a turn of the session with these words (through its agent when it is one). `seq`: the stored prompt's place, when known.
  send(sessionId: string, text: string, meta: Record<string, unknown>, sent: (seq?: number) => void): Promise<"sent" | "held" | "gone">;
  inbox(sessionId: string, title: string, body: string): void;
  running(sessionId: string): boolean;
  pending(sessionId: string): boolean;
  error(e: unknown, at: string): void;
};

export type View = { watch: Watch | null; limits: { tries: number; pushes: number; turns: number; days: number } };

const SCHEMA = "CREATE TABLE IF NOT EXISTS pr_watches (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL)";
const REASONS_FAILED = new Set(["error", "refusal", "max_steps", "max_tokens", "budget", "model_context_window_exceeded"]);

// The pace of the looks. A spec shortens it; read when used.
const pace = (w: Watch): number => {
  const set = Number(process.env.KEEL_STEWARD_POLL_MS);
  if (Number.isFinite(set) && set > 0) return set;
  return w.stay && w.checks?.summary === "passing" ? QUIET_MS : POLL_MS;
};

export class Steward {
  // The turns the watch started that run now: the branch each may push to (src/steward/guard.ts).
  readonly guards = new Map<string, { branch: string; repo: string; number: number }>();
  private looking = new Set<string>();
  private settling = new Set<string>();

  constructor(private store: Store, private bus: Bus, private io: Io) {
    store.migrate(SCHEMA);
  }

  get(sessionId: string): Watch | undefined {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM pr_watches WHERE session_id = ?").get(sessionId);
    return r ? (JSON.parse(r.data) as Watch) : undefined;
  }
  active(): Watch[] {
    return this.store.db.query<{ data: string }, []>("SELECT data FROM pr_watches").all().map((r) => JSON.parse(r.data) as Watch).filter((w) => w.state !== "ended");
  }
  view(sessionId: string): View {
    return { watch: this.get(sessionId) ?? null, limits: { tries: TRIES, pushes: PUSHES, turns: TURNS, days: WATCH_MS / 86_400_000 } };
  }

  private save(w: Watch): Watch {
    w.updated = Date.now();
    if (w.seen.length > SEEN_MAX) w.seen = w.seen.slice(-SEEN_MAX);
    if (w.told.length > 50) w.told = w.told.slice(-50);
    this.store.db.query("INSERT INTO pr_watches (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data").run(w.session_id, JSON.stringify(w));
    this.bus.emit({ t: "feature", name: "steward", session_id: w.session_id, data: { changed: true } });
    return w;
  }

  // The earliest time a look is due, for the tick while the daemon is idle.
  due(): number | undefined {
    let at: number | undefined;
    for (const w of this.active()) { const t = (w.looked ?? 0) + pace(w); at = at === undefined ? t : Math.min(at, t); }
    return at;
  }
  tick(now = Date.now()) {
    for (const w of this.active()) {
      if (this.looking.has(w.session_id) || (w.looked ?? 0) + pace(w) > now) continue;
      void this.look(w.session_id).catch((e) => this.io.error(e, "pr steward look"));
    }
  }

  // ---- The owner's controls ----------------------------------------------

  async start(sessionId: string, o: { stay?: boolean; bots?: string[] } = {}): Promise<Watch> {
    const s = this.store.session(sessionId);
    if (!s) throw Object.assign(new Error("no such session"), { status: 404 });
    if (s.archived) throw Object.assign(new Error("the session is archived"), { status: 409 });
    const wt = this.io.worktree(sessionId);
    if (!wt || wt.state !== "active") throw Object.assign(new Error("the session has no worktree of its own to work in"), { status: 409 });
    const bots = [...new Set((o.bots ?? []).map((b) => String(b).trim()).filter((b) => /^[A-Za-z0-9][A-Za-z0-9._\[\]/-]{0,60}$/.test(b)))].slice(0, 10);
    const had = this.get(sessionId);
    const found = await gh.prOfBranch(wt.path, wt.branch);
    if (!found) throw Object.assign(new Error("this branch has no pull request yet: open one first"), { status: 404 });
    if (found.state !== "OPEN") throw Object.assign(new Error(`the pull request is ${found.state.toLowerCase()}`), { status: 409 });
    // The same pull request that is watched: only its options change.
    if (had && had.state !== "ended" && had.number === found.number && had.repo === found.repo) {
      had.stay = !!o.stay;
      had.bots = bots;
      return this.save(had);
    }
    const now = Date.now();
    const seen = await gh.look(found.repo, found.number);
    const f = readFacts(seen.view, seen.inline);
    const w: Watch = {
      session_id: sessionId, repo: found.repo, number: found.number, url: found.url, branch: found.branch, state: "watching",
      note: "Watching.", stay: !!o.stay, bots, started: now, updated: now, expires: now + WATCH_MS,
      // What people said before the watch began is not new: the owner can tell the session about it.
      head: f.head, head_at: now, seen: f.said.map((c) => c.id), told: [], tries: 0, pushes: 0, turns: 0, ignored: 0, errors: 0,
    };
    this.save(w);
    this.wake();
    return w;
  }

  stop(sessionId: string, end: End = "stopped", note = "Turned off.", inbox = false): Watch | undefined {
    const w = this.get(sessionId);
    if (!w || w.state === "ended") return w;
    return this.finish(w, end, note, inbox);
  }

  private wake() { void import("../core/pulse.ts").then((m) => m.pulse().kick()); }

  // ---- A look --------------------------------------------------------------

  async look(sessionId: string): Promise<void> {
    if (this.looking.has(sessionId)) return;
    this.looking.add(sessionId);
    try { await this.lookNow(sessionId); } finally { this.looking.delete(sessionId); }
  }

  private async lookNow(sessionId: string): Promise<void> {
    let w = this.get(sessionId);
    if (!w || w.state === "ended") return;
    const s = this.store.session(sessionId);
    if (!s || s.archived) return void (s ? this.finish(w, "stopped", "The session was archived.") : undefined);
    const now = Date.now();
    if (w.fixing?.ended) return void (await this.settle(w));
    if (w.state === "fixing") return void this.mend(w, now);
    let facts: Facts;
    try {
      const got = await gh.look(w.repo, w.number);
      facts = readFacts(got.view, got.inline);
    } catch (e) {
      w.errors++;
      w.looked = now;
      if (w.errors >= UNREADABLE) return void this.finish(w, "unreadable", `GitHub could not be read ${UNREADABLE} times in a row (${(e as Error).message.slice(0, 160)}).`, true);
      this.save(w);
      return;
    }
    w = this.get(sessionId);
    if (!w || w.state !== "watching") return; // the owner turned it off while gh answered
    w.errors = 0;
    w.looked = now;
    if (facts.head && facts.head !== w.head) { w.head = facts.head; w.head_at = now; }
    w.checks = { summary: facts.checks.summary, passed: facts.checks.passed, failed: facts.checks.failed, pending: facts.checks.pending };
    // A conflict or a green end clears the failures that were tried.
    if (facts.checks.summary === "passing" && !facts.conflict) w.tries = 0;
    await this.believe(w, facts);
    const step = decide(w, facts, now);
    this.apply(w, step);
    if (step.do === "fix") await this.fix(w, facts, step);
  }

  // Who may be believed among the comments not seen yet.
  private async believe(w: Watch, f: Facts) {
    const seen = new Set(w.seen);
    const fresh = f.said.filter((c) => !seen.has(c.id));
    if (!fresh.length) return;
    const viewer = await gh.viewer();
    for (const c of fresh) {
      const t = trustOf(c, { viewer, bots: w.bots });
      c.trusted = t === "yes" || (t === "ask" && (await gh.writes(w.repo, c.author)));
    }
  }

  private apply(w: Watch, step: Step) {
    const seen = new Set(w.seen);
    for (const id of step.ignore) if (!seen.has(id)) { w.seen.push(id); w.ignored++; }
    if (step.do === "end") this.finish(w, step.end, step.note, step.inbox);
    else if (step.do === "wait") this.save(w);
  }

  private async fix(w: Watch, f: Facts, step: Extract<Step, { do: "fix" }>) {
    const wt = this.io.worktree(w.session_id);
    if (!wt || wt.state !== "active") return void this.finish(w, "removed", "The session's worktree is gone, so there is nowhere to fix it.", true);
    const logs: Record<string, string> = {};
    if (step.why.includes("checks")) {
      await Promise.all(step.failed.slice(0, 3).map(async (c) => { try { logs[c.name] = await gh.failedLog(w.repo, c.url); } catch { /* the link and the name still go */ } }));
    }
    // The owner turned it off while the logs were read.
    const cur = this.get(w.session_id);
    if (!cur || cur.state !== "watching") return;
    const text = task(w, f, step, logs, f.base);
    const fixes = step.why.includes("checks") || step.why.includes("conflict");
    w.state = "fixing";
    w.turns++;
    if (fixes) w.tries++;
    for (const k of step.key.split(" ")) if (/^(checks|conflict):/.test(k)) w.told.push(k);
    for (const c of step.said) if (!w.seen.includes(c.id)) w.seen.push(c.id);
    w.fixing = { why: step.why, head: f.head, since: Date.now(), key: step.key };
    w.note = `${fixes ? `Fix ${w.tries} of ${TRIES}` : "Comments"}: ${say(step.why)}. A turn is working on it.`;
    this.save(w);
    const guard = { branch: w.branch, repo: w.repo, number: w.number };
    const id = w.session_id;
    const mark = (seq?: number) => {
      this.guards.set(id, guard);
      const cur = this.get(id);
      if (cur?.fixing) { cur.fixing.seq = seq ?? this.store.lastSeq(id); this.save(cur); }
    };
    let out: "sent" | "held" | "gone";
    try {
      out = await this.io.send(id, text, { kind: "steward", repo: w.repo, number: w.number, why: step.why }, mark);
    } catch (e) {
      this.io.error(e, "pr steward start");
      const cur = this.get(id);
      if (cur) this.finish(cur, "stopped", `The turn could not start: ${(e as Error).message.slice(0, 200)}`, true);
      return;
    }
    if (out === "held") { const cur = this.get(id); if (cur) this.finish(cur, "stopped", "The session is stopped, so no turn was started.", false); }
    else if (out === "gone") { const cur = this.get(id); if (cur) this.finish(cur, "stopped", "The session is gone.", false); }
  }

  // A fix whose turn was given and is not known to run: it never started, or its end was missed.
  private mend(w: Watch, now: number) {
    const fx = w.fixing;
    if (!fx) { w.state = "watching"; return void this.save(w); }
    if (this.io.running(w.session_id) || this.io.pending(w.session_id)) return;
    if (fx.seq === undefined) {
      if (now - fx.since > 60_000) this.finish(w, "stopped", "The turn did not start: the words were not delivered.", true);
      return;
    }
    // The session is idle and no end was seen (a daemon restart in between): the turn is over.
    if (now - w.updated > 120_000) { fx.ended = { reason: "end_turn" }; this.save(w); void this.settle(w).catch((e) => this.io.error(e, "pr steward settle")); }
  }

  // ---- The turn's end ------------------------------------------------------

  // Every event the bus carries: the end of the turn a watch started.
  onEvent(e: StoredEvent) {
    if (e.kind !== "turn_end") return;
    const w = this.get(e.session_id);
    const fx = w?.fixing;
    if (!w || w.state !== "fixing" || !fx || fx.ended || fx.seq === undefined || e.seq <= fx.seq) return;
    const reason = String(e.data?.reason ?? "");
    // A restart cut the turn: it goes on by itself.
    if (reason === "restart") return;
    this.guards.delete(e.session_id);
    fx.ended = { reason, ...(typeof e.data?.stopped_by === "string" ? { by: e.data.stopped_by } : {}) };
    this.save(w);
    void this.settle(w).catch((err) => this.io.error(err, "pr steward settle"));
  }

  private async settle(w: Watch): Promise<void> {
    const fx = w.fixing;
    if (!fx?.ended) return;
    if (this.settling.has(w.session_id)) return;
    this.settling.add(w.session_id);
    try {
      this.guards.delete(w.session_id);
      if (fx.ended.reason === "interrupted" && ownerStop(fx.ended.by)) return void this.finish(w, "stopped", "Stopped by you.");
      let f: Facts;
      try { const got = await gh.look(w.repo, w.number); f = readFacts(got.view, got.inline); } catch { return; } // the next look settles it
      const cur = this.get(w.session_id);
      if (!cur || cur.state !== "fixing") return;
      w = cur;
      const mine = w.fixing!;
      const pushed = !!f.head && f.head !== mine.head;
      w.state = "watching";
      w.fixing = undefined;
      if (pushed) { w.pushes++; w.head = f.head; w.head_at = Date.now(); }
      // What the turn said itself on the pull request (as the owner, through gh) is not news.
      const viewer = await gh.viewer();
      for (const c of f.said) if (viewer && c.author.toLowerCase() === viewer.toLowerCase() && c.at >= mine.since - 5_000 && !w.seen.includes(c.id)) w.seen.push(c.id);
      const reason = mine.ended!.reason;
      const fixes = mine.why.includes("checks") || mine.why.includes("conflict");
      if (!pushed && (fixes || REASONS_FAILED.has(reason))) {
        const why = REASONS_FAILED.has(reason) ? `The turn ended: ${reason.replace(/_/g, " ")}.` : "The turn ended with nothing pushed.";
        return void this.finish(w, "capped", `${why} ${fixes ? "The failure is still there." : ""}`.trim(), true);
      }
      w.note = pushed ? `Pushed ${f.head.slice(0, 8)}. Watching the checks.` : "Watching.";
      w.looked = 0;
      this.save(w);
    } finally {
      this.settling.delete(w.session_id);
    }
  }

  // ---- The end -------------------------------------------------------------

  private finish(w: Watch, end: End, note: string, inbox = false): Watch {
    w.state = "ended";
    w.end = end;
    w.note = note || endWords(end);
    w.fixing = undefined;
    this.save(w);
    try {
      this.bus.emit({ t: "event", event: this.store.append(w.session_id, "note", { kind: "steward", text: `PR Steward on ${w.repo}#${w.number} ended: ${w.note}`, end }) });
    } catch (e) { this.io.error(e, "pr steward note"); }
    if (inbox) {
      try { this.io.inbox(w.session_id, `PR Steward stopped on ${w.repo}#${w.number}`, `${w.note} The pull request is as the watch left it: open the session to take over.`); } catch (e) { this.io.error(e, "pr steward inbox"); }
    }
    return w;
  }

  // ---- A daemon start --------------------------------------------------------

  recover() {
    for (const w of this.active()) {
      if (w.state === "fixing" && w.fixing && !w.fixing.ended && w.fixing.seq !== undefined && this.io.running(w.session_id)) this.guards.set(w.session_id, { branch: w.branch, repo: w.repo, number: w.number });
      w.looked = 0;
      this.store.db.query("UPDATE pr_watches SET data = ? WHERE session_id = ?").run(JSON.stringify(w), w.session_id);
    }
  }
}

const say = (why: Why[]) => why.map((x) => (x === "checks" ? "checks failed" : x === "conflict" ? "a conflict" : "new comments")).join(", ");
