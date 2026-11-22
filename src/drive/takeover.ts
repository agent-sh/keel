// Taking over a session another harness runs: Keel copies it as it is now (an
// import, or an update of the Keel session made from it before), asks the
// agent view to end the original by its harness's own exit path (`stop`), and
// copies what it wrote last, so the Keel session goes on where the original
// stopped. Nothing is ended while the original has work in flight (a turn,
// subagents, shell jobs) or waits on a prompt; the answer is then a snapshot
// whose `step` says in plain words what the owner does first. The copy is told
// what came of it in its own transcript, as a note the model reads.
//
// The owner reaches this from the page (POST /api/import/takeover); a model
// only through keel__session_import with take_over, a card only the owner
// answers.
import { readFileSync, statSync } from "node:fs";
import type { Store } from "../core/store.ts";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Engine } from "../engine/turn.ts";
import type { Providers } from "../providers/registry.ts";
import { HARNESSES, modelFor, type Imports } from "../integrations/import/service.ts";
import type { Found as Source, Harness } from "../integrations/import/types.ts";
import { DriveError, inFlight, stopSession, toRow, type Drive, type Found, type Row } from "./drive.ts";
import * as av from "./agentview.ts";

export type Job = { id: string; cron: string; recurring: boolean; durable: boolean; prompt: string };
export type Behind = { jobs: Job[]; running: string | null };
export type Answer = {
  action: "taken_over" | "snapshot" | "created" | "updated" | "opened";
  session: any;
  imported_events: number;
  counts?: unknown;
  notes: string[];
  stopped?: boolean;
  was_running?: boolean | null;
  how?: string;
  step?: string;
  left_behind?: Behind;
  not_copied?: { messages: number | null; transcript: string };
  live_source?: boolean;
  told?: boolean;
};
export type Req = { session?: string; harness?: Harness; id?: string; path?: string; model?: string; title?: string };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const RECURRING_LIFE_MS = 7 * 24 * 3600 * 1000; // Claude Code expires a recurring job after 7 days

// The jobs a Claude Code transcript leaves set: made with CronCreate and not
// deleted with CronDelete, a one-shot whose time has not passed, a recurring
// one younger than the seven days Claude Code keeps it.
export function scheduledJobs(text: string, now = Date.now()): Job[] {
  const asked = new Map<string, any>();
  const deletes = new Map<string, string>();
  const jobs: Job[] = [];
  const deleted = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes("Cron") && ![...asked.keys(), ...deletes.keys()].some((id) => line.includes(id))) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const blocks = r?.message?.content;
    if (!Array.isArray(blocks)) continue;
    if (r.type === "assistant") {
      for (const b of blocks) {
        if (b?.type !== "tool_use") continue;
        if (b.name === "CronCreate") asked.set(b.id, b.input ?? {});
        if (b.name === "CronDelete") deletes.set(b.id, String(b.input?.id ?? ""));
      }
    } else if (r.type === "user") {
      const res = r.toolUseResult ?? {};
      for (const b of blocks) {
        if (b?.type !== "tool_result" || b.is_error === true) continue;
        const input = asked.get(b.tool_use_id);
        if (input) {
          asked.delete(b.tool_use_id);
          if (typeof res.id !== "string" || !res.id) continue;
          const made = Date.parse(r.timestamp ?? "") || now;
          const recurring = res.recurring ?? input.recurring ?? true;
          const gone = recurring ? made + RECURRING_LIFE_MS < now : typeof res.nextFireAt === "number" && res.nextFireAt < now;
          const i = jobs.findIndex((j) => j.id === res.id);
          if (i >= 0) jobs.splice(i, 1);
          if (!gone) jobs.push({ id: res.id, cron: String(input.cron ?? ""), recurring: !!recurring, durable: res.durable === true, prompt: String(input.prompt ?? "") });
        } else if (deletes.has(b.tool_use_id)) {
          deleted.add(deletes.get(b.tool_use_id)!);
          deletes.delete(b.tool_use_id);
        }
      }
    }
  }
  return jobs.filter((j) => !deleted.has(j.id));
}

