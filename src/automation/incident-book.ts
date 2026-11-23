// What just broke, across sessions: one incident per cause (a provider that
// cannot be reached or keeps failing, a credential or quota it refuses, the
// judge that cannot review, the daemon's loop stalling, the daemon going down
// by itself, the store's disk), with what it touched, what Keel does about it,
// what the owner can do, and when it cleared. Pure: the daemon feeds it what
// it already records (turn failures, the provider's shared wait, the judge's
// verdicts, stall rows, start records, the store's disk state) and keeps what
// it returns (src/automation/incidents.ts). The page reads the same words.
//
// One failure is the session's own (its failure notice says it). A cause is
// an incident when it repeats across the daemon: in two sessions, or three
// times, within WINDOW_MS. A provider the shared wait confirmed, a daemon that
// went down by itself and a disk that is full are incidents at once: each is
// already more than one session's matter.

export type IncidentCause = "provider" | "account" | "judge" | "stall" | "restarts" | "disk";

// A session it touched: an agent (`parent`) or a session of the owner's.
// `state`: how it stands now. `n`: how many of its turns failed.
export type Touched = { id: string; title: string; parent?: string | null; state: "failed" | "waiting" | "went_on" | "cut"; n: number; last: number };

export type Incident = {
  id: string;
  key: string;
  cause: IncidentCause;
  // The provider's name, for the provider and account causes.
  label: string;
  // The failure class most of it was (src/admin/classes.ts), or the cause's own word; `classes`: each one's count.
  cls: string;
  classes?: Record<string, number>;
  since: number;
  last: number;
  // Every occurrence: failed turns, refused reviews, stalls, stops.
  count: number;
  // Turns that failed (an agent's or a session's): work that stopped and waits on the owner.
  failed: number;
  touched: Touched[];
  // Sessions it touched past those named.
  more: number;
  // The last words of the failure, for the row's detail.
  sample: string;
  // The provider's shared wait holds sessions (held, not failed).
  held: boolean;
  // A held wait that passed the owner's alert time (src/providers/outage.ts, alertMs).
  long?: boolean;
  cleared?: number;
  cleared_how?: string;
  // When the one alert for it went out.
  notified?: number;
};

// A thing that happened, of a cause. `session`: where (none for the daemon's own).
export type Hit = {
  key: string; cause: IncidentCause; label?: string; cls: string; at: number; message: string;
  session?: { id: string; title: string; parent?: string | null };
  // A turn failed (counts in `failed`). Otherwise an occurrence that stopped no turn.
  failed?: boolean;
  // Stand-alone: an incident at once (a stop of the daemon, a full disk).
  now?: boolean;
};

// The numbers, from the failed turns of the daemon's history (20 to 23 Nov: 110 failed turns, 45
// of a provider's or account's class): every storm began with failures 0 to 12 s apart (once 62 s,
// a rate limit), and a session that repeats its own failure does so 160 to 370 s apart. A window of
// two minutes takes every storm from its second session and leaves one session's repeats its own;
// two sessions that failed of one class three or four minutes apart (twice in the history) stay
// two failures, each told on its own.
export const WINDOW_MS = 2 * 60_000;
// Three of a cause, or two sessions, make an incident. Every incident in the history opened on its
// second session; three of one session is for a cause with no session (stalls, the judge).
export const REPEATS = 3;
export const SESSIONS = 2;
// A cause with no sign of its end (no answer, no verdict) is over when nothing of it came for this
// long. Inside an incident of the history failures came at most 365 s apart; two incidents of one
// cause were three hours apart or more. Ten minutes keeps one outage one incident and two apart.
export const QUIET_MS = 5 * WINDOW_MS;
// How often a held wait's time moves on while nothing else of it does.
const HELD_BEAT_MS = 60_000;
// Sessions named on a row; the rest are counted.
export const NAMED = 60;

// Provider classes that are the provider's matter, not the session's (a request too large, a refusal over its content are the session's).
const PROVIDER_CLS = new Set(["unreachable", "server", "overloaded", "stream_drop", "rate_limit"]);
const ACCOUNT_CLS = new Set(["auth", "quota"]);
export const causeOfClass = (cls: string): IncidentCause | undefined => (PROVIDER_CLS.has(cls) ? "provider" : ACCOUNT_CLS.has(cls) ? "account" : undefined);

