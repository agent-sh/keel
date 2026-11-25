// The phone API's contract with the unchanged Hermes app: what its sync,
// chat, run and usage answers carry, and what its push health says. These are
// shapes no browser e2e reaches; the app's own reading of them is cited per test.
import { afterAll, describe, expect, jest, setSystemTime, test } from "bun:test";
import { ownEnv } from "../../../test/env.ts";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { setDeps } from "../../automation/core.ts";
import * as agents from "../../automation/agents.ts";
import * as alerts from "../../automation/alerts.ts";
import { setAttachmentsRoot } from "../../engine/attachments.ts";
import { ask, answer, askFor } from "../../tools/interact.ts";
import wire from "./contract/wire.json";
import { answersText, approvalMessage, canonicalMessage, sha256Hex } from "./sig.ts";
import { MobileStore } from "./store.ts";
import { bucketOf, heldOf, mobileApi } from "./v1.ts";
import { pushData, testMessage } from "./push.ts";
import { liveData, liveStatus } from "./live.ts";
import { landMessage } from "./landings.ts";
import { landCard } from "../../board/card.ts";
import { startJob, stopJob } from "../../tools/jobs.ts";
import { alertPush } from "../../server/routes/mobile.ts";
import { Gate, type Approval } from "../../safety/gate.ts";
import { planRoutes, plansWaiting } from "../../server/routes/plan.ts";
import { Checkpoints } from "../../safety/checkpoints.ts";
import { searchRoutes } from "../../server/routes/search.ts";
import { toolsFor } from "../../tools/registry.ts";
import { Helper } from "../../helper/helper.ts";
import { allHooks } from "../../engine/hooks.ts";
import type { MailSource } from "../../helper/mail.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-mobile-"));
// The daemon's config folder is this run's own: what a route reads there (the push files) is what a test put there.
ownEnv({ KEEL_CONFIG_DIR: join(dir, "config") });
mkdirSync(process.env.KEEL_CONFIG_DIR!);
const store = new Store(dir);
const bus = new Bus();
setDeps({ store, bus, errors: { capture() {} } } as any);
alerts.migrate();
agents.migrate();
setAttachmentsRoot(dir);
const mobile = new MobileStore(store);
const running = new Set<string>();
const sent: any[] = [];
// The engine's send, as far as the phone API sees it: a prompt starts a turn,
// joins a running one (steer) or waits in the queue.
let sendBreaks = false;
const asked = new Set<string>();
const turnStatus = new Map<string, any>();
const turnStart = new Map<string, string>();
const engine = {
  isRunning: (id: string) => running.has(id),
  statusOf: (id: string) => turnStatus.get(id) ?? { kind: "idle" },
  turnOf: (id: string) => turnStart.get(id),
  send: (id: string, text: string, opts: any) => {
    sent.push({ id, text, opts });
    const images = opts.images?.length ? opts.images : undefined;
    // A question for the helper is stored once under its sender's key, with its mark, as the engine does.
    if (opts.key?.startsWith("ask:")) { if (asked.has(`${id} ${opts.key}`)) return { duplicate: true }; asked.add(`${id} ${opts.key}`); }
    const r = running.has(id) || opts.mode === "queue" ? (() => { const q = store.enqueue(id, text, opts.mode !== "queue", images, opts.meta); return { queued: q, steer: q.steer }; })() : { event: store.append(id, "user", { text, images, ...opts.meta }) };
    if (sendBreaks) throw new Error("the daemon stopped here");
    return r;
  },
  interrupt: async () => {},
};
const providers = { models: async () => [], marked: (m: any) => m, defaultModel: async () => "fx:default", resolve: async () => ({}) };
// The permission gate over the same store. A card put in its table is listed at once; one put
// there before a gate is made is open to an answer (as a card a restart left open is).
let gate = new Gate(store, bus);
const card = (a: Partial<Approval> & Pick<Approval, "id" | "session_id" | "summary">): Approval => {
  const full: Approval = { call_id: `call-${a.id}`, tool: "Bash", kind: "shell", input: { command: a.summary }, risk: "low", suggest: [], state: "pending", created: Date.now(), ...a };
  store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?)").run(full.id, full.session_id, full.state, JSON.stringify(full), full.created);
  return full;
};
// What each turn changed: a checkpoint store of the test's own, made by the changes tests.
let ckpts: Checkpoints | undefined;
// The fleet as the phone sees it: its machines, and what starting a session on one answers.
let fleetRows: any[] = [];
// The page's search over this test's store, made at its first use.
let searched: ((req: Request) => Promise<Response>) | undefined;
const searchGet = () => (searched ??= (searchRoutes({ store } as any) as any)["/api/search"].GET);
// The owner's last absence as the page's digest has it, and when the phone said the owner was there.
let awayDigest: any = null;
const seenAt: number[] = [];
const T0 = Date.UTC(2026, 10, 23, 12, 0);
const DIGEST = {
  from: T0, to: T0 + 2 * 3600_000, spans: [{ from: T0, to: T0 + 2 * 3600_000 }], away_ms: 2 * 3600_000, present: true, as_of: T0 + 2 * 3600_000 + 60_000,
  sessions: [
    { id: "s-a", title: "Fix the build", watch: "fail", turns: 2, failed: { provider: 1 }, agents: {}, approvals: 0, questions: 0, parked: 0, cost: 0.12, text: "2 turns ended, 1 failed (provider); $0.12", bad: "1 failed (provider)" },
    { id: "s-b", title: "Docs", watch: "done", turns: 1, failed: {}, agents: { done: 2 }, approvals: 1, questions: 0, parked: 0, cost: 0.03, text: "1 turn ended; agents: 2 ended; 1 approval waits; $0.03" },
  ],
  quiet: 4, totals: { turns: 3, failed: 1, agents: { done: 2 }, approvals: 1, questions: 0, parked: 0, cost: 0.15 }, daemon: ["The daemon went down at 12:40 and came back after 29 s."], daemon_brief: "the daemon went down and came back after 29 s",
};
// The owner's helper, made by the first test that needs it: a mail source that has no account, no mail checks.
// (Its memory meter registers a turn hook, taken off at the end.)
let helper: Helper | null = null;
const hooksAtStart = allHooks().length;
afterAll(() => { helper?.stop(); allHooks().length = hooksAtStart; });
const noMail = { id: "none", label: "No mail", available: () => false, account: () => undefined, can: { modify: false, send: false, calendar: false } } as unknown as MailSource;
const helperOn = async () => {
  helper ??= new Helper({ store, bus, engine, providers, workspace: dir, errors: { capture() {}, onCapture: () => () => {} } } as any, noMail);
  helper.configure({ mail_every_min: 0 });
  await helper.setOn(true);
  return helper;
};
let fleetStart: (b: any) => Response = () => Response.json({ error: "no fleet in this test" }, { status: 409 });
// The daemon's errors, as the Errors panel reads them.
const tracker = new ErrorTracker(store, bus);
// Branches that wait to land, as the board would give them (src/integrations/mobile/landings.test.ts tests the reading).
const H = "3f2a9c1d0b7e4a5f8c6d2e1b0a9f8e7d6c5b4a39";
const landRow = (o: any = {}) => ({ id: "ag1", session_id: "s-ag1", parent_id: "s-root", depth: 1, title: "Fix the retry delay", type: "general-purpose", model: "m", state: "completed", created: 1, ended: 2, machine: null,
  branch: "keel/fix-retry", repo: dir, base: "main", head: H, ahead: 2, behind: 1, worktree: "here", checks: { state: "known", passed: ["typecheck", "unit"], failed: [], notRun: [] },
  review: { by: "rv1", title: "Review the retry fix", how: "named", state: "completed", verdict: "approved", source: "verdict", line: "Bounded.", tip: H, of: H, current: true, at: 1 },
  reviews: [], landed: { state: "no", missing: 2 }, queue: null, live: null, ...o });
let landNow = landCard({ root: "s-root", title: "Mobile round", row: landRow() as any, report: "Done.\n(Checks after its last edit (4 min ago): unit passed 2 min ago.)", numstat: "84\t12\tsrc/a.ts\n20\t2\tandroid/b.kt", baseTip: "9b1e0c4d7a2f5836e1d0c9b8a7f6e5d4c3b2a190" });
// One whose checks are not known and that left the queue, with no review: every field of a card is sent.
const landLeft = landCard({ root: "s-root", title: "Mobile round", row: landRow({ id: "ag2", session_id: "s-ag2", state: "stopped", base: null, ahead: null, behind: null, checks: { state: "unknown", why: "its worktree was removed" }, review: null,
  queue: { id: "lq-0", state: "left", why: "unit failed on the rebased tree", landed: null, tip: H, current: true, updated: 1 } }) as any, report: null, numstat: "" });
const landAsked: string[] = [];
const landingsStub = {
  list: async () => [landNow, landLeft],
  land: async (key: string, fp: string) => (landAsked.push(`land ${key} ${fp}`), fp === landNow.fp ? { entry: { id: "lq-1", state: "queued", why: null }, warnings: [], card: landNow } : { status: 409, error: "Its facts changed since it was shown. Read the card again before deciding.", card: landNow }),
  back: async (key: string, fp: string, text: string) => (landAsked.push(`back ${key} ${fp} ${text}`), fp === landNow.fp ? { sent: { waits: true, held: false }, card: landNow } : { status: 409, error: "gone", card: null }),
};
const routes: any = mobileApi({ store, bus, engine, providers, errors: tracker, workspace: dir, mobile, gate: () => gate, changed() {}, checkpoints: () => ckpts, landings: landingsStub,
  fleetMachines: async () => fleetRows, startFleetSession: async (b: any) => fleetStart(b),
  away: () => awayDigest, awaySeen: () => { awayDigest = null; }, ownerSeen: (ms: number) => void seenAt.push(ms),
  search: (r: Request) => searchGet()(r), helper: () => helper, live: () => liveStatus([{ title: "Review", running: true, since: 1795195000500, needs: 0 }]) } as any);
afterAll(() => setSystemTime());

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const akey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const apub = akey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const dev = mobile.claimPairCode(mobile.createPairCode(600), "phone", pub, apub, false)!;

// A signed request to a route, as the app signs it.
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${sha256Hex(raw)}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  const pathname = path.split("?")[0]!;
  for (const [pattern, handlers] of Object.entries(routes)) {
    const names: string[] = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
    const m = pathname.match(re);
    if (!m || !(handlers as any)[method]) continue;
    const req: any = new Request(`http://x${path}`, { method, body: raw || undefined, headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig, ...extra } });
    req.params = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
    const res: Response = await (handlers as any)[method](req, { requestIP: () => null, timeout() {} });
    return { status: res.status, body: await res.json() };
  }
  throw new Error(`no route ${method} ${path}`);
}
const session = (title = "") => store.createSession({ model: "fx:saved", workspace: dir, title });
// A 1x1 PNG, and an upload as the app makes it: the bytes as the body.
const PNG: Uint8Array<ArrayBuffer> = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function upload(name: string, mime: string, bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  const req = signedRaw("POST", `/v1/upload?name=${name}&mime=${mime}`, bytes);
  for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
  const res: Response = await routes["/v1/upload"].POST(Object.assign(req, { params: {} }), {});
  return res.status === 200 ? await res.json() : { status: res.status, ...(await res.json()) };
}