const oneLine = (t: string, n = 160) => {
  const f = t.split(/\s+/).filter(Boolean).join(" ");
  return f.length <= n ? f : `${f.slice(0, n)}...`;
};
const jobLines = (jobs: Job[]) => jobs.map((j) => `\n- \`${j.cron}\` ${j.recurring ? "recurring" : "once"}${j.durable ? ", kept on disk by Claude Code" : ""}: ${oneLine(j.prompt)}`).join("");

// What a copy is told while its original still runs. `where`: the machine the
// original runs on, when it is not this one. `state`: what it does there, or
// null when that could not be asked.
export function liveText(o: { label: string; id: string; where?: string; state: string | null; step: string | null; jobs: Job[]; finish?: string }): string {
  const src = `${o.label} session ${o.id}${o.where ? ` on ${o.where}` : ""}`;
  let t = o.state !== null
    ? `[harness take-over] This session is a copy of ${src}, and the original still runs there: it is ${o.state}.`
    : `[harness take-over] This session is a copy of ${src}, which may still run there: Keel could not ask the agent view.`;
  t += o.step ? ` Keel did not end it. ${o.step}` : " It was copied, not taken over.";
  if (o.jobs.length) t += `\nIts scheduled jobs stay with the original and do not carry over:${jobLines(o.jobs)}\nOnce it has ended, recreate the ones still wanted with keel__loop_create.`;
  t += "\nUntil the original ends or the owner says so, do not act on shared resources it may also be driving: its repositories and worktrees, processes and servers, GPUs and leases, scheduled jobs.";
  if (o.state !== null) t += o.finish ?? " Once it is idle, the owner finishes the take-over with Take over now on this session's page.";
  return t;
}

// What a copy is told once its original has ended. `told`: it was told before
// that the original still ran. `gap`: what the original wrote that the copy
// lacks, because the copy went on in Keel.
export function endedText(o: { label: string; id: string; where?: string; how: string | null; told: boolean; stoppedNow: boolean; gap?: { messages: number | null; transcript: string }; jobs: Job[] }): string {
  const src = `${o.label} session ${o.id}${o.where ? ` on ${o.where}` : ""}`;
  const h = o.how ? ` (${o.how})` : "";
  const { gap } = o;
  const lacks = !gap ? "what it wrote last is above"
    : gap.messages === 0 ? "it wrote nothing after this session was copied from it, so nothing of it is missing here"
    : gap.messages === null ? `what it wrote after this session was copied from it is not here and could not be counted; its transcript is ${gap.transcript}`
    : `${gap.messages} of its messages after this session was copied from it are not here, since this session went on in Keel; they are in its transcript, ${gap.transcript}`;
  let t = o.told
    ? `[harness take-over] The original ${src} has ended${h}, and ${lacks}. This session alone holds the conversation now; the hold on shared resources is over.`
    : `[harness take-over] The original ${src} ${o.stoppedNow ? "was ended" : "has ended"}${h}, and this session goes on from it${gap ? `: ${lacks}` : ""}.`;
  if (o.jobs.length) t += `\nIts scheduled jobs ended with it and do not carry over:${jobLines(o.jobs)}\nRecreate the ones still wanted with keel__loop_create.`;
  return t;
}

// The one thing the owner does by hand when the agent view cannot end a session.
export function manualStep(row: Row, raw: av.Raw): string {
  const again = "then take it over again: Keel adds what it wrote last";
  const job = typeof raw.job === "string" && raw.job ? raw.job : "";
  if (row.kind === "claude" && job) return `Keel cannot stop "${row.name}" from here. Run claude stop ${job} in a shell, ${again}.`;
  if (row.kind === "claude") return `Keel cannot stop "${row.name}" from here. Type /exit in its terminal, ${again}.`;
  if (row.kind === "codex") return `Keel cannot stop "${row.name}" from here. Type /quit in its terminal, ${again}.`;
  return `Keel cannot stop "${row.name}" from here. Close it in its terminal, ${again}.`;
}

