// A provider that cannot be reached: the wait every session of the provider shares.
// Which failures are that is said in ./unreachable.ts (no token was spent on such
// a request, so it is safe to send again any number of times). A turn is not
// counted a retry for one: it waits until the provider answers
// (research/provider-outage.md).
//
// The wait is one per provider, not one per session: one try at a time, a
// probe of the provider first (its model listing) and then one waiting request,
// so twelve agents on a dead network send nothing. The rest go when that one
// is answered, spread over a few seconds.
import { readFileSync, writeFileSync } from "node:fs";
import { unreachable } from "./unreachable.ts";

// The wait's numbers, each with its reason.
export const OUTAGE = {
  // The first tries come quickly: a dropped socket or a DNS hiccup heals within seconds.
  quickMs: [1_000, 2_000, 4_000, 8_000],
  // Then one try every 15 to 30 s, with jitter: inside the 5 to 60 s the leading
  // open harness uses, and slow enough that a provider that is down for hours
  // gets a few small requests a minute from the whole daemon.
  slowMinMs: 15_000,
  slowMaxMs: 30_000,
  // A try that fails this many times after the first failure is an outage (about
  // 3 s): it is told once. A shorter one is a blip and says nothing.
  confirmTries: 2,
  // A probe that does not answer in this long counts as no answer (a black hole).
  probeMs: 10_000,
  // The request let through to try the provider gets this long to be answered
  // or to fail before another one is let through.
  canaryMs: 30_000,
  // The waiting requests go this far apart once the provider answers, and all
  // of them within the spread: no burst at the provider, and none waits long.
  staggerMs: 250,
  spreadMs: 5_000,
  // A provider that has not answered for a week will not: the wait ends and the
  // turn fails as unreachable. Longer than a night or a weekend offline.
  maxMs: Number(process.env.KEEL_UNREACHABLE_MAX_MS) || 7 * 86_400_000,
  // An outage open when the daemon stopped is taken up again by a request that
  // fails within this long of the start (the resumed turns do, within a minute).
  carryMs: 10 * 60_000,
};

export type Timing = typeof OUTAGE;

// How long until try number `tries` (0 is the first after the failure).
export function outageDelayMs(tries: number, rand: () => number = Math.random, t: Timing = OUTAGE): number {
  return tries < t.quickMs.length ? t.quickMs[tries]! : Math.round(t.slowMinMs + rand() * (t.slowMaxMs - t.slowMinMs));
}

// How far apart `n` waiting requests go once the provider answers.
export const staggerGapMs = (n: number, t: Timing = OUTAGE) => (n <= 1 ? 0 : Math.min(t.staggerMs, t.spreadMs / (n - 1)));

// An outage as the rest of the daemon reads it. `sessions`: the ones that wait in it now.
export type Outage = { provider: string; since: number; message: string; tries: number; confirmed: boolean; sessions: string[] };
export type OutageEvents = {
  // The outage is real (confirmTries failed): said once.
  open?(o: Outage): void;
  // A session began to wait in an outage, or left it (`o` undefined).
  waiting?(session: string, o: Outage | undefined): void;
  // The outage is over after `ms`. `answered`: the provider answered; false when
  // nobody waits for it any more or the wait reached its ceiling.
  close?(o: Outage, ms: number, answered: boolean): void;
};

type Timer = ReturnType<typeof setTimeout>;
type Waiter = { session?: string; error: unknown; go(): void; fail(e: unknown): void; timer?: Timer };
// `sessions`: the ones that wait in it, the one whose request is out to try the provider included.
type Open = { provider: string; since: number; message: string; tries: number; confirmed: boolean; waiters: Waiter[]; sessions: Set<string>; timer?: Timer; canary: boolean; probing: boolean };
type Opts = {
  // Asks the provider something small. Resolves when it answered anything, throws what the
  // transport threw. Absent: the first waiting request is the try.
  probe?: (provider: string) => Promise<unknown>;
  // Where open outages are kept across a restart.
  file?: string;
  now?: () => number;
  rand?: () => number;
  // Other numbers than OUTAGE's (a test's).
  timing?: Partial<Timing>;
};

const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const words = (e: unknown) => String((e as any)?.message ?? e ?? "").slice(0, 300);

export class Outages {
  private opens = new Map<string, Open>();
  // Outages the last daemon left open: the first failure of the provider takes up its start.
  private carried = new Map<string, { since: number; message: string }>();
  private events: OutageEvents = {};
  // The daemon stops: what is open is kept as it is for the next one.
  private stopped = false;
  private now: () => number;
  private rand: () => number;
  private t: Timing;