describe("messages", () => {
  test("an unfinished reply keeps its text and says how it ended; harness input is not the owner's", async () => {
    const parent = session("Parent A");
    const s = store.updateSession(session("Review").id, {} as any);
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    store.append(s.id, "user", { text: "status ok" });
    store.append(s.id, "user", { text: "Task:\nstatus ok", kind: "task", agent_id: "ag1" });
    store.append(s.id, "user", { text: '<subagent_result agent_id="ag2" title="Child" status="done">\nstatus ok\n</subagent_result>', kind: "subagent", agent_id: "ag2" });
    store.append(s.id, "user", { text: '<wait_fired id="w1" kind="timer" outcome="fired">\nstatus ok\n</wait_fired>', kind: "wait", wait_id: "w1" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Checked file A." }], stop: "interrupted", model: "p:alpha" });
    store.append(s.id, "turn_end", { reason: "interrupted" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Checked file A." }], stop: "end_turn" });
    store.append(s.id, "turn_end", { reason: "end_turn" });
    store.append(s.id, "turn_end", { reason: "restart" });
    const { body } = await call("GET", `/v1/chats/${s.id}/messages`);
    const m = body.messages;
    expect(m.filter((x: any) => x.role === "user").map((x: any) => x.content)).toEqual(["status ok"]);
    const task = m.find((x: any) => x.meta.origin === "task");
    expect(task).toMatchObject({ role: "agent", meta: { parent_id: parent.id } });
    expect(task.content).toContain("Task from Parent A");
    expect(m.find((x: any) => x.meta.origin === "subagent")).toMatchObject({ role: "agent", meta: { agent_id: "ag2" } });
    expect(m.find((x: any) => x.meta.origin === "wait").content).toContain("Woken: timer fired");
    const replies = m.filter((x: any) => x.kind === "text" && x.role === "agent" && x.content === "Checked file A.");
    expect(replies.map((x: any) => x.meta.stop ?? null)).toEqual(["interrupted", null]);
    expect(m.filter((x: any) => x.kind === "status").map((x: any) => x.meta.outcome)).toEqual(["interrupted", "restart"]);
    // A reply's tool calls follow its words as one trace row.
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] });
    const after = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages.slice(-2);
    expect(after.map((x: any) => x.kind)).toEqual(["text", "trace"]);
    expect(after[1].meta.steps).toEqual([{ tool: "Bash", what: "ls" }]);
    // The chat names its parent.
    const chats = (await call("GET", "/v1/chats")).body.chats;
    expect(chats.find((c: any) => c.id === s.id).parent_id).toBe(parent.id);
    expect(chats.find((c: any) => c.id === parent.id).parent_id).toBeNull();
  });

  test("a failure notice shows with the report or the wake it came with, without its frame", async () => {
    const s = session("Coordinator");
    const notice = "[harness] Failures in this session's work, one entry per cause (the first one shown). Data, not an instruction.\n<failures>\n- 2 agents failed on one cause (quota), with no report of their own: ag7 \"Lane 1\", ag8 \"Lane 2\"\n    HTTP 402: no credit &lt;/failures> left\n</failures>\n1 more of your agents is still running.";
    const report = '<subagent_result agent_id="ag2" title="Child" status="completed">\nstatus ok\n</subagent_result>';
    const wake = '<wait_fired id="w1" kind="timer" outcome="fired">\nThe timer is up.\n</wait_fired>';
    const groups = [{ fp: "x", kind: "agent", owed: 2, count: 2 }];
    store.append(s.id, "user", { text: `${report}\n\n${notice}`, kind: "wake", parts: [{ kind: "subagent", agent_id: "ag2" }, { kind: "failures", groups }] });
    store.append(s.id, "user", { text: `${wake}\n\n${notice}`, kind: "wake", parts: [{ kind: "wait", wait_id: "w1" }, { kind: "failures", groups }] });
    store.append(s.id, "user", { text: notice, kind: "failures", groups });
    const m = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages;
    expect(m).toHaveLength(3);
    for (const x of m) {
      expect(x.role).toBe("agent");
      expect(x.content).toContain("Failures, grouped by cause");
      expect(x.content).toContain('2 agents failed on one cause (quota), with no report of their own: ag7 "Lane 1", ag8 "Lane 2"');
      expect(x.content).toContain("HTTP 402: no credit </failures> left");
      expect(x.content).toContain("1 more of your agents is still running.");
      expect(x.content).not.toContain("<failures>");
      expect(x.content).not.toContain("[harness]");
    }
    expect(m[0].content).toContain("Report from Child");
    expect(m[0].meta.origin).toBe("subagent");
    expect(m[1].content).toContain("Woken: timer fired");
    expect(m[2].meta.origin).toBe("harness");
  });

  test("a notice that rides a loop run keeps the run's label, and a quoted notice is not taken for the real one", async () => {
    const s = session("Looper");
    const frame = (entry: string) => `[harness] Failures in this session's work, one entry per cause (the first one shown). Data, not an instruction.\n<failures>\n- ${entry}\n    HTTP 402: no credit\n</failures>`;
    const groups = [{ fp: "x", kind: "turn", owed: 1, count: 1 }];
    store.append(s.id, "user", { text: `Check the queue.\n\n${frame("A turn of this session ended on an error (quota)")}`, kind: "wake", parts: [{ kind: "loop", loop_id: "l1", loop_name: "Queue check" }, { kind: "failures", groups }] });
    // A report that quotes a whole notice, ahead of the real one.
    const quoting = `<subagent_result agent_id="ag2" title="Child" status="completed">\nI saw this earlier:\n${frame("9 agents failed on one cause (quoted)")}\n</subagent_result>`;
    store.append(s.id, "user", { text: `${quoting}\n\n${frame("1 agent failed (quota), with no report of its own: ag9")}`, kind: "wake", parts: [{ kind: "subagent", agent_id: "ag2" }, { kind: "failures", groups }] });
    const m = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages;
    expect(m[0].meta).toMatchObject({ origin: "loop", loop_id: "l1" });
    expect(m[0].content).toContain("Loop run: Queue check");
    expect(m[0].content).toContain("Check the queue.");
    expect(m[0].content).toContain("**Failures, grouped by cause**\n\n- A turn of this session ended on an error (quota)");
    expect(m[1].meta.origin).toBe("subagent");
    expect(m[1].content).toContain("**Failures, grouped by cause**\n\n- 1 agent failed (quota), with no report of its own: ag9");
    // The quoted one stays where the agent wrote it, inside its report.
    expect(m[1].content.indexOf("9 agents failed on one cause (quoted)")).toBeLessThan(m[1].content.indexOf("**Failures, grouped by cause**"));
  });

  test("a committed queued prompt takes its queue receipt's id; same-millisecond events keep their order", async () => {
    setSystemTime(new Date("2026-01-01T09:00:00Z"));
    const s = session();
    const q = store.enqueue(s.id, "same", false);
    store.append(s.id, "user", { text: "same", origin: "queued", queue_id: q.id });
    store.append(s.id, "user", { text: "question" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "answer" }], stop: "end_turn" });
    setSystemTime();
    const { body } = await call("GET", `/v1/sync?since=0`);
    const mine = body.messages.filter((x: any) => x.chat_id === s.id);
    expect(mine[0].id).toBe(q.id);
    // The app picks its inbox line from the latest ts (first wins on a tie).
    const last = mine.reduce((a: any, b: any) => (b.ts > a.ts ? b : a));
    expect(last.content).toBe("answer");
    const chat = body.chats.find((c: any) => c.id === s.id);
    expect(chat).toMatchObject({ preview: "answer", last_role: "agent" });
  });

  test("only the shown branch reaches the chat; the other branch is marked deleted for the app", async () => {
    const s = session();
    const base = store.append(s.id, "user", { text: "base" });
    const old = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "old" }] }, base.id);
    const neu = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "new" }] }, base.id);
    const shown = async () => (await call("GET", `/v1/chats/${s.id}/messages?limit=150`)).body.messages;
    let m = await shown();
    expect(m.filter((x: any) => x.kind !== "deleted").map((x: any) => x.content)).toEqual(["base", "new"]);
    expect(m.find((x: any) => x.id === old.id).kind).toBe("deleted");
    store.updateSession(s.id, { head: old.id });
    m = await shown();
    expect(m.filter((x: any) => x.kind !== "deleted").map((x: any) => x.content)).toEqual(["base", "old"]);
    expect(m.find((x: any) => x.id === neu.id).kind).toBe("deleted");
    // A page asked for from a message of the branch that was left: refused, so the app reloads the chat.
    const stale = await call("GET", `/v1/chats/${s.id}/messages?paged=1&limit=150&before=${neu.id}`);
    expect([stale.status, stale.body.error]).toEqual([409, "that message is not on this chat's shown branch; reload the chat"]);
  });

  test("a client that pages gets the newest page and the page before it", async () => {
    const s = session();
    for (let i = 1; i <= 301; i++) store.append(s.id, "user", { text: `row-${i}` });
    const all = (await call("GET", `/v1/chats/${s.id}/messages?limit=150`)).body;
    expect(all.messages).toHaveLength(301);
    const p1 = (await call("GET", `/v1/chats/${s.id}/messages?limit=150&paged=1`)).body;
    expect([p1.messages[0].content, p1.messages.at(-1).content]).toEqual(["row-152", "row-301"]);
    const p2 = (await call("GET", `/v1/chats/${s.id}/messages?limit=150&before=${p1.older}`)).body;
    const p3 = (await call("GET", `/v1/chats/${s.id}/messages?limit=150&before=${p2.older}`)).body;
    expect([p2.messages[0].content, p2.messages.at(-1).content, p3.messages.map((x: any) => x.content), p3.older]).toEqual(["row-2", "row-151", ["row-1"], null]);
    // A phone starting from nothing gets this chat's newest page, at the current cursor, and pages the rest.
    const first = (await call("GET", "/v1/sync?since=0")).body;
    const mine = first.messages.filter((x: any) => x.chat_id === s.id).map((x: any) => x.content);
    expect([mine.length, mine.at(-1), first.seq, first.more, first.complete]).toEqual([40, "row-301", mobile.globalSeq(), false, true]);
  });

  test("the first sync carries messages for the ten chats at the top of the list, and none for an archived one", async () => {
    const made = Array.from({ length: 12 }, (_, i) => session(`bound-${i}`));
    const archived = session("bound-archived");
    for (const [i, s] of [...made, archived].entries()) {
      setSystemTime(new Date(Date.UTC(2031, 0, 1, 0, 0, i)));
      store.append(s.id, "user", { text: `in ${s.title}` });
    }
    setSystemTime();
    store.updateSession(archived.id, { archived: true });
    const { body } = await call("GET", "/v1/sync?since=0");
    const withMessages = new Set(body.messages.map((m: any) => m.chat_id));
    // The newest ten that are not archived, whatever else the store holds.
    expect([...withMessages].sort()).toEqual(made.slice(2).map((s) => s.id).sort());
    // Every chat still has its row, with the line the list shows.
    for (const s of [...made, archived]) expect(body.chats.find((c: any) => c.id === s.id).preview).toBe(`in ${s.title}`);
    // An archived or older chat's messages come when it is opened.
    expect(texts((await call("GET", `/v1/chats/${made[0]!.id}/messages?paged=1&limit=150`)).body.messages, made[0]!.id)).toEqual(["in bound-0"]);
    // Dated ahead of every other test's chats: gone again, so theirs are the newest.
    for (const s of [...made, archived]) store.deleteSession(s.id);
  });

  test("a sync page is never filled with events the app does not show", async () => {
    const s = session();
    const from = mobile.globalSeq();
    for (let i = 0; i < 2001; i++) store.append(s.id, "note", { text: "n" });
    store.append(s.id, "user", { text: "sentinel" });
    const { body } = await call("GET", `/v1/sync?since=${from}`);
    expect(body.messages.map((x: any) => x.content)).toEqual(["sentinel"]);
    expect(body.more).toBe(false);
  });
});

describe("chats", () => {
  test("read is shared with the workbench, pin is kept, an unknown profile makes no chat", async () => {
    const a = session("A"), b = session("B");
    for (const sid of [a.id, b.id]) store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, channels) VALUES (?, ?, 'approval', ?, 't', 'b', 0, '{}', '[]')").run(`al-${sid}`, Date.now(), sid);
    const unread = async () => Object.fromEntries((await call("GET", "/v1/chats")).body.chats.map((c: any) => [c.id, c.unread]));
    expect([(await unread())[a.id], (await unread())[b.id]]).toEqual([1, 1]);
    expect((await call("POST", `/v1/chats/${a.id}/read`)).status).toBe(200);
    expect([(await unread())[a.id], (await unread())[b.id], alerts.unreadCounts().sessions[a.id] ?? 0]).toEqual([0, 1, 0]);

    expect((await call("PATCH", `/v1/chats/${a.id}`, { pinned: 1 })).body.chat.pinned).toBe(1);
    expect(store.session(a.id)!.settings.pinned_ms).toBeNumber();
    expect((await call("PATCH", `/v1/chats/${a.id}`, { pinned: 0 })).body.chat.pinned).toBe(0);

    const before = store.sessions().length;
    const r = await call("POST", "/v1/chats", { title: "x", profile: "retired-fixture" });
    expect(r.status).toBe(409);
    expect(store.sessions().length).toBe(before);
    expect((await call("POST", "/v1/chats", { title: "x", profile: "default" })).status).toBe(200);
  });

  test("a photo goes with its caption or the message is refused", async () => {
    const s = session();
    const png = PNG;
    const att = await upload("a.png", "image/png", png);
    sent.length = 0;
    expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "", attachments: [{ id: "f".repeat(64) }] })).status).toBe(400);
    expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "look", attachments: [{ id: "f".repeat(64) }] })).status).toBe(400);
    expect(sent).toHaveLength(0);
    expect((await call("POST", `/v1/chats/${s.id}/messages`, { text: "look", attachments: [att] })).status).toBe(200);
    const back = await call("POST", `/v1/chats/${s.id}/messages`, { text: "", attachments: [att] });
    expect(back.status).toBe(200);
    // The owner's bubble shows the photo it carried: named in the message, served by /v1/media.
    const shown = back.body.message.meta.attachments[0];
    expect(shown).toMatchObject({ kind: "image", mime: "image/png" });
    const img: Response = await routes["/v1/media/:id"].GET(Object.assign(signedRaw("GET", `/v1/media/${shown.media}`, new Uint8Array()), { params: { id: shown.media } }), {});
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png);
    expect(sent.map((x) => [x.text, x.opts.images?.[0]?.type, x.opts.images?.[0]?.data === Buffer.from(png).toString("base64")])).toEqual([["look", "image", true], ["", "image", true]]);
  });
});

describe("sends", () => {
  const prompts = (sid: string) => store.events(sid).filter((e) => e.kind === "user").length + store.queue(sid).length;

  test("a retry after the queue moved says what the prompt became", async () => {
    const s = session();
    sent.length = 0;
    const send = (id: string) => call("POST", `/v1/chats/${s.id}/messages`, { text: `later ${id}`, mode: "queue", client_id: id });
    const a = (await send("q-a")).body.message, b = (await send("q-b")).body.message;
    // The queue ran the first: its prompt is in the history under the receipt's id.
    store.dequeue(a.id);
    store.append(s.id, "user", { text: "later q-a", origin: "queued", queue_id: a.id });
    expect((await send("q-a")).body.message).toMatchObject({ id: a.id, kind: "text", content: "later q-a" });
    // The owner took the second off the queue on the desktop.
    store.dequeue(b.id);
    expect((await send("q-b")).body.message).toMatchObject({ id: b.id, kind: "deleted" });
    expect(sent.length).toBe(2);
  });

  test("a send that fails part way leaves no prompt and no receipt; the retry stores it once", async () => {
    const s = session();
    // An id over the limit is refused, not cut: two that differ later are two sends.
    const long = await call("POST", `/v1/chats/${s.id}/messages`, { text: "once", client_id: "x".repeat(201) });
    expect([long.status, prompts(s.id)]).toEqual([400, 0]);
    sendBreaks = true;
    await expect(call("POST", `/v1/chats/${s.id}/messages`, { text: "once", client_id: "c-broken" })).rejects.toThrow("the daemon stopped here");
    sendBreaks = false;
    expect(prompts(s.id)).toBe(0);
    const r = await call("POST", `/v1/chats/${s.id}/messages`, { text: "once", client_id: "c-broken" });
    expect([r.status, r.body.replayed, prompts(s.id)]).toEqual([200, undefined, 1]);
  });
});

describe("uploads", () => {
  test("a file over the limit is refused by its declared size, before its bytes are read, and the app is told the limit", async () => {
    const me = (await call("GET", "/v1/me")).body;
    expect(me.uploads).toEqual({ max_bytes: 20 * 1024 * 1024, inline_images: ["image/png", "image/jpeg", "image/gif", "image/webp"], image_edge: 2000 });
    let read = false;
    const req = signedRaw("POST", "/v1/upload?name=big.bin&mime=application/octet-stream", PNG);
    req.headers.set("content-length", String(me.uploads.max_bytes + 1));
    Object.defineProperty(req, "arrayBuffer", { value: async () => { read = true; return PNG.buffer; } });
    const res: Response = await routes["/v1/upload"].POST(Object.assign(req, { params: {} }), {});
    expect([res.status, (await res.json()).error, read]).toEqual([413, "a file can be at most 20 MiB", false]);
    expect((await upload("empty.txt", "text/plain", new Uint8Array())).status).toBe(400);
  });

  test("a name of dots is a file, and the stored type is what the daemon acts on", async () => {
    const text = (t: string) => new TextEncoder().encode(t);
    // `.` and `..` name a folder: stored as `file`, not an error.
    expect([(await upload(".", "text/plain", text("dot"))).file_name, (await upload("..", "text/plain", text("dots"))).file_name]).toEqual(["file", "file"]);
    // A PDF is one by its bytes, whatever it is called; bytes that only claim to be one are not.
    expect((await upload("a.bin", "application/octet-stream", text("%PDF-1.7 body"))).mime).toBe("application/pdf");
    expect((await upload("b.pdf", "application/pdf", text("not a pdf"))).mime).toBe("application/octet-stream");
    // A claim is kept for text only; one with control characters, or of a type nothing here acts on, is plain bytes.
    expect((await upload("c.json", encodeURIComponent("Application/JSON; charset=utf-8"), text("{}"))).mime).toBe("application/json");
    expect((await upload("d.txt", encodeURIComponent("text/plain\r\nx-evil: 1"), text("d"))).mime).toBe("application/octet-stream");
    expect((await upload("e.zip", "application/zip", text("PK"))).mime).toBe("application/octet-stream");
  });
});

// A session whose turns write files in a folder of its own, with checkpoints taken as the engine takes them.
async function changedSession() {
  ckpts ??= new Checkpoints(store, bus, { capture() {} } as any, join(dir, "checkpoints"));
  const ws = mkdtempSync(join(dir, "ws-"));
  writeFileSync(join(ws, "a.txt"), "one\ntwo\n");
  const s = store.createSession({ model: "fx:saved", workspace: ws, title: "Edits" });
  const call = { id: "c", tool: { name: "Bash", readOnly: false, kind: "shell" }, input: { command: "x" }, ctx: { cwd: ws } } as any;
  // A turn of tool calls, each the change it makes; `gap`, a change someone else makes between two of them.
  const turn = async (prompt: string, ...steps: (() => void)[]) => {
    store.append(s.id, "user", { text: prompt });
    store.append(s.id, "turn_start", {});
    for (const step of steps) {
      if ((step as any).gap) { step(); continue; }
      await ckpts!.before(s, call); step(); await ckpts!.after(s, call);
    }
    await ckpts!.end(s);
  };
  const gap = (f: () => void) => Object.assign(f, { gap: true });
  await turn("Change a", () => writeFileSync(join(ws, "a.txt"), "one\nTWO\nthree\n"));
  // The owner's editor saves c.txt between two of the turn's calls: outside the session's work.
  await turn("Add b", () => writeFileSync(join(ws, "b.txt"), "new file\n"), gap(() => writeFileSync(join(ws, "c.txt"), "the owner's\n")), () => {});
  return s;
}