// Whether a Keel row of the agent view is the source a request names.
function isSource(raw: av.Raw, f: Source): boolean {
  if (raw.host) return false;
  if (typeof raw.transcript === "string" && raw.transcript === f.path) return true;
  return ["session", "thread"].some((k) => raw[k] === f.id);
}

export class TakeOver {
  constructor(private d: { store: Store; bus: Bus; engine: Engine; providers: Providers; errors: ErrorTracker; workspace: string }, private drive: Drive, private imports: Imports) {
    drive.onList.push((rows) => void this.settle(rows).catch((e) => d.errors.capture("server", e, { at: "takeover settle" })));
  }

  // A copy went on in Keel: a turn taken here, or one running now.
  wentOn(sessionId: string): boolean {
    return this.d.engine.isRunning(sessionId) || this.imports.wentOn(sessionId);
  }

  // The source a running row names: its transcript on this machine.
  sourceOf(f: Found): Source {
    const harness = (["claude", "codex", "agy"] as const).find((k) => k === f.row.kind);
    if (!harness) throw new HttpError(409, `sessions of ${f.row.kind} cannot be copied yet`);
    if (f.host) throw new HttpError(409, `"${f.row.name}" runs on ${f.host}; Keel copies only sessions whose file is on this machine`);
    const t = typeof f.raw.transcript === "string" ? f.raw.transcript : "";
    // An Antigravity conversation is found in its stores by its id when the row names no file.
    const byId = () => (harness === "agy" && typeof f.raw.session === "string" ? this.imports.find("agy", f.raw.session) : undefined);
    // The store list is cached for seconds; a conversation started since is read again.
    const src = t ? this.imports.byPath(t, harness) : (byId() ?? (this.imports.invalidate(), byId()));
    if (!t && !src) throw new HttpError(409, `the agent view does not name the file "${f.row.name}" keeps, so Keel cannot copy it`);
    if (!src) throw new HttpError(409, `the file ${t || f.raw.session} that "${f.row.name}" keeps could not be read`);
    return src;
  }

  // An import of the source, or an update of the copy made before. A copy that
  // went on is left as it is (`went_on`).
  async copy(src: Source, o: { model?: string; title?: string; mode?: "new" | "update" | "open" }): Promise<{ action: "created" | "updated" | "opened"; session: any; imported_events: number; counts: unknown; notes: string[]; went_on?: boolean }> {
    const prior = this.imports.links(src.harness, src.id)[0];
    if (prior && !o.mode && this.wentOn(prior.session_id)) return { action: "opened", session: this.d.store.session(prior.session_id), imported_events: 0, counts: undefined, notes: [], went_on: true };
    const model = o.model || (await modelFor(this.d.providers, src));
    if (!model) throw new HttpError(409, "no model is available: no provider has credentials");
    const workspace = src.cwd && isDir(src.cwd) ? src.cwd : this.d.workspace;
    const seq = prior ? this.lastSeq(prior.session_id) : 0;
    const r = await this.imports.import(src, { mode: o.mode ?? (prior ? "update" : undefined), model, workspace, title: o.title });
    if (r.action === "created") this.d.bus.emit({ t: "session", session: r.session });
    else if (r.action === "updated") this.emitSince(r.session.id, seq);
    return { action: r.action, session: r.session, imported_events: r.imported_events, counts: r.read?.counts, notes: r.read?.notes ?? [] };
  }