// How the daemon before this start went down (its start record, src/admin/life.ts), and whether
// that is an incident: killed (no stop at all) and a crash are; a signal (systemd's stop or restart
// sends SIGTERM), a stop and a restart are planned and are not.
export const wentDownByItself = (how: string | undefined): how is "killed" | "crash" => how === "killed" || how === "crash";

const pl = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The row's title: what broke, in a few words.
export function titleOf(i: Pick<Incident, "cause" | "label" | "cls" | "count" | "held">): string {
  const who = i.label || "A provider";
  switch (i.cause) {
    case "provider":
      if (i.held || i.cls === "unreachable") return `${who} cannot be reached`;
      if (i.cls === "overloaded") return `${who} is overloaded`;
      if (i.cls === "rate_limit") return `${who} limits requests`;
      if (i.cls === "stream_drop") return `${who} drops its answers`;
      return `${who} is failing`;
    case "account": return i.cls === "quota" ? `${who} refuses for quota or billing` : `${who} refuses its credential`;
    case "judge": return "The judge cannot review calls";
    case "stall": return "Keel's loop stalls";
    case "restarts": return i.count > 1 ? `Keel went down by itself ${i.count} times` : "Keel went down by itself";
    case "disk": return i.cls === "silent" ? "Keel's disk does not answer" : "Keel's disk is full";
  }
}

// What Keel does about it, said plainly.
export function doingOf(i: Pick<Incident, "cause" | "cls" | "held" | "failed"> & { touched?: Touched[] }): string {
  switch (i.cause) {
    case "provider":
      if (i.held && !i.failed) return "Keel holds the work and tries the provider again every few seconds: it goes on by itself when it answers. Nothing failed.";
      if (i.held) return "Keel holds the work that still runs and tries again every few seconds. The turns that failed before the wait stay failed.";
      return "Each request is tried again a few times; turns whose tries ran out failed and wait for you.";
    case "account": return "Turns on this provider fail at once: a refused credential or quota is not tried again.";
    case "judge": return "Calls that need the judge's review are refused (it fails closed); the rest run.";
    case "stall": return "Work goes on between stalls. Each stall is in Errors with what took the time.";
    case "restarts": return i.touched && !i.touched.length ? "No turn was running, so none was cut." : "Cut turns are resumed, or held for you when they cannot be.";
    case "disk": return "Nothing new is saved. What you send waits and goes out by itself.";
  }
}

// What the owner can do, or that there is nothing to do.
export function youOf(i: Pick<Incident, "cause" | "cls" | "held" | "failed">): string {
  switch (i.cause) {
    case "provider": return i.failed ? "When it answers, tell the failed sessions and agents to go on." : "Nothing to do. If it lasts, check the network or the provider's status.";
    case "account": return i.cls === "quota" ? "Add credit, or wait for the limit to reset." : "Sign in again or set its key in Settings, Providers.";
    case "judge": return "Check the judge's model in Settings, Safety. A refused card can be let through once.";
    case "stall": return "Look at the machine's load, or at the stall rows in Errors for the cause.";
    case "restarts": return "Settings, Daemon says how it went down and what became of each cut turn.";
    case "disk": return "Free some space on the disk that holds Keel's state.";
  }
}

// What it touched, in one line: "9 agents and 1 session: 13 turns failed, 4 waiting", "3 sessions waiting".
export function radiusOf(i: Pick<Incident, "touched" | "more" | "failed" | "cause" | "count">): string {
  const agents = i.touched.filter((t) => t.parent).length;
  const own = i.touched.length - agents + i.more;
  const who = [agents ? pl(agents, "agent") : "", own ? pl(own, "session") : ""].filter(Boolean).join(" and ");
  const waiting = i.touched.filter((t) => t.state === "waiting").length;
  const wentOn = i.touched.filter((t) => t.state === "went_on").length;
  const cut = i.touched.filter((t) => t.state === "cut").length;
  if (i.cause === "stall" || (i.cause === "judge" && !who)) return `${pl(i.count, i.cause === "stall" ? "stall" : "refused review")}${who ? ` in ${who}` : ""}`;
  // All of them in one state: said once ("3 sessions waiting", "3 agents went on").
  const all = i.touched.length && !i.more && !i.failed;
  if (all && waiting === i.touched.length) return `${who} waiting`;
  if (all && wentOn === i.touched.length) return `${who}: all went on`;
  const bits = [i.failed ? `${pl(i.failed, "turn")} failed` : "", waiting ? `${waiting} waiting` : "", wentOn ? `${wentOn} went on` : "", cut ? `${cut} cut by the stop` : ""].filter(Boolean).join(", ");
  return who ? `${who}${bits ? `: ${bits}` : ""}` : bits;
}