describe("search", () => {
  test("the phone finds a session by its title and by what was said in it, the words marked", async () => {
    searchGet();
    const a = session("Rotate the signing keys");
    const b = session("Docs");
    store.append(b.id, "user", { text: "Why does the invoice total drift by a cent?" });
    store.append(b.id, "assistant", { blocks: [{ type: "text", text: "The invoice total is rounded twice." }] });
    store.side.flush();
    const r = (await call("GET", `/v1/search?q=${encodeURIComponent("invoice total")}`)).body;
    const ofB = r.hits.filter((h: any) => h.chat_id === b.id);
    expect(ofB.length).toBe(1); // one hit a session
    expect(ofB[0].title).toBe("Docs");
    expect(ofB[0].snippet).toContain("\u0001invoice\u0002");
    expect(["user", "assistant"]).toContain(ofB[0].kind);
    expect(typeof ofB[0].ts).toBe("number");
    const t = (await call("GET", `/v1/search?q=${encodeURIComponent("signing")}`)).body.hits;
    expect(t[0]).toMatchObject({ chat_id: a.id, kind: "title", title: "Rotate the signing keys" });
    // A session whose title and talk both hold the words is one row, with what was said.
    store.append(a.id, "user", { text: "Rotate the signing keys before Friday" });
    store.side.flush();
    const both = (await call("GET", `/v1/search?q=${encodeURIComponent("signing")}`)).body.hits.filter((h: any) => h.chat_id === a.id);
    expect(both.map((h: any) => [h.kind, h.title])).toEqual([["user", "Rotate the signing keys"]]);
    expect((await call("GET", "/v1/search?q=")).body.hits).toEqual([]);
    // A limit the search does not understand is said as the search says it.
    const bad = await call("GET", `/v1/search?q=${encodeURIComponent("state:sideways x")}`);
    expect([bad.status, bad.body.limit]).toEqual([400, true]);
  });
});

describe("working", () => {
  test("when a running turn started is read by one seek of the turn index, not a walk of the session", async () => {
    const s = session("Times");
    const at = Date.now() - 60_000;
    store.append(s.id, "turn_start", {}, null, at - 30_000);
    store.append(s.id, "turn_end", {}, null, at - 20_000);
    store.append(s.id, "turn_start", {}, null, at);
    for (let i = 0; i < 20; i++) store.append(s.id, "assistant", { text: String(i) });
    running.add(s.id);
    const query = store.db.query.bind(store.db);
    const asked: string[] = [];
    store.db.query = ((sql: string) => { if (/session_id = \?/.test(sql) && /turn_(start|end)/.test(sql)) asked.push(sql); return query(sql); }) as any;
    let body: any;
    try { body = (await call("GET", "/v1/sync?since=0")).body; } finally { store.db.query = query as any; running.delete(s.id); }
    expect(body.working.find((w: any) => w.chat_id === s.id).since).toBe(at / 1000);
    const plan = (sql: string) => JSON.stringify(query("EXPLAIN QUERY PLAN " + sql).all(...Array(sql.split("?").length - 1).fill(s.id)));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((sql) => !plan(sql).includes("events_turn_marks"))).toEqual([]);
  });
});