  // The owner's take-over (also the model's, once the owner said yes).
  async takeOver(req: Req): Promise<Answer> {
    let row: Found | null = null;
    let done = await this.once(req, (f) => (row = f));
    const sid = done.session?.id as string | undefined;
    if (!sid) return done;
    const went = (done as any).went_on;
    delete (done as any).went_on;
    if (done.action === "snapshot") {
      const r = row as Found | null;
      const b = await this.tellLive(sid, r?.raw.live === true ? r : null, done.step ?? null);
      done.told = b.told;
      if (went) done.step = `${done.step ?? ""} This session went on here since it was copied, so nothing of the original is added to it.`.trim();
      if (b.jobs.length || b.running) done.left_behind = { jobs: b.jobs, running: b.running };
    } else if (done.action === "taken_over") {
      const { behind, gap } = await this.tellEnded(sid, done.how ?? null, done.stopped === true);
      const r = row as Found | null;
      if (r) for (const l of this.imports.liveSources()) if (l.session_id !== sid && l.drive_id === r.row.id) await this.tellEnded(l.session_id, done.how ?? null, false);
      if (gap) done.not_copied = gap;
      if (behind.jobs.length) done.left_behind = { jobs: behind.jobs, running: null };
    }
    done.session = this.d.store.session(sid) ?? done.session;
    return done;
  }

  private async once(req: Req, seen: (f: Found) => void): Promise<Answer> {
    const named = req.path || (req.harness && req.id);
    let named_src: Source | undefined;
    if (named) {
      named_src = req.path ? this.imports.byPath(req.path, req.harness) : this.imports.find(req.harness!, req.id!);
      if (!named_src) throw new HttpError(404, req.path ? "no reader recognises this file" : `${req.harness} has no session ${req.id}`);
    }
    let f: Found | null;
    try {
      f = req.session ? await this.drive.find(req.session, 0) : await this.findSource(named_src!);
    } catch (e) {
      if (e instanceof DriveError && e.code === "NOT_FOUND") throw new HttpError(404, "the agent view lists no such session; its list names the sessions it runs");
      if (e instanceof DriveError && e.code === "INVALID_PARAM") throw new HttpError(400, e.message);
      if (!named_src) throw new HttpError(409, (e as Error).message);
      // Without the agent view nothing can be stopped; the named source is still copied.
      const c = await this.copy(named_src, req);
      return { ...c, action: "snapshot", stopped: false, was_running: null, step: `Keel could not ask the agent view whether it still runs (${(e as Error).message}). End it where it runs, then take it over again.` };
    }
    if (!f) {
      // Not run by anything the agent view sees: the copy is the whole of it.
      const c = await this.copy(named_src!, req);
      return { ...c, action: "taken_over", stopped: false, was_running: false };
    }
    seen(f);
    const src = named_src ?? this.sourceOf(f);
    const first = await this.copy(src, req);
    const live = f.raw.live === true;
    const answer = (c: typeof first, action: "taken_over" | "snapshot", stopped: boolean, step?: string, earlier = 0): Answer =>
      ({ ...c, imported_events: c.imported_events + earlier, action, stopped, was_running: live, ...(step ? { step } : {}) });
    if (!live) return answer(first, "taken_over", false);
    const snapshot = (step: string) => answer(first, "snapshot", false, step);
    if (f.raw.stale === true) return snapshot(`Its machine cannot be reached now (${f.raw.host_error || "no answer"}). Keel has a copy as of its last sync; end it there, then take it over again.`);
    const notIdle = (what: string) => snapshot(`"${f!.row.name}" is not idle (${what}), and Keel does not end a session while its turn, subagents or shell jobs run. Take it over again once it is idle.`);
    const busy = inFlight(f.raw);
    if (busy) return notIdle(busy);
    if (await this.drive.held(f)) return snapshot(`"${f.row.name}" waits on a prompt, and ending it now would answer or close the prompt. Answer it where it runs, then take it over again.`);
    let identity: unknown;
    try {
      // Read again just before the stop: work may have started since the list.
      const now = f.host ? f.raw : await this.drive.freshRow(f);
      const late = inFlight(now);
      if (late) return notIdle(late);
      identity = await this.drive.identity(f);
    } catch (e) {
      return snapshot(`Keel did not stop it: ${(e as Error).message}. Take it over again.`);
    }
    const stop = await stopSession(f, identity);
    this.drive.invalidate();
    // No answer to the stop is not proof either way: the copy stays a copy (it
    // runs nothing), and taking over again reads the original's state anew and
    // copies what it wrote last, once.
    if (!stop.stopped) return snapshot(stop.unsupported ? manualStep(f.row, f.raw) : `Keel asked the agent view to end it and got no answer it could trust (${stop.why}); it may or may not have ended. Take it over again: Keel checks whether it still runs and copies what it wrote last.`);
    // A copy that went on gets nothing more of the original: the ended line says what it lacks.
    const done = first.went_on ? answer(first, "taken_over", true) : answer(await this.copy(src, req), "taken_over", true, undefined, first.imported_events);
    if (stop.how) done.how = stop.how;
    if (first.went_on) (done as any).went_on = true;
    return done;
  }