// The row as one line: the activity list's, the alert's body, a terminal's.
// A radius with nothing in it (a stop of the daemon that cut no turn) is left out.
const sentences = (...xs: string[]) => xs.filter(Boolean).map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)).join(" ");
export const lineOf = (i: Incident) => (i.cleared ? sentences(`${titleOf(i)} (cleared: ${i.cleared_how ?? "over"})`, radiusOf(i)) : sentences(titleOf(i), radiusOf(i), doingOf(i)));
// The alert's body: what it touched and what Keel does.
export const bodyOf = (i: Incident) => sentences(radiusOf(i), doingOf(i));

// Whether the owner is told now: once, when work failed or stopped because of it, at once; a
// held wait only when it lasts (outage.ts, alertMs): a short one needs nothing of the owner.
export const owesAlert = (i: Incident) => !i.notified && !i.cleared && (i.cause !== "provider" || i.failed > 0 || !!i.long);

type Pending = { hits: Hit[] };

export class IncidentBook {
  private open = new Map<string, Incident>();
  private pending = new Map<string, Pending>();
  private recent: Incident[] = [];
  constructor(private makeId: () => string = () => crypto.randomUUID()) {}

  list(): Incident[] { return [...this.open.values()]; }
  get(key: string): Incident | undefined { return this.open.get(key); }
  cleared(): Incident[] { return this.recent; }

  // An incident kept from before a restart: open again as it was.
  restore(i: Incident) {
    if (i.cleared) return;
    this.open.set(i.key, { ...i, touched: [...i.touched] });
  }

  // One occurrence. Returns the incident it is part of when there is one (new or grown).
  hit(h: Hit): Incident | undefined {
    const had = this.open.get(h.key);
    if (had) { this.fold(had, h); return had; }
    const p = this.pending.get(h.key) ?? { hits: [] };
    p.hits = p.hits.filter((x) => h.at - x.at <= WINDOW_MS);
    p.hits.push(h);
    this.pending.set(h.key, p);
    const sessions = new Set(p.hits.map((x) => x.session?.id).filter(Boolean));
    if (!h.now && p.hits.length < REPEATS && sessions.size < SESSIONS) return undefined;
    this.pending.delete(h.key);
    const first = p.hits[0]!;
    const i: Incident = { id: this.makeId(), key: h.key, cause: h.cause, label: h.label ?? "", cls: h.cls, since: first.at, last: first.at, count: 0, failed: 0, touched: [], more: 0, sample: "", held: false };
    for (const x of p.hits) this.fold(i, x);
    this.open.set(i.key, i);
    return i;
  }

  private fold(i: Incident, h: Hit) {
    i.count++;
    i.since = Math.min(i.since, h.at);
    i.last = Math.max(i.last, h.at);
    i.sample = h.message.slice(0, 400);
    if (h.label) i.label = h.label;
    // A held wait says "cannot be reached"; otherwise the class most of it was.
    const c = (i.classes ??= {});
    c[h.cls] = (c[h.cls] ?? 0) + 1;
    if (!i.held) i.cls = Object.entries(c).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    if (h.failed) i.failed++;
    if (h.session) this.touch(i, h.session, h.failed ? "failed" : h.cause === "restarts" ? "cut" : undefined, h.at, h.failed ? 1 : 0);
  }

  private touch(i: Incident, s: { id: string; title: string; parent?: string | null }, state: Touched["state"] | undefined, at: number, n: number) {
    const t = i.touched.find((x) => x.id === s.id);
    if (t) {
      t.n += n;
      t.last = Math.max(t.last, at);
      if (state) t.state = state;
      if (s.title) t.title = s.title;
      return;
    }
    if (i.touched.length >= NAMED) { i.more++; return; }
    i.touched.push({ id: s.id, title: s.title, parent: s.parent ?? null, state: state ?? "failed", n, last: at });
  }