describe("reconnect", () => {
  test("a phone that says what it holds, by a digest per bucket of rows, is sent only the buckets that changed", async () => {
    const a = session("Kept A"), b = session("Kept B");
    // A phone that has synced something (a cursor of 0 is a whole read).
    store.append(b.id, "user", { text: "hello" });
    const whole = (await call("GET", "/v1/sync?since=0")).body;
    const rows = whole.chats.map((c: any) => ({ id: c.id, h: c.h }));
    const n = Math.min(rows.length, 128);
    const held = heldOf(rows, n);
    const at = whole.seq;
    // Nothing changed: no rows at all, where every row went before.
    const before = (await call("GET", `/v1/sync?since=${at}`)).body, after = (await call("GET", `/v1/sync?since=${at}&held=${held}`)).body;
    expect([before.complete, before.chats.length === whole.chats.length, after.complete, after.chats, after.buckets]).toEqual([true, true, false, [], { n, of: [] }]);
    const size = (x: any) => JSON.stringify(x.chats).length;
    expect(size(after)).toBeLessThan(size(before) / 10);
    // One renamed: the rows of its bucket alone, the renamed one among them.
    store.updateSession(a.id, { title: "Kept A, renamed" });
    const changed = (await call("GET", `/v1/sync?since=${at}&held=${held}`)).body;
    expect(changed.buckets).toEqual({ n, of: [bucketOf(a.id, n)] });
    expect(changed.chats.map((c: any) => c.title)).toContain("Kept A, renamed");
    expect(changed.chats.every((c: any) => bucketOf(c.id, n) === bucketOf(a.id, n))).toBe(true);
    // A row the phone holds that is gone: its bucket is sent whole, without it (the phone drops it).
    const gone = heldOf([...rows, { id: "s-gone", h: "00000000" }], n);
    const dropped = (await call("GET", `/v1/sync?since=${at}&held=${gone}`)).body;
    expect(dropped.buckets.of).toContain(bucketOf("s-gone", n));
    expect(dropped.chats.some((c: any) => c.id === "s-gone")).toBe(false);
    // The stream's first hello does the same; a whole read sends every row whatever is said.
    const st = await openStream(at, held);
    try {
      await st.read((f) => f.length > 0);
      expect([st.frames[0].sync.chats.map((c: any) => c.id).sort(), st.frames[0].sync.buckets]).toEqual([changed.chats.map((c: any) => c.id).sort(), changed.buckets]);
    } finally { await st.close(); }
    expect((await call("GET", `/v1/sync?since=0&held=${held}`)).body.complete).toBe(true);
    // A malformed digest is no digest: every row.
    expect((await call("GET", `/v1/sync?since=${at}&held=zz`)).body.complete).toBe(true);
  });

  test("what a phone holding many rows says fits any request header limit on the way", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `01a207a7-14cd-7521-82a1-${String(i).padStart(12, "0")}`, h: "f81933b8" }));
    const held = heldOf(many, Math.min(many.length, 128));
    // Proxies commonly take 8 KB of request line and headers; the stream's whole line stays far under it.
    expect(`GET /v1/events?since=123456789&held=${held} HTTP/1.1`.length).toBeLessThan(2048);
    const srv = Bun.serve({ port: 0, fetch: (r) => new Response(String(new URL(r.url).searchParams.get("held")?.split(".").length)) });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/v1/events?since=5&held=${held}`);
      expect([r.status, await r.text()]).toEqual([200, "128"]);
    } finally { srv.stop(true); }
  });

  test("both sides make the same digests (the contract's example)", () => {
    const ex = (wire as any).held;
    expect(heldOf(ex.rows, ex.n)).toBe(ex.held);
    expect(ex.rows.map((r: any) => bucketOf(r.id, ex.n))).toEqual(ex.buckets);
  });
});

describe("away", () => {
  test("the digest of the owner's absence reaches the phone in its words, and seen there it is gone", async () => {
    awayDigest = DIGEST;
    const a = (await call("GET", "/v1/away")).body.away;
    expect(a.span).toMatch(/^While you were away, .* \(2 h\)$/);
    expect(a.brief).toBe("the daemon went down and came back after 29 s; 3 turns ended, 1 failed; 1 approval waits");
    expect([a.failed, a.waiting, a.quiet, a.daemon]).toEqual([1, 1, 4, DIGEST.daemon]);
    expect(a.sessions.map((r: any) => [r.chat_id, r.state, r.bad ?? ""])).toEqual([["s-a", "Failed", "1 failed (provider)"], ["s-b", "Done", ""]]);
    expect((await call("DELETE", "/v1/away")).status).toBe(200);
    expect((await call("GET", "/v1/away")).body.away).toBeNull();
    // The owner touching the phone ends an absence, as a page in use does.
    expect((await call("POST", "/v1/presence", { idle_ms: 4000 })).status).toBe(200);
    expect(seenAt.at(-1)).toBe(4000);
    expect((await call("POST", "/v1/presence", {})).status).toBe(400);
  });
});

describe("errors", () => {
  // What broke on the daemon, on the phone: the page's open list, each kind whole.
  const fail = (source: "provider" | "server", message: string, sid?: string) => {
    const quiet = console.error;
    console.error = () => {};
    try { return tracker.capture(source, new Error(message), undefined, sid ? { session_id: sid } : {}); } finally { console.error = quiet; }
  };
  test("the open errors reach the phone whole, with their counts, times and session, and are read and resolved there", async () => {
    const s = session("Billing check 1");
    setSystemTime(T0);
    const long = `HTTP 402: the account has no credit left. ${"Add credit to the account or switch the session to another model. ".repeat(8)}`.trim();
    // Four times, a second apart, then a stall a minute later; the clock is put back after.
    let billing = fail("provider", long, s.id);
    for (let i = 1; i <= 3; i++) { setSystemTime(T0 + i * 1000); billing = fail("provider", long, s.id); }
    setSystemTime(T0 + 60_000);
    const stall = fail("server", "The loop was held for 3.2 s: a read of the ledger on the main thread");
    const done = fail("server", "An error the owner already resolved");
    setSystemTime();
    tracker.resolve(done.id, true);
    const list = (await call("GET", "/v1/errors")).body;
    const mine = list.errors.filter((e: any) => [billing.id, stall.id, done.id].includes(e.id));
    expect(mine.map((e: any) => [e.id, e.message, e.source, e.count, e.read, e.recovered, e.chat_id ?? null, e.title ?? null])).toEqual([
      [stall.id, "The loop was held for 3.2 s: a read of the ledger on the main thread", "server", 1, false, false, null, null],
      [billing.id, long, "provider", 4, false, false, s.id, "Billing check 1"],
    ]);
    expect([mine[1].first, mine[1].last, mine[0].first]).toEqual([T0 / 1000, T0 / 1000 + 3, T0 / 1000 + 60]);
    const unread0 = list.unread;
    expect(unread0).toBeGreaterThanOrEqual(2);
    // Read on the phone is read on the page: it leaves the count and stays on the list.
    const read = await call("POST", `/v1/errors/${billing.id}/read`);
    expect([read.status, read.body.row.id, read.body.row.read]).toEqual([200, billing.id, true]);
    expect(store.error(billing.id)!.read_ts).toBeGreaterThan(0);
    const after = (await call("GET", "/v1/errors")).body;
    expect(after.unread).toBe(unread0 - 1);
    expect(after.errors.find((e: any) => e.id === billing.id).read).toBe(true);
    expect((await call("POST", `/v1/errors/${billing.id}/unread`)).body.row.read).toBe(false);
    // Resolved, it leaves the open list.
    expect((await call("POST", `/v1/errors/${stall.id}/resolve`)).status).toBe(200);
    expect(store.error(stall.id)!.resolved_ts).toBeGreaterThan(0);
    expect((await call("GET", "/v1/errors")).body.errors.some((e: any) => e.id === stall.id)).toBe(false);
    expect((await call("POST", `/v1/errors/${stall.id}/forget`)).status).toBe(400);
    expect((await call("POST", "/v1/errors/no-such-error/read")).status).toBe(404);
  });
  // A key that reached an error's message is not sent to the phone: the tracker keeps the redacted text, and the route sends that.
  test("a secret in an error's message arrives redacted, and the list needs the device's signature", async () => {
    const key = "sk-ant-api03-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3";
    const e = fail("provider", `HTTP 401: invalid x-api-key ${key} for the account`);
    const row = (await call("GET", "/v1/errors")).body.errors.find((x: any) => x.id === e.id);
    expect(row.message).toContain("HTTP 401: invalid x-api-key");
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain("Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3");
    // Without the signature or with a signature of another path: nothing of the list.
    for (const headers of [{} as Record<string, string>, { authorization: `Bearer ${dev.token}` }]) {
      const res: Response = await routes["/v1/errors"].GET(Object.assign(new Request("http://x/v1/errors", { headers }), { params: {} }), { requestIP: () => null, timeout() {} });
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain("errors\":");
    }
  });
});

describe("landings", () => {
  test("a landing from the phone needs the approval key over the card's key and print; sent back, the words go whole", async () => {
    const path = `/v1/landings/${encodeURIComponent(landNow.key)}`;
    const list = (await call("GET", "/v1/landings")).body;
    expect(list.cards.map((c: any) => [c.key, c.ready, c.fp])).toEqual([[landNow.key, true, landNow.fp], [landLeft.key, false, landLeft.fp]]);
    landAsked.length = 0;
    // The request key alone lands nothing.
    expect((await call("POST", `${path}/land`, { fp: landNow.fp })).status).toBe(403);
    // Signed over another print than the one sent: refused before the queue is asked.
    const ts = String(Math.floor(Date.now() / 1000));
    const other = sign("sha256", Buffer.from(landMessage(landNow.key, "another", ts)), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    expect((await call("POST", `${path}/land`, { fp: landNow.fp }, { "x-hm-asig": other })).status).toBe(403);
    expect(landAsked).toEqual([]);
    const asig = sign("sha256", Buffer.from(landMessage(landNow.key, landNow.fp, ts)), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    const landed = await call("POST", `${path}/land`, { fp: landNow.fp }, { "x-hm-asig": asig });
    expect([landed.status, landed.body.entry.id, landAsked]).toEqual([200, "lq-1", [`land ${landNow.key} ${landNow.fp}`]]);
    // Sent back: words are needed, kept within a bound, and a print that changed is told with the card as it is.
    expect((await call("POST", `${path}/back`, { fp: landNow.fp, text: "  " })).status).toBe(400);
    expect((await call("POST", `${path}/back`, { fp: landNow.fp, text: "x".repeat(4001) })).status).toBe(400);
    expect((await call("POST", `${path}/back`, { fp: landNow.fp, text: "Split the rename out." })).body.sent).toEqual({ waits: true, held: false });
    expect(landAsked.at(-1)).toBe(`back ${landNow.key} ${landNow.fp} Split the rename out.`);
    expect(await call("POST", `${path}/back`, { fp: "old", text: "again" })).toMatchObject({ status: 409, body: { error: "gone", card: null } });
    expect((await call("POST", `${path}/merge`, { fp: landNow.fp })).status).toBe(400);
    expect((await call("POST", `${path}/land`, {})).status).toBe(400);
    // A key that is not a valid percent-encoding is a bad request, not a failure of the daemon.
    landAsked.length = 0;
    expect((await call("POST", "/v1/landings/s-root.%E0%A4%A/back", { fp: landNow.fp, text: "words" })).status).toBe(400);
    expect(landAsked).toEqual([]);
  });
});

describe("helper", () => {
  test("the phone turns the helper on, finds its conversation in the list, reads what it was told and prunes its memory", async () => {
    const was = helper;
    helper = null;
    try {
      // A daemon that runs no helper says so.
      expect((await call("GET", "/v1/helper")).status).toBe(409);
      helper = new Helper({ store, bus, providers, workspace: dir, errors: { capture() {}, onCapture: () => () => {} } } as any, noMail);
      helper.configure({ mail_every_min: 0 });
      expect((await call("GET", "/v1/helper")).body).toMatchObject({ on: false, chat_id: null, events: [] });
      expect((await call("PATCH", "/v1/helper", { on: "yes" })).status).toBe(400);
      // Turned on from the phone: its conversation is made, and the list marks it.
      const on = (await call("PATCH", "/v1/helper", { on: true })).body;
      expect(on.on).toBe(true);
      const row = (await call("GET", "/v1/chats")).body.chats.find((c: any) => c.id === on.chat_id);
      expect(row).toMatchObject({ title: "Helper", helper: 1, pinned: 1 });
      expect((await call("GET", "/v1/chats")).body.chats.filter((c: any) => c.helper).length).toBe(1);
      // What it was told, newest first.
      helper.record("failed", null, "Docs failed", "the provider refused", "feed");
      helper.record("mail", null, "Mail from Dana", "asks for the invoice", "feed");
      expect((await call("GET", "/v1/helper")).body.events.map((e: any) => e.title)).toEqual(["Mail from Dana", "Docs failed"]);
      // Its memory: all of it, found by words, one record forgotten.
      helper.records.put([{ key: "person.dana-levi", value: "Dana Levi, the client", aliases: ["Dana"], topics: ["clients"] }, { key: "pref.notify", value: "Failures only" }], "owner");
      expect((await call("GET", "/v1/helper")).body.memory).toBe(2);
      expect((await call("GET", "/v1/helper/memory")).body.items.map((m: any) => m.key).sort()).toEqual(["person.dana-levi", "pref.notify"]);
      expect((await call("GET", "/v1/helper/memory?q=Dana")).body.items.map((m: any) => m.key)).toEqual(["person.dana-levi"]);
      expect((await call("DELETE", "/v1/helper/memory/person.dana-levi")).body).toEqual({ ok: true });
      expect((await call("DELETE", "/v1/helper/memory/person.dana-levi")).status).toBe(404);
      expect((await call("GET", "/v1/helper/memory")).body.items.map((m: any) => m.key)).toEqual(["pref.notify"]);
      // A forget names a record by its key, never by a name another record is known by: a stale key
      // that is now pref.notify's alias forgets nothing, and a key that is not a key's spelling is refused.
      helper.records.put([{ key: "pref.notify", value: "Failures only", aliases: ["pref.alerts"] }], "owner");
      expect((await call("DELETE", "/v1/helper/memory/pref.alerts")).status).toBe(404);
      expect((await call("DELETE", "/v1/helper/memory/%E0%A4%A")).status).toBe(400);
      expect((await call("GET", "/v1/helper/memory")).body.items.map((m: any) => m.key)).toEqual(["pref.notify"]);
      // The whole memory comes a screen at a time: the newest, with how many there are.
      helper.records.put(Array.from({ length: 205 }, (_, i) => ({ key: `fact.n${i}`, value: `fact ${i}` })), "owner");
      const all = (await call("GET", "/v1/helper/memory")).body;
      expect([all.items.length, all.total, (await call("GET", "/v1/helper")).body.memory]).toEqual([200, 206, 206]);
      // Off: the conversation stays where it was.
      expect((await call("PATCH", "/v1/helper", { on: false })).body).toMatchObject({ on: false, chat_id: on.chat_id });
      helper.stop();
    } finally {
      helper = was;
    }
  });
});

describe("start", () => {
  test("a new session starts as the sheet chose: model, folder, machine and its first message", async () => {
    const before = sent.length;
    const ws = mkdtempSync(join(dir, "start-"));
    const old = session("Old");
    store.updateSession(old.id, { workspace: ws } as any);
    const offer = (await call("GET", "/v1/start")).body;
    expect(offer.model).toBe("fx:default");
    expect(offer.folders[0]).toMatchObject({ path: ws });
    expect(offer.folders.find((f: any) => f.home)?.path).toBe(dir);
    // A folder and a first message: the session is made there and the message sent.
    const made = (await call("POST", "/v1/chats", { workspace: ws, text: "Find why the build fails" })).body.chat;
    expect(store.session(made.id)!.workspace).toBe(ws);
    expect(sent.slice(before).map((x) => [x.id, x.text])).toEqual([[made.id, "Find why the build fails"]]);
    // A folder that is not one here, a relative one, and a model nobody has are refused before a session exists.
    const n = store.sessions().length;
    expect((await call("POST", "/v1/chats", { workspace: join(dir, "nope") })).status).toBe(400);
    expect((await call("POST", "/v1/chats", { workspace: "rel/dir" })).status).toBe(400);
    const was = providers.resolve;
    providers.resolve = async () => { throw new Error("no such model"); };
    try { expect((await call("POST", "/v1/chats", { model: "x:gone" })).body.error).toBe("no such model: pick another model"); } finally { providers.resolve = was; }
    expect(store.sessions().length).toBe(n);
    // On a machine of the fleet: the fleet's own start, and its refusal said as it came.
    fleetStart = (b) => {
      if (b.machine !== "m_7") return Response.json({ error: "no such machine" }, { status: 400 });
      const s = store.createSession({ model: b.model, workspace: b.workspace ?? "/srv/work", title: b.title });
      return Response.json({ session: s }, { status: 201 });
    };
    try {
      const far = (await call("POST", "/v1/chats", { machine: "m_7", workspace: "/srv/work/app", text: "Run the tests there" })).body.chat;
      expect(store.session(far.id)!.workspace).toBe("/srv/work/app");
      expect(sent.at(-1)).toMatchObject({ id: far.id, text: "Run the tests there" });
      expect((await call("POST", "/v1/chats", { machine: "m_9" })).body.error).toBe("no such machine");
    } finally { fleetStart = () => Response.json({ error: "no fleet in this test" }, { status: 409 }); }
  });
});

describe("changes", () => {
  test("a session's changes: each turn's files with their counts, newest first, and one file's diff", async () => {
    const s = await changedSession();
    const r = (await call("GET", `/v1/chats/${s.id}/changes`)).body;
    expect(r.turns.map((t: any) => [t.n, t.prompt, t.files.map((f: any) => [f.path, f.status, f.added, f.removed])])).toEqual([
      [2, "Add b", [["b.txt", "A", 1, 0], ["c.txt", "A", 1, 0]]],
      [1, "Change a", [["a.txt", "M", 2, 1]]],
    ]);
    expect(r.turns[0].files.map((f: any) => f.outside ?? false)).toEqual([false, true]);
    expect(r.session.map((f: any) => f.path).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    const one = (await call("GET", `/v1/chats/${s.id}/changes/diff?turn=${r.turns[1].turn}&path=a.txt`)).body;
    expect([one.path, one.status, one.truncated, one.diff.includes("-two"), one.diff.includes("+TWO"), one.diff.includes("b.txt")]).toEqual(["a.txt", "M", false, true, true, false]);
    // Since the session's first turn, without a turn.
    expect((await call("GET", `/v1/chats/${s.id}/changes/diff?path=b.txt`)).body.diff).toContain("+new file");
    // A path that leaves the folder is refused; a session on another machine says where its files are.
    expect((await call("GET", `/v1/chats/${s.id}/changes/diff?path=../x`)).status).toBe(400);
    if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
    store.db.query("UPDATE sessions SET machine = 'build box' WHERE id = ?").run(s.id);
    try {
      const far = (await call("GET", `/v1/chats/${s.id}/changes`)).body;
      expect([far.turns, far.unavailable]).toEqual([[], "This session's files are on build box: its changes are read on the computer."]);
    } finally { store.db.query("UPDATE sessions SET machine = NULL WHERE id = ?").run(s.id); }
  });
});

describe("plans", () => {
  // The page's plan routes over the same store, and the tool a model in plan mode calls.
  let draining = false;
  const planApi: any = planRoutes({ store, bus, engine: { isDraining: () => draining } } as any);
  const present = toolsFor("other").find((t) => t.name === "present_plan")!;
  const stops: AbortController[] = [];
  const presents = (sid: string, callId: string, plan: string) => {
    store.append(sid, "assistant", { blocks: [{ type: "tool_use", id: callId, name: "present_plan", input: { plan, title: "Split the store" } }] });
    let got: any;
    const stop = new AbortController();
    stops.push(stop);
    present.run({ plan, title: "Split the store" }, { callId, sessionId: sid, signal: stop.signal } as any).then((r: any) => (got = r));
    return Object.assign(() => got, { stop: () => stop.abort() });
  };
  const signedApprove = (aid: string, body: any) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const asig = sign("sha256", Buffer.from(approvalMessage(aid, body.choice, ts, true, "")), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    return call("POST", `/v1/approvals/${aid}`, body, body.choice === "deny" ? {} : { "x-hm-asig": asig, "x-hm-asig-v": "2" });
  };

  test("a waiting plan is a card on the phone: read whole, approved in a mode, or sent back with what to change", async () => {
    const s = session("Refactor");
    const result = presents(s.id, "call-plan-1", "1. Split store.ts.\n2. Move the checkpoint thread.\n3. Run the tests.");
    await Bun.sleep(0);
    // The chat needs the owner, and the card says the whole plan; the Needs list has it.
    const synced = (await call("GET", "/v1/sync")).body;
    expect(synced.chats.find((c: any) => c.id === s.id).status).toBe("needs_you");
    const c = synced.approvals.find((a: any) => a.chat_id === s.id);
    expect(c).toMatchObject({ id: `plan-${s.id}.call-plan-1`, kind: "plan", state: "pending", command: "Split the store", text: "1. Split store.ts.\n2. Move the checkpoint thread.\n3. Run the tests.", lines: 3, hold: ["plan"] });
    expect(c.actions.map((a: string[]) => a[1])).toEqual(["session", "once", "deny"]);
    // The chat shows it in place.
    const page = (await call("GET", `/v1/chats/${s.id}/messages?paged=1`)).body;
    expect(page.messages.some((m: any) => m.kind === "approval" && m.meta.approval_id === `plan-${s.id}.call-plan-1` && m.meta.card === "plan")).toBe(true);
    // Approving needs the approval key and the plan read to its end.
    expect((await call("POST", `/v1/approvals/plan-${s.id}.call-plan-1`, { choice: "session", seen: "whole" })).status).toBe(403);
    const unread = await signedApprove(`plan-${s.id}.call-plan-1`, { choice: "session" });
    expect([unread.status, unread.body.error]).toEqual([409, "Read the plan to its end to approve it."]);
    const ok = await signedApprove(`plan-${s.id}.call-plan-1`, { choice: "session", seen: "whole" });
    expect(ok.status).toBe(200);
    expect(ok.body.approval).toMatchObject({ id: `plan-${s.id}.call-plan-1`, state: "approved", choice: "session" });
    await Bun.sleep(0);
    expect(result().content).toContain("now in auto-edits mode");
    expect(JSON.parse(store.db.query<{ data: string }, [string]>("SELECT data FROM plans WHERE session_id = ?").get(s.id)!.data).mode).toBe("auto-edits");
    // How it ended reaches a phone that was away.
    expect((await call("GET", "/v1/sync")).body.approvals.find((a: any) => a.id === `plan-${s.id}.call-plan-1`)).toMatchObject({ state: "approved" });
    expect((await signedApprove(`plan-${s.id}.call-plan-1`, { choice: "once", seen: "whole" })).status).toBe(409);

    // Sent back: what to change goes to the model, and nothing is signed for it.
    const again = presents(s.id, "call-plan-2", "1. Split store.ts.");
    await Bun.sleep(0);
    const back = await call("POST", `/v1/approvals/plan-${s.id}.call-plan-2`, { choice: "deny", feedback: "Keep the checkpoint thread where it is." });
    expect([back.status, back.body.approval.state]).toEqual([200, "denied"]);
    await Bun.sleep(0);
    expect(again().content).toContain("Keep the checkpoint thread where it is.");
    void planApi;
  });

  test("two sessions' plans under one call id wait side by side: deciding one leaves the other waiting", async () => {
    const a = session("A"), b = session("B");
    const ra = presents(a.id, "call-same", "1. A."), rb = presents(b.id, "call-same", "1. B.");
    await Bun.sleep(0);
    expect(plansWaiting().filter((p) => p.id === "call-same").map((p) => p.session_id).sort()).toEqual([a.id, b.id].sort());
    expect((await call("POST", `/v1/approvals/plan-${a.id}.call-same`, { choice: "deny", feedback: "not A" })).status).toBe(200);
    await Bun.sleep(0);
    expect([ra().content.includes("not A"), rb()]).toEqual([true, undefined]);
    const cards = (await call("GET", "/v1/sync")).body.approvals.filter((c: any) => c.kind === "plan" && c.id.endsWith(".call-same"));
    expect(cards.map((c: any) => [c.id, c.state]).sort()).toEqual([[`plan-${a.id}.call-same`, "denied"], [`plan-${b.id}.call-same`, "pending"]].sort());
    expect((await call("POST", `/v1/approvals/plan-${b.id}.call-same`, { choice: "deny" })).status).toBe(200);
  });

  test("a plan parked by a stopping daemon is not said to have ended; one whose turn was stopped is", async () => {
    const s = session("Parked");
    const parked = presents(s.id, "call-park", "1. Wait.");
    await Bun.sleep(0);
    draining = true;
    try { parked.stop(); } finally { draining = false; }
    await Bun.sleep(0);
    expect((await call("GET", "/v1/sync")).body.approvals.some((c: any) => c.id === `plan-${s.id}.call-park`)).toBe(false);
    // Put back on its card at the next start: the phone sees it waiting, under the same id.
    presents(s.id, "call-park", "1. Wait.");
    await Bun.sleep(0);
    expect((await call("GET", "/v1/sync")).body.approvals.filter((c: any) => c.id === `plan-${s.id}.call-park`).map((c: any) => c.state)).toEqual(["pending"]);
    // The owner's Stop ends it.
    stops.at(-1)!.abort();
    await Bun.sleep(0);
    expect((await call("GET", "/v1/sync")).body.approvals.filter((c: any) => c.id === `plan-${s.id}.call-park`).map((c: any) => c.state)).toEqual(["expired"]);
  });

  test("a plan is not approved from a notification", async () => {
    const s = session("From a notification");
    presents(s.id, "call-note", "1. One.");
    await Bun.sleep(0);
    const r = await signedApprove(`plan-${s.id}.call-note`, { choice: "once", seen: "whole", via: "notification" });
    expect([r.status, r.body.error]).toEqual([409, "Open the plan to read it before approving it."]);
    expect((await call("POST", `/v1/approvals/plan-${s.id}.call-note`, { choice: "deny", via: "notification" })).status).toBe(200);
  });

  test("a plan's push opens the app and allows nothing from the notification", () => {
    const d = alertPush({ id: "al-1", kind: "question", session_id: "s-1", title: "Plan to approve: Refactor", body: "Split the store", data: { plan_id: "call-9", open_session: "s-1" } } as any).data;
    expect([d.aid, d.hold, d.opts]).toEqual(["plan-s-1.call-9", "plan", JSON.stringify(["deny"])]);
  });

  test("a phone with no screen lock approves a plan only into a mode where every change asks", async () => {
    const s = session("No lock");
    presents(s.id, "call-plan-3", "1. One step.");
    await Bun.sleep(0);
    store.db.query("UPDATE mobile_devices SET nolock = 1 WHERE id = ?").run(dev.device_id);
    try {
      expect((await signedApprove(`plan-${s.id}.call-plan-3`, { choice: "session", seen: "whole" })).status).toBe(403);
      expect((await signedApprove(`plan-${s.id}.call-plan-3`, { choice: "once", seen: "whole" })).status).toBe(200);
    } finally { store.db.query("UPDATE mobile_devices SET nolock = 0 WHERE id = ?").run(dev.device_id); }
  });
});

describe("questions", () => {
  test("a pending question keeps its words however far back; several questions need one answer each", async () => {
    const s = session();
    const input = { questions: [{ id: "build", question: "Build type?", options: [{ label: "Debug" }, { label: "Release" }] }, { id: "checks", question: "Which checks?", options: [{ label: "Unit" }, { label: "Integration" }] }] };
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-q", name: "AskUserQuestion", input }] });
    let got: any;
    ask({ callId: "call-q", sessionId: s.id, signal: new AbortController().signal } as any).then((a) => (got = a?.answers));
    for (let i = 0; i < 45; i++) store.append(s.id, "note", { text: "later" });
    const card = (await call("GET", `/v1/chats/${s.id}/run`)).body.approvals.find((a: any) => a.id === `q-${s.id}.call-q`);
    expect(card.command).toBe("Build type?\nWhich checks?");
    expect(card.questions.map((q: any) => q.options)).toEqual([["Debug", "Release"], ["Unit", "Integration"]]);
    // The card has its place in the chat, where the app answers it.
    const inChat = (await call("GET", `/v1/chats/${s.id}/messages`)).body.messages.find((m: any) => m.kind === "approval");
    expect(inChat.meta).toMatchObject({ approval_id: `q-${s.id}.call-q`, card: "question", state: "pending" });
    // Answers are signed with the approval key over what they say.
    const answer = (body: any, text: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const asig = sign("sha256", Buffer.from(`approve2\nq-${s.id}.call-q\nonce\n${sha256Hex(text)}\n${ts}`), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
      return call("POST", `/v1/approvals/q-${s.id}.call-q`, { choice: "once", ...body }, { "x-hm-asig": asig, "x-hm-asig-v": "2" });
    };
    // One scalar for two questions is refused, and so is an answer that leaves one out.
    expect((await answer({ answer: "Debug" }, "Debug")).status).toBe(400);
    const partial = { build: "Debug" };
    expect((await answer({ answers: partial }, JSON.stringify([["build", "Debug"]]))).status).toBe(400);
    expect(got).toBeUndefined();
    const both = { build: "Debug", checks: ["Integration"] };
    expect((await answer({ answers: both }, JSON.stringify([["build", "Debug"], ["checks", ["Integration"]]]))).status).toBe(200);
    await Bun.sleep(0);
    expect(got).toEqual({ build: { picked: ["Debug"] }, checks: { picked: ["Integration"] } });
    // Reopened later (a sync), the closed card still says what was picked, question by question.
    const reopened = (await call("GET", "/v1/sync?since=0")).body.approvals.find((a: any) => a.id === `q-${s.id}.call-q`);
    expect(reopened).toMatchObject({ state: "approved", answers: { build: { picked: ["Debug"] }, checks: { picked: ["Integration"] } } });
    expect(reopened.questions.map((q: any) => q.id)).toEqual(["build", "checks"]);
  });

  // The model says what each choice means beside its label, and heads the question with a word: the
  // phone chooses from the same words the page shows.
  test("a choice's meaning and the question's header reach the phone", async () => {
    const s = session();
    const input = { questions: [{ header: "Scope", question: "Fix only cart.js or the whole module?", options: [{ label: "Only cart.js", description: "Smallest change, ships today" }, { label: "Whole module", description: "Every caller gets the bound" }, { label: "Ask the team" }] }, { question: "Go?", options: [{ label: "Yes" }, { label: "No" }] }] };
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-d", name: "AskUserQuestion", input }] });
    ask({ callId: "call-d", sessionId: s.id, signal: new AbortController().signal } as any);
    const card = (await call("GET", `/v1/chats/${s.id}/run`)).body.approvals.find((a: any) => a.id === `q-${s.id}.call-d`);
    expect(card.questions[0]).toMatchObject({ header: "Scope", options: ["Only cart.js", "Whole module", "Ask the team"], details: ["Smallest change, ships today", "Every caller gets the bound", ""] });
    // A question with no meanings and no header says neither.
    expect(Object.keys(card.questions[1]).sort()).toEqual(["id", "multi", "options", "question"]);
  });

  test("a choice's meaning and a header run long: the card carries them cut, with a mark", async () => {
    const s = session();
    const long = "Every caller of the retry helper gets the bound. ".repeat(40);
    const input = { questions: [{ header: "A header far longer than any chip should be", question: "Which?", options: [{ label: "A", description: long }, { label: "B", description: "Short" }] }] };
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-l", name: "AskUserQuestion", input }] });
    ask({ callId: "call-l", sessionId: s.id, signal: new AbortController().signal } as any);
    const q = (await call("GET", `/v1/chats/${s.id}/run`)).body.approvals.find((a: any) => a.id === `q-${s.id}.call-l`).questions[0];
    expect(q.details[0].length).toBeLessThanOrEqual(300);
    expect(q.details[0].length).toBeGreaterThan(290);
    expect(q.details[0].endsWith("\u2026")).toBe(true);
    expect(long.startsWith(q.details[0].slice(0, -1))).toBe(true);
    expect(q.details[1]).toBe("Short");
    expect(q.header.length).toBeLessThanOrEqual(32);
    expect(q.header.endsWith("\u2026")).toBe(true);
  });

  // A server can ask one question after another on one call. A card of the
  // first, still on the phone after it was answered on the desktop, must not
  // answer or decline the second.
  test("a server's question is answered by its own card: a card of the question before it finds nothing", async () => {
    const s = session();
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-s", name: "mcp_call", input: { tool: "srv__ask" } }] });
    const ctx = { callId: "call-s", sessionId: s.id, signal: new AbortController().signal } as any;
    const form = (id: string, question: string) => ({ id, from: "srv", message: question, questions: [{ id: "ok", question, options: [{ label: "Yes" }, { label: "No" }] }] });
    const cards = async () => (await call("GET", `/v1/chats/${s.id}/run`)).body.approvals.filter((a: any) => a.kind === "question").map((a: any) => a.id);
    const send = (id: string, choice: "once" | "deny", answer?: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const asig = sign("sha256", Buffer.from(`approve2\n${id}\nonce\n${sha256Hex(answer ?? "")}\n${ts}`), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
      return call("POST", `/v1/approvals/${id}`, { choice, ...(answer ? { answer } : {}) }, choice === "once" ? { "x-hm-asig": asig, "x-hm-asig-v": "2" } : {});
    };
    const first = askFor(ctx, form("q-one", "Go on?"));
    expect(await cards()).toEqual([`q-${s.id}.call-s-q-one`]);
    // Answered on the desktop; the server asks its next question on the same call.
    expect(answer(s.id, "call-s", { ok: { picked: ["Yes"] } }, false, "q-one")).toBe(true);
    expect(await first).toEqual({ ok: { picked: ["Yes"] } });
    let second: any = "waiting";
    askFor(ctx, form("q-two", "Delete it all?")).then((a) => (second = a));
    expect(await cards()).toEqual([`q-${s.id}.call-s-q-two`]);
    // The phone still shows the first card: its answer, its dismissal and the call's bare id find nothing.
    expect([(await send(`q-${s.id}.call-s-q-one`, "once", "Yes")).status, (await send(`q-${s.id}.call-s-q-one`, "deny")).status, (await send(`q-${s.id}.call-s`, "once", "Yes")).status, (await send(`q-${s.id}.call-s`, "deny")).status]).toEqual([409, 409, 409, 409]);
    await Bun.sleep(0);
    expect(second).toBe("waiting");
    // The first card comes back closed under its own id, with nothing of the second question in it.
    const closed = (await call("GET", "/v1/sync?since=0")).body.approvals.find((a: any) => a.id === `q-${s.id}.call-s-q-one`);
    expect([closed.state, closed.command, closed.questions]).toEqual(["approved", "", []]);
    // The second card answers the second question.
    expect((await send(`q-${s.id}.call-s-q-two`, "once", "No")).status).toBe(200);
    await Bun.sleep(0);
    expect(second).toEqual({ ok: { picked: ["No"] } });
  });

  test("two sessions' questions under one call id are two cards: answering one leaves the other waiting", async () => {
    const a = session("A"), b = session("B");
    const one = { questions: [{ id: "q", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] };
    const got: Record<string, any> = {};
    for (const s of [a, b]) {
      store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-1-0", name: "AskUserQuestion", input: one }] });
      ask({ callId: "call-1-0", sessionId: s.id, signal: new AbortController().signal } as any).then((x) => (got[s.id] = x?.answers));
    }
    const ids = (await call("GET", "/v1/sync?since=0")).body.approvals.filter((c: any) => c.kind === "question" && c.id.endsWith(".call-1-0") && c.state === "pending").map((c: any) => c.id);
    expect(ids.sort()).toEqual([`q-${a.id}.call-1-0`, `q-${b.id}.call-1-0`].sort());
    const ts = String(Math.floor(Date.now() / 1000));
    const aid = `q-${b.id}.call-1-0`;
    const text = answersText({ q: "No" });
    const asig = sign("sha256", Buffer.from(approvalMessage(aid, "once", ts, true, text)), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    expect((await call("POST", `/v1/approvals/${aid}`, { choice: "once", answers: { q: "No" } }, { "x-hm-asig": asig, "x-hm-asig-v": "2" })).status).toBe(200);
    await Bun.sleep(0);
    expect([got[a.id], got[b.id]]).toEqual([undefined, { q: { picked: ["No"] } }]);
    expect((await call("POST", `/v1/approvals/q-${a.id}.call-1-0`, { choice: "deny" })).status).toBe(200);
    // A push names the card of the session that asked.
    expect(alertPush({ id: "al-q", kind: "question", session_id: a.id, title: "Question", body: "Ship it?", data: { call_id: "call-1-0", open_session: b.id } } as any).data.aid).toBe(`q-${b.id}.call-1-0`);
  });

  test("a question answered elsewhere comes back closed in the next sync", async () => {
    const s = session();
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "call-c", name: "AskUserQuestion", input: { question: "Go?", type: "yesno" } }] });
    const ac = new AbortController();
    const p = ask({ callId: "call-c", sessionId: s.id, signal: ac.signal } as any);
    const from = mobile.globalSeq();
    let cards = (await call("GET", `/v1/sync?since=${from}`)).body.approvals.filter((a: any) => a.id === `q-${s.id}.call-c`);
    expect(cards.map((c: any) => c.state)).toEqual(["pending"]);
    ac.abort();
    await p;
    cards = (await call("GET", `/v1/sync?since=${from}`)).body.approvals.filter((a: any) => a.id === `q-${s.id}.call-c`);
    expect(cards.map((c: any) => c.state)).toEqual(["expired"]);
  });
});

describe("run, usage and pulse", () => {
  test("Run lists the latest turn's calls and names the saved model; usage counts every input token", async () => {
    const s = session();
    running.add(s.id);
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "turn_start", {});
    const steps = async () => (await call("GET", `/v1/chats/${s.id}/run`)).body;
    expect((await steps()).steps).toHaveLength(0);
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "fixture_lookup", input: { query: "q" } }], model: "fx:saved" });
    store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: "secret output" }] });
    const mid = await steps();
    expect(mid.steps.map((x: any) => [x.tool, x.what])).toEqual([["fixture_lookup", "q"]]);
    expect(JSON.stringify(mid)).not.toContain("secret output");
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "done" }], model: "fx:saved" });
    store.append(s.id, "turn_end", { reason: "end_turn", usage: { input: 200, output: 5, cache_read: 30, cache_write: 4 } });
    running.delete(s.id);
    const idle = await steps();
    expect([idle.steps.length, idle.session.model]).toEqual([1, "fx:saved"]);
    store.updateSession(s.id, { usage: { input: 300, output: 15, cache_read: 50, cache_write: 4 } as any });
    const u = (await call("GET", `/v1/chats/${s.id}/usage`)).body;
    expect(u.session.prompt_tokens + u.session.output_tokens).toBe(369);
    expect([u.turn.prompt_tokens, u.turn.output_tokens, u.turn.calls]).toEqual([234, 5, 2]);
    store.append(s.id, "turn_start", {});
    running.add(s.id);
    expect((await steps()).steps).toHaveLength(0);
    running.delete(s.id);
  });

  test("the elapsed time counts from the turn's start, not its newest event", async () => {
    setSystemTime(new Date("2026-02-01T10:00:00Z"));
    const s = session();
    store.append(s.id, "turn_start", {});
    running.add(s.id);
    setSystemTime(new Date("2026-02-01T10:00:40Z"));
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x" }] });
    setSystemTime(new Date("2026-02-01T10:00:50Z"));
    const w = (await call("GET", "/v1/sync?since=0")).body.working.find((x: any) => x.chat_id === s.id);
    expect(Date.now() / 1000 - w.since).toBe(50);
    // The next turn, before its start is stored: it counts from now, not from the previous turn.
    store.append(s.id, "turn_end", { reason: "end_turn" });
    setSystemTime(new Date("2026-02-01T10:02:00Z"));
    store.append(s.id, "user", { text: "next" });
    const w2 = (await call("GET", "/v1/sync?since=0")).body.working.find((x: any) => x.chat_id === s.id);
    expect(Date.now() / 1000 - w2.since).toBe(0);
    running.delete(s.id);
    setSystemTime();
  });

  test("Pulse: seven day bars, unpriced turns apart, cron fails from failed runs only", async () => {
    store.db.run("PRAGMA foreign_keys = OFF");
    store.db.run("CREATE TABLE IF NOT EXISTS loop_runs (id TEXT PRIMARY KEY, loop_id TEXT, session_id TEXT, due_ms INTEGER, started_ms INTEGER, ended_ms INTEGER, ok INTEGER, detail TEXT, skip_reason TEXT, stop INTEGER NOT NULL DEFAULT 0)");
    const before = (await call("GET", "/v1/pulse")).body;
    const s = session();
    // A manual turn that failed is not a cron failure.
    store.append(s.id, "turn_start", {});
    store.append(s.id, "error", { message: "boom" });
    store.append(s.id, "turn_end", { reason: "error", usage: { cost: 1 } });
    store.append(s.id, "turn_end", { reason: "end_turn", usage: {} });
    const now = Date.now();
    store.db.query("INSERT INTO loop_runs (id, loop_id, session_id, due_ms, ended_ms, ok) VALUES ('run-f', 'l1', ?, ?, ?, 0)").run(s.id, now, now);
    store.db.query("INSERT INTO loop_runs (id, loop_id, session_id, due_ms, ended_ms, ok, skip_reason) VALUES ('run-s', 'l1', ?, ?, ?, 0, 'busy')").run(s.id, now, now);
    const p = (await call("GET", "/v1/pulse")).body;
    expect(p.spend_7d).toHaveLength(7);
    expect(p.spend_7d[6] - before.spend_7d[6]).toBeCloseTo(1);
    expect(p.spend_7d_unpriced[6] - before.spend_7d_unpriced[6]).toBe(1);
    expect(p.failures_today - before.failures_today).toBe(1);
    expect(p.failed_runs_today.map((r: any) => r.id)).toContain("run-f");
  });
});

// The event stream as the app reads it: `read` pulls frames until `until` holds.
async function openStream(since?: number, held?: string) {
  const path = (since === undefined ? "/v1/events" : `/v1/events?since=${since}`) + (held ? `${since === undefined ? "?" : "&"}held=${held}` : "");
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("sha256", Buffer.from(`GET\n${path}\n${ts}\n${sha256Hex("")}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  const req: any = new Request(`http://x${path}`, { headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
  req.params = {};
  const res: Response = await routes["/v1/events"].GET(req, { requestIP: () => null, timeout() {} });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: any[] = [];
  let buf = "";
  const read = async (until: (frames: any[]) => boolean) => {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) frames.push(JSON.parse(buf.slice(6, i)));
    }
    return frames;
  };
  return { frames, read, close: () => reader.cancel() };
}
const texts = (messages: any[], sid: string) => messages.filter((m) => m.chat_id === sid && m.kind !== "deleted").map((m) => m.content);