  private async findSource(src: Source): Promise<Found | null> {
    const raws = await this.drive.raws(0);
    const raw = raws.find((r) => (av.KINDS as readonly string[]).includes(r.tool) && isSource(r, src));
    return raw ? this.drive.find(av.rowId(raw)) : null;
  }

  // ---- what the copy is told ----

  private behind(sessionId: string, running: string | null): Behind {
    const l = this.imports.link(sessionId);
    let jobs: Job[] = [];
    if (l?.harness === "claude") {
      try { jobs = scheduledJobs(readFileSync(l.source_path, "utf8")); } catch {}
    }
    return { jobs, running };
  }

  private label(sessionId: string) {
    const l = this.imports.link(sessionId);
    return { label: HARNESSES.find((h) => h.harness === l?.harness)?.label ?? "another harness", id: l?.source_id ?? "?" };
  }

  private lastSeq(sessionId: string) {
    return this.d.store.lastSeq(sessionId);
  }
  // What an update appended reaches the open pages.
  private emitSince(sessionId: string, seq: number) {
    for (const e of this.d.store.events(sessionId, seq)) this.d.bus.emit({ t: "event", event: e });
    const s = this.d.store.session(sessionId);
    if (s) this.d.bus.emit({ t: "session", session: s });
  }

  // A note the model reads on its next turn; never written while a turn runs in the copy.
  private write(sessionId: string, text: string): boolean {
    if (this.d.engine.isRunning(sessionId)) return false;
    const e = this.d.store.append(sessionId, "note", { kind: "takeover", text, model: true });
    this.d.bus.emit({ t: "event", event: e });
    return true;
  }

  // Tells the copy its original still runs, once while it runs.
  async tellLive(sessionId: string, f: Found | null, step: string | null): Promise<Behind & { told: boolean }> {
    const b = this.behind(sessionId, f ? inFlight(f.raw) : null);
    if (f && this.imports.liveSource(sessionId)) return { ...b, told: true };
    const t = liveText({ ...this.label(sessionId), state: f ? (b.running ? `working (${b.running})` : f.row.state) : null, step, jobs: b.jobs });
    const told = this.write(sessionId, t);
    if (told && f) this.imports.putLive(sessionId, f.row.id);
    return { ...b, told };
  }

