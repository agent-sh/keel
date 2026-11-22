// Resuming, in Keel, a conversation another harness runs on a machine reached
// over ssh: the take-over of src/drive/takeover.ts with the machine's helper
// in the place of the agent view. Keel asks the helper whether the original
// still works on something, the owner chooses to wait until it is idle (with a
// deadline) or to resume now (shown what is in flight, and whether its
// background jobs go on), the helper ends the original, and the copy is made
// from the transcript as it was left. The copy is a session here placed on
// that machine, told in its own transcript what was interrupted so it can redo
// it. Never two writers: nothing is copied for a resume while the original
// could not be ended.
//
// Ending the original cannot be undone, so what the copy needs is checked
// before it (the transcript can be read there, a model can run the copy): a
// failure then leaves the original running. Once the original is ended, what
// it was ended in the middle of is kept (the end receipt) until the copy holds
// it in a note. A copy that fails after the stop says so, and the retry makes
// the copy only: nothing is stopped twice, and nothing in flight is forgotten.
//
// The end receipt is stored (fleet_resume_ends), so a daemon that restarts
// between the stop and the copy still owes the copy and makes it at its start.
// It is written before the stop is sent ("stopping") and again with the
// machine's answer ("stopped"). A stop whose answer never came is settled by
// looking: the original still runs (nothing was ended, the receipt goes), or
// it is gone (ended, with what the owner was shown as the work in flight). An
// original that is still leaving is looked at again for as long as the helper
// gives it to leave. The card's own look settles it too, so a lost answer
// leaves the owner the copy to finish, not an empty card. The receipt passes
// through the store's redaction like the note made from it.
// The note in the copy and the receipt's removal are one write: one copy,
// told once.
//
// A wait the owner authorized is stored too (fleet_resume_waits), with its
// deadline and the process it was given for: a daemon that restarts goes on
// waiting until that same deadline, for that same process. A wait past its
// deadline, or whose process was replaced, ends without a stop. From the
// moment the stop is sent the wait is "finishing": before it a cancel means no
// stop, after it a cancel is refused and said to be finishing. While the stop
// is out and unanswered neither is known: the wait still shows as waiting,
// and a cancel waits for the answer, which says which of the two it is. A
// stop that got no answer (the link failed) ended nothing as far as anyone
// knows: the wait is waiting again and can be cancelled, and a cancelled wait
// sends no stop when the link is back. If that stop did reach the machine,
// its receipt says so at the next look and the copy is offered.
// A wait has one timer at a time, whoever set it: one chain of looks.
// A service that was stopped writes nothing more, whatever comes back to it.
import type { Bus } from "../core/bus.ts";
import { contains } from "../core/paths.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import { endedText, liveText } from "../drive/takeover.ts";
import type { Engine } from "../engine/turn.ts";
import { atWork, type Activity, type InFlight } from "../integrations/import/activity.ts";
import { HARNESSES, modelFor, type Imports } from "../integrations/import/service.ts";
import type { Found, Harness, Read } from "../integrations/import/types.ts";
import type { Providers } from "../providers/registry.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError } from "./link.ts";

export type Seen = Activity & { revision?: string; process?: { pid: number; started_ms: number; status?: string }; checked_ms: number };
type EndedJob = { label: string; command?: string; pid?: number; pgid?: number; since_ms?: number; running: boolean };
type Ended = { ended: boolean; deferred?: boolean; in_flight?: InFlight[]; was_running?: boolean; why?: string; how?: string; took_ms?: number; jobs: EndedJob[]; calls: EndedJob[] };
export type Wait = {
  machine_id: string; harness: Harness; id: string; jobs: "keep" | "end"; model?: string;
  // "finishing": idle was seen and the stop was sent; the copy is being made.
  state: "waiting" | "finishing" | "resumed" | "expired" | "failed" | "cancelled";
  started_ms: number; deadline_ms: number; ended_ms?: number;
  last?: { state: Activity["state"]; why: string; checked_ms: number };
  session_id?: string; error?: string; process?: Seen["process"];
};
type Waiting = Wait & { timer?: Timer };
const open = (w: Wait) => w.state === "waiting" || w.state === "finishing";
// The original is ended and its copy is not made yet: what the copy will be told.
type EndReceipt = {
  machine_id: string; harness: Harness; id: string; model?: string; waited_ms?: number;
  state: "stopping" | "stopped"; process: NonNullable<Seen["process"]>; jobs: "keep" | "end";
  in_flight: InFlight[]; ended?: Ended; sent_ms?: number; stopped_ms?: number; error?: string;
  // The stop's answer never came: the original was found gone afterwards.
  unconfirmed?: boolean;
};
export type Pending = { stopped_ms: number; how?: string; in_flight: number; error?: string };
export type Resumed = {
  action: "taken_over"; session: any; imported_events: number; counts?: unknown; notes: string[];
  stopped: boolean; was_running: boolean; how?: string;
  in_flight: InFlight[]; jobs: EndedJob[];
  not_copied?: { messages: number | null; transcript: string };
};