describe("the event stream", () => {
  test("a stream that falls behind says resync instead of dropping silently", async () => {
    const st = await openStream();
    const s = session();
    for (let i = 0; i < 1100; i++) bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "x" } as any);
    let sentAfter = false;
    // The phone read what was queued; the next frame says what it missed.
    await st.read((f) => {
      if (!sentAfter && f.length >= 1000) { sentAfter = true; bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "after" } as any); }
      return f.some((x) => x.type === "resync") || f.length > 5000;
    });
    await st.close();
    expect(st.frames.some((x) => x.type === "resync")).toBe(true);
    // An app that names no cursor gets no catch-up in the stream.
    expect(st.frames.filter((x) => x.type === "hello").map((x) => "sync" in x)).toEqual([false]);
  });

  test("a stream that fell behind catches up on the same stream once the phone reads again", async () => {
    const s = session();
    const st = await openStream(mobile.globalSeq());
    for (let i = 0; i < 1100; i++) bus.emit({ t: "delta", session_id: s.id, kind: "text", index: 0, text: "x" } as any);
    // Stored while the stream drops frames: the phone never gets this one live.
    const lost = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "stored during the lag" }] });
    bus.emit({ t: "event", event: lost } as any);
    let poked = false;
    await st.read((f) => {
      if (!poked && f.length >= 1000) { poked = true; bus.emit({ t: "session", session: store.session(s.id)! } as any); }
      return f.filter((x) => x.type === "hello").length >= 2 || f.length > 5000;
    });
    await st.close();
    const types = st.frames.map((x) => x.type);
    expect(types.indexOf("resync")).toBeGreaterThan(0);
    const recovered = st.frames[types.lastIndexOf("hello")];
    expect(types.lastIndexOf("hello")).toBe(types.indexOf("resync") + 1);
    expect(texts(recovered.sync.messages, s.id)).toEqual(["stored during the lag"]);
    expect(recovered.cursor).toBe(mobile.gseqOf(lost.id));
  });

  test("a cursor this store never gave, or one more than a page behind, is told to reload whole", async () => {
    const s = session();
    store.append(s.id, "user", { text: "kept" });
    const now = mobile.globalSeq();
    // A cursor from another store (a restored backup): above anything given here.
    const ahead = (await call("GET", `/v1/sync?since=${now + 500}`)).body;
    expect([ahead.reload, ahead.seq, ahead.more]).toEqual(["ahead", now, false]);
    expect(texts(ahead.messages, s.id)).toEqual(["kept"]);
    // Deleting the newest session does not put a level phone ahead.
    const gone = session();
    store.append(gone.id, "user", { text: "gone" });
    const level = mobile.globalSeq();
    store.deleteSession(gone.id);
    expect((await call("GET", `/v1/sync?since=${level}`)).body.reload).toBeUndefined();
    // More than a page behind: the newest page of every chat, not the backlog.
    for (let i = 0; i < 2001; i++) store.append(s.id, "user", { text: `row-${i}` });
    const behind = (await call("GET", `/v1/sync?since=${level}`)).body;
    expect([behind.reload, behind.seq, behind.more, texts(behind.messages, s.id).length]).toEqual(["behind", mobile.globalSeq(), false, 40]);
    // The stream says the same in its first frame.
    const st = await openStream(level);
    const [hello] = await st.read((f) => f.length >= 1);
    await st.close();
    expect(hello.sync.reload).toBe("behind");
  }, 30_000); // two thousand stored events: slow on a disk that is busy
});