  // Tells the copy its original ended: brought up to date first, unless it went
  // on in Keel, when the line says how many of the original's messages it lacks.
  async tellEnded(sessionId: string, how: string | null, stoppedNow: boolean): Promise<{ behind: Behind; gap?: { messages: number | null; transcript: string } }> {
    const l = this.imports.link(sessionId);
    if (!l) {
      this.imports.clearLive(sessionId);
      return { behind: { jobs: [], running: null } };
    }
    const told = !!this.imports.liveSource(sessionId);
    const behind = stoppedNow ? this.behind(sessionId, null) : { jobs: [], running: null };
    let gap: { messages: number | null; transcript: string } | undefined;
    const src = this.imports.find(l.harness, l.source_id) ?? this.imports.byPath(l.source_path, l.harness);
    if (this.wentOn(sessionId)) {
      let messages: number | null = null;
      try {
        if (src) messages = (await this.imports.read(src)).events.slice(l.items).filter((e) => e.kind === "user" || e.kind === "assistant").length;
      } catch {}
      gap = { messages, transcript: l.source_path };
    } else if (src) {
      try {
        const seq = this.lastSeq(sessionId);
        await this.imports.import(src, { mode: "update", model: this.d.store.session(sessionId)!.model, workspace: this.d.workspace });
        this.emitSince(sessionId, seq);
      } catch (e) {
        this.d.errors.capture("server", e, { at: "takeover catch up", session: sessionId });
      }
    }
    if (!told && !behind.jobs.length && !gap) return { behind };
    const t = endedText({ ...this.label(sessionId), how, told, stoppedNow, gap, jobs: behind.jobs });
    if (this.write(sessionId, t)) this.imports.clearLive(sessionId);
    return { behind, gap };
  }

  // Every list the agent view printed settles the copies whose original it
  // shows ended or no longer lists. A row of a machine that cannot be reached says nothing.
  private settling = false;
  async settle(rows: Row[]) {
    if (this.settling) return;
    this.settling = true;
    try {
      for (const l of this.imports.liveSources()) {
        const r = rows.find((x) => x.id === l.drive_id);
        if (!r || (!r.live && r.state !== "disconnected")) await this.tellEnded(l.session_id, null, false);
      }
    } finally {
      this.settling = false;
    }
  }

  // After a plain import of a session the agent view lists as live: the copy is told, once.
  async noteLive(sessionId: string, f: Found) {
    if (f.raw.live !== true || f.raw.stale === true || this.imports.liveSource(sessionId)) return;
    await this.tellLive(sessionId, f, null);
  }

  // The same, when only the source is known (the page's import): in the background, once the list is read.
  noteLiveLater(sessionId: string) {
    if (!this.drive.configured()) return;
    const l = this.imports.link(sessionId);
    if (!l) return;
    (async () => {
      const raws = await this.drive.raws();
      const raw = raws.find((r) => !r.host && (r.transcript === l.source_path || ["session", "thread"].some((k) => r[k] === l.source_id)));
      if (raw) await this.noteLive(sessionId, await this.drive.find(av.rowId(raw)));
    })().catch((e) => this.d.errors.capture("server", e, { at: "takeover note live", session: sessionId }));
  }

  // The sessions the agent view runs now, with what an import and a take-over of each take.
  // `unset`: no agent view is configured, so nothing is listed (not "none run").
  async running(): Promise<{ sessions: (Row & { harness: Harness | null; transcript_path: string | null; imported?: string })[]; not_listed?: string[]; unset?: true }> {
    if (!this.drive.configured()) return { sessions: [], not_listed: ["no agent view is set: name its program in Settings, Sessions elsewhere"], unset: true };
    let raws: av.Raw[];
    try {
      raws = await this.drive.raws();
    } catch (e) {
      return { sessions: [], not_listed: [(e as Error).message] };
    }
    const out = raws.filter((r) => (av.KINDS as readonly string[]).includes(r.tool) && r.live === true).map((raw) => {
      const busy = inFlight(raw);
      const r = { ...toRow(raw), ...(busy ? { state: "working" as const, detail: busy } : {}) };
      const harness = (["claude", "codex", "agy"] as const).find((k) => k === r.kind) ?? null;
      const t = !raw.host && typeof raw.transcript === "string" ? raw.transcript : null;
      const src = harness && !raw.host ? (t ? this.imports.byPath(t, harness) : harness === "agy" && raw.session ? this.imports.find("agy", raw.session) : undefined) : undefined;
      const link = src ? this.imports.links(src.harness, src.id)[0] : undefined;
      return { ...r, harness, transcript_path: src?.path ?? t, imported: link?.session_id };
    });
    return { sessions: out };
  }
}

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
