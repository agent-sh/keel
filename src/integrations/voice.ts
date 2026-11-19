// Voice through parlar (agent-sh/parlar), the owner's voice plugin.
//
// parlar's own daemon (parlard) owns the mic and the speaker; Keel reaches it
// through the `parlar` program, the way parlar's harness plugins do:
// - `parlar hook <event>` with the hook JSON on stdin tells parlard about a
//   session: `prompt` when a turn starts, `stop` (or `interrupt`) when it ends,
//   `session-end` when the session goes away.
// - `parlar hook wait` blocks until the owner speaks to the session, then exits 2
//   with the speech on stderr; Keel delivers it as a message (origin `voice`)
//   that wakes the session. One wait runs, for the session that has the voice.
// - `parlar ctl` switches the conversation (talk, mute, unmute, off) and reads
//   its state; `ctl watch` streams parlard's events, so a focus move or a stop
//   made in parlar's own indicator moves or ends the wait.
// - The say tool is a bundled MCP server (`parlar mcp`), deferred like every
//   MCP tool; each call names its session (`_meta.sessionId`, Codex's way, so one
//   process serves every session). A session without the voice, or a
//   subagent's, gets "not spoken" and parlar is never reached.
//
// Voice is on only where the owner turned it on: Talk in a session, or parlar's
// indicator moving the voice to a session the owner talked to. With voice off
// everywhere no parlar process runs.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import type { Session } from "../core/types.ts";
import { registerHooks } from "../engine/hooks.ts";
import type { Engine } from "../engine/turn.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { McpTool } from "../mcp/client.ts";
import shipped from "./parlar_tools.json" with { type: "json" };
import { pumpLines, readText } from "../core/proc.ts";

export const PARLAR_SERVER = "parlar";
// parlar's Codex mode: the session id on every call and hook, speech as plain `[voice uN]` lines.
export const PARLAR_HARNESS = "codex";
const HOOK_MS = 5_000;          // parlar's plugin gives its hooks 5 s
const WAIT_MS = 86_400_000;     // and its waiter a day
const RIDE_OUT_MS = 300_000;    // a parlard that went away is waited for this long,
const RETRY_MS = 3_000;         // retried this often (parlar's own waiter does the same)
export const NOT_SPOKEN = "Voice is not on in this session (not spoken).";

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

// KEEL_PARLAR, else parlar on PATH, ~/.local/bin, or its Claude Code plugin copy.
export function discoverParlar(home: string, env: (k: string) => string | undefined): { bin: string } | { error: string } {
  const set = (k: string) => env(k)?.trim() || undefined;
  const given = set("KEEL_PARLAR");
  if (given) return isFile(given) ? { bin: given } : { error: `KEEL_PARLAR names ${given}, which is not a file` };
  const data = set("XDG_DATA_HOME") ?? join(home, ".local/share");
  const found = [
    ...(set("PATH") ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "parlar")),
    join(home, ".local/bin/parlar"),
    join(data, "parlar/marketplace/claude/parlar/bin/parlar"),
    join(home, ".local/share/parlar/marketplace/claude/parlar/bin/parlar"),
  ].find(isFile);
  return found ? { bin: found } : { error: "parlar is not installed: install it (agent-sh/parlar), or set KEEL_PARLAR to the parlar program" };
}

type Ran = { code: number | null; stdout: string; stderr: string };

const readAll = (s: ReadableStream<Uint8Array>) => readText(s, "parlar").catch(() => "");

export type VoiceState = { available: boolean; running?: boolean; on?: boolean; here?: boolean; mic_muted?: boolean; phase?: string; listening?: boolean };

export class Voice {
  private voiced = new Set<string>();  // sessions the owner gave the voice: their turns tell parlar
  private told = new Set<string>();    // sessions parlard was told of
  private at: string | null = null;    // the session that has the voice
  private wait: { id: number; session: string; stop: () => void } | null = null;
  private watching: { stop: () => void } | null = null;
  private last: any = null;            // parlar's state as the watch last read it
  private next = 1;
  private saved: string;

  constructor(readonly bin: string, private store: Store, private engine: Engine, private bus: Bus, private errors: ErrorTracker) {
    this.saved = join(store.stateDir, "voice.json");
  }