describe("branches", () => {
  test("a head moved onto an event that was already below it is a branch change, and a leftover marker stops no move", async () => {
    const s = session();
    const a = store.append(s.id, "user", { text: "a" });
    const b = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "b" }] });
    const marks = () => mobile.branchSeq(s.id);
    expect(marks()).toBe(0);
    // Rewound to `a`, then its child `b` shown again: `b` was stored before the rewind, so it is no append.
    store.updateSession(s.id, { head: a.id });
    const rewound = marks();
    store.updateSession(s.id, { head: b.id });
    expect([rewound > 0, marks() > rewound]).toEqual([true, true]);
    // A new event below the head is an append: no mark.
    const at = marks();
    store.append(s.id, "user", { text: "c" });
    expect(marks()).toBe(at);
    // A marker row left behind (a trigger cut short) does not make the next move throw.
    store.db.query("INSERT INTO event_gseq (event_id) VALUES (?)").run(`head:${s.id}`);
    store.updateSession(s.id, { head: a.id });
    expect(marks()).toBeGreaterThan(at);
    expect(store.db.query("SELECT COUNT(*) AS n FROM event_gseq WHERE event_id LIKE 'head:%'").get()).toEqual({ n: 0 });
  });

  test("a head move that brought no frame reaches the phone with the next heartbeat, before the cursor passes it", async () => {
    const s = session();
    const base = store.append(s.id, "user", { text: "base" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "old" }] }, base.id);
    const neu = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "new" }] }, base.id);
    jest.useFakeTimers();
    const st = await openStream(mobile.globalSeq());
    try {
      store.updateSession(s.id, { head: base.id }); // no bus frame
      jest.advanceTimersByTime(15_000);
    } finally {
      jest.useRealTimers();
    }
    await st.read((f) => f.some((x) => x.type === "seq"));
    await st.close();
    const types = st.frames.map((x) => x.type);
    expect(types.indexOf("chat_reset")).toBeGreaterThan(0);
    expect(types.indexOf("chat_reset")).toBeLessThan(types.indexOf("seq"));
    const reset = st.frames.find((x) => x.type === "chat_reset");
    expect([reset.chat_id, texts(reset.messages, s.id), reset.messages.find((m: any) => m.id === neu.id).kind]).toEqual([s.id, ["base"], "deleted"]);
    expect(st.frames.find((x) => x.type === "seq").cursor).toBe(mobile.globalSeq());
  });
});