  // The provider's shared wait holds these sessions now (src/providers/outage.ts): an incident at
  // once, the sessions that left it went on. `long`: it lasted past the alert time.
  held(o: { key: string; label: string; since: number; message: string; sessions: { id: string; title: string; parent?: string | null }[]; long?: boolean }, at: number): Incident {
    let i = this.open.get(o.key);
    if (!i) {
      const p = this.pending.get(o.key);
      this.pending.delete(o.key);
      i = { id: this.makeId(), key: o.key, cause: "provider", label: o.label, cls: "unreachable", since: o.since, last: at, count: 0, failed: 0, touched: [], more: 0, sample: o.message.slice(0, 400), held: true };
      for (const x of p?.hits ?? []) this.fold(i, x);
      this.open.set(o.key, i);
    }
    const was = JSON.stringify([i.held, i.since, i.sample, i.long, i.touched.map((t) => [t.id, t.state])]);
    i.held = true;
    i.cls = "unreachable";
    i.since = Math.min(i.since, o.since);
    if (o.message) i.sample = o.message.slice(0, 400);
    if (o.long) i.long = true;
    const now = new Set(o.sessions.map((s) => s.id));
    for (const t of i.touched) if (t.state === "waiting" && !now.has(t.id)) t.state = "went_on";
    for (const s of o.sessions) {
      const t = i.touched.find((x) => x.id === s.id);
      if (t?.state === "waiting") continue;
      this.touch(i, s, "waiting", at, 0);
    }
    // The wait is synced at each of its tries: what it holds is written when it moved, and its time
    // at most once a minute (a held wait is never quiet; a start that finds it no longer held is).
    const moved = was !== JSON.stringify([i.held, i.since, i.sample, i.long, i.touched.map((t) => [t.id, t.state])]);
    if (moved || at - i.last >= HELD_BEAT_MS) i.last = Math.max(i.last, at);
    return i;
  }

  // Its end: the provider answered, the judge gave a verdict, the disk has room. Returns the cleared incident.
  clear(key: string, how: string, at: number): Incident | undefined {
    this.pending.delete(key);
    const i = this.open.get(key);
    if (!i) return undefined;
    // A provider that answered one request while sessions still wait for it is not back for them.
    if (i.held && i.touched.some((t) => t.state === "waiting")) return undefined;
    for (const t of i.touched) if (t.state === "waiting") t.state = "went_on";
    i.cleared = at;
    i.cleared_how = how;
    this.open.delete(key);
    this.recent = [i, ...this.recent.filter((x) => x.key !== key || x.id !== i.id)].slice(0, 20);
    return i;
  }

  // A turn on a provider went through. A provider that keeps failing between its answers is not back: the
  // incident ends at an answer only when nothing of it came in the window, else it ends when it goes
  // quiet or at a later answer (one alert an episode, not one each time it answers once).
  answered(key: string, how: string, at: number): Incident | undefined {
    const i = this.open.get(key);
    if (i && !i.held && at - i.last <= WINDOW_MS) return undefined;
    return this.clear(key, how, at);
  }

  // The held wait is over (the provider answered, or nobody waits any more).
  unheld(key: string, how: string, at: number): Incident | undefined {
    const i = this.open.get(key);
    if (!i) return undefined;
    i.held = false;
    return this.clear(key, how, at);
  }

  // Those with no sign of their end that went quiet. A held wait is never quiet while it holds.
  quiet(at: number): Incident[] {
    const out: Incident[] = [];
    for (const i of [...this.open.values()]) {
      if (i.held) continue;
      if (at - i.last < QUIET_MS) continue;
      const c = this.clear(i.key, `nothing more of it for ${Math.round(QUIET_MS / 60_000)} min`, at);
      if (c) out.push(c);
    }
    for (const [k, p] of this.pending) if (p.hits.every((h) => at - h.at > WINDOW_MS)) this.pending.delete(k);
    return out;
  }

  // Whether a failure alert is this incident's to tell: the session it is about (an agent's own,
  // for an alert of its parent's) failed of the incident's cause and of a class the incident holds,
  // within the window. A failure of another class (a reply cut at its limit, a request too large, a
  // tool) is the session's own, told as it was. One alert an incident, never one a session.
  absorbs(sessionId: string, cls: string | undefined, at: number): Incident | undefined {
    const cause = cls ? causeOfClass(cls) : undefined;
    if (!cause) return undefined;
    for (const i of this.open.values()) {
      if (i.cause !== cause || !i.classes?.[cls!]) continue;
      if (i.touched.some((t) => t.id === sessionId && at - t.last <= WINDOW_MS)) return i;
    }
    return undefined;
  }
}
