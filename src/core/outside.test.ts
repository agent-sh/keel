import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { forPeers } from "./outside.ts";

// What another machine's relay is shown (the fleet stream, src/server/routes/fleet.ts): nothing of a session another
// harness runs, one there when the relay opened or one made after it, and no frame whose kind says nothing of whose it is.
test("a relay to another machine carries no session, state or frame of an outside session, and no frame it cannot attribute", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-outside-peers-"));
  try {
    const store = new Store(dir);
    store.migrate("CREATE TABLE alerts (id TEXT PRIMARY KEY, session_id TEXT);");
    const mark = { harness: "claude" as const, source_id: "x", state: "working" as const, since: 1, files: 0, failures: 0 };
    const mine = store.createSession({ title: "mine", model: "m", workspace: dir });
    const out = store.createSession({ title: "elsewhere", model: "m", workspace: dir });
    store.updateSession(out.id, { outside: mark });
    store.db.query("INSERT INTO alerts VALUES ('al-out', ?), ('al-mine', ?)").run(out.id, mine.id);
    const shared = forPeers(store.db);
    expect(shared.sessions(store.sessions()).map((s) => s.id)).toEqual([mine.id]);
    expect(Object.keys(shared.states({ [mine.id]: 1, [out.id]: 2 }))).toEqual([mine.id]);
    const later = store.updateSession(store.createSession({ title: "later", model: "m", workspace: dir }).id, { outside: mark });
    const frames = (id: string) => [
      { t: "session", session: store.session(id)! },
      { t: "event", event: store.append(id, "user", { text: "words" }) },
      { t: "delta", session_id: id, index: 0, kind: "text", text: "x" },
      { t: "feature", name: "state", session_id: id, data: {} },
      // The automation's frames say what they are about inside (an alert: src/automation/core.ts emit).
      { t: "feature", name: "automation", data: { kind: "alert", data: { id: "a1", session_id: id, title: "x" } } },
    ];
    const goes = (f: any) => shared.relay(f) !== null;
    expect(frames(out.id).map(goes)).toEqual([false, false, false, false, false]);
    expect(frames(later.id).map(goes)).toEqual([false, false, false, false, false]);
    expect(frames(mine.id).map(goes)).toEqual([true, true, true, true, true]);
    expect(goes({ t: "ui", version: "1" })).toBe(true);
    // The agent view's list names every session it found, outside ones too: it is this daemon's and stays home,
    // as does a frame of a kind the relay has no rule for and one of a session's kind that names no session.
    expect(goes({ t: "feature", name: "outside", data: { sessions: [{ id: "claude:x", name: "elsewhere", waiting_on: "a question" }] } })).toBe(false);
    expect(goes({ t: "feature", name: "a-kind-added-later", data: { title: "elsewhere" } })).toBe(false);
    expect(goes({ t: "feature", name: "state", data: {} })).toBe(false);
    expect(goes({ t: "error", error: {} })).toBe(false);
    // The inbox: its counts stay home; alerts read by id go without a hidden session's, and how many changed stays home.
    const counts = { total: 2, sessions: { [out.id]: 1, [mine.id]: 1 } };
    const read = shared.relay({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { ids: ["al-out", "al-mine"], changed: 2, rev: 5 }, counts } })!;
    expect(read.data).toEqual({ kind: "alerts_read", data: { ids: ["al-mine"], rev: 5 } });
    expect(JSON.stringify(read)).not.toContain(out.id);
    expect(goes({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { ids: ["al-out"], rev: 6 }, counts } })).toBe(false);
    expect(goes({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { unread: "al-out", rev: 7 }, counts } })).toBe(false);
    expect(goes({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { session_id: out.id, rev: 8 }, counts } })).toBe(false);
    const all = shared.relay({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { all: true, changed: 2, rev: 9 }, counts } })!;
    expect(all.data).toEqual({ kind: "alerts_read", data: { all: true, rev: 9 } });
    const alert = shared.relay({ t: "feature", name: "automation", data: { kind: "alert", data: { id: "al-mine", session_id: mine.id }, counts } })!;
    expect(alert.data).toEqual({ kind: "alert", data: { id: "al-mine", session_id: mine.id } });
    // A question that waits goes without a hidden session's.
    const q = shared.relay({ t: "questions", pending: [{ session_id: out.id, call_id: "c1" }, { session_id: mine.id, call_id: "c2" }] })!;
    expect(q.pending).toEqual([{ session_id: mine.id, call_id: "c2" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The trust panel and the secrets cards of a far session refresh from frames that name the session: one that
// names none stays home, so the emits name the sessions they concern (routes/trust.ts, routes/secrets.ts).
test("a trust or secret frame goes to another machine when it names a session of Keel's own, and not otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-outside-peers-"));
  try {
    const store = new Store(dir);
    store.migrate("CREATE TABLE alerts (id TEXT PRIMARY KEY, session_id TEXT);");
    const mine = store.createSession({ title: "mine", model: "m", workspace: dir });
    const out = store.updateSession(store.createSession({ title: "elsewhere", model: "m", workspace: dir }).id, { outside: { harness: "claude", source_id: "x", state: "working", since: 1, files: 0, failures: 0 } });
    const shared = forPeers(store.db);
    for (const [name, data] of [["trust", { cwd: dir }], ["secret", { forgotten: "id1" }]] as const) {
      expect(shared.relay({ t: "feature", name, session_id: mine.id, data })).toEqual({ t: "feature", name, session_id: mine.id, data });
      expect(shared.relay({ t: "feature", name, session_id: out.id, data })).toBeNull();
      expect(shared.relay({ t: "feature", name, data })).toBeNull();
    }
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the sets of sessions: a session another harness runs is in none unless its caller asks.

import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { overview } from "../admin/overview.ts";
import { Messages } from "../fleet/messages.ts";
import { Handoffs } from "../fleet/handoff.ts";
import { helperTool, useHelper } from "../helper/tools.ts";
import { treesOf } from "../automation/lessons-mine.ts";
import { outsideRefused } from "../server/app.ts";
import { sessionRef, sessionRefs } from "../admin/session-ref.ts";

const MARK = { harness: "claude" as const, source_id: "y", state: "waiting" as const, since: 1, files: 0, failures: 0 };
function two() {
  const dir = mkdtempSync(join(tmpdir(), "keel-outside-sets-"));
  const store = new Store(dir);
  // (What the engine's modules add to a store, as src/admin/overview.test.ts makes it.)
  store.migrate(`ALTER TABLE sessions ADD COLUMN parent_id TEXT;
    ALTER TABLE sessions ADD COLUMN machine TEXT;
    CREATE TABLE telemetry_turns (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, ms INTEGER, outcome TEXT, turn_event TEXT);
    CREATE TABLE telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, cost REAL, unpriced INTEGER, turn_event TEXT, outcome TEXT, error_class TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, status TEXT, created INTEGER, ended INTEGER);`);
  const mine = store.createSession({ title: "mine", model: "m", workspace: dir });
  const out = store.updateSession(store.createSession({ title: "SECRET-OUTSIDE-TITLE", model: "m", workspace: dir }).id, { outside: MARK });
  store.append(out.id, "user", { text: "SECRET-OUTSIDE-PROMPT" });
  return { dir, store, mine, out, done: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the store's sessions, the overview, the addressable sessions and the lessons' trees leave an outside session out", () => {
  const { dir, store, mine, out, done } = two();
  try {
    expect(store.sessions().map((s) => s.id)).toEqual([mine.id]);
    expect(store.sessions({ outside: true }).map((s) => s.id).sort()).toEqual([mine.id, out.id].sort());
    const from = { store, counts: () => new Map<string, number>(), now: () => ({ state: "idle" as const, lines: [] }), state: () => ({ watch: "need" as const, agents: 0 }) };
    const o = overview(from as any, { since: Date.now() - 3_600_000 });
    expect(o.sessions.map((r) => r.id)).toEqual([mine.id]);
    expect(JSON.stringify(o)).not.toContain("SECRET-OUTSIDE");
    const fleet = { name: "here", id: "d1", rows: () => [] };
    const m = new Messages(store, { emit() {} } as any, {} as any, fleet as any, () => undefined, () => {});
    expect(m.addressable().map((a) => a.session.id)).toEqual([mine.id]);
    expect([...treesOf(store.db, 0, Date.now(), (d) => d).values()].map((c) => c.trees)).toEqual([1]);
    void dir;
  } finally { done(); }
});

// What the command line's routes and the timeline resolve a name with (/api/cli/resolve, /api/cli/state/:id,
// POST /api/run, the timeline and hours routes): an outside session is one only for a caller shown it.
test("a name means an outside session only to a caller shown it: by its id, a prefix or its short id", () => {
  const { store, mine, out, done } = two();
  try {
    for (const name of [out.id, out.id.slice(0, 20), out.id.slice(-12)]) {
      expect(sessionRefs(store, name)).toEqual([]);
      expect(() => sessionRef(store, name)).toThrow(`no session ${name}`);
      expect(sessionRef(store, name, true).id).toBe(out.id);
    }
    expect(sessionRef(store, mine.id).id).toBe(mine.id);
    // A prefix both share names only the one of Keel's own to a blind caller, both to the owner.
    const both = mine.id.slice(0, 8) === out.id.slice(0, 8) ? mine.id.slice(0, 8) : null;
    if (both) {
      expect(sessionRefs(store, both)).toEqual([mine.id]);
      expect(sessionRefs(store, both, undefined, true).sort()).toEqual([mine.id, out.id].sort());
    }
  } finally { done(); }
});

// The command line's own routes, asked by another machine (a forwarded request): an outside session is no session,
// by its id or a prefix; the owner's command line resolves it.
test("the command line's routes resolve an outside session for the owner only", async () => {
  const { store, out, done } = two();
  try {
    const { runRoutes } = await import("../server/routes/run.ts");
    const { innerHeaders } = await import("../safety/presence.ts");
    const routes = runRoutes({ store, bus: { emit() {} }, engine: {}, providers: {}, workspace: "/" } as any) as any;
    const linked = (path: string) => Object.assign(new Request(`http://keel${path}`, { headers: innerHeaders({ local: false, enrolled: true, present: null }, "far box") }), { params: { id: out.id.slice(0, 20) } });
    for (const name of [out.id, out.id.slice(0, 20)]) {
      expect(() => routes["/api/cli/resolve"].GET(linked(`/api/cli/resolve?id=${name}`))).toThrow(`no session ${name}`);
    }
    expect(() => routes["/api/cli/state/:id"].GET(linked(`/api/cli/state/${out.id.slice(0, 20)}`))).toThrow(`no session ${out.id.slice(0, 20)}`);
    const own = await routes["/api/cli/resolve"].GET(new Request(`http://keel/api/cli/resolve?id=${out.id.slice(0, 20)}`)).json();
    expect(own.session.id).toBe(out.id);
  } finally { done(); }
});

test("the helper reads no outside session, and a handoff refuses one", async () => {
  const { store, out, done } = two();
  try {
    useHelper({ deps: { store, engine: { isRunning: () => false, statusOf: () => ({ kind: "idle" }) } } } as any);
    const read = await helperTool("helper__session_read")!.run({ session: out.id }, {} as any);
    expect(read.is_error).toBe(true);
    expect(JSON.stringify(read)).not.toContain("SECRET-OUTSIDE");
    const byTitle = await helperTool("helper__session_read")!.run({ session: "SECRET-OUTSIDE-TITLE" }, {} as any);
    expect(JSON.stringify(byTitle)).not.toContain("SECRET-OUTSIDE-PROMPT");
    const h = Object.create(Handoffs.prototype);
    h.moving = new Map();
    expect(() => h.refusal(out, { machine_id: "local" })).toThrow(/read-only/);
  } finally { useHelper(undefined); done(); }
});

test("a request that acts on an outside session is refused, past copying, archiving, deleting and the owner's marks", async () => {
  const req = (method: string, body?: unknown) => new Request("http://keel/x", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const [m, path] of [["POST", "recap"], ["POST", "compact"], ["POST", "summarize"], ["POST", "side"], ["DELETE", "side"], ["POST", "review"], ["POST", "clear"], ["POST", "export-to"], ["POST", "handoff"], ["POST", "messages"], ["POST", "terminal/run"], ["POST", "clone"], ["POST", "some/new/act"]] as const) {
    expect(await outsideRefused(req(m), `${m} /api/sessions/:id/${path}`)).toBe(true);
  }
  for (const [m, path] of [["POST", "outside/copy"], ["POST", "marks"], ["POST", "files/exist"], ["POST", "call-marks"], ["GET", "recap"], ["GET", "events"]] as const) {
    expect(await outsideRefused(req(m), `${m} /api/sessions/:id/${path}`)).toBe(false);
  }
  expect(await outsideRefused(req("DELETE"), "DELETE /api/sessions/:id")).toBe(false);
  expect(await outsideRefused(req("PATCH", { archived: true }), "PATCH /api/sessions/:id")).toBe(false);
  expect(await outsideRefused(req("PATCH", { title: "x" }), "PATCH /api/sessions/:id")).toBe(true);
  expect(await outsideRefused(req("PATCH", { archived: true, model: "m" }), "PATCH /api/sessions/:id")).toBe(true);
});

// The callers that ask for the sessions another harness runs: each shows them to the owner on this
// machine (the list, home and the tray) or acts on the owner's list (the archive policy). A new one
// is added here with its reason, or it does not ask.
const ASK = new Map([
  ["src/server/app.ts", 1],             // GET /api/sessions: the owner's list (not for another machine)
  ["src/server/routes/state.ts", 2],    // the state board's pass-through, and GET /api/state for the page's list and home
  ["src/server/routes/shell.ts", 1],    // the desktop app's tray: what waits for the owner
  ["src/server/routes/search.ts", 1],   // a state filter of a search whose scope leaves them out for a peer
  ["src/admin/storage.ts", 1],          // the owner's archive policy over the owner's list
]);
const sources = () => [...new Glob("src/**/*.ts").scanSync({ cwd: process.cwd() })].filter((f) => !f.endsWith(".test.ts")).sort();
// A call of `sessions(` or `all(` whose options say `outside: true`, over as many lines as it is written on.
export const ASKS = /\b(?:sessions|all)\((?:[^;()]|\([^()]*\))*?\boutside:\s*true/g;
test("only the listed callers ask for the sessions another harness runs", () => {
  expect("store.sessions({\n  archived: true,\n  outside: true,\n})".match(ASKS)?.length).toBe(1);
  expect("store.sessions({ archived: true }); x({ outside: true })".match(ASKS)).toBeNull();
  const found = new Map<string, number>();
  for (const f of sources()) {
    const n = readFileSync(f, "utf8").match(ASKS)?.length ?? 0;
    if (n) found.set(f, n);
  }
  expect(Object.fromEntries(found)).toEqual(Object.fromEntries(ASK));
});

// The store's own statements are its business (store.ts: its sets leave outside sessions out). Every other
// statement over the sessions table selects only what carries none of a session's words (its id, its
// parent, its times and flags, a count), or leaves outside sessions out (`outside IS NULL`), or is named
// here with why it may read more. A new one does one of the three.
const READS_MORE = new Map<string, [number, string]>([
  ["src/integrations/outside/service.ts", [1, "the outside service's own rows: what it reads again after a restart"]],
  ["src/integrations/import/keel.ts", [1, "another Keel's store, the file being imported; not this daemon's table"]],
  ["src/integrations/import/hermes.ts", [2, "Hermes's own store, being imported"]],
  ["src/admin/telemetry.ts", [1, "telemetry_tools: written by the turns Keel runs, and a session another harness runs has none"]],
  ["src/admin/telemetry-report.ts", [1, "telemetry_tools, as above"]],
  ["src/admin/turn-compare.ts", [1, "telemetry_calls: Keel's own requests (the backfill from events leaves copies out)"]],
  ["src/admin/cost-drivers.ts", [1, "the titles of trees found in telemetry_calls, as above"]],
  ["src/server/routes/usage.ts", [1, "the titles of sessions found in the usage ledger, as above"]],
  ["src/server/routes/memory.ts", [2, "what memory gave and recalled: none for a session another harness runs (src/integrations/tacit.ts flags)"]],
  ["src/admin/storage.ts", [6, "the owner's Storage report, tags and archive policy; GET /api/storage and the cleanup list leave copies out for any caller but the owner"]],
  ["src/admin/hours-read.ts", [1, "one session read by its id, which the door answers as no such session for any caller but the owner (peer-scope.ts)"]],
  ["src/admin/retention.ts", [1, "times and the pin of sessions it may clear, no words"]],
  ["src/engine/build-pin.ts", [1, "session_pins: made by turns Keel runs"]],
  ["src/fleet/message-state.ts", [1, "messages to or from one session; a message to a session another harness runs is refused (409)"]],
  ["src/server/routes/search.ts", [1, "its scope leaves them out for any caller but the owner (seesOutside)"]],
  ["src/server/routes/search-content.ts", [4, "the same scope as search.ts, given as q.where"]],
  ["src/server/routes/content-routes.ts", [1, "one session's tree for its folder's provider rules; a session another harness runs sends nothing to a provider"]],
  ["src/safety/checkpoints.ts", [1, "checkpoints: made by Keel's own tool calls"]],
  ["src/safety/egress-report.ts", [1, "egress rows: made by Keel's own commands"]],
  ["src/automation/earlier-facts.ts", [1, "agents: started only under Keel's own sessions"]],
  ["src/automation/lessons-mine.ts", [1, "the sessions the hits name, and hitsOf leaves copies out"]],
  ["src/core/outside.ts", [1, "the outside sessions' harness and own id (no words of theirs), to leave them out of the sessions elsewhere list for a blind caller"]],
]);
// The columns a statement may read with no reason: none of them carries a session's words.
const BARE = /^(DISTINCT\s+)?((\w+\.)?(id|parent_id|session_id|archived|created|updated|head|head_event_id)|\d+|\?|(COUNT|MIN|MAX)\([\w.*]*\))(\s+AS\s+\w+)?$/i;
const columns = (text: string) => {
  const out: string[] = [];
  let depth = 0, at = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(at, i).trim()); at = i + 1; }
  }
  return [...out, text.slice(at).trim()];
};
// Each statement's text around a FROM or JOIN of the sessions table: from the SELECT before it to the end of its string.
export function sessionReads(text: string): { line: number; columns: string[]; filtered: boolean }[] {
  const out: { line: number; columns: string[]; filtered: boolean }[] = [];
  for (const m of text.matchAll(/\b(FROM|JOIN)\s+sessions\b/g)) {
    const i = m.index!;
    const before = text.slice(Math.max(0, i - 600), i);
    const sel = before.lastIndexOf("SELECT");
    const head = sel >= 0 ? before.slice(sel + 6) : "?";
    // To where the statement is run (its .all, .get or .run), else a few lines.
    const rest = text.slice(i, i + 600);
    const end = rest.search(/\.(all|get|run|values)\(|;\n/);
    const tail = rest.slice(0, end >= 0 ? end : 300);
    // A JOIN's columns are the SELECT's up to the table it joins to.
    const flat = head.replace(/\s+/g, " ").trim();
    const cols = columns(m[1] === "FROM" ? flat : flat.slice(0, Math.max(0, flat.lastIndexOf(" FROM ")) || flat.length));
    out.push({ line: text.slice(0, i).split("\n").length, columns: cols, filtered: /\boutside IS NULL\b/.test(head + tail) });
  }
  return out;
}
test("every statement over the sessions table outside the store reads no words of an outside session, or says why", () => {
  expect(sessionReads(`db.query("SELECT id, parent_id FROM sessions WHERE x = ?")`)[0]).toMatchObject({ columns: ["id", "parent_id"], filtered: false });
  expect(sessionReads("db.query(`SELECT s.title FROM t JOIN sessions s ON s.id = t.sid AND s.outside IS NULL`)")[0]!.filtered).toBe(true);
  const more = new Map<string, number>();
  for (const f of sources()) {
    if (f === "src/core/store.ts") continue;
    for (const r of sessionReads(readFileSync(f, "utf8"))) {
      if (r.filtered || (r.columns.length && r.columns.every((c) => BARE.test(c)))) continue;
      more.set(f, (more.get(f) ?? 0) + 1);
    }
  }
  expect(Object.fromEntries(more)).toEqual(Object.fromEntries([...READS_MORE].map(([f, [n]]) => [f, n])));
});