// contract/wire.json is the wire written once: the bytes that are signed, and
// per shape the fields the app reads with examples. Here the daemon is held to
// it; the app's build holds the app to the same file (ContractTest.kt).
describe("the wire contract", () => {
  const fields = wire.fields as Record<string, Record<string, string>>;
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const at = (o: any, path: string) => path.split(".").reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
  // The shapes inside a shape: where they are and what they are.
  const PARTS: Record<string, [string, string][]> = {
    sync: [["chats", "chat"], ["messages", "message"], ["approvals", "card"], ["working", "working_row"], ["drafts", "draft"], ["reset", "reset"]],
    message: [["meta.steps", "step"], ["meta.attachments", "attachment"]], send: [["attachments", "upload_ref"]], card: [["questions", "question"], ["answers", "picked"]],
    page: [["messages", "message"]], receipt: [["message", "message"]], resolved: [["approval", "card"]],
    pulse: [["approvals", "card"], ["live_sessions", "pulse_session"]], helper: [["events", "helper_event"]], helper_answer: [["read", "helper_read"]], memory: [["items", "memory_record"]], usage: [["session", "usage_session"]], created: [["chat", "chat"]],
    hello: [["sync", "sync"]], message_frame: [["message", "message"], ["chat", "chat"]], chat_frame: [["chat", "chat"]],
    chat_reset: [["messages", "message"], ["chat", "chat"]], approval: [["approval", "card"]], seq: [["working", "working_row"]],
    changes: [["turns", "change_turn"], ["session", "file_change"]], change_turn: [["files", "file_change"]],
    start: [["models", "start_model"], ["folders", "start_folder"], ["machines", "start_machine"]],
    search: [["hits", "search_hit"]],
    away: [["away.sessions", "away_session"]],
    errors: [["errors", "error_row"]], error_marked: [["row", "error_row"]], error_changed: [["row", "error_row"]],
    landings: [["cards", "land_card"]], land_card: [["areas", "land_area"]], landed: [["card", "land_card"]], sent_back: [["card", "land_card"]], landing_refused: [["card", "land_card"]],
  };
  // What a value breaks of its shape's fields, the shapes inside it included; `seen` collects the fields it has.
  function broken(shape: string, v: any, seen = new Set<string>(), out: string[] = []) {
    for (const [path, decl] of Object.entries(fields[shape]!)) {
      const got = at(v, path);
      if (got === undefined) { if (!decl.endsWith("?")) out.push(`${shape}.${path} is missing`); continue; }
      if (!decl.replace("?", "").split("|").includes(typeOf(got))) out.push(`${shape}.${path} is ${typeOf(got)}, not ${decl}`);
      else seen.add(`${shape}.${path}`);
    }
    for (const [path, part] of PARTS[shape] ?? []) {
      const x = at(v, path);
      for (const c of Array.isArray(x) ? x : x && typeof x === "object" ? (part === "picked" ? Object.values(x) : [x]) : []) broken(part, c, seen, out);
    }
    return out;
  }
  const approve = (aid: string, body: any) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const text = body.answers ? answersText(body.answers) : "";
    const asig = sign("sha256", Buffer.from(approvalMessage(aid, body.choice, ts, true, text)), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    return call("POST", `/v1/approvals/${aid}`, body, body.choice === "deny" ? {} : { "x-hm-asig": asig, "x-hm-asig-v": "2" });
  };
  // A landing as the app asks it: the approval key signs the card's key, its print and the time.
  const landOn = (key: string, fp: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const asig = sign("sha256", Buffer.from(landMessage(key, fp, ts)), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    return call("POST", `/v1/landings/${encodeURIComponent(key)}/land`, { fp }, { "x-hm-asig": asig });
  };
  const QUESTIONS = { questions: [{ id: "build", question: "Build type?", options: [{ label: "Debug" }, { label: "Release" }] }, { id: "checks", question: "Which checks?", multiSelect: true, options: [{ label: "Unit" }, { label: "Integration" }] }] };
  const asks = (sid: string, callId: string) => {
    const e = store.append(sid, "assistant", { blocks: [{ type: "tool_use", id: callId, name: "AskUserQuestion", input: QUESTIONS }] });
    let got: any;
    ask({ callId, sessionId: sid, signal: new AbortController().signal } as any).then((a) => (got = a?.answers));
    return { event: e, answer: () => got };
  };

  test("both sides sign the same bytes", () => {
    for (const r of wire.signing.request) {
      expect(sha256Hex(r.body)).toBe(r.body_sha256);
      expect(new TextDecoder().decode(canonicalMessage(r.method, r.path + (r.query === null ? "" : `?${r.query}`), r.ts, r.body))).toBe(r.canonical);
    }
    for (const a of wire.signing.approval) {
      expect(a.answers ? answersText(a.answers) : "").toBe(a.answers_text);
      expect(approvalMessage(a.id, a.choice, a.ts, true, a.answers_text)).toBe(a.message);
    }
    for (const l of wire.signing.land) expect(landMessage(l.key, l.fp, l.ts)).toBe(l.message);
  });

  test("the examples are of their shapes", () => {
    for (const [shape, list] of Object.entries(wire.examples)) for (const ex of list) expect(broken(shape, ex)).toEqual([]);
    expect(Object.keys(wire.examples).sort()).toEqual(Object.keys(fields).sort());
  });

  test("what the daemon sends has every field the app reads, under its name and type", async () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const take = (shape: string, v: any) => void broken(shape, v, seen, bad);
    const parent = session("Parent");
    const s = session("Fix the build");
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    const base = store.append(s.id, "user", { text: "Why does the build fail?" });
    const left = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "left behind" }] }, base.id);
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }], model: "fx:saved" }, base.id);
    store.append(s.id, "turn_end", { reason: "interrupted" });
    store.append(s.id, "user", { text: '<subagent_result agent_id="ag2" title="Child" status="done">\nstatus ok\n</subagent_result>', kind: "subagent", agent_id: "ag2" });
    const failed = session("Failed");
    store.append(failed.id, "error", { message: "HTTP 402: no credit" });
    const q = asks(s.id, "call-w");
    // Permission cards: one that waits and is held (long, its start alone kept, a hidden character,
    // a command for another machine), and one that was answered from the phone.
    card({ id: "apr-held", session_id: s.id, summary: `cd /srv\nrm -rf build\u202e\n${"x".repeat(21_000)}`, input: { command: "x", machine: "build box" } });
    // A chained command asked by its middle part: the card says where that part stands.
    card({ id: "apr-chain", session_id: s.id, summary: "cd /srv && rm -rf build && echo done", part: { text: "rm -rf build", nth: 0 }, risk: "high", why: "deletes files" });
    card({ id: "apr-done", session_id: s.id, summary: "npm test", state: "allowed", choice: "once", resolved: Date.now(), by: { client: "phone", device: "Pixel 8", seen: "whole" } });
    // What the question's wait costs, as its alert keeps it (src/automation/wait-cost.ts): its card says it.
    const wait = { at: Date.now(), agents: 2, rate: 0.05, tokens: 90_000, usd: 0.4, until: Date.now() + 120_000, key: 0.45 };
    store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, rev, kept) VALUES ('al-wait', ?, 'question', ?, 'Question', 'Build type?', 0, ?, 0, 0)").run(wait.at, s.id, JSON.stringify({ call_id: "call-w", open_session: s.id, wait }));
    running.add(parent.id);
    bus.emit({ t: "delta", session_id: parent.id, kind: "text", index: 0, text: "Looking at the" } as any);

    // The parent's agent at work: its row counts it.
    store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ag-contract", parent.id, s.id, "Fix the build", "general-purpose", "fx:saved", 1, "running", Date.now());
    // A session at rest whose agent still works: its dot sits in a ring.
    const resting = session("Resting");
    store.append(resting.id, "user", { text: "Go" });
    store.append(resting.id, "turn_end", { reason: "end_turn" });
    store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ag-ring", resting.id, failed.id, "Looks", "general-purpose", "fx:saved", 1, "running", Date.now());
    // A session at work on a command: its row says what it does now.
    const acting = session("Acting");
    running.add(acting.id);
    store.append(acting.id, "user", { text: "Run the tests" });
    turnStart.set(acting.id, store.append(acting.id, "turn_start", {}).id);
    store.append(acting.id, "assistant", { blocks: [{ type: "tool_use", id: "ta", name: "Bash", input: { command: "bun test", description: "Run the unit tests" } }], model: "fx:saved" });
    turnStatus.set(acting.id, { kind: "tool", names: ["Bash"], since: Date.now() });
    // The owner's helper, its conversation a chat of the list, told of a failure, with a record kept.
    const h = await helperOn();
    h.record("failed", s.id, "Fix the build failed", "HTTP 402: no credit", "feed");
    h.records.put([{ key: "person.dana-levi", value: "Dana Levi, the client", topics: ["clients"] }], "owner");
    // Answers to requests.
    const first = (await call("GET", "/v1/sync?since=0")).body;
    take("sync", first);
    // The row's dot: a session at rest that waits on its agent is the work dot in a ring; one that failed is the failed dot.
    expect(first.chats.find((c: any) => c.id === resting.id)).toMatchObject({ dot: "work", dot_ring: "agents", dot_word: "Waiting on agents" });
    expect(first.chats.find((c: any) => c.id === failed.id)).toMatchObject({ dot: "fail", dot_word: "Failed" });
    expect(first.chats.find((c: any) => c.id === failed.id)).not.toHaveProperty("dot_ring");
    // The row of a session at work says what its turn does now; one that waits on the owner or has failed says its state and none.
    expect(first.chats.find((c: any) => c.id === acting.id)).toMatchObject({ dot: "work", action: "Run the unit tests" });
    expect(first.chats.find((c: any) => c.id === failed.id)).not.toHaveProperty("action");
    // The helper's name and picture: the answer carries the picture's mark, its bytes are a route, and a notification of its
    // conversation carries both so the phone can show its face.
    await h.uploadAvatar(PNG);
    h.setName("Pip");
    const named = (await call("GET", "/v1/helper")).body;
    take("helper", named);
    expect([named.name, typeof named.face]).toEqual(["Pip", "string"]);
    const face: Response = await routes["/v1/helper/face"].GET(signedRaw("GET", "/v1/helper/face", new Uint8Array()), {});
    expect([face.status, face.headers.get("content-type"), (await face.arrayBuffer()).byteLength > 0]).toEqual([200, "image/png", true]);
    const told = alertPush({ id: "al4", ts: Date.now(), kind: "finished", session_id: h.session()!.id, title: "Pip: done", body: "x", read: false, data: {}, channels: [] } as any, undefined, { name: h.name(), face: named.face });
    take("push", pushData(told, mobile.globalSeq(), "push_6"));
    expect(told.data).toMatchObject({ who: "Pip", face: named.face });
    expect(alertPush({ id: "al5", ts: Date.now(), kind: "finished", session_id: s.id, title: "x", body: "x", read: false, data: {}, channels: [] } as any).data).not.toHaveProperty("who");
    take("helper", (await call("GET", "/v1/helper")).body);
    // A command a call waits on, which the owner can move behind it: it is told, moved once, and then no longer in front.
    const waiting = session("Waiting on a command");
    const job = startJob({ sessionId: waiting.id, command: "sleep 30", description: "Run the unit tests", cwd: dir, logDir: join(dir, "jobs"), callId: "toolu_9" });
    job.mover = new AbortController();
    try {
      take("command", (await call("GET", `/v1/chats/${waiting.id}/command`)).body);
      expect((await call("GET", `/v1/chats/${waiting.id}/command`)).body.front).toMatchObject({ job: job.id, call: "toolu_9", command: "Run the unit tests" });
      expect((await call("GET", `/v1/chats/${s.id}/command`)).body.front).toBeNull();
      const moved = await call("POST", `/v1/chats/${waiting.id}/background`, {});
      take("moved", moved.body);
      expect(moved.body.moved).toBe(true);
      expect(job.mover.signal.aborted).toBe(true);
      // Moved already: the command is no longer in front, and a second move says so.
      const again = await call("POST", `/v1/chats/${waiting.id}/background`, {});
      take("moved", again.body);
      expect(again.body.moved).toBe(false);
      expect((await call("GET", `/v1/chats/${waiting.id}/command`)).body.front).toBeNull();
    } finally { await stopJob(job, "test over"); }
    take("memory", (await call("GET", "/v1/helper/memory")).body);
    // A question from the helper row, asked twice under one id, and its answer: the session it read, named.
    const ask = (await call("POST", "/v1/helper/ask", wire.examples.helper_ask[0])).body;
    take("helper_asked", ask);
    take("helper_asked", (await call("POST", "/v1/helper/ask", wire.examples.helper_ask[0])).body);
    store.append(h.session()!.id, "assistant", { blocks: [{ type: "text", text: "Fix the build failed: the provider refused." }, { type: "tool_use", id: "t-ask", name: "helper__session_read", input: { session: s.id } }, { type: "tool_use", id: "t-ask2", name: "helper__sessions", input: {} }] });
    store.append(h.session()!.id, "turn_end", { reason: "done" });
    take("helper_answer", (await call("GET", `/v1/helper/ask/${ask.id}`)).body);
    store.db.query("DELETE FROM agents WHERE id = 'ag-contract'").run();
    take("page", (await call("GET", `/v1/chats/${s.id}/messages?paged=1&limit=3`)).body);
    take("receipt", (await call("POST", `/v1/chats/${parent.id}/messages`, { ...wire.examples.send[0], client_id: "contract-receipt" })).body);
    // A prompt that carries a photo and a file.
    const photo = await upload("photo.png", "image/png", PNG), notes = await upload("notes.txt", "text/plain", new TextEncoder().encode("hello notes\n"));
    take("upload", photo);
    take("receipt", (await call("POST", `/v1/chats/${failed.id}/messages`, { text: "look", attachments: [photo, notes] })).body);

    // The other answers the app reads: usage, the machine, push, pairing, a refusal.
    store.updateSession(s.id, { usage: { input: 300, output: 15, cache_read: 50, cache_write: 4, cost: 0.02 } as any });
    // As the pulse is read one agent still waits and a warm ping kept the cache for half an hour more.
    const hookWas = alerts.waitHook.now;
    alerts.waitHook.now = () => ({ agents: 1, rate: 0.05, tokens: 90_000, usd: 0.4, until: Date.now() + 30 * 60_000 });
    const pulse = (await call("GET", "/v1/pulse")).body;
    alerts.waitHook.now = hookWas;
    take("pulse", pulse);
    // What waits is in the next-look order: the wait that costs most first, whatever was asked before it.
    expect(pulse.approvals.filter((a: any) => a.state === "pending").map((a: any) => a.id)[0]).toBe(`q-${s.id}.call-w`);
    // Its key is the one it began with; its words say what it costs now, and when it was asked.
    expect(pulse.approvals[0].wait.key).toBe(0.45);
    expect(pulse.approvals[0].wait_line).toBe("1 agent waits ($0.050/min); cache of 90K tokens expires in 30 min: about $0.40 to rewrite");
    expect(pulse.approvals[0].asked).toBe(wait.at / 1000);
    take("usage", (await call("GET", `/v1/chats/${s.id}/usage`)).body);
    take("me", (await call("GET", "/v1/me")).body);
    take("created", (await call("POST", "/v1/chats", {})).body);
    // What a new session can start with, the fleet's machines among it.
    fleetRows = [{ id: "local", name: "desk", enabled: true, state: "ready" }, { id: "m_7", name: "build box", enabled: true, state: "offline", workspace_root: "/srv/work", daemon: { state: "offline" } }];
    const listing = providers.models;
    (providers as any).models = async () => [{ id: "fx:default", name: "Default model" }, { id: "fx:other" }];
    take("start", (await call("GET", "/v1/start")).body);
    store.append(s.id, "user", { text: "Search the whole ledger for the drift" });
    store.side.flush();
    take("search", (await call("GET", `/v1/search?q=${encodeURIComponent("ledger drift since:7d")}`)).body);
    take("search", (await call("GET", `/v1/search?q=${encodeURIComponent("Fix build")}`)).body);
    awayDigest = DIGEST;
    take("away", (await call("GET", "/v1/away")).body);
    awayDigest = null;
    // The open errors: one kind in two sessions, one of the daemon's own.
    const quiet = console.error;
    console.error = () => {};
    const both = tracker.capture("provider", new Error("HTTP 402: no credit (contract)"), undefined, { session_id: s.id });
    tracker.capture("provider", new Error("HTTP 402: no credit (contract)"), undefined, { session_id: parent.id });
    tracker.capture("server", new Error("The loop was held (contract)"));
    console.error = quiet;
    take("errors", (await call("GET", "/v1/errors")).body);
    take("error_marked", (await call("POST", `/v1/errors/${both.id}/read`)).body);
    take("errors", (await call("POST", "/v1/errors/read-all", { ids: [both.id] })).body);
    // Branches that wait to land: listed, landed on the print shown, sent back, refused on another print.
    take("landings", (await call("GET", "/v1/landings")).body);
    take("landed", (await landOn(landNow.key, landNow.fp)).body);
    take("sent_back", (await call("POST", `/v1/landings/${encodeURIComponent(landNow.key)}/back`, { fp: landNow.fp, text: "Split it." })).body);
    take("landing_refused", (await landOn(landNow.key, "old-print")).body);
    (providers as any).models = listing;
    fleetRows = [];
    take("error", (await call("POST", `/v1/chats/${s.id}/messages`, { text: "" })).body);
    // What a session changed, and one file's diff; a session with nothing to show says why.
    const edits = await changedSession();
    const changes = (await call("GET", `/v1/chats/${edits.id}/changes`)).body;
    take("changes", changes);
    take("file_diff", (await call("GET", `/v1/chats/${edits.id}/changes/diff?turn=${changes.turns[1].turn}&path=a.txt`)).body);
    if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
    const far = session("Far");
    store.db.query("UPDATE sessions SET machine = 'build box' WHERE id = ?").run(far.id);
    take("changes", (await call("GET", `/v1/chats/${far.id}/changes`)).body);
    // Push for this app: off while the daemon lacks the app's entry (it says which file), on with it.
    writeFileSync(join(process.env.KEEL_CONFIG_DIR!, "fcm-service-account.json"), "{}");
    take("push_config", (await call("GET", "/v1/push-config?app=dev.avifenesh.keel")).body);
    writeFileSync(join(process.env.KEEL_CONFIG_DIR!, "google-services.json"), JSON.stringify({
      project_info: { project_number: "123456789", project_id: "phone-push" },
      client: [{ client_info: { mobilesdk_app_id: "1:123456789:android:bbb", android_client_info: { package_name: "dev.avifenesh.keel" } }, api_key: [{ current_key: "key-k" }] }],
    }));
    take("push_config", (await call("GET", "/v1/push-config?app=dev.avifenesh.keel")).body);
    // A push for an approval, as its data leaves for the phone.
    take("push", pushData(alertPush({ id: "al1", ts: Date.now(), kind: "approval", session_id: s.id, title: "Fix the build needs your approval", body: "rm -rf build", read: false, data: { approval_id: "apr_9", hold: [] }, channels: [] } as any), mobile.globalSeq(), "push_1"));
    take("push", pushData(testMessage(), mobile.globalSeq(), "push_2"));
    take("push", pushData({ kind: "live", high: false, data: liveData(liveStatus([{ title: "Fix the build", running: true, since: 1000, needs: 0 }, { title: "Docs", running: true, since: 2000, needs: 1 }])) }, mobile.globalSeq(), "push_3"));
    take("push", pushData({ kind: "live", high: false, data: liveData(liveStatus([{ title: "Fix the build", running: true, since: 1000, needs: 0 }], 3)) }, mobile.globalSeq(), "push_4"));
    // A failure with no session to open: its notification opens the Errors view.
    const outage = pushData(alertPush({ id: "al2", ts: Date.now(), kind: "outage", session_id: null, title: "Provider outage", body: "HTTP 529", read: false, data: {}, channels: [] } as any), mobile.globalSeq(), "push_5");
    expect(outage.open).toBe("errors");
    take("push", outage);
    expect(alertPush({ id: "al3", ts: Date.now(), kind: "failed", session_id: s.id, title: "Failed", body: "x", read: false, data: {}, channels: [] } as any).data.open).toBeUndefined();
    // A phone pairs, then unpairs.
    const k3 = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pairReq: any = new Request("http://x/v1/pair", { method: "POST", body: JSON.stringify({ code: mobile.createPairCode(600), device_name: "p", pub: k3.publicKey.export({ type: "spki", format: "der" }).toString("base64"), apub, lock: true }) });
    const paired = await ((await routes["/v1/pair"].POST(pairReq, { requestIP: () => ({ address: "10.0.0.7" }) })) as Response).json();
    take("paired", paired);
    const ts3 = String(Math.floor(Date.now() / 1000));
    const gone: any = new Request(`http://x/v1/devices/${paired.device_id}`, { method: "DELETE", headers: { authorization: `Bearer ${paired.token}`, "x-hm-ts": ts3,
      "x-hm-sig": sign("sha256", Buffer.from(`DELETE\n/v1/devices/${paired.device_id}\n${ts3}\n${sha256Hex("")}`), { key: k3.privateKey, dsaEncoding: "der" }).toString("base64") } });
    gone.params = { did: paired.device_id };
    take("revoked", await ((await routes["/v1/devices/:did"].DELETE(gone, {})) as Response).json());

    // The stream: its first frame, then one of each kind.
    jest.useFakeTimers();
    const st = await openStream(mobile.globalSeq());
    try {
      const ev = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Fixed." }], model: "fx:saved" });
      bus.emit({ t: "event", event: ev } as any);
      bus.emit({ t: "session", session: store.session(s.id)! } as any);
      bus.emit({ t: "delta", session_id: parent.id, kind: "text", index: 0, text: " build" } as any);
      take("resolved", (await approve(`q-${s.id}.call-w`, { choice: "once", answers: { build: "Debug", checks: ["Unit", "by hand"] } })).body);
      const res = store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "call-w", content: "answered" }] });
      bus.emit({ t: "event", event: res } as any);
      bus.emit({ t: "session", session: store.updateSession(s.id, { head: left.id }) } as any);
      bus.emit({ t: "session", session: failed, deleted: true } as any);
      // A kind of failure happens again, and one is resolved.
      const again = tracker.capture("server", new Error("The loop was held (contract)"));
      tracker.resolve(again.id, true);
      bus.emit({ t: "error", error: tracker.get(again.id)! } as any);
      jest.advanceTimersByTime(15_000);
    } finally {
      jest.useRealTimers();
    }
    await st.read((f) => f.some((x) => x.type === "seq"));
    await st.close();
    const SHAPE: Record<string, string> = { message: "message_frame", chat: "chat_frame" };
    for (const f of st.frames) take(SHAPE[f.type] ?? f.type, f);
    expect(new Set(st.frames.map((f) => f.type))).toEqual(new Set(["hello", "message", "chat", "working", "delta", "approval", "chat_reset", "chat_removed", "error_changed", "seq"]));
    expect(st.frames.filter((f) => f.type === "error_changed").map((f) => f.gone)).toContain(true);

    // Catch-ups that say more than events: a branch that changed, a cursor that cannot be caught up from.
    take("sync", (await call("GET", `/v1/sync?since=${st.frames[0].cursor}`)).body);
    take("sync", (await call("GET", `/v1/sync?since=${mobile.globalSeq() + 9}`)).body);
    // A catch-up for a phone that said what it holds: the buckets that changed, sent whole.
    take("sync", (await call("GET", `/v1/sync?since=${st.frames[0].cursor}&held=${heldOf([{ id: "s-gone", h: "00000000" }], 1)}`)).body);
    running.delete(parent.id);
    store.db.query("DELETE FROM approvals WHERE id IN ('apr-held', 'apr-chain', 'apr-done')").run();
    store.db.query("DELETE FROM alerts WHERE id = 'al-wait'").run();

    expect(bad).toEqual([]);
    // Every field the app reads was sent at least once here, so a renamed optional field fails too.
    const sent = Object.entries(fields).filter(([shape]) => !["send", "answer", "upload_ref", "new_chat", "helper_ask"].includes(shape)).flatMap(([shape, f]) => Object.keys(f).map((k) => `${shape}.${k}`));
    expect(sent.filter((k) => !seen.has(k))).toEqual([]);
    expect(q.answer()).toEqual({ build: { picked: ["Debug"] }, checks: { picked: ["Unit"], other: "by hand" } });
  });

  test("the daemon takes what the app sends", async () => {
    const s = session();
    sent.length = 0;
    const [send, withPhoto] = wire.examples.send;
    const first = (await call("POST", `/v1/chats/${s.id}/messages`, send)).body;
    expect(first.message).toMatchObject({ content: send!.text, kind: "queued" });
    expect((await call("POST", `/v1/chats/${s.id}/messages`, send)).body).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(sent).toHaveLength(1);
    // A prompt with a photo names the upload by the id its answer gave. The example upload is that answer.
    expect(await upload("photo.png", "image/png", PNG)).toEqual(wire.examples.upload[0]);
    const look = (await call("POST", `/v1/chats/${s.id}/messages`, withPhoto)).body;
    expect(look.message.meta.attachments).toMatchObject([{ kind: "image", mime: "image/png" }]);
    // A card answered by question id, and one dismissed.
    const [answer, dismiss] = wire.examples.answer;
    const a = asks(s.id, "call-x"), b = asks(s.id, "call-y");
    expect((await approve(`q-${s.id}.call-x`, answer)).status).toBe(200);
    expect((await approve(`q-${s.id}.call-y`, dismiss)).status).toBe(200);
    await Bun.sleep(0);
    expect(a.answer()).toEqual({ build: { picked: ["Debug"] }, checks: { picked: ["Unit", "Integration"] } });
    expect(b.answer().build.picked).toEqual([]);
  });
});

