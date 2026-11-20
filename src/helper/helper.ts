// The owner's helper: one conversation that never ends, pinned above the
// sessions. It follows the other sessions (read-only tools over Keel, and a
// digest of what happened), checks his mail on a timer, and keeps what is
// worth remembering in a list he can see and edit.
//
// Cost: the helper's context is long and its wakes are far apart, so it asks
// for the long cache lifetime from its first request (cache_long). It wakes
// only for what he would want summed up while away (a failure, a usage
// limit, an error spike, mail that needs him), a burst gathered into one
// wake and wakes kept apart; everything else is told with the next turn,
// whoever starts it. New mail is triaged by the reader model (the cheapest
// the helper's provider lists, or the owner's KEEL_READER_MODEL) before the
// helper hears of it. History stays bounded by compaction, which keeps his
// words verbatim and is told to keep his decisions and commitments; the
// long term is the remembered list, recalled per turn within a budget.
import * as alerts from "../automation/alerts.ts";
import { deliver } from "../automation/core.ts";
import type { Session, StoredEvent } from "../core/types.ts";
import { lineage } from "../core/tree.ts";
import { checkpointAt } from "../engine/compact.ts";
import { registerHooks } from "../engine/hooks.ts";
import { toMessages } from "../engine/turn.ts";
import { detect } from "../safety/secrets.ts";
import type { Deps } from "../server/app.ts";
import { mailSource, type MailMsg, type MailSource } from "./mail.ts";
import { digestLines, levelOfAlert, MEMORY_KINDS, memoryLine, nextWakeAt, recall, spike, type DigestEvent, type Level, type MemoryItem, type MemoryKind } from "./policy.ts";

export type HelperSettings = {
  on: boolean;
  session_id: string | null;
  mail_every_min: number; // 0: no periodic mail check
  wake_gap_min: number;
};
type State = HelperSettings & { last_wake: number; mail_baseline: boolean };

// A burst of events is gathered this long before a wake (one wake, not one per event).
export const COALESCE_MS = 60_000;
// Errors: this many captures within the window is a spike worth a wake.
export const SPIKE_WINDOW_MS = 10 * 60_000;
export const SPIKE_COUNT = 5;
// Per turn: remembered items recalled (characters) and digest lines told.
export const RECALL_CHARS = 2_000;
export const DIGEST_LINES = 30;
// A remembered item is one fact in a sentence or two.
export const MEMORY_CHARS = 500;
// Mail looked at per check: unread in the inbox, from the last two days.
const MAIL_QUERY = "in:inbox is:unread newer_than:2d";
const MAIL_MAX = 25;
// Gmail's bulk categories never reach the triage.
const BULK = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);

const DEFAULTS: State = { on: false, session_id: null, mail_every_min: 10, wake_gap_min: 10, last_wake: 0, mail_baseline: false };

export const HELPER_PROMPT = `You are the owner's personal helper inside Keel, his agent harness: one conversation that never ends. He talks to you from his desk and his phone.

What you do:
- Follow his other sessions. You get digests of what happened (a session failed, needs him, finished long work, errors spiked, mail that needs him). Use helper__sessions, helper__session_read and helper__activity to look closer; answer "what's going on" from them, short and concrete, most important first.
- Send a message to another session (keel__session_send) only when he tells you to.
- Mail and calendar: mail__search, mail__read, calendar__events. Label, archive or mark read (mail__label) only when he asks. mail__send only when he asks for that message; he confirms every message on a card before it goes, so write it whole first (recipients, subject, text).
- When a digest arrives, decide whether he must act or would want to know now. If so, tell him in one line with PushNotification (notify on other models) and say it here. If not, reply with one short line and notify nothing. Routine progress is never worth a notification.

What you remember: you choose. With helper__remember, keep what will matter later: his preferences, decisions, people and how he relates to them, commitments with dates, and stable facts about his work. One fact per item, in plain words, dated when time matters. Update an item instead of adding a near copy (pass its id); helper__forget what turned false. Never keep secrets (passwords, tokens, keys, codes), and nothing he asks you not to keep. He sees and edits the list. Remembered items relevant to a message come with it in a <remembered> block: context, not his words.

Be brief. He reads you between other work.`;

const FOCUS = "the owner's preferences, decisions, commitments with their dates, the people he named, the open threads and what he asked you to watch or do later. Items already saved with helper__remember need only a mention.";

const g = globalThis as { __keelHelper?: { stop(): void } };