  // One run of parlar, bounded; `stop` ends it early. The process group is killed either way.
  run(args: string[], stdin: unknown, ms: number, stop?: AbortSignal): Promise<Ran | null> {
    let p: ReturnType<typeof Bun.spawn>;
    try {
      const env = { ...process.env };
      delete env.CLAUDE_CODE_ENTRYPOINT; // parlar's waiters stand down in a headless Claude Code run; Keel is not one
      p = Bun.spawn([this.bin, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(JSON.stringify(stdin)), stdout: "pipe", stderr: "pipe", detached: true, env });
    } catch {
      return Promise.resolve(null);
    }
    const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
    return new Promise<Ran | null>((resolve) => {
      const timer = setTimeout(() => { kill(); resolve(null); }, ms);
      const onStop = () => { kill(); clearTimeout(timer); resolve(null); };
      stop?.addEventListener("abort", onStop, { once: true });
      Promise.all([readAll(p.stdout as ReadableStream<Uint8Array>), readAll(p.stderr as ReadableStream<Uint8Array>), p.exited]).then(([stdout, stderr, code]) => {
        clearTimeout(timer);
        stop?.removeEventListener("abort", onStop);
        resolve(stop?.aborted ? null : { code, stdout, stderr });
      });
    });
  }

  hook(event: string, input: unknown) {
    return this.run(["hook", event, "--harness", PARLAR_HARNESS], input, HOOK_MS);
  }

  async ctl(...args: string[]): Promise<string> {
    const r = await this.run(["ctl", ...args], undefined, HOOK_MS);
    if (!r) throw new Error("parlar did not answer");
    if (r.code !== 0) throw new Error((r.stderr.trim() || r.stdout.trim()).replace(/^Error: /, "") || `parlar ctl ${args[0]} failed`);
    return r.stdout;
  }

  private async report(): Promise<any | null> {
    try {
      const r = JSON.parse(await this.ctl("state"));
      if (this.watching) this.last = r;
      return r;
    } catch {
      this.last = null;
      return null;
    }
  }

  hasVoice(id: string) {
    return this.at === id;
  }

  // A session the owner talks to: not a subagent's, not archived.
  private voiceSession(id: string): Session | undefined {
    const s = this.store.session(id);
    return s && !s.archived && !s.parent_id ? s : undefined;
  }

  private on(id: string) {
    this.voiced.add(id);
    this.told.add(id);
  }

  private save(id: string | null) {
    try { id ? writeFileSync(this.saved, JSON.stringify({ session: id })) : rmSync(this.saved, { force: true }); } catch {}
  }

  private savedSession(): string | null {
    try { return JSON.parse(readFileSync(this.saved, "utf8")).session ?? null; } catch { return null; }
  }

  private changed(id?: string) {
    for (const sid of new Set([id, this.at, ...this.voiced].filter(Boolean) as string[]))
      this.state(sid).then((data) => this.bus.emit({ t: "feature", name: "voice", session_id: sid, data })).catch(() => {});
  }

  // The wait for the session; it replaces the one that ran.
  private arm(s: Session, parked: boolean) {
    const id = this.next++;
    this.wait?.stop();
    const ac = new AbortController();
    this.wait = { id, session: s.id, stop: () => ac.abort() };
    void this.run(["hook", parked ? "wait-parked" : "wait", "--harness", PARLAR_HARNESS], { session_id: s.id, cwd: s.workspace }, WAIT_MS, ac.signal).then((r) => {
      if (this.wait?.id === id) this.wait = null;
      if (r?.code === 2) this.deliver(s.id, r.stderr);
      else if (r && this.at === s.id && !ac.signal.aborted && !this.engine.isRunning(s.id)) this.arm(s, false); // a wait that ran out is armed again
    });
  }

  private disarm() {
    this.wait?.stop();
    this.wait = null;
  }

  listening(id: string) {
    return this.wait?.session === id;
  }

  // The voice is at `s` now (or nowhere): the wait follows it.
  private follow(s: Session | undefined) {
    const before = this.at;
    this.at = s?.id ?? null;
    if (!s) this.disarm();
    else if (!this.listening(s.id)) this.arm(s, this.engine.isRunning(s.id));
    if (before !== this.at) this.changed(before ?? undefined);
  }