  constructor(private o: Opts = {}) {
    this.now = o.now ?? Date.now;
    this.rand = o.rand ?? Math.random;
    this.t = { ...OUTAGE, ...o.timing };
    if (o.file) {
      // `at`: when the outage was last seen open. One the last daemon saw open a while ago is over or forgotten.
      const now = this.now();
      try {
        for (const [k, v] of Object.entries<any>(JSON.parse(readFileSync(o.file, "utf8")))) {
          if (typeof v?.since === "number" && now - Number(v.at ?? 0) <= this.t.carryMs) this.carried.set(k, { since: v.since, message: String(v.message ?? "") });
        }
      } catch {}
      // What this daemon carries is dropped when no request took it up in time.
      if (this.carried.size) setTimeout(() => { if (this.carried.size) { this.carried.clear(); this.persist(); } }, this.t.carryMs).unref?.();
    }
  }

  listen(events: OutageEvents) { this.events = events; }

  private info(o: Open): Outage {
    return { provider: o.provider, since: o.since, message: o.message, tries: o.tries, confirmed: o.confirmed, sessions: [...o.sessions] };
  }

  // The outage a session waits in.
  of(session: string): Outage | undefined {
    for (const o of this.opens.values()) if (o.sessions.has(session)) return this.info(o);
    return undefined;
  }

  list(): Outage[] {
    return [...this.opens.values()].map((o) => this.info(o));
  }

  // Whether an outage of the provider is known: one that is open, or one the last daemon left open.
  known(provider: string): boolean {
    return this.opens.has(provider) || this.carried.has(provider);
  }

  private tell<K extends keyof OutageEvents>(k: K, ...args: Parameters<NonNullable<OutageEvents[K]>>) {
    try { (this.events[k] as any)?.(...args); } catch (e) { console.error(`[outage] ${k}: ${(e as Error)?.message ?? e}`); }
  }

  private persist() {
    if (!this.o.file || this.stopped) return;
    const at = this.now();
    const kept: Record<string, { since: number; message: string; at: number }> = {};
    for (const o of this.opens.values()) if (o.confirmed) kept[o.provider] = { since: o.since, message: o.message, at };
    for (const [k, v] of this.carried) kept[k] ??= { ...v, at };
    try { writeFileSync(this.o.file, JSON.stringify(kept)); } catch {}
  }

  private join(o: Open, session: string | undefined) {
    if (!session || o.sessions.has(session)) return;
    o.sessions.add(session);
    this.tell("waiting", session, this.info(o));
  }

  private leave(o: Open, session: string | undefined) {
    if (session && o.sessions.delete(session)) this.tell("waiting", session, undefined);
  }

  // A session's turn is over (stopped, parked): it waits in nothing.
  left(session: string) {
    for (const o of [...this.opens.values()]) {
      this.leave(o, session);
      this.idle(o);
    }
  }

  // Nobody waits for the provider any more: nothing is tried.
  private idle(o: Open) {
    if (!o.waiters.length && !o.sessions.size && !o.probing) this.end(o, false);
  }