export class ResumeError extends Error {
  constructor(public status: number, message: string, public more: Record<string, unknown> = {}) { super(message); }
}

const POLL_MS = 2000;
const RECOVER_MS = 20_000; // a copy owed at the start is tried again this often while the machine does not answer
const RECOVER_TRIES = 6;
const EXIT_MS = 15_000; // the helper gives an original 10 s to leave after the stop; a little more before it counts as still running
const KEEP_MS = 10 * 60_000; // a finished wait stays on its row this long
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const mins = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

// What the copy reads of the work its original was ended in the middle of.
export function inFlightLines(items: InFlight[], ended: Pick<Ended, "jobs" | "calls">, now = Date.now()): string {
  const since = (ms?: number) => (ms ? `, for ${mins(now - ms)}` : "");
  const lines: string[] = [];
  for (const j of items.filter((i) => i.kind === "job")) {
    const e = ended.jobs.find((x) => x.pgid === j.pgid);
    const fate = e?.running ? `left running there (pid ${j.pid}${since(j.since_ms)})` : "ended with it";
    lines.push(`- background job, ${fate}: ${j.label}${j.command && j.command !== j.label ? ` [${j.command}]` : ""}`);
  }
  for (const c of items.filter((i) => i.kind === "tool" || i.kind === "subagent")) {
    const still = ended.calls.some((e) => e.pid === c.pid && e.running);
    lines.push(`- ${c.kind === "tool" ? "call" : "subagent"}, ${still ? `still running there (pid ${c.pid}); check before retrying` : "interrupted"}${since(c.since_ms)}: ${c.label}`);
  }
  for (const c of items.filter((i) => i.kind === "turn" || i.kind === "prompt")) lines.push(`- ${c.label}`);
  return lines.join("\n");
}

export class Resumes {
  private waits = new Map<string, Waiting>();
  // How often a wait looks, and how long an original may take to leave after its stop (a test is faster).
  poll = POLL_MS;
  exitMs = EXIT_MS;
  private ends = new Map<string, EndReceipt>();
  // The conversations a resume works on now: one at a time each, so one copy.
  private busy = new Set<string>();
  // The stops that are out for a wait and not answered yet: whether each ended the original.
  private stops = new Map<string, Promise<boolean>>();
  private ticking = new Set<string>();
  private timers = new Set<Timer>();
  private stopped = false;