describe("push health", () => {
  const rec = (id: string, device: string, token: string, ms: number) => ({ id, device_id: device, kind: "test", sent_ms: ms, ok: true, token_hash: sha256Hex(token) });
  test("receipts order by send, a new token starts untested, an early receipt is kept, an app without receipts is not warned", () => {
    const d = mobile.claimPairCode(mobile.createPairCode(600), "p2", pub, apub, false)!.device_id;
    mobile.setPushToken(d, "tok-1");
    // Four sends in one millisecond; a receipt for the first leaves three.
    for (const id of ["a", "b", "c", "e"]) mobile.recordPush({ ...rec(`p-${id}`, d, "tok-1", Date.now()), ok: false, error: "sending" });
    expect(mobile.ackPush(d, "p-a")).toBe(true); // before the push service answered
    for (const id of ["a", "b", "c", "e"]) mobile.recordPush(rec(`p-${id}`, d, "tok-1", Date.now()));
    let st = mobile.pushStatus(d);
    expect([st.unacknowledged, st.warning, st.receipts]).toEqual([3, true, true]);
    // The same token again keeps the warning; a new one starts untested.
    mobile.setPushToken(d, "tok-1");
    expect(mobile.pushStatus(d).warning).toBe(true);
    mobile.setPushToken(d, "tok-2");
    st = mobile.pushStatus(d);
    expect([st.last, st.unacknowledged, st.warning, st.previous?.id]).toEqual([null, 0, false, "p-e"]);
    // A device that never confirmed anything: unknown, not a warning.
    const d3 = mobile.claimPairCode(mobile.createPairCode(600), "p3", pub, apub, false)!.device_id;
    mobile.setPushToken(d3, "tok-3");
    for (const id of ["x", "y", "z"]) mobile.recordPush(rec(`p-${id}`, d3, "tok-3", Date.now()));
    st = mobile.pushStatus(d3);
    expect([st.unacknowledged, st.receipts, st.warning]).toEqual([3, false, false]);
  });
});

function signedRaw(method: string, path: string, bytes: Uint8Array<ArrayBuffer>) {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${h}`), { key: privateKey, dsaEncoding: "der" }).toString("base64");
  return new Request(`http://x${path}`, { method, body: bytes, headers: { authorization: `Bearer ${dev.token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
}

describe("pairing", () => {
  // The app signs every network attempt of its pairing POST with the request
  // key and names the server in the body (Api.pair, PairSigner).
  const k2 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub2 = k2.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  async function pair(code: string, signed = true) {
    const raw = JSON.stringify({ code, device_name: "p", pub: pub2, apub, lock: true, server: "http://x" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("sha256", Buffer.from(`POST\n/v1/pair\n${ts}\n${sha256Hex(raw)}`), { key: k2.privateKey, dsaEncoding: "der" }).toString("base64");
    const req: any = new Request("http://x/v1/pair", { method: "POST", body: raw, headers: signed ? { "x-hm-ts": ts, "x-hm-sig": sig } : {} });
    const res: Response = await routes["/v1/pair"].POST(req, { requestIP: () => ({ address: "10.0.0.9" }) });
    return { status: res.status, body: await res.json() };
  }
  const me = (token: string) => routes["/v1/devices"].GET(Object.assign(signedAs(token, "GET", "/v1/devices"), { params: {} }), {});
  function signedAs(token: string, method: string, path: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign("sha256", Buffer.from(`${method}\n${path}\n${ts}\n${sha256Hex("")}`), { key: k2.privateKey, dsaEncoding: "der" }).toString("base64");
    return new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-hm-ts": ts, "x-hm-sig": sig } });
  }

  test("a phone that lost the answer pairs again with the same code and keeps one device; a used token ends retries", async () => {
    const code = mobile.createPairCode(600);
    const first = await pair(code);
    expect(first.status).toBe(200);
    const before = mobile.devices().length;
    // The answer never arrived: the same code again, signed afresh.
    const again = await pair(code);
    expect(again.status).toBe(200);
    expect(again.body.device_id).toBe(first.body.device_id);
    expect(mobile.devices().length).toBe(before);
    expect((await me(first.body.token)).status).toBe(401);
    // Unsigned, a used code stays used.
    expect((await pair(code, false)).status).toBe(403);
    // Once the token has been used, no retry replaces it.
    expect((await me(again.body.token)).status).toBe(200);
    expect((await pair(code)).status).toBe(403);
    expect((await me(again.body.token)).status).toBe(200);
  });

  test("a phone that unpairs is told the daemon revoked it, and is refused from then on", async () => {
    const paired = await pair(mobile.createPairCode(600));
    const id = paired.body.device_id;
    const gone: Response = await routes["/v1/devices/:did"].DELETE(Object.assign(signedAs(paired.body.token, "DELETE", `/v1/devices/${id}`), { params: { did: id } }), {});
    // `ok` is what the app takes as the daemon's confirmation.
    expect([gone.status, await gone.json()]).toEqual([200, { ok: true }]);
    // Asked again (the answer was lost): unauthorized, which the app also takes as revoked.
    const again: Response = await routes["/v1/devices/:did"].DELETE(Object.assign(signedAs(paired.body.token, "DELETE", `/v1/devices/${id}`), { params: { did: id } }), {});
    expect(again.status).toBe(401);
    expect((await me(paired.body.token)).status).toBe(401);
  });
});

// The read-first rule, from the phone: the card carries the whole text, an
// allow says it was shown, and a notification allows only what one line shows.
describe("permission cards", () => {
  const LONG = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1}`).join("\n");
  // The review's command: 160 plain characters, low risk, its tail padded far out of a notification's sight.
  const PADDED = `echo ok${" ".repeat(160 - "echo ok".length - "; echo tail > t.txt".length)}; echo tail > t.txt`;
  const answer = (aid: string, body: any) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const asig = sign("sha256", Buffer.from(approvalMessage(aid, body.choice, ts, true, "")), { key: akey.privateKey, dsaEncoding: "der" }).toString("base64");
    return call("POST", `/v1/approvals/${aid}`, body, body.choice === "deny" ? {} : { "x-hm-asig": asig, "x-hm-asig-v": "2" });
  };
  // The push of a card's alert, as the daemon sends it now (the card's form read from the gate).
  const pushOf = (a: Approval) => pushData(alertPush({ id: "al", ts: 1, kind: "approval", session_id: a.session_id, title: "t", body: "b", read: false, data: { approval_id: a.id, risk: a.risk }, channels: [] } as any, gate.form(a)), 1, "push_x");

  test("a long command is allowed only once the app says it showed all of it; a deny and a short one need nothing", async () => {
    const s = session("Cards");
    const echo = [{ kind: "shell" as const, pattern: "echo *" }];
    const long = card({ id: "apr-long", session_id: s.id, summary: LONG, suggest: echo });
    const short = card({ id: "apr-short", session_id: s.id, summary: "npm test", suggest: [{ kind: "shell", pattern: "npm test" }] });
    const other = card({ id: "apr-other", session_id: s.id, summary: `${LONG}\necho more` });
    const marked = card({ id: "apr-marked", session_id: s.id, summary: "echo txt.r \u202e< x.txt" });
    const risky = card({ id: "apr-risky", session_id: s.id, summary: "sudo reboot", risk: "high", why: "the command runs as root" });
    const padded = card({ id: "apr-padded", session_id: s.id, summary: PADDED, suggest: echo });
    const wide = card({ id: "apr-wide", session_id: s.id, summary: "git commit -am fix && git push origin main" });
    const far = card({ id: "apr-far", session_id: s.id, tool: "keel__run_on", summary: "rm -rf build", input: { machine: "build-box", command: "rm -rf build", cwd: "/srv/app" } });
    const standing = card({ id: "apr-standing", session_id: s.id, summary: "echo hi > hi.txt", suggest: echo });
    gate = new Gate(store, bus);
    gate.machineOf = () => ({ name: "desk" });

    // What the phone is given: the whole text, the count, and why it is held.
    const cards = Object.fromEntries((await call("GET", `/v1/chats/${s.id}/run`)).body.approvals.map((a: any) => [a.id, a]));
    expect(cards["apr-long"]).toMatchObject({ command: LONG, text: LONG, lines: 41, cut: false, total: null, hold: ["long"], notes: [], rtl: false, machine: "", glance: false });
    expect(cards["apr-short"]).toMatchObject({ text: "npm test", lines: 1, hold: [], line: "Bash: npm test", glance: true, grants: ["npm test"] });
    expect(cards["apr-marked"]).toMatchObject({ command: "echo txt.r <U+202E>< x.txt", text: "echo txt.r <U+202E>< x.txt", hold: ["marked"] });
    expect(cards["apr-marked"].notes[0]).toContain("characters that do not show as written");
    expect(cards["apr-risky"]).toMatchObject({ hold: ["risk"], notes: ["High risk: the command runs as root."], grants: [] });
    // A command for another machine says where, on the card and in the notification's line, and is read first.
    expect(cards["apr-far"]).toMatchObject({ hold: ["where"], notes: ["Runs on build-box, in /srv/app."], machine: "build-box", line: "keel__run_on on build-box in /srv/app: rm -rf build", glance: false });
    // A standing answer's action names the rule it stores, and is offered only where there is one.
    expect(cards["apr-standing"].actions).toEqual([["Approve", "once", "primary"], ["Allow echo * for this session", "session", ""], ["Deny", "deny", "danger"]]);
    expect(cards["apr-risky"].actions.map((x: string[]) => x[1])).toEqual(["once", "deny"]);
    expect(cards["apr-wide"].actions.map((x: string[]) => x[1])).toEqual(["once", "deny"]);

    // A notification's actions for each shape, as the daemon sends them: Allow once only where the
    // collapsed line shows all of it, never a standing answer, and the line it shows.
    expect(pushOf(short)).toMatchObject({ opts: '["once","deny"]', hold: "", body: "Bash: npm test" });
    expect(pushOf(long)).toMatchObject({ opts: '["deny"]', hold: "long" });
    expect(pushOf(marked)).toMatchObject({ opts: '["deny"]', hold: "marked", body: "Bash: echo txt.r <U+202E>< x.txt" });
    expect(pushOf(risky)).toMatchObject({ opts: '["deny"]', hold: "risk" });
    // Not held, but more than a collapsed notification shows: 160 characters with a tail, and 42 plain ones.
    expect(pushOf(padded)).toMatchObject({ opts: '["deny"]', hold: "" });
    expect(pushOf(wide)).toMatchObject({ opts: '["deny"]', hold: "" });
    expect(pushOf(far)).toMatchObject({ opts: '["deny"]', hold: "where", body: "keel__run_on on build-box in /srv/app: rm -rf build" });
    // An alert raised before cards recorded this: no Allow.
    for (const data of [{ approval_id: "x", risk: "high" }, { approval_id: "x", risk: "low" }, { approval_id: "x", risk: "low", hold: [] }])
      expect(alertPush({ id: "old", ts: 1, kind: "approval", session_id: s.id, title: "t", body: "b", read: false, data, channels: [] } as any).data.opts).toBe('["deny"]');
    expect(alertPush({ id: "new", ts: 1, kind: "approval", session_id: s.id, title: "t", body: "Bash: npm test", read: false, data: { approval_id: "x", risk: "low", hold: [], glance: true }, channels: [] } as any).data.opts).toBe('["once","deny"]');

    // An app from before the rule sends no `seen`: the long card is held, with the sentence it shows, and stays open.
    const held = await answer("apr-long", { choice: "once" });
    expect([held.status, held.body.error, held.body.hold]).toEqual([409, "Open the request to read it first: it is 41 lines long.", ["long"]]);
    expect(held.body.approval).toMatchObject({ state: "pending", text: LONG });
    expect((await answer("apr-long", { choice: "session" })).status).toBe(409);
    // A notification shows one line: its allow never counts as having shown the text, whatever it says.
    expect((await answer("apr-long", { choice: "once", seen: "whole", via: "notification" })).status).toBe(409);
    expect((await answer("apr-marked", { choice: "once" })).status).toBe(409);
    expect((await answer("apr-risky", { choice: "once" })).status).toBe(409);
    expect((await answer("apr-far", { choice: "once" })).status).toBe(409);
    expect(gate.approval("apr-long")).toMatchObject({ state: "pending" });

    // The padded command and the wide one are not held, and the app's card may allow them. A
    // notification may not: its collapsed line does not show them whole.
    const tail = await answer("apr-padded", { choice: "once", via: "notification" });
    expect([tail.status, tail.body.error]).toEqual([409, "Open the request to read it first: a notification shows only its start."]);
    expect((await answer("apr-wide", { choice: "once", via: "notification", seen: "whole" })).status).toBe(409);
    expect((await answer("apr-far", { choice: "once", via: "notification" })).body.error).toBe("Open the request to read it first: it runs on build-box.");
    expect([gate.approval("apr-padded")!.state, gate.approval("apr-wide")!.state, gate.approval("apr-far")!.state]).toEqual(["pending", "pending", "pending"]);
    expect((await answer("apr-padded", { choice: "once" })).status).toBe(200);
    // A notification never gives a standing answer, on any card.
    const stand = await answer("apr-standing", { choice: "session", via: "notification" });
    expect([stand.status, stand.body.error]).toEqual([409, "A notification allows once or denies. Open the request to give a standing answer."]);
    expect(gate.approval("apr-standing")!.state).toBe("pending");
    expect((await answer("apr-standing", { choice: "session" })).status).toBe(200);
    expect(gate.approval("apr-standing")).toMatchObject({ state: "allowed", choice: "session", by: { client: "phone", device: "phone" } });

    // With the app's word the long one is taken, and the card says where it was answered.
    const ok = await answer("apr-long", { choice: "once", seen: "whole" });
    expect([ok.status, ok.body.approval.state, ok.body.approval.from]).toEqual([200, "approved", "the phone (phone), its text shown whole"]);
    expect(gate.approval("apr-long")!.by).toEqual({ client: "phone", device: "phone", seen: "whole" });
    // An answer that comes second is told who answered first and how long ago, with the card as it ended.
    const late = await answer("apr-long", { choice: "once", seen: "whole" });
    expect([late.status, late.body.approval.state, late.body.approval.from]).toEqual([409, "approved", "the phone (phone), its text shown whole"]);
    expect(late.body.error).toMatch(/^this approval is already allowed \(once\) from the phone \(phone\), \d s ago$/);
    // A short one is allowed as before, from the card or from a notification.
    expect((await answer("apr-short", { choice: "once", via: "notification" })).status).toBe(200);
    expect(gate.approval("apr-short")!.by).toEqual({ client: "notification", device: "phone" });
    // A deny is taken at once, from anywhere.
    expect((await answer("apr-other", { choice: "deny", via: "notification" })).status).toBe(200);
    expect(gate.approval("apr-other")).toMatchObject({ state: "denied", by: { client: "notification", device: "phone" } });
    // (No reason of the phone's making: the call's result is then the words a denial on the page gives.)
    expect(gate.approval("apr-other")!.reason).toBeUndefined();
    for (const id of ["apr-risky", "apr-marked", "apr-wide", "apr-far"]) expect((await answer(id, { choice: "deny" })).status).toBe(200);
  });
});

// A session another harness runs is only shown in Keel (src/core/outside.ts): the paired phone gets nothing of it.
test("the phone gets nothing of an outside session: no row, no message, no frame", async () => {
  const cursor = mobile.globalSeq();
  const out = session("Elsewhere CANARY-PHONE");
  store.updateSession(out.id, { outside: { harness: "claude", source_id: "src-phone", state: "working", since: Date.now(), files: 0, failures: 0 } });
  const said = store.append(out.id, "user", { text: "CANARY-PHONE words typed in the other harness" });
  const mine = session("Mine on the phone");
  const st = await openStream(mobile.globalSeq());
  bus.emit({ t: "session", session: store.session(out.id)! } as any);
  bus.emit({ t: "event", event: said } as any);
  const reply = store.append(mine.id, "assistant", { blocks: [{ type: "text", text: "mine" }] });
  bus.emit({ t: "event", event: reply } as any);
  await st.read((f) => f.some((x) => x.type === "message" && x.message?.chat_id === mine.id));
  await st.close();
  const answers = [st.frames, (await call("GET", "/v1/chats")).body, (await call("GET", "/v1/sync?since=0")).body, (await call("GET", `/v1/sync?since=${cursor}`)).body, (await call("GET", "/v1/sessions")).body];
  for (const a of answers) {
    expect(JSON.stringify(a)).not.toContain("CANARY-PHONE");
    expect(JSON.stringify(a)).not.toContain(out.id);
  }
  expect(JSON.stringify(answers[3])).toContain(mine.id);
  expect((await call("GET", `/v1/chats/${out.id}/messages`)).status).toBe(404);
});
