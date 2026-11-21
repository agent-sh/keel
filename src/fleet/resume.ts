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
  state: "waiting" | "resumed" | "expired" | "failed" | "cancelled";
  started_ms: number; deadline_ms: number; ended_ms?: number;
  last?: { state: Activity["state"]; why: string; checked_ms: number };
  session_id?: string; error?: string; process?: Seen["process"];
};
// The original is ended and its copy is not made yet: what the copy will be told.
type EndReceipt = {
  machine_id: string; harness: Harness; id: string; model?: string; waited_ms?: number;
  ended: Ended; in_flight: InFlight[]; stopped_ms: number; error?: string;
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
const KEEP_MS = 10 * 60_000; // a finished wait stays on its row this long
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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
  private waits = new Map<string, Wait & { timer?: Timer }>();
  private ends = new Map<string, EndReceipt>();
  // The conversations a resume works on now: one at a time each, so one copy.
  private busy = new Set<string>();

  constructor(private d: { store: Store; bus: Bus; engine: Engine; providers: Providers; errors: ErrorTracker }, private fleet: Fleet, private imports: Imports) {}

  private key = (machine: string, harness: string, id: string) => `${machine}:${harness}:${id}`;
  private q = (harness: string, id: string) => `harness=${encodeURIComponent(harness)}&id=${encodeURIComponent(id)}`;

  // Whether the original still works on something, from the helper there.
  activity(m: MachineRow, harness: Harness, id: string): Promise<Seen> {
    return this.fleet.handsJson<Seen>(m.id, `/api/fleet/hands/activity?${this.q(harness, id)}`, { timeout: 30_000, idempotent: true });
  }

  waitOf(machine: string, harness: string, id: string): Wait | undefined {
    const w = this.waits.get(this.key(machine, harness, id));
    if (!w) return undefined;
    if (w.ended_ms && Date.now() - w.ended_ms > KEEP_MS) { this.waits.delete(this.key(machine, harness, id)); return undefined; }
    const { timer: _, ...view } = w;
    return view;
  }

  // The original was ended and the copy is still to be made.
  pendingOf(machine: string, harness: string, id: string): Pending | undefined {
    const r = this.ends.get(this.key(machine, harness, id));
    return r && { stopped_ms: r.stopped_ms, how: r.ended.how, in_flight: r.in_flight.length, error: r.error };
  }

  // A copy that went on in Keel is never appended to.
  private wentOn = (sessionId: string) => this.d.engine.isRunning(sessionId) || this.imports.wentOn(sessionId);

  private write(sessionId: string, text: string): boolean {
    if (this.d.engine.isRunning(sessionId)) return false;
    const e = this.d.store.append(sessionId, "note", { kind: "takeover", text, model: true });
    this.d.bus.emit({ t: "event", event: e });
    return true;
  }

  // The copy: a new session placed on that machine, or the copy made before
  // brought up to date (left as it is when it went on here).
  private async copy(m: MachineRow, harness: Harness, id: string, o: { model?: string; title?: string; mode?: "new" | "update" | "open" }) {
    const r = await this.fleet.handsJson<{ session: Found & { cwd_exists: boolean }; read: Read }>(m.id, `/api/fleet/hands/transcript?${this.q(harness, id)}&full=1`, { timeout: 120_000, idempotent: true });
    const f = r.session;
    const prior = this.imports.links(harness, id, undefined, m.id)[0];
    const model = o.model || (prior && this.d.store.session(prior.session_id)?.model) || (await modelFor(this.d.providers, f));
    if (!model) throw new ResumeError(409, "no model is available: no provider has credentials");
    const workspace = f.cwd && f.cwd_exists && contains(m.workspace_root!, f.cwd) ? f.cwd : m.workspace_root!;
    if (prior && !o.mode && this.wentOn(prior.session_id)) {
      const messages = r.read.events.slice(prior.items).filter((e) => e.kind === "user" || e.kind === "assistant").length;
      return { action: "opened" as const, session: this.d.store.session(prior.session_id)!, imported_events: 0, read: r.read, gap: { messages, transcript: `${m.name}:${f.path}` } };
    }
    const seq = prior ? (this.d.store.events(prior.session_id).at(-1)?.seq ?? 0) : 0;
    let out;
    try {
      out = await this.imports.import(f, { mode: o.mode ?? (prior ? "update" : undefined), model, workspace, title: o.title, from: { machine: m.id, read: r.read } });
    } catch (e) {
      // The original rewound or changed branch since the copy: a new copy, not a splice.
      if ((e as any)?.status !== 409 || !prior || o.mode) throw e;
      out = await this.imports.import(f, { mode: "new", model, workspace, title: o.title, from: { machine: m.id, read: r.read } });
    }
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
      finish: " The owner resumes it here from this session's page, which ends the original there.",
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
  private async finish(m: MachineRow, harness: Harness, id: string, seen: Seen, o: { jobs: "keep" | "end"; model?: string; waited_ms?: number; idle_ms?: number }): Promise<Resumed | null> {
    await this.preflight(m, harness, id, o.model);
    let receipt: EndReceipt | undefined;
    if (seen.process) {
      const ended = await this.fleet.handsJson<Ended>(m.id, "/api/fleet/hands/harness/end", {
        method: "POST", timeout: 60_000,
        body: JSON.stringify({ harness, id, pid: seen.process.pid, started_ms: seen.process.started_ms, jobs: o.jobs, revision: seen.revision, idle_ms: o.idle_ms }),
      });
      if (ended.deferred) return null;
      if (!ended.ended) throw new ResumeError(409, `Keel did not end the original on ${m.name}: ${ended.why ?? "no reason given"}. Nothing was copied; end it there, or look again.`);
      // Ended: from here the copy is owed, with what it was ended in the middle of.
      if (ended.was_running) {
        receipt = { machine_id: m.id, harness, id, model: o.model, waited_ms: o.waited_ms, ended, in_flight: ended.in_flight ?? seen.in_flight, stopped_ms: Date.now() };
        this.ends.set(this.key(m.id, harness, id), receipt);
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
      if (!receipt) throw e;
      if (!(e instanceof LinkError) && !(e instanceof ResumeError) && (e as any)?.status !== 409) this.d.errors.capture("server", e, { at: "resume copy", machine: m.id });
      receipt.error = e instanceof LinkError ? `${m.name} did not answer: ${e.message}` : (e as Error).message;
      throw new ResumeError(502, `The original on ${m.name} was stopped, but the copy did not finish: ${receipt.error}. Finish the copy: nothing is stopped again.`, { stopped: true, pending: this.pendingOf(m.id, harness, id) });
    }
    const ended: Ended = receipt?.ended ?? { ended: true, was_running: false, jobs: [], calls: [] };
    const label = HARNESSES.find((h) => h.harness === harness)?.label ?? harness;
    const how = ended.was_running ? `${ended.how ?? "SIGTERM"}${receipt?.waited_ms ? `, once it was idle after ${mins(receipt.waited_ms)}` : ""}` : null;
    let text = endedText({ label, id, where: m.name, how, told: false, stoppedNow: !!ended.was_running, gap: c.gap, jobs: [] });
    const flight = receipt?.in_flight ?? [];
    if (flight.length) {
      text += `\nIt was ended while this was in flight:\n${inFlightLines(flight, ended, receipt!.stopped_ms)}`;
      if (flight.some((i) => i.kind !== "job")) text += "\nCheck any surviving process before redoing interrupted work.";
      if (ended.jobs.some((j) => j.running)) text += "\nA job left running still does the original's work on that machine: look at it before starting it again.";
      if (ended.jobs.some((j) => !j.running)) text += "\nA job that ended with it did not finish: start it again if it is still needed.";
    }
    if (ended.was_running || c.gap) this.write(c.session.id, text);
    this.ends.delete(k);
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
      const owed = this.ends.get(k);
      if (owed) return await this.complete(m, harness, id, owed, o.model);
      if (o.when === "copy") throw new ResumeError(409, "No stopped original waits for its copy. Look again.");
      return await this.choose(m, harness, id, { ...o, when: o.when });
    } finally {
      this.busy.delete(k);
    }
  }

  private async choose(m: MachineRow, harness: Harness, id: string, o: { when: "now" | "idle"; jobs: "keep" | "end"; wait_ms?: number; model?: string; revision?: string }): Promise<Resumed | { action: "waiting"; wait: Wait }> {
    const k = this.key(m.id, harness, id);
    const had = this.waits.get(k);
    if (had?.state === "waiting") {
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
    const w: Wait & { timer?: Timer } = { machine_id: m.id, harness, id, jobs: o.jobs, model: o.model, state: "waiting", process: seen.process, started_ms: Date.now(), deadline_ms: Date.now() + o.wait_ms, last: { state: seen.state, why: seen.why, checked_ms: seen.checked_ms } };
    this.waits.set(k, w);
    this.emit(w);
    w.timer = setTimeout(() => void this.tick(w), POLL_MS);
    return { action: "waiting", wait: this.waitOf(m.id, harness, id)! };
  }

  cancel(machine: string, harness: string, id: string): boolean {
    const w = this.waits.get(this.key(machine, harness, id));
    if (w?.state !== "waiting") return false;
    this.end(w, "cancelled");
    return true;
  }

  private end(w: Wait & { timer?: Timer }, state: Wait["state"], more: Partial<Wait> = {}) {
    clearTimeout(w.timer);
    Object.assign(w, more, { state, ended_ms: Date.now() });
    this.emit(w);
  }

  private emit(w: Wait & { timer?: Timer }) {
    const { timer: _, ...wait } = w;
    this.d.bus.emit({ t: "feature", name: "fleet_resume", data: { wait } });
  }

  private async tick(w: Wait & { timer?: Timer }) {
    if (w.state !== "waiting") return;
    const expired = () => this.end(w, "expired", { error: `Keel could not confirm it was idle by ${clock(w.deadline_ms)}: ${w.last?.why ?? "no answer"}` });
    if (Date.now() >= w.deadline_ms) return expired();
    const m = this.fleet.row(w.machine_id);
    if (!m?.workspace_root) return this.end(w, "failed", { error: "the machine is no longer enabled with a granted directory" });
    try {
      const seen = await this.activity(m, w.harness, w.id);
      if (w.state !== "waiting") return;
      if (seen.process && (w.process?.pid !== seen.process.pid || w.process?.started_ms !== seen.process.started_ms)) return this.end(w, "failed", { error: "Another process runs this session now. Review it again." });
      const changed = w.last?.state !== seen.state || w.last?.why !== seen.why;
      w.last = { state: seen.state, why: seen.why, checked_ms: seen.checked_ms };
      const idle_ms = w.deadline_ms - Date.now();
      if (idle_ms <= 0) return expired();
      const k = this.key(w.machine_id, w.harness, w.id);
      if (!atWork(seen) && !this.busy.has(k)) {
        this.busy.add(k);
        try {
          const r = await this.finish(m, w.harness, w.id, seen, { jobs: w.jobs, model: w.model, waited_ms: Date.now() - w.started_ms, idle_ms });
          if (r) return this.end(w, "resumed", { session_id: r.session.id });
        } finally {
          this.busy.delete(k);
        }
      }
      if (changed) this.emit(w);
    } catch (e) {
      // A machine that does not answer is asked again until the deadline; anything else ends the wait.
      if (!(e instanceof LinkError)) {
        if (!(e instanceof ResumeError)) this.d.errors.capture("server", e, { at: "resume wait", machine: w.machine_id });
        return this.end(w, "failed", { error: (e as Error).message });
      }
      w.last = { state: "active", why: `${m.name} did not answer: ${(e as Error).message}`, checked_ms: Date.now() };
      this.emit(w);
    }
    if (Date.now() >= w.deadline_ms) return expired();
    w.timer = setTimeout(() => void this.tick(w), Math.min(POLL_MS, Math.max(100, w.deadline_ms - Date.now())));
  }
}