export class Helper {
  source: MailSource;
  private errTimes: number[] = [];
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private mailTimer: ReturnType<typeof setInterval> | null = null;
  private done = new Set<string>(); // helper prompts already given their note
  private off: (() => void)[] = [];
  checking: Promise<unknown> | null = null;

  constructor(readonly deps: Deps, source = mailSource()) {
    this.source = source;
    deps.store.migrate(`
CREATE TABLE IF NOT EXISTS helper_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS helper_memory (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, updated INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS helper_events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL, fed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS helper_events_ts ON helper_events(ts);
CREATE TABLE IF NOT EXISTS helper_mail_seen (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);`);
  }

  // --- state ---------------------------------------------------------------

  state(): State {
    const r = this.deps.store.db.query<{ value: string }, []>("SELECT value FROM helper_state WHERE id = 1").get();
    return { ...DEFAULTS, ...(r ? JSON.parse(r.value) : {}) };
  }
  private save(p: Partial<State>): State {
    const next = { ...this.state(), ...p };
    this.deps.store.db.query("INSERT INTO helper_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }
  session(): Session | undefined {
    const id = this.state().session_id;
    const s = id ? this.deps.store.session(id) : undefined;
    return s && !s.archived ? s : undefined;
  }
  isHelper = (id: string | null | undefined) => !!id && id === this.state().session_id;

  view() {
    const st = this.state();
    const s = this.session();
    return {
      on: st.on && !!s, session_id: s?.id ?? null, mail_every_min: st.mail_every_min, wake_gap_min: st.wake_gap_min, last_wake: st.last_wake || null,
      mail: { id: this.source.id, label: this.source.label, available: this.source.available(), account: this.source.available() ? this.source.account() : undefined, can: this.source.can },
      events: this.events(40),
    };
  }
  private emit() {
    this.deps.bus.emit({ t: "feature", name: "helper", data: this.view() });
  }

  // Turned on: the session is made once (or made again when he deleted or
  // archived it) and kept. Turned off: no wakes and no mail checks; the
  // conversation and the remembered list stay.
  async setOn(on: boolean): Promise<void> {
    if (on && !this.session()) {
      const { store, providers, workspace } = this.deps;
      const model = await providers.defaultModel();
      const s = store.createSession({ title: "Helper", model, workspace, settings: { helper: true, pinned_ms: Date.now(), cache_long: true } });
      this.deps.bus.emit({ t: "session", session: s });
      // A new conversation starts with nothing told (the old one's events went with it).
      store.db.query("DELETE FROM helper_events").run();
      this.save({ session_id: s.id, last_wake: 0 });
    }
    this.save({ on });
    this.start();
    this.emit();
  }
  configure(p: { mail_every_min?: unknown; wake_gap_min?: unknown }) {
    const n = (v: unknown, k: string) => {
      if (!Number.isFinite(v) || (v as number) < 0 || (v as number) > 1440) throw Object.assign(new Error(`${k} is minutes from 0 to 1440`), { status: 400 });
      return Number(v);
    };
    this.save({ ...(p.mail_every_min !== undefined ? { mail_every_min: n(p.mail_every_min, "mail_every_min") } : {}), ...(p.wake_gap_min !== undefined ? { wake_gap_min: n(p.wake_gap_min, "wake_gap_min") } : {}) });
    this.start();
    this.emit();
  }

  // --- memory ----------------------------------------------------------------

  memory(): MemoryItem[] {
    return this.deps.store.db.query<MemoryItem, []>("SELECT * FROM helper_memory ORDER BY updated DESC").all();
  }
  item(ref: string): MemoryItem | undefined {
    const r = ref.trim();
    const all = this.memory();
    return all.find((m) => m.id === r) ?? (r.length >= 4 ? (all.filter((m) => m.id.endsWith(r)).length === 1 ? all.find((m) => m.id.endsWith(r)) : undefined) : undefined);
  }
  remember(p: { text: unknown; kind?: unknown; id?: unknown }, source: "helper" | "owner"): MemoryItem {
    const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
    const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw bad("text is the fact to remember");
    if (text.length > MEMORY_CHARS) throw bad(`one item is at most ${MEMORY_CHARS} characters: keep one fact per item`);
    if (detect(text).length) throw bad("that looks like a secret (a key, token or password): it is not kept");
    const prev = p.id !== undefined && p.id !== null && p.id !== "" ? this.item(String(p.id)) : undefined;
    if (p.id && !prev) throw bad(`no remembered item ${p.id}`);
    const kind = (p.kind ?? prev?.kind ?? "fact") as MemoryKind;
    if (!MEMORY_KINDS.includes(kind)) throw bad(`kind is one of ${MEMORY_KINDS.join(", ")}`);
    const now = Date.now();
    const db = this.deps.store.db;
    let m: MemoryItem;
    if (prev) {
      db.query("UPDATE helper_memory SET text = ?, kind = ?, updated = ?, source = ? WHERE id = ?").run(text, kind, now, source === "owner" ? "owner" : prev.source, prev.id);
      m = { ...prev, text, kind, updated: now, source: source === "owner" ? "owner" : prev.source };
    } else {
      const dup = this.memory().find((x) => x.text.toLowerCase() === text.toLowerCase());
      if (dup) return dup;
      m = { id: Bun.randomUUIDv7(), ts: now, updated: now, kind, text, source, used: 0 };
      db.query("INSERT INTO helper_memory (id, ts, updated, kind, text, source, used) VALUES (?, ?, ?, ?, ?, ?, 0)").run(m.id, m.ts, m.updated, m.kind, m.text, m.source);
    }
    this.deps.bus.emit({ t: "feature", name: "helper_memory", data: { items: this.memory() } });
    return m;
  }
  forget(ref: string): MemoryItem | undefined {
    const m = this.item(ref);
    if (!m) return undefined;
    this.deps.store.db.query("DELETE FROM helper_memory WHERE id = ?").run(m.id);
    this.deps.bus.emit({ t: "feature", name: "helper_memory", data: { items: this.memory() } });
    return m;
  }

  // --- events ----------------------------------------------------------------

  events(limit: number): DigestEvent[] {
    return this.deps.store.db.query<DigestEvent, [number]>("SELECT id, ts, kind, session_id, title, body, level FROM helper_events ORDER BY ts DESC LIMIT ?").all(limit).reverse();
  }
  private unfed(): DigestEvent[] {
    return this.deps.store.db.query<DigestEvent, []>("SELECT id, ts, kind, session_id, title, body, level FROM helper_events WHERE fed = 0 ORDER BY ts").all();
  }
  private markFed(list: DigestEvent[]) {
    const q = this.deps.store.db.query("UPDATE helper_events SET fed = 1 WHERE id = ?");
    for (const e of list) q.run(e.id);
  }

  record(kind: string, sessionId: string | null, title: string, body: string, level: Level) {
    if (!this.state().on || !this.session()) return;
    const e: DigestEvent = { id: Bun.randomUUIDv7(), ts: Date.now(), kind, session_id: sessionId, title: title.slice(0, 200), body: body.slice(0, 400), level };
    const db = this.deps.store.db;
    db.query("INSERT INTO helper_events (id, ts, kind, session_id, title, body, level) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e.id, e.ts, e.kind, e.session_id, e.title, e.body, e.level);
    db.query("DELETE FROM helper_events WHERE ts < ?").run(Date.now() - 30 * 86400_000);
    if (level === "wake") this.schedule();
    this.emit();
  }

  private title = (id: string | null) => (id ? this.deps.store.session(id)?.title || "untitled" : "");

  private schedule() {
    if (this.wakeTimer) return;
    const st = this.state();
    const at = nextWakeAt(Date.now(), st.last_wake, COALESCE_MS, st.wake_gap_min * 60_000);
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.wake(); }, Math.max(0, at - Date.now()));
  }

  // One wake carries every event not told yet.
  wake(): boolean {
    const s = this.session();
    if (!s || !this.state().on) return false;
    const list = this.unfed();
    if (!list.some((e) => e.level === "wake")) return false;
    const text = `[helper digest] What happened since you last heard (times in UTC):\n${digestLines(list, DIGEST_LINES, this.title)}\n\nDecide whether the owner must act or would want to know now; if so, notify him in one line. Otherwise reply with one short line.`;
    if (!deliver(s.id, text, { kind: "helper_digest", events: list.length })) return false;
    this.markFed(list);
    this.save({ last_wake: Date.now() });
    this.emit();
    return true;
  }

  // --- mail --------------------------------------------------------------------

  // New unread inbox mail since the last check. The first check only notes
  // what is there (a backlog is not news); bulk categories are skipped; the
  // rest is triaged by the reader model, and only what needs him wakes the
  // helper.
  async checkMail(): Promise<{ new: number; important: number }> {
    const s = this.session();
    if (!s || !this.state().on || !this.source.available()) return { new: 0, important: 0 };
    const db = this.deps.store.db;
    const found = await this.source.search(MAIL_QUERY, MAIL_MAX);
    const seen = new Set(db.query<{ id: string }, []>("SELECT id FROM helper_mail_seen").all().map((r) => r.id));
    const fresh = found.filter((m) => !seen.has(m.id));
    const ins = db.query("INSERT OR IGNORE INTO helper_mail_seen (id, ts) VALUES (?, ?)");
    for (const m of fresh) ins.run(m.id, Date.now());
    db.query("DELETE FROM helper_mail_seen WHERE ts < ?").run(Date.now() - 14 * 86400_000);
    if (!this.state().mail_baseline) {
      this.save({ mail_baseline: true });
      return { new: 0, important: 0 };
    }
    const real = fresh.filter((m) => !m.labels.some((l) => BULK.has(l)));
    if (!real.length) return { new: fresh.length, important: 0 };
    const verdict = await this.triage(s, real);
    let important = 0;
    for (const m of real) {
      const v = verdict.get(m.id);
      if (v?.level === "ignore") continue;
      const wake = v ? v.level === "now" : m.labels.includes("IMPORTANT");
      if (wake) important++;
      this.record("mail", null, `${m.from.replace(/\s*<[^>]*>/, "") || m.from}: ${m.subject}`, `${v?.why ? `${v.why} ` : ""}(mail id ${m.id})`, wake ? "wake" : "feed");
    }
    return { new: fresh.length, important };
  }

  private async triage(s: Session, list: MailMsg[]): Promise<Map<string, { level: "now" | "later" | "ignore"; why: string }>> {
    const out = new Map<string, { level: "now" | "later" | "ignore"; why: string }>();
    const text = list.map((m) => `id: ${m.id}\nfrom: ${m.from}\nsubject: ${m.subject}\nlabels: ${m.labels.join(" ")}\nsnippet: ${m.snippet}`).join("\n\n");
    const ask = "For each message, one line: `<id> now|later|ignore <reason in a few words>`. now: the owner must act soon or would want to know now (a person writing to him, a deadline, a security or payment problem, something he is waiting for). later: worth a mention when he next asks. ignore: newsletters, receipts, automated notices that need nothing. Nothing else.";
    try {
      const r = await this.deps.engine.read(s.id, "new mail", text, ask, AbortSignal.timeout(60_000));
      for (const line of r.text.split("\n")) {
        const m = line.trim().replace(/^[-*`\s]+/, "").match(/^(\S+?)`?\s+(now|later|ignore)\b[\s:,-]*(.*)$/i);
        if (m && list.some((x) => x.id === m[1])) out.set(m[1]!, { level: m[2]!.toLowerCase() as "now" | "later" | "ignore", why: m[3]!.trim().slice(0, 160) });
      }
    } catch (e) {
      // Without a verdict Gmail's own Important label decides (see checkMail).
      this.deps.errors.capture("server", e, { at: "helper mail triage" });
    }
    return out;
  }

  // --- the turn ----------------------------------------------------------------

  // The note a helper prompt gets: events not told yet, and the remembered
  // items it calls up that the context has not seen since its last summary.
  private note(s: Session, events: StoredEvent[], prompt: string): { text: string; recalled: string[]; told: DigestEvent[] } | null {
    const at = checkpointAt(events).at;
    const seen = new Set<string>();
    for (const e of events.slice(at + 1)) for (const id of e.data?.helper?.recall ?? []) seen.add(id);
    const told = this.unfed();
    const query = `${prompt}\n${told.map((e) => `${e.title} ${e.body}`).join("\n")}`;
    const items = recall(this.memory(), query, seen, RECALL_CHARS);
    const parts: string[] = [];
    if (told.length) parts.push(`<digest>\nEvents since you last heard (times in UTC):\n${digestLines(told, DIGEST_LINES, this.title)}\n</digest>`);
    if (items.length) parts.push(`<remembered>\nFrom your remembered list (ids in brackets; context, not the owner's words):\n${items.map(memoryLine).join("\n")}\n</remembered>`);
    if (!parts.length) return null;
    return { text: parts.join("\n\n"), recalled: items.map((m) => m.id), told };
  }

  install() {
    g.__keelHelper?.stop();
    g.__keelHelper = this;
    const h = this;
    registerHooks({
      system: (s) => (s.settings.helper ? HELPER_PROMPT : ""),
      compactFocus: (s) => (s.settings.helper ? FOCUS : undefined),
      async beforeRequest(s, req) {
        if (req.purpose !== "turn" || !s.settings.helper) return req;
        const events = lineage(h.deps.store.events(s.id), h.deps.store.session(s.id)?.head ?? null);
        let i = events.length - 1;
        while (i >= 0 && (events[i]!.kind === "turn_start" || events[i]!.kind === "compaction" || (events[i]!.kind === "note" && !events[i]!.data.model) || (events[i]!.kind === "note" && events[i]!.data.memory))) i--;
        const last = events[i];
        if (last?.kind !== "user" || h.done.has(last.id)) return req;
        h.done.add(last.id);
        const n = h.note(s, events, String(last.data.text ?? ""));
        if (!n) return req;
        h.markFed(n.told);
        if (n.recalled.length) {
          const q = h.deps.store.db.query("UPDATE helper_memory SET used = used + 1 WHERE id = ?");
          for (const id of n.recalled) q.run(id);
        }
        const hooks = [n.told.length && "digest", n.recalled.length && "remembered"].filter(Boolean);
        const ev = h.deps.store.append(s.id, "note", { text: n.text, model: true, memory: { source: "helper", hooks }, helper: { recall: n.recalled, events: n.told.length } });
        h.deps.bus.emit({ t: "event", event: ev });
        return { ...req, messages: toMessages(lineage(h.deps.store.events(s.id), h.deps.store.session(s.id)?.head ?? null)) };
      },
    });
    this.off.push(this.deps.bus.on((f) => {
      try {
        if (f.t === "feature" && f.name === "automation" && f.data?.kind === "alert") this.onAlert(f.data.data as alerts.Alert);
        else if (f.t === "error") this.onError(f.error);
      } catch (e) {
        this.deps.errors.capture("server", e, { at: "helper event" });
      }
    }));
    this.start();
    // A wake a restart cut short is scheduled again.
    if (this.unfed().some((e) => e.level === "wake")) this.schedule();
  }

  private onAlert(a: alerts.Alert) {
    if (this.isHelper(a.session_id)) {
      // The helper's own reply to a digest is not news for the inbox.
      if (a.kind === "finished") {
        const s = this.session();
        const evs = s ? lineage(this.deps.store.events(s.id), s.head) : [];
        if (evs.findLast((e) => e.kind === "user")?.data.kind === "helper_digest") alerts.markRead({ ids: [a.id] });
      }
      return;
    }
    const level = levelOfAlert(a.kind, a.data, alerts.LONG_TURN_MS);
    if (!level) return;
    const who = a.data?.child_title ? ` (agent ${a.data.child_title})` : "";
    this.record(a.kind, a.session_id, `${a.title}${who}`, a.body, level);
  }

  private onError(err: { message: string; session_id?: string; ts: number }) {
    if (this.isHelper(err.session_id)) return;
    const r = spike(this.errTimes, Date.now(), SPIKE_WINDOW_MS, SPIKE_COUNT);
    this.errTimes = r.times;
    if (!r.spiked) return;
    const recent = this.deps.store.errors(20, { resolved: false }).filter((e) => Date.now() - e.ts < SPIKE_WINDOW_MS).slice(0, 3);
    this.record("error_spike", null, `${SPIKE_COUNT} or more failures in ${SPIKE_WINDOW_MS / 60_000} minutes`, recent.map((e) => e.message.split("\n")[0]!.slice(0, 120)).join("; "), "wake");
  }

  private start() {
    if (this.mailTimer) clearInterval(this.mailTimer);
    this.mailTimer = null;
    const st = this.state();
    if (!st.on || !st.mail_every_min) return;
    this.mailTimer = setInterval(() => { this.runMailCheck(); }, st.mail_every_min * 60_000);
    // The first look soon after start, so a fresh daemon has its baseline.
    setTimeout(() => this.runMailCheck(), 15_000);
  }

  runMailCheck() {
    if (this.checking) return this.checking;
    this.checking = this.checkMail()
      .catch((e) => { this.deps.errors.capture("server", e, { at: "helper mail check" }); return { new: 0, important: 0 }; })
      .finally(() => { this.checking = null; });
    return this.checking;
  }

  stop() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.mailTimer) clearInterval(this.mailTimer);
    this.wakeTimer = this.mailTimer = null;
    for (const f of this.off) f();
    this.off = [];
  }
}