  // Speech for the session: a message that starts a turn or steers the running one.
  private deliver(id: string, speech: string) {
    const text = speech.trim();
    if (!text || !this.store.session(id)) return;
    try {
      this.engine.send(id, text, { meta: { origin: "voice" } });
    } catch (e) {
      this.errors.capture("server", e, { at: "voice delivery", session: id });
    }
  }

  private focused(report: any): string | null {
    const f = (report?.sessions ?? []).find((x: any) => x.focused === true)?.session;
    return typeof f === "string" && f ? f : null;
  }

  // Read parlar's state; the wait goes where the voice is.
  private async sync() {
    const r = await this.report();
    if (!r) return;
    if (r.active !== true) {
      this.voiced.clear();
      this.save(null);
      this.follow(undefined);
      this.changed();
      return;
    }
    const f = this.focused(r);
    const s = f ? this.voiceSession(f) : undefined;
    if (s) {
      this.on(s.id);
      this.save(s.id);
    }
    this.follow(s);
    this.changed();
  }

  // One watch of parlard's events for the daemon, while any session has voice.
  private startWatch() {
    if (this.watching) return;
    const ac = new AbortController();
    this.watching = { stop: () => ac.abort() };
    void (async () => {
      let downSince: number | null = null;
      while (!ac.signal.aborted) {
        let heard = false;
        let p: ReturnType<typeof Bun.spawn> | null = null;
        try {
          p = Bun.spawn([this.bin, "ctl", "watch"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
          const kill = () => { try { process.kill(-p!.pid, "SIGKILL"); } catch {} };
          ac.signal.addEventListener("abort", kill, { once: true });
          // One state read at a time, in order, as the lines come.
          let chain = Promise.resolve();
          await pumpLines(p.stdout, (line) => {
            heard = true;
            if (!line.includes('"levels"')) chain = chain.then(() => this.sync()); // levels stream all the time; the rest is state
          }, "parlar watch").catch(() => {});
          await chain;
          ac.signal.removeEventListener("abort", kill);
        } catch {}
        if (ac.signal.aborted) return;
        this.last = null;
        if (heard) downSince = null;
        downSince ??= Date.now();
        if (Date.now() - downSince >= RIDE_OUT_MS) {
          // parlard is gone: nothing more to hear until Talk again
          this.stopWatch();
          this.at = null;
          this.disarm();
          this.voiced.clear();
          this.save(null);
          this.changed();
          return;
        }
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    })();
  }

  private stopWatch() {
    this.watching?.stop();
    this.watching = null;
    this.last = null;
  }

  async state(id: string): Promise<VoiceState> {
    const r = this.last ?? (await this.report());
    if (!r) return { available: true, running: false };
    return { available: true, running: true, on: r.active === true, here: this.focused(r) === id, mic_muted: r.mic_muted === true, phase: r.phase, listening: this.listening(id) };
  }

  // The owner's controls.
  async control(id: string, action: string): Promise<VoiceState> {
    const s = this.voiceSession(id);
    if (!s) throw Object.assign(new Error("voice is for the owner's own sessions, not a subagent's or an archived one"), { status: 409 });
    // Mute, Unmute and Stop act on the conversation this session holds. A
    // click from a page that still shows it here after the voice moved to
    // another session changes nothing; the answer names where it went.
    if (action !== "talk") {
      const r = await this.report();
      const f = r?.active === true ? this.focused(r) : null;
      if (f && f !== s.id) {
        this.last = null;
        const state = await this.state(id);
        this.changed(id);
        const t = this.store.session(f)?.title?.trim();
        throw Object.assign(new Error(`Voice moved to ${t || f}; nothing was changed here`), { status: 409, state });
      }
    }
    try {
      if (action === "talk") {
        await this.hook("session-start", { session_id: s.id, cwd: s.workspace });
        await this.ctl("talk", "--session", s.id, "--harness", PARLAR_HARNESS);
        this.on(s.id);
        this.save(s.id);
        this.follow(s);
        this.startWatch();
      } else if (action === "mute") await this.ctl("mute");
      else if (action === "unmute") await this.ctl("unmute");
      else if (action === "stop") {
        await this.ctl("off");
        this.stopWatch();
        this.at = null;
        this.disarm();
        this.voiced.clear();
        this.save(null);
      }
    } catch (e) {
      throw Object.assign(e as Error, { status: (e as any).status ?? 502 });
    }
    this.last = null;
    const st = await this.state(id);
    this.changed(id);
    return st;
  }

  // A turn starts in a voiced session: parlard hears of it; the wait is armed for the turn.
  turnStarted(id: string) {
    if (!this.voiced.has(id)) return;
    const s = this.voiceSession(id);
    if (!s) return;
    void this.hook("prompt", { session_id: s.id, cwd: s.workspace }).then(() => {
      if (this.at === s.id) this.arm(s, true);
    });
  }

  // A turn ended: parlard hears it with the last answer (spoken when the model
  // said nothing); speech that came during the turn is delivered now, else the
  // wait is armed again.
  async turnEnded(id: string, reason: string) {
    if (!this.voiced.has(id)) return;
    const s = this.voiceSession(id);
    if (!s) return;
    const input: any = { session_id: s.id, cwd: s.workspace };
    const last = lineage(this.store.events(id), s.head ?? null).reverse().find((e) => e.kind === "assistant" && e.data.blocks?.some((b: any) => b.type === "text" && b.text.trim()));
    if (last) input.last_assistant_message = last.data.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (reason === "interrupted") await this.hook("interrupt", input);
    else {
      const r = await this.hook("stop", input);
      try {
        const reply = JSON.parse(r?.stdout.trim() || "null");
        if (reply?.decision === "block" && typeof reply.reason === "string") return this.deliver(s.id, reply.reason);
      } catch {}
    }
    if (this.at === s.id) this.arm(s, false);
  }

  // Archived or deleted: its wait stops and parlard forgets it.
  sessionEnded(id: string) {
    this.voiced.delete(id);
    if (!this.told.delete(id)) return;
    if (this.at === id) {
      this.at = null;
      this.disarm();
    }
    if (this.savedSession() === id) this.save(null);
    if (!this.voiced.size) this.stopWatch();
    void this.hook("session-end", { session_id: id, reason: "other" });
  }

  // After a restart the session that had the voice takes it back, unless another has it.
  async resume() {
    const id = this.savedSession();
    if (!id) return;
    const s = this.voiceSession(id);
    if (!s) return this.save(null);
    await this.hook("session-start", { session_id: s.id, cwd: s.workspace });
    const r = await this.report();
    if (!r || r.active !== true) return this.save(null);
    if (!this.focused(r)) {
      try { await this.ctl("focus", s.id); } catch { return; }
    }
    this.on(s.id);
    this.startWatch();
    await this.sync();
  }

  shutdown() {
    this.stopWatch();
    this.disarm();
  }
}

// Wires voice into the daemon: the bundled say tool, the turn hooks, session ends.
export function installVoice(v: Voice | null, m: McpManager | undefined, bus: Bus, found: { bin: string } | { error: string }) {
  if (m) {
    m.addBundled(PARLAR_SERVER, {
      label: "Voice (parlar)",
      config: "bin" in found ? { command: found.bin, args: ["mcp", "--harness", PARLAR_HARNESS] } : null,
      missing: "error" in found ? found.error : undefined,
      tools: shipped.tools as McpTool[],
      instructions: shipped.instructions,
      reads: (tool) => tool === "say",
      async call(tool, input, ctx, run) {
        // Speech only where the owner is talking: refused before parlar is reached.
        if (!v || !v.hasVoice(ctx.sessionId)) return { content: NOT_SPOKEN };
        return run(tool, input, { sessionId: ctx.sessionId });
      },
    });
  }
  if (!v) return;
  registerHooks({ turnEnd: (s, reason) => v.turnEnded(s.id, reason) });
  bus.on((f) => {
    if (f.t === "event" && f.event.kind === "turn_start") v.turnStarted(f.event.session_id);
    else if (f.t === "session" && f.session.archived) v.sessionEnded(f.session.id);
  });
  void v.resume();
}

export const parlarAvailable = (found: { bin: string } | { error: string }) => "bin" in found && existsSync(found.bin);
