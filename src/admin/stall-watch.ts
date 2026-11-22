// The stall watcher: what the daemon's main thread was doing while its loop
// did not run.
//
// The loop finds a stall only after it (stall.ts), and from inside it can
// say one thing: whether the process used processor time. That does not
// tell a sync of the store's log from a wait for a child from a machine
// that gave the daemon no processor, and those need opposite fixes.
//
// A thread of its own can look while the loop is held
// (stall-watch-worker.ts). It reads one shared number ten times a second
// while the daemon works (once a second while it is idle, when it also looks
// at the main thread itself), and nothing else while the loop is well. When
// the loop is late, it samples the main thread from Linux's /proc until the
// loop runs again. The loop then asks what the samples say (stall-cause.ts)
// and puts the answer in the stall's row.
//
// - It never holds the loop: the loop writes a number and posts a message;
//   the answer comes as a message, and a row whose answer does not come
//   within ASK_MS is written without it.
// - It reads files of its own process from its own thread: no ptrace, no
//   privilege, and no stall it could cause.
// - Its samples are a ring of fixed length.
// - Linux only. Elsewhere, and after a failure of the watcher (reported
//   once), a stall says its cause is not known.
//
// It cannot see JavaScript frames of another thread: a stall that computed
// is named by the section the daemon timed (stall.ts), not by the watcher.
// One thing it is told: which statement the store's connection is in, by a
// number the connection writes around each one (src/core/statement-label.ts).
// A stall in a read of the database, a write to its log or a wait for its
// write lock then says which query it was.
// Bun's profiler (node:inspector) samples the thread that starts it, and a
// held loop cannot start one.
import { askerCell, askerLabels } from "../core/asker.ts";
import { realOf } from "../core/paths.ts";
import { type Arch, type Cause, type Dirs, STOPPED, unknown } from "./stall-cause.ts";
import { SENT } from "./stall-beat.ts";
import { dropBeat, nudge, shareBeat } from "./stall.ts";
import { onLabels, statementCell } from "../core/statement-label.ts";

declare const __KEEL_STALLWATCH_JS__: string | undefined;

// How long a stall's row waits for the watcher's answer.
const ASK_MS = 2000;
// This many answers in a row that did not come: the thread is taken to be stuck, and is reported and ended.
const UNANSWERED = 2;

let program: string | undefined;
function programUrl(): string {
  if (program) return program;
  return (program = typeof __KEEL_STALLWATCH_JS__ === "string"
    ? URL.createObjectURL(new Blob([__KEEL_STALLWATCH_JS__], { type: "application/javascript" }))
    : new URL("./stall-watch-worker.ts", import.meta.url).href);
}

const NOT_HERE = "the cause is not known on this platform (the watcher reads Linux's /proc)";

const BY_SIGNAL = "stopped by a signal (continued by SIGCONT)";
// The words of a pause, wherever they stand, become the signal's.
const signalled = (text: string) => text.replace(/not running: stopped, or waiting for memory \([^)]*\)/g, BY_SIGNAL).split(STOPPED).join(BY_SIGNAL);
const bySignal = (c: Cause): Cause => ({
  ...c, cont: true, text: signalled(c.text),
  ...(c.also ? { also: signalled(c.also) } : {}),
  shares: c.shares.map((s) => (s.kind === "stopped" ? { ...s, what: BY_SIGNAL } : s)),
});

export class StallWatch {
  private worker?: Worker;
  private asked = new Map<number, (c: Cause | undefined) => void>();
  private ids = 0;
  private off?: string;
  private unanswered = 0;
  private stopped = false;
  private cells?: Int32Array;
  private unlabel?: () => void;
  // The watcher's thread id once it runs (its processor time is under /proc/<pid>/task/<tid>).
  tid?: number;
  // The last SIGCONT, on the monotonic clock: a stall that ends with one was a stop by a signal.
  private continued = 0;
  private onCont = () => { this.continued = performance.now(); };
  // A stall the watcher saw while the loop was idle and no timer of the loop's was due (StallMonitor.unsaid).
  onHeld?: (ms: number) => void;

  constructor(private dirs: Dirs, private onError: (e: unknown) => void = () => {}, private workerProgram?: string, private askMs = ASK_MS) {}

  get running() { return !!this.worker; }
  // Why no watcher runs, when none does.
  get why() { return this.off; }