  constructor(private d: { store: Store; bus: Bus; engine: Engine; providers: Providers; errors: ErrorTracker }, private fleet: Fleet, private imports: Imports) {
    d.store.migrate("CREATE TABLE IF NOT EXISTS fleet_resume_ends (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
    for (const r of d.store.db.query<{ key: string; data: string }, []>("SELECT key, data FROM fleet_resume_ends").all()) this.ends.set(r.key, JSON.parse(r.data));
    d.store.migrate("CREATE TABLE IF NOT EXISTS fleet_resume_waits (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
    for (const r of d.store.db.query<{ key: string; data: string }, []>("SELECT key, data FROM fleet_resume_waits").all()) this.waits.set(r.key, JSON.parse(r.data));
  }

  // What the last daemon left: an original it ended (or was ending) whose copy
  // is not made. The copy is made now; a machine that does not answer is asked
  // again for a while, then the receipt waits for the owner (the card shows it).
  // And the waits it held: each goes on until its own deadline, for its own
  // process. One whose stop had been sent follows its receipt: the copy when
  // the original is gone, waiting again when it still runs.
  recover(delayMs = 2000) {
    for (const k of this.ends.keys()) this.later(() => void this.recoverOne(k, 0), delayMs);
    for (const [k, w] of this.waits) {
      if (!open(w)) continue;
      if (w.state === "finishing" && !this.ends.has(k)) this.setWait(w, "waiting");
      if (w.state === "waiting") this.look(w, delayMs);
    }
  }

  // A hot reload builds a new one: this one's timers end.
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private later(f: () => void, ms: number): Timer {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) f(); }, ms);
    this.timers.add(t);
    return t;
  }

  // The wait's next look. The one it had is taken away first: a wait has one
  // chain of looks, however many places ask for the next one.
  private look(w: Waiting, ms: number) {
    this.unlook(w);
    w.timer = this.later(() => { w.timer = undefined; void this.tick(w); }, ms);
  }
  private unlook(w: Waiting) {
    if (!w.timer) return;
    clearTimeout(w.timer);
    this.timers.delete(w.timer);
    w.timer = undefined;
  }

  // Redacted as the note is: it holds command lines from the far machine.
  private saveEnd(k: string, receipt: EndReceipt) {
    const r = this.d.store.redact(null, "note", receipt) as EndReceipt;
    this.ends.set(k, r);
    this.d.store.db.query("INSERT OR REPLACE INTO fleet_resume_ends (key, data) VALUES (?, ?)").run(k, JSON.stringify(r));
  }
  private dropEnd(k: string) {
    this.ends.delete(k);
    this.d.store.db.query("DELETE FROM fleet_resume_ends WHERE key = ?").run(k);
  }

  private async recoverOne(k: string, n: number) {
    const r = this.ends.get(k);
    if (!r || this.busy.has(k)) return;
    const m = this.fleet.row(r.machine_id);
    if (!m) return this.dropEnd(k); // the machine was removed: there is nothing left to copy from
    if (!m.workspace_root) return this.saveEnd(k, { ...r, error: "the machine is no longer enabled with a granted directory" });
    this.busy.add(k);
    try {
      const owed = await this.owed(m, k);
      if (owed) await this.complete(m, r.harness, r.id, owed, owed.model);
      // The original still runs: the wait that had sent the stop goes on looking.
      const w = this.waits.get(k);
      if (w?.state === "waiting") this.look(w, this.poll);
    } catch (e) {
      if (this.stopped) return;
      const link = e instanceof LinkError || (e instanceof ResumeError && e.more.link === true);
      if (link && n + 1 < RECOVER_TRIES) return void this.later(() => void this.recoverOne(k, n + 1), RECOVER_MS);
      if (link) this.d.errors.capture("server", e, { at: "resume copy owed", machine: r.machine_id });
      // The wait that sent the stop ends here; the receipt stays for the owner.
      const w = this.waits.get(k);
      if (w?.state === "finishing") this.end(w, "failed", { error: (e as Error).message });
    } finally {
      this.busy.delete(k);
    }
  }

  // The original of this conversation that is ended with its copy not made, if any.
  private async owed(m: MachineRow, k: string): Promise<EndReceipt | undefined> {
    const r = this.ends.get(k);
    return r?.state === "stopping" ? this.settle(m, r) : r;
  }

  // A stop that was sent and whose answer is not known, against a look at the
  // machine. The original is gone: the stop ended it, and the copy is owed with
  // what was in flight. It is still there as the same process, within the time
  // the helper gives it to leave: "leaving", look again. Otherwise it still
  // runs (or runs again, started there since): nothing of this stop is owed.
  private settled(r: EndReceipt, seen: Seen): EndReceipt | "leaving" | undefined {
    const k = this.key(r.machine_id, r.harness, r.id);
    if (seen.process) {
      const own = seen.process.pid === r.process.pid && seen.process.started_ms === r.process.started_ms;
      if (own && r.sent_ms && Date.now() - r.sent_ms < this.exitMs) return "leaving";
      this.dropEnd(k);
      // A wait that had sent it waits again, until its deadline. Its next look is set by whoever runs this one.
      const w = this.waits.get(k);
      if (w?.state === "finishing") this.setWait(w, "waiting");
      return undefined;
    }
    const jobs = r.in_flight.filter((i) => i.kind === "job").map((j) => ({ label: j.label, command: j.command, pid: j.pid, pgid: j.pgid, since_ms: j.since_ms, running: r.jobs === "keep" }));
    this.saveEnd(k, { ...r, state: "stopped", unconfirmed: true, stopped_ms: Date.now(), ended: { ended: true, was_running: true, how: "SIGTERM", in_flight: r.in_flight, jobs, calls: [] } });
    return this.ends.get(k);
  }

  private async settle(m: MachineRow, r: EndReceipt): Promise<EndReceipt | undefined> {
    for (;;) {
      const seen = await this.activity(m, r.harness, r.id);
      // Stopped meanwhile (the daemon goes down, or a reload replaced this): nothing more is written.
      if (this.stopped) throw new LinkError("the daemon is stopping");
      const out = this.settled(r, seen);
      if (out !== "leaving") return out;
      await Bun.sleep(Math.min(1000, this.poll));
    }
  }

  private key = (machine: string, harness: string, id: string) => `${machine}:${harness}:${id}`;
  private q = (harness: string, id: string) => `harness=${encodeURIComponent(harness)}&id=${encodeURIComponent(id)}`;

  // Whether the original still works on something, from the helper there. A
  // stop whose answer never came, with no resume working on it now, is settled
  // by this look: the card that asked is then given the copy to finish.
  async activity(m: MachineRow, harness: Harness, id: string): Promise<Seen> {
    const seen = await this.fleet.handsJson<Seen>(m.id, `/api/fleet/hands/activity?${this.q(harness, id)}`, { timeout: 30_000, idempotent: true });
    const k = this.key(m.id, harness, id);
    const r = this.ends.get(k);
    if (r?.state === "stopping" && !this.busy.has(k) && !this.stopped) this.settled(r, seen);
    return seen;
  }

  waitOf(machine: string, harness: string, id: string): Wait | undefined {
    const w = this.waits.get(this.key(machine, harness, id));
    if (!w) return undefined;
    if (w.ended_ms && Date.now() - w.ended_ms > KEEP_MS) {
      this.waits.delete(this.key(machine, harness, id));
      this.d.store.db.query("DELETE FROM fleet_resume_waits WHERE key = ?").run(this.key(machine, harness, id));
      return undefined;
    }
    const { timer: _, ...view } = w;
    // A stop that is out and not answered has ended nothing yet as far as anyone knows.
    if (view.state === "finishing" && this.stops.has(this.key(machine, harness, id))) view.state = "waiting";
    return view;
  }

  // The original was ended and the copy is still to be made.
  pendingOf(machine: string, harness: string, id: string): Pending | undefined {
    const r = this.ends.get(this.key(machine, harness, id));
    return r?.state === "stopped" ? { stopped_ms: r.stopped_ms!, how: r.ended?.how, in_flight: r.in_flight.length, error: r.error } : undefined;
  }

  // A copy that went on in Keel is never appended to.
  private wentOn = (sessionId: string) => this.d.engine.isRunning(sessionId) || this.imports.wentOn(sessionId);

  private write(sessionId: string, text: string): boolean {
    if (this.d.engine.isRunning(sessionId)) return false;
    const e = this.d.store.append(sessionId, "note", { kind: "takeover", text, model: true });
    this.d.bus.emit({ t: "event", event: e });
    return true;
  }

  // What was asked of the machine came back to a service that was stopped (the
  // daemon going down, a reload that replaced it): nothing more is written
  // here. What is stored says where it stands, and the next daemon goes on.
  private live() {
    if (this.stopped) throw new LinkError("the daemon is stopping");
  }

  // The copy: a new session placed on that machine, or the copy made before
  // brought up to date (left as it is when it went on here).
  private async copy(m: MachineRow, harness: Harness, id: string, o: { model?: string; title?: string; mode?: "new" | "update" | "open" }) {
    const r = await this.fleet.handsJson<{ session: Found & { cwd_exists: boolean }; read: Read }>(m.id, `/api/fleet/hands/transcript?${this.q(harness, id)}&full=1`, { timeout: 120_000, idempotent: true });
    this.live();
    const f = r.session;
    const prior = this.imports.links(harness, id, undefined, m.id)[0];
    const model = o.model || (prior && this.d.store.session(prior.session_id)?.model) || (await modelFor(this.d.providers, f));
    if (!model) throw new ResumeError(409, "no model is available: no provider has credentials");
    const workspace = f.cwd && f.cwd_exists && contains(m.workspace_root!, f.cwd) ? f.cwd : m.workspace_root!;
    if (prior && !o.mode && this.wentOn(prior.session_id)) {
      const messages = r.read.events.slice(prior.items).filter((e) => e.kind === "user" || e.kind === "assistant").length;
      return { action: "opened" as const, session: this.d.store.session(prior.session_id)!, imported_events: 0, read: r.read, gap: { messages, transcript: `${m.name}:${f.path}` } };
    }
    const seq = prior ? this.d.store.lastSeq(prior.session_id) : 0;
    let out;
    try {
      out = await this.imports.import(f, { mode: o.mode ?? (prior ? "update" : undefined), model, workspace, title: o.title, from: { machine: m.id, read: r.read } });
    } catch (e) {
      // The original rewound or changed branch since the copy: a new copy, not a splice.
      if ((e as any)?.status !== 409 || !prior || o.mode) throw e;
      out = await this.imports.import(f, { mode: "new", model, workspace, title: o.title, from: { machine: m.id, read: r.read } });
    }
    this.live();
    if (out.action === "created" && workspace !== f.cwd) this.d.store.append(out.session.id, "note", { text: `Its folder ${f.cwd ?? "(none)"} is not inside the directory granted on ${m.name}; it goes on in ${workspace} there.` });
    if (out.action === "updated") for (const e of this.d.store.events(out.session.id, seq)) this.d.bus.emit({ t: "event", event: e });
    this.d.bus.emit({ t: "session", session: this.d.store.session(out.session.id)! });
    return { action: out.action, session: this.d.store.session(out.session.id)!, imported_events: out.imported_events, read: r.read, gap: undefined };
  }

  // A plain import of a transcript whose harness still runs: the copy is told so, once.
  async copied(m: MachineRow, sessionId: string, harness: Harness, id: string) {
    let a: Seen;
    try { a = await this.activity(m, harness, id); } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      return;
    }
    if (a.state === "ended") return;
    const label = HARNESSES.find((h) => h.harness === harness)?.label ?? harness;
    this.write(sessionId, liveText({
      label, id, where: m.name, state: a.state === "active" ? `working (${a.why})` : "idle", step: null, jobs: [],
      finish: " The owner takes it over here from this session's page, which ends the original there.",
    }));
  }

  // What the copy needs, looked at while the original still runs: its
  // transcript is found and read on the machine, and a model can run the copy.
  private async preflight(m: MachineRow, harness: Harness, id: string, model?: string) {
    const r = await this.fleet.handsJson<{ session: Found }>(m.id, `/api/fleet/hands/transcript?${this.q(harness, id)}`, { timeout: 120_000, idempotent: true });
    const left = "The original was left as it is.";
    if (model) {
      try { await this.d.providers.resolve(model); } catch (e) { throw new ResumeError(400, `The model ${model} cannot run the copy: ${(e as Error).message}. ${left}`); }
      return;
    }
    const prior = this.imports.links(harness, id, undefined, m.id)[0];
    if (!((prior && this.d.store.session(prior.session_id)?.model) || (await modelFor(this.d.providers, r.session)))) throw new ResumeError(409, `No model is available: no provider has credentials. ${left}`);
  }

  // Ends the original and makes the copy. `seen`: the state the owner acted on.
  // `wait`: the wait this stop is for. It is looked at again right before the
  // stop leaves (a cancel may have come while the checks ran) and is
  // "finishing" from then on.
  private async finish(m: MachineRow, harness: Harness, id: string, seen: Seen, o: { jobs: "keep" | "end"; model?: string; waited_ms?: number; idle_ms?: number; wait?: Waiting }): Promise<Resumed | null> {
    const k = this.key(m.id, harness, id);
    const owed = await this.owed(m, k);
    if (owed) return this.complete(m, harness, id, owed, o.model ?? owed.model);
    await this.preflight(m, harness, id, o.model);
    let receipt: EndReceipt | undefined;
    if (seen.process) {
      if (o.wait && o.wait.state !== "waiting") return null;
      // Stored before the stop leaves: a stop whose answer is lost (the link, or
      // this daemon going down) is settled from it, never sent blind again. The
      // wait is finishing from here on the row; it is shown so once the answer says it ended.
      const answer = Promise.withResolvers<boolean>();
      if (o.wait) { o.wait.state = "finishing"; this.saveWait(o.wait); this.stops.set(k, answer.promise); }
      this.saveEnd(k, { machine_id: m.id, harness, id, model: o.model, waited_ms: o.waited_ms, state: "stopping", process: seen.process, jobs: o.jobs, in_flight: seen.in_flight, sent_ms: Date.now() });
      let ended: Ended;
      try {
        ended = await this.fleet.handsJson<Ended>(m.id, "/api/fleet/hands/harness/end", {
          method: "POST", timeout: 60_000,
          body: JSON.stringify({ harness, id, pid: seen.process.pid, started_ms: seen.process.started_ms, jobs: o.jobs, revision: seen.revision, idle_ms: o.idle_ms }),
        });
      } catch (e) {
        // No answer says nothing about the stop: the receipt stays, and the next look settles it.
        // The wait is waiting again (it can be cancelled): nothing is known to have ended.
        this.stops.delete(k);
        if (o.wait?.state === "finishing" && !this.stopped) { o.wait.state = "waiting"; this.saveWait(o.wait); }
        answer.resolve(false);
        this.live();
        if (!(e instanceof LinkError)) throw e;
        throw new ResumeError(502, `${m.name} did not answer the stop: ${e.message}. The original may have been stopped: look again, and finish the copy if it was.`, { link: true, maybe_stopped: true });
      }
      // An answer: nothing was ended, or it was and the copy is owed from here.
      this.stops.delete(k);
      if (this.stopped) answer.resolve(!!ended.ended);
      this.live(); // the receipt is as it was written before the stop left: the next daemon settles it
      if (!ended.ended || !ended.was_running) this.dropEnd(k);
      if (o.wait?.state === "finishing") {
        if (ended.ended) this.emit(o.wait);
        else { o.wait.state = "waiting"; this.saveWait(o.wait); }
      }
      answer.resolve(!!ended.ended);
      if (ended.deferred) return null;
      if (!ended.ended) throw new ResumeError(409, `Keel did not end the original on ${m.name}: ${ended.why ?? "no reason given"}. Nothing was copied; end it there, or look again.`);
      if (ended.was_running) {
        receipt = { ...this.ends.get(k)!, state: "stopped", ended, in_flight: ended.in_flight ?? seen.in_flight, stopped_ms: Date.now() };
        this.saveEnd(k, receipt);
      }
    }
    return this.complete(m, harness, id, receipt, o.model);
  }

  // The copy of an original that is ended (`receipt`) or was not running. A
  // failure after the stop keeps the receipt and says what happened: the
  // original stopped, the copy did not finish, and the copy alone is retried.
  private async complete(m: MachineRow, harness: Harness, id: string, receipt: EndReceipt | undefined, model?: string): Promise<Resumed> {
    const k = this.key(m.id, harness, id);
    let c: Awaited<ReturnType<Resumes["copy"]>>;
    try {
      c = await this.copy(m, harness, id, { model: model ?? receipt?.model });
    } catch (e) {
      if (!receipt || this.stopped) throw e;
      if (!(e instanceof LinkError) && !(e instanceof ResumeError) && (e as any)?.status !== 409) this.d.errors.capture("server", e, { at: "resume copy", machine: m.id });
      this.saveEnd(k, { ...receipt, error: e instanceof LinkError ? `${m.name} did not answer: ${e.message}` : (e as Error).message });
      throw new ResumeError(502, `The original on ${m.name} was stopped, but the copy did not finish: ${this.ends.get(k)!.error}. Finish the copy: nothing is stopped again.`, { stopped: true, link: e instanceof LinkError, pending: this.pendingOf(m.id, harness, id) });
    }
    const ended: Ended = receipt?.ended ?? { ended: true, was_running: false, jobs: [], calls: [] };
    const label = HARNESSES.find((h) => h.harness === harness)?.label ?? harness;
    const how = ended.was_running ? `${ended.how ?? "SIGTERM"}${receipt?.waited_ms ? `, once it was idle after ${mins(receipt.waited_ms)}` : ""}` : null;
    let text = endedText({ label, id, where: m.name, how, told: false, stoppedNow: !!ended.was_running, gap: c.gap, jobs: [] });
    const flight = receipt?.in_flight ?? [];
    if (flight.length) {
      text += `\nIt was ended while this was in flight:\n${inFlightLines(flight, ended, receipt!.stopped_ms)}`;
      if (receipt!.unconfirmed) text += "\nThe machine's answer to the stop did not arrive: this is what was in flight when Keel sent it, and what survived there is not known.";
      if (flight.some((i) => i.kind !== "job")) text += "\nCheck any surviving process before redoing interrupted work.";
      if (ended.jobs.some((j) => j.running)) text += "\nA job left running still does the original's work on that machine: look at it before starting it again.";
      if (ended.jobs.some((j) => !j.running)) text += "\nA job that ended with it did not finish: start it again if it is still needed.";
    }
    this.live();
    // The note and the receipt's end are one write: the copy is told once.
    const told = this.d.store.atomic(c.session.id, () => {
      const e = (ended.was_running || c.gap) && !this.d.engine.isRunning(c.session.id) ? this.d.store.append(c.session.id, "note", { kind: "takeover", text, model: true }) : undefined;
      this.dropEnd(k);
      return e;
    });
    if (told) this.d.bus.emit({ t: "event", event: told });
    // The wait that was for it is over, whoever made the copy.
    const w = this.waits.get(k);
    if (w && open(w)) this.end(w, "resumed", { session_id: c.session.id });
    return {
      action: "taken_over", session: this.d.store.session(c.session.id)!, imported_events: c.imported_events, counts: c.read.counts, notes: c.read.notes,
      stopped: !!ended.was_running, was_running: !!ended.was_running, how: how ?? undefined, in_flight: flight, jobs: ended.jobs, not_copied: c.gap,
    };
  }

  // The owner's choice. "now": whatever it does, its jobs as chosen; "idle":
  // at once when no turn is in flight, else a wait that ends it once its turn
  // is over or gives up at the deadline. The owner chooses what happens to its jobs.
  // "copy": the original was ended and its copy did not finish; the copy alone.
  // An original that is ended already gets its copy whatever was asked.
  async resume(m: MachineRow, harness: Harness, id: string, o: { when: "now" | "idle" | "copy"; jobs: "keep" | "end"; wait_ms?: number; model?: string; revision?: string }): Promise<Resumed | { action: "waiting"; wait: Wait }> {
    const k = this.key(m.id, harness, id);
    if (this.busy.has(k)) throw new ResumeError(409, "Keel is resuming this conversation now.");
    this.busy.add(k);
    try {
      const owed = await this.owed(m, k);
      if (owed) return await this.complete(m, harness, id, owed, o.model ?? owed.model);
      if (o.when === "copy") throw new ResumeError(409, "No stopped original waits for its copy. Look again.");
      return await this.choose(m, harness, id, { ...o, when: o.when });
    } finally {
      this.busy.delete(k);
    }
  }

  private async choose(m: MachineRow, harness: Harness, id: string, o: { when: "now" | "idle"; jobs: "keep" | "end"; wait_ms?: number; model?: string; revision?: string }): Promise<Resumed | { action: "waiting"; wait: Wait }> {
    const k = this.key(m.id, harness, id);
    const had = this.waits.get(k);
    if (had && open(had)) {
      if (o.when === "idle") throw new ResumeError(409, "Keel already waits for it to be idle", { wait: this.waitOf(m.id, harness, id) });
      this.end(had, "cancelled");
    }
    const seen = await this.activity(m, harness, id);
    if (seen.process && (o.when === "now" || o.revision) && seen.revision !== o.revision) throw new ResumeError(409, "The original or its work changed. Review what is running before ending it.");
    if (o.when === "now") return (await this.finish(m, harness, id, seen, o))!;
    if (!atWork(seen)) {
      const r = await this.finish(m, harness, id, seen, { ...o, idle_ms: o.wait_ms ?? 30_000 });
      if (r) return r;
    }
    if (!(o.wait_ms && o.wait_ms > 0)) throw new ResumeError(400, "give wait_ms: how long Keel waits for it to be idle");
    const w: Waiting = { machine_id: m.id, harness, id, jobs: o.jobs, model: o.model, state: "waiting", process: seen.process, started_ms: Date.now(), deadline_ms: Date.now() + o.wait_ms, last: { state: seen.state, why: seen.why, checked_ms: seen.checked_ms } };
    this.waits.set(k, w);
    this.saveWait(w);
    this.emit(w);
    this.look(w, this.poll);
    return { action: "waiting", wait: this.waitOf(m.id, harness, id)! };
  }

  // Before the stop is sent a cancel means no stop. Once the stop has ended the
  // original the wait is finishing: that is said, not a cancel that did not
  // happen. In between, the stop's answer decides: one that ended nothing (the
  // original went back to work) leaves a wait that can still be cancelled.
  async cancel(machine: string, harness: string, id: string): Promise<{ cancelled: boolean; finishing?: boolean }> {
    const k = this.key(machine, harness, id);
    const w = this.waits.get(k);
    if (w?.state === "finishing" && (await (this.stops.get(k) ?? true))) return { cancelled: false, finishing: true };
    if (w?.state !== "waiting") return { cancelled: false };
    this.end(w, "cancelled");
    return { cancelled: true };
  }

  private saveWait(w: Waiting) {
    const { timer: _, ...wait } = w;
    this.d.store.db.query("INSERT OR REPLACE INTO fleet_resume_waits (key, data) VALUES (?, ?)").run(this.key(w.machine_id, w.harness, w.id), JSON.stringify(wait));
  }

  private setWait(w: Waiting, state: "waiting" | "finishing") {
    w.state = state;
    this.saveWait(w);
    this.emit(w);
  }

  private end(w: Waiting, state: Wait["state"], more: Partial<Wait> = {}) {
    this.unlook(w);
    Object.assign(w, more, { state, ended_ms: Date.now() });
    this.saveWait(w);
    this.emit(w);
  }

  private emit(w: Waiting) {
    const { timer: _, ...wait } = w;
    this.d.bus.emit({ t: "feature", name: "fleet_resume", data: { wait } });
  }

  // One look at a time for a wait: a look asked for while one is out is dropped (the one out sets the next).
  private async tick(w: Waiting) {
    const k = this.key(w.machine_id, w.harness, w.id);
    if (this.ticking.has(k)) return;
    this.ticking.add(k);
    try { await this.lookNow(w); } finally { this.ticking.delete(k); }
  }

  private async lookNow(w: Waiting) {
    if (this.stopped || !open(w)) return;
    const k = this.key(w.machine_id, w.harness, w.id);
    // Past the deadline nothing is stopped. A stop already sent is not undone by it: its copy is still owed.
    const expired = () => (this.ends.has(k)
      ? this.end(w, "failed", { error: `The original was being ended when the wait reached its deadline (${clock(w.deadline_ms)}); its copy is not made yet. Finish the copy from its card.` })
      : this.end(w, "expired", { error: `Keel could not confirm it was idle by ${clock(w.deadline_ms)}: ${w.last?.why ?? "no answer"}` }));
    if (Date.now() >= w.deadline_ms) return expired();
    const m = this.fleet.row(w.machine_id);
    if (!m?.workspace_root) return this.end(w, "failed", { error: "the machine is no longer enabled with a granted directory" });
    try {
      const seen = await this.activity(m, w.harness, w.id);
      if (this.stopped || !open(w)) return;
      // Only the process the owner was shown is ever ended for this wait.
      if (seen.process && (w.process?.pid !== seen.process.pid || w.process?.started_ms !== seen.process.started_ms)) return this.end(w, "failed", { error: "Another process runs this session now. Review it again." });
      const changed = w.last?.state !== seen.state || w.last?.why !== seen.why;
      w.last = { state: seen.state, why: seen.why, checked_ms: seen.checked_ms };
      const idle_ms = w.deadline_ms - Date.now();
      if (idle_ms <= 0) return expired();
      if (!atWork(seen) && !this.busy.has(k)) {
        this.busy.add(k);
        try {
          const r = await this.finish(m, w.harness, w.id, seen, { jobs: w.jobs, model: w.model, waited_ms: Date.now() - w.started_ms, idle_ms, wait: w });
          if (r) return; // the copy is made: the wait ended with it
        } finally {
          this.busy.delete(k);
        }
      }
      if (changed && open(w)) this.emit(w);
    } catch (e) {
      if (this.stopped) return; // the wait is on its row: the next daemon goes on with it
      // A machine that does not answer is asked again until the deadline; anything else ends the wait.
      if (!(e instanceof LinkError) && !(e instanceof ResumeError && e.more.link === true)) {
        if (!(e instanceof ResumeError)) this.d.errors.capture("server", e, { at: "resume wait", machine: w.machine_id });
        return void (open(w) && this.end(w, "failed", { error: (e as Error).message }));
      }
      w.last = { state: "active", why: `${m.name} did not answer: ${(e as Error).message}`, checked_ms: Date.now() };
      this.emit(w);
    }
    if (this.stopped || !open(w)) return; // cancelled while the checks ran
    if (Date.now() >= w.deadline_ms) return expired();
    this.look(w, Math.min(this.poll, Math.max(100, w.deadline_ms - Date.now())));
  }
}