  // A request to `provider` failed as unreachable. Resolves when it may be sent
  // again: it is the one let through to try, or the provider answered. Rejects
  // when the signal aborts, and with the failure itself at the ceiling.
  wait(provider: string, e: unknown, signal: AbortSignal, who: { session?: string } = {}): Promise<void> {
    if (signal.aborted) return Promise.reject(aborted());
    const now = this.now();
    let o = this.opens.get(provider);
    if (!o) {
      const kept = this.carried.get(provider);
      this.carried.delete(provider);
      o = { provider, since: kept?.since ?? now, message: words(e), tries: 0, confirmed: !!kept, waiters: [], sessions: new Set(), canary: false, probing: false };
      this.opens.set(provider, o);
    } else if (o.canary) {
      // The request let through to try the provider failed too.
      o.canary = false;
      clearTimeout(o.timer);
      o.timer = undefined;
      this.failed(o);
    }
    o.message = words(e);
    if (now - o.since >= this.t.maxMs) {
      this.giveUp(o);
      return Promise.reject(e);
    }
    const at = o;
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        session: who.session, error: e,
        go: () => { clearTimeout(w.timer); signal.removeEventListener("abort", onAbort); resolve(); },
        fail: (err) => { clearTimeout(w.timer); signal.removeEventListener("abort", onAbort); reject(err); },
      };
      const onAbort = () => {
        clearTimeout(w.timer);
        const i = at.waiters.indexOf(w);
        if (i >= 0) at.waiters.splice(i, 1);
        this.leave(at, who.session);
        this.idle(at);
        reject(aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      at.waiters.push(w);
      this.join(at, who.session);
      this.arm(at);
    });
  }

  private arm(o: Open) {
    if (o.timer || o.probing || this.opens.get(o.provider) !== o) return;
    o.timer = setTimeout(() => this.tried(o), outageDelayMs(o.tries, this.rand, this.t));
  }

  // One more try failed.
  private failed(o: Open) {
    o.tries++;
    if (o.confirmed) return this.persist();
    if (o.tries < this.t.confirmTries) return;
    o.confirmed = true;
    this.persist();
    this.tell("open", this.info(o));
  }

  // A try, from a timer: what it throws is said and the wait goes on with the next one.
  private tried(o: Open) {
    this.attempt(o).catch((e) => {
      console.error(`[outage] a try of ${o.provider} failed: ${(e as Error)?.message ?? e}`);
      o.probing = false;
      this.arm(o);
    });
  }

  private async attempt(o: Open) {
    o.timer = undefined;
    if (this.opens.get(o.provider) !== o) return;
    if (this.now() - o.since >= this.t.maxMs) return this.giveUp(o);
    // The request let through is still out and nothing else waits: looked at again later.
    if (!o.waiters.length) return o.sessions.size ? this.arm(o) : this.end(o, false);
    o.probing = true;
    const up = await this.reach(o.provider);
    o.probing = false;
    if (this.opens.get(o.provider) !== o) return;
    if (!up) {
      this.failed(o);
      return this.arm(o);
    }
    const w = o.waiters.shift();
    if (!w) return this.idle(o);
    // One request tries the provider. It is answered (answered), fails (wait), or is
    // given up on after a while, and then another goes.
    o.canary = true;
    o.timer = setTimeout(() => { o.canary = false; this.tried(o); }, Math.max(outageDelayMs(o.tries, this.rand, this.t), this.t.canaryMs));
    w.go();
  }

  private async reach(provider: string): Promise<boolean> {
    if (!this.o.probe) return true;
    let late: Timer | undefined;
    try {
      // Whichever side loses the race, its failure is nobody's: never a rejection left unhandled.
      const asked = Promise.resolve().then(() => this.o.probe!(provider));
      asked.catch(() => {});
      await Promise.race([
        asked,
        new Promise((_, reject) => { late = setTimeout(() => reject(Object.assign(new Error("the probe timed out: connection timed out"), { kind: "unreachable" })), this.t.probeMs); }),
      ]);
      return true;
    } catch (e) {
      // Any answer, a refusal included, is an answer.
      return !unreachable(e);
    } finally {
      clearTimeout(late);
    }
  }

  // The provider answered a request (a reply began, or a status of its own came back).
  answered(provider: string) {
    if (!this.opens.size && !this.carried.size) return;
    const o = this.opens.get(provider);
    if (!o) {
      // An outage the last daemon left open, and the provider answers now.
      const kept = this.carried.get(provider);
      if (!kept) return;
      this.carried.delete(provider);
      this.persist();
      this.tell("close", { provider, since: kept.since, message: kept.message, tries: 0, confirmed: true, sessions: [] }, this.now() - kept.since, true);
      return;
    }
    this.end(o, true);
  }

  private end(o: Open, answered: boolean) {
    if (this.opens.get(o.provider) !== o) return;
    // A stopping daemon's turns leave because they are parked, not because they stopped waiting.
    if (this.stopped && !answered) return;
    this.opens.delete(o.provider);
    clearTimeout(o.timer);
    o.timer = undefined;
    const info = this.info(o);
    // The waiting requests go one after another, the first at once.
    const gap = staggerGapMs(o.waiters.length, this.t);
    o.waiters.splice(0).forEach((w, i) => {
      if (!i || !gap) return w.go();
      w.timer = setTimeout(w.go, Math.round(i * gap * (0.9 + this.rand() * 0.2)));
    });
    for (const s of [...o.sessions]) this.leave(o, s);
    if (!o.confirmed) return;
    this.persist();
    this.tell("close", info, this.now() - o.since, answered);
  }

  // The ceiling: every waiting request fails with what it failed with.
  private giveUp(o: Open) {
    if (this.opens.get(o.provider) !== o) return;
    this.opens.delete(o.provider);
    clearTimeout(o.timer);
    const info = this.info(o);
    for (const w of o.waiters.splice(0)) w.fail(w.error);
    for (const s of [...o.sessions]) this.leave(o, s);
    this.persist();
    if (o.confirmed) this.tell("close", info, this.now() - o.since, false);
  }

  // The daemon stops: nothing is tried any more. What is open stays in the file for the next
  // daemon, which takes it up where it was: its turns are parked, and go on waiting there.
  stop() {
    if (this.stopped) return;
    this.persist();
    this.stopped = true;
    for (const o of this.opens.values()) clearTimeout(o.timer);
  }
}