  start() {
    if (this.worker || this.off || this.stopped) return;
    if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) { this.off = NOT_HERE; return; }
    let w: Worker;
    const cells = new SharedArrayBuffer(16);
    try {
      w = new Worker(this.workerProgram ?? programUrl());
    } catch (e) {
      return this.fail(e);
    }
    (w as Worker & { unref?: () => void }).unref?.(); // the thread never holds the process open
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { ready: true; tid?: number } | { id: number; cause: Cause } | { error: string } | { held: { ms: number } };
      if ("error" in m) return this.fail(new Error(`The stall watcher stopped: ${m.error}`));
      if ("ready" in m) { this.tid = m.tid; return; }
      if ("held" in m) { try { this.onHeld?.(m.held.ms); } catch (e) { this.onError(e); } return; }
      const done = this.asked.get(m.id);
      this.asked.delete(m.id);
      this.unanswered = 0;
      done?.(m.cause);
    };
    w.onerror = (ev: ErrorEvent) => this.fail(new Error(`The stall watcher stopped: ${ev.message || "its thread failed"}`));
    // A thread that ended without a word (it exited, or was ended from outside) is a failure as well.
    w.addEventListener("close", () => { if (this.worker === w) this.fail(new Error("The stall watcher stopped: its thread ended")); });
    this.worker = w;
    shareBeat((this.cells = new Int32Array(cells)));
    // A descriptor's link under /proc is a real path: the folders are compared as where their links land.
    this.post(w, { start: { beat: cells, stmt: statementCell.buffer, ask: askerCell.buffer, dirs: { state: realOf(this.dirs.state), config: realOf(this.dirs.config) }, arch: process.arch as Arch } });
    // The labels of the store's statements, as they are made: a sample says which statement the loop was in.
    const unlabel = onLabels((id, text) => { try { this.post(w, { label: [id, text] }); } catch {} });
    // And of who asked for a read that holds the loop (src/core/asker.ts): the sample says that too.
    const unask = askerLabels((id, text) => { try { this.post(w, { asker: [id, text] }); } catch {} });
    this.unlabel = () => { unlabel(); unask(); };
    process.on("SIGCONT", this.onCont);
  }

  // The thread blocks between its looks and takes a message only when it is
  // told one waits: the count of messages sent, and its wait ended.
  private post(w: Worker, m: unknown) {
    if (this.cells) Atomics.add(this.cells, SENT, 1);
    w.postMessage(m);
    if (this.cells) nudge(this.cells);
  }

  // Reported once; from then on a stall says the watcher is off.
  private fail(e: unknown) {
    if (this.off || this.stopped) return;
    this.off = "the watcher is off since it failed (see its own error)";
    this.end();
    try { this.onError(e); } catch {}
  }

  private end() {
    const w = this.worker;
    this.worker = undefined;
    if (this.cells) dropBeat(this.cells);
    this.unlabel?.();
    this.unlabel = undefined;
    process.off("SIGCONT", this.onCont);
    try { w?.terminate(); } catch {}
    for (const done of this.asked.values()) done(undefined);
    this.asked.clear();
  }

  // For good: a watcher that was stopped is not started again, and what its thread says while it ends is not a failure.
  stop() { this.stopped = true; this.end(); }

  // What the watcher saw of the stall that just ended: `ms` long, somewhere
  // in the last `windowMs`. Always answers, within ASK_MS.
  ask(ms: number, windowMs: number): Promise<Cause> {
    const w = this.worker;
    if (!w) return Promise.resolve(unknown(this.off ?? "the watcher was not running"));
    const ended = performance.now();
    return new Promise<Cause>((resolve) => {
      const id = ++this.ids;
      const timer = setTimeout(() => {
        this.asked.delete(id);
        resolve(unknown("the watcher did not answer in time"));
        if (++this.unanswered >= UNANSWERED) this.fail(new Error(`The stall watcher stopped: it did not answer ${UNANSWERED} stalls in a row`));
      }, this.askMs);
      this.asked.set(id, (c) => {
        clearTimeout(timer);
        if (!c) return resolve(unknown(this.off ?? "the watcher stopped"));
        // A SIGCONT as the stall ended: the stop was a signal's, and the watcher's word for it says so.
        // The signal's own callback may still be on its way: it gets a moment.
        const continued = () => this.continued > 0 && Math.abs(this.continued - ended) < 1000;
        const named = () => resolve(continued() ? bySignal(c) : c);
        if (c.shares.some((s) => s.kind === "stopped") && !continued()) setTimeout(named, 50);
        else named();
      });
      try { this.post(w, { ask: id, ms, window_ms: windowMs }); } catch (e) { this.asked.get(id)?.(undefined); this.fail(e); }
    });
  }
}
