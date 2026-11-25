// A Codex session answered in place, against the stand-in of `codex app-server` (test/e2e/fixtures/codex-app-server.ts)
// over a scratch Codex home the mirror watches: a send resumes the thread with its own provider, folder, approval
// policy and sandbox, the reply streams as deltas, the command Codex asks about is a one-call card, the answer goes
// back, the rollout holds the message and the reply, and the child is gone after the turn. A question is a question
// card. A session another process holds takes nothing. After a restart a send is looked for in the rollout.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { Bus } from "../../core/bus.ts";
import type { Frame, Holder } from "../../core/types.ts";
import { ownEnv } from "../../../test/env.ts";
import { answer, allPendingQuestions } from "../../tools/interact.ts";
import { Outside } from "./service.ts";
import { OUTSIDE_DEFAULTS } from "./settings.ts";
import { Gate } from "../../safety/gate.ts";
import { CodexApp, holdsMessage, threadFacts, type CardGate } from "./codex-app.ts";

const top = mkdtempSync(join(tmpdir(), "keel-codex-app-"));
ownEnv({ KEEL_IMPORT_CODEX_DIR: undefined, KEEL_IMPORT_CLAUDE_DIR: undefined });
afterAll(() => rmSync(top, { recursive: true, force: true }));
const STANDIN = join(import.meta.dir, "../../../test/e2e/fixtures/codex-app-server.ts");

const until = async <T>(f: () => T | undefined | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

let k = 0;
function rig(opts: { holder?: () => Holder | undefined; realGate?: boolean } = {}) {
  const dir = join(top, String(k++));
  const codex = join(dir, "codex");
  const cwd = join(dir, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "claude"), { recursive: true });
  process.env.KEEL_IMPORT_CODEX_DIR = codex;
  process.env.KEEL_IMPORT_CLAUDE_DIR = join(dir, "claude");
  const now = new Date();
  const day = join(codex, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(day, { recursive: true });
  const store = new Store(join(dir, "state"));
  const bus = new Bus();
  const frames: Frame[] = [];
  bus.on((f) => void frames.push(f));
  const settings = { ...OUTSIDE_DEFAULTS };
  let app: CodexApp | undefined;
  const o = new Outside({ store, bus, workspace: dir, settings: () => settings, viewed: () => true, ours: (id) => !!app?.ours(id) });
  o.start();
  const cards: { name: string; input: any; why: string; shown?: string }[] = [];
  let decide: (name: string) => { deny: string } | void = () => undefined;
  const stub = { askOnce: async (_s, call, name, why, _held, shown) => { cards.push({ name, input: call.input, why, shown }); return decide(name); }, approvals: () => [], settled: () => {} } as CardGate;
  let real = opts.realGate ? new Gate(store, bus) : undefined;
  let gate: CardGate = real ?? stub;
  const outside = { row: (id: string) => o.row(id), holderNow: (id: string) => opts.holder?.() ?? o.holderNow(id), retell: (id: string) => o.retell(id) };
  const make = () => (app = new CodexApp({ store, bus, outside, gate: () => gate, bin: () => STANDIN, home: () => codex, trouble: (e) => { throw e; } }));
  make();
  const thread = `019a0000-0000-7000-8000-${String(k).padStart(12, "0")}`;
  const rollout = join(day, `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${thread}.jsonl`);
  const rec = (type: string, payload: object) => appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n");
  const done = () => { app?.stop(); o.stop(); store.db.close(); };
  // Written once the day's folder is watched: the mirror follows a rollout that grows while it watches.
  const session = async () => {
    await until(() => (o as any).watchers.has(day));
    rec("session_meta", { id: thread, timestamp: now.toISOString(), cwd, originator: "codex_cli_rs", cli_version: "0.172.0", source: "cli", model_provider: "acme", thread_source: "user" });
    rec("turn_context", { turn_id: "t0", cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-x", summary: "auto" });
    rec("event_msg", { type: "task_started", turn_id: "t0" });
    rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Start the work" }] });
    rec("event_msg", { type: "user_message", message: "Start the work" });
    rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Started." }] });
    rec("event_msg", { type: "task_complete", turn_id: "t0" });
    return until(() => store.sessions({ outside: true }).find((s) => s.outside?.source_id === thread));
  };
  // The gate of the next daemon (its constructor parks every card still open).
  const nextGate = () => (gate = real = new Gate(store, bus));
  return { dir, codex, cwd, store, bus, frames, o, gate: () => real, nextGate, app: () => app!, make, cards, setDecide: (f: typeof decide) => { decide = f; }, thread, rollout, rec, session, done };
}

describe("a Codex session answered in place", () => {
  test("the thread's facts from its rollout; a message found in what Codex wrote", () => {
    const f = threadFacts([{ type: "session_meta", payload: { model_provider: "acme", cwd: "/a" } }], [{ type: "turn_context", payload: { cwd: "/b", approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } }, { type: "turn_context", payload: { cwd: "/c", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }]);
    expect(f).toEqual({ provider: "acme", cwd: "/c", approval: "never", sandbox: "danger-full-access" });
    // A policy this build does not know is left to Codex's own (never guessed looser).
    expect(threadFacts([], [{ type: "turn_context", payload: { approval_policy: { granular: {} }, sandbox_policy: { type: "external-sandbox" } } }])).toEqual({ provider: undefined, cwd: undefined });
    expect(holdsMessage([{ type: "event_msg", payload: { type: "user_message", message: " go on " } }], "go on")).toBe(true);
    expect(holdsMessage([{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] } }], "go on")).toBe(true);
    expect(holdsMessage([{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "go on" }] } }], "go on")).toBe(false);
  });

  test("a send resumes the thread, streams the reply, asks the command as a card, and the child ends after the turn", async () => {
    const r = rig();
    try {
      const s = await r.session();
      expect(s.outside?.holder).toEqual({ kind: "free" });
      expect(r.app().route(s.id)).toBe("resume");
      const sent = r.app().send(s.id, "fix the build", "k1");
      expect("send" in sent && sent.send.state).toBe("stored");
      // The same key again is the same send: given once.
      const again = r.app().send(s.id, "fix the build", "k1");
      expect("send" in again && "send" in sent && again.send.id === sent.send.id).toBe(true);
      // Keel's child holds it while it works.
      await until(() => r.store.session(s.id)?.outside?.holder?.kind === "keel");
      await until(() => !r.app().ours(s.id), 15_000);
      const text = readFileSync(r.rollout, "utf8");
      expect(text).toContain('"message":"fix the build"');
      expect(text).toContain("The command was allowed: fix the build");
      // One card, for its one command, in the harness's words.
      expect(r.cards).toEqual([{ name: "Codex command", input: { command: "make test", cwd: expect.any(String) }, why: "asked by Codex: It runs the project's tests", shown: undefined }]);
      // The reply streamed as deltas; nothing was stored as an event of the session by the driver: the mirror stores the rollout's.
      const deltas = r.frames.filter((f): f is Extract<Frame, { t: "delta" }> => f.t === "delta" && f.session_id === s.id).map((f) => f.text).join("");
      expect(deltas).toContain("The command was allowed: fix the build");
      // Resumed with the thread's own provider, folder, approval policy and sandbox.
      const log = readFileSync(`${r.rollout}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(log.find((m) => m.method === "thread/resume")?.params).toEqual({ threadId: r.thread, excludeTurns: true, modelProvider: "acme", cwd: r.cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
      expect(log.some((m) => m.method === "thread/unsubscribe")).toBe(true);
      // Delivered: the rollout holds it, and the composer has nothing left to say of it.
      expect(r.app().sends(s.id)).toEqual([]);
      expect(r.store.db.query<{ state: string }, []>("SELECT state FROM outside_sends").all()).toEqual([{ state: "delivered" }]);
      await until(() => r.store.session(s.id)?.outside?.holder?.kind === "free");
      // A denial goes back as Codex's decline.
      r.setDecide(() => ({ deny: "no" }));
      r.app().send(s.id, "try again", "k2");
      await until(() => readFileSync(r.rollout, "utf8").includes("The command was declined: try again"), 15_000);
      await until(() => !r.app().ours(s.id));
    } finally { r.done(); }
  }, 30_000);

  test("a file change is the gate's one-call card: the owner's alone, showing the diff Codex will write", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      r.app().send(s.id, "edit the constant", "k1");
      const a = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0], 15_000);
      expect(a).toMatchObject({ tool: "Codex file change", kind: "edit", once: true, risk: "high", facts: { held: "harness" } });
      expect(a.summary).toContain("+const a = 2;");
      expect(a.summary).toContain(join(r.cwd, "a.ts"));
      expect(r.gate()!.resolve(a.id, s.id, { choice: "deny" })).toEqual({ ok: true });
      await until(() => readFileSync(r.rollout, "utf8").includes("The change was declined: edit the constant"), 15_000);
      await until(() => !r.app().ours(s.id));
    } finally { r.done(); }
  }, 30_000);

  test("Codex's question is a question card; its answer goes back by question id", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "ask me about the button", "k1");
      const q = await until(() => allPendingQuestions().find((x) => x.session_id === s.id));
      expect(q.asked?.from).toBe("Codex");
      expect(q.asked?.questions).toEqual([{ id: "color", header: "Color", question: "Which color should the button be?", options: [{ label: "Blue", description: "The brand color" }, { label: "Green", description: undefined }], secret: undefined }]);
      expect(answer(s.id, q.call_id, { color: { picked: ["Green"] } }, false, q.asked!.id)).toBe(true);
      await until(() => readFileSync(r.rollout, "utf8").includes("You picked Green."), 15_000);
      await until(() => !r.app().ours(s.id));
    } finally { r.done(); }
  }, 30_000);

  test("Stop interrupts the turn Keel runs; a send while it runs steers it", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id));
      expect(r.app().route(s.id)).toBe("steer");
      r.app().send(s.id, "and also this", "k2");
      await until(() => readFileSync(r.rollout, "utf8").includes('"message":"and also this"'));
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(readFileSync(r.rollout, "utf8")).toContain('"type":"turn_aborted"');
      expect(r.store.db.query<{ key: string; state: string }, []>("SELECT key, state FROM outside_sends ORDER BY key").all()).toEqual([{ key: "k1", state: "delivered" }, { key: "k2", state: "delivered" }]);
    } finally { r.done(); }
  }, 30_000);

  test("a Codex that stops answering: Stop gives up on it in seconds, and a second Stop ends it at once", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "stuck now", "k1");
      await until(() => r.frames.some((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")));
      let t = Date.now();
      // The first Stop asks Codex to interrupt; nothing answers, so it ends the child after a few seconds.
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 20_000);
      expect(Date.now() - t).toBeLessThan(15_000);
      // Again, with a second Stop while the first waits: the child ends at once.
      r.app().send(s.id, "stuck again", "k2");
      await until(() => r.frames.filter((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")).length >= 2, 15_000);
      void r.app().interrupt(s.id);
      t = Date.now();
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 20_000);
      expect(Date.now() - t).toBeLessThan(4_000);
    } finally { r.done(); }
  }, 60_000);

  test("a session another process holds takes nothing, and says who holds it", async () => {
    const r = rig({ holder: () => ({ kind: "terminal", pid: 4242 }) });
    try {
      const s = await r.session();
      expect(r.app().route(s.id, { kind: "terminal", pid: 4242 })).toBe("held");
      const got = r.app().send(s.id, "hello", "k1");
      expect(got).toEqual({ error: "Open in a terminal (pid 4242): answer it there. Keel sends nothing to a session another process holds.", status: 409, holder: { kind: "terminal", pid: 4242 } });
      expect(r.store.db.query("SELECT * FROM outside_sends").all()).toEqual([]);
    } finally { r.done(); }
  });

  test("after a restart a send that started is looked for in the rollout, never sent again; a turn it cut and its cards say so", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      const size = readFileSync(r.rollout).length;
      const put = r.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, ?, 'started', ?, NULL, ?)");
      put.run("a", s.id, "ka", "it went", size, Date.now());
      put.run("b", s.id, "kb", "it did not", size, Date.now());
      put.run("c", s.id, "kc", "it was cut", size, Date.now());
      r.rec("event_msg", { type: "user_message", message: "it went" });
      r.rec("event_msg", { type: "task_complete", turn_id: "t1" });
      r.rec("event_msg", { type: "user_message", message: "it was cut" });
      // The daemon ended while Codex waited on a card: the card is still open in the store.
      const call = { id: "codex-x-c1-c1", tool: { name: "Codex command", kind: "shell", description: "", readOnly: false, input_schema: { properties: { command: {} } }, run: async () => ({ content: "" }) }, input: { command: "make" }, ctx: { sessionId: s.id, cwd: r.cwd, signal: new AbortController().signal, spillDir: "", seen: new Map() } } as any;
      void r.gate()!.askOnce(r.store.session(s.id)!, call, "Codex command", "Codex asks", "harness");
      const card = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0]);
      r.app().stop();
      r.nextGate();
      r.make().start();
      expect(r.gate()!.approval(card.id)).toMatchObject({ state: "cancelled", reason: "Keel restarted while Codex worked: the turn stopped there" });
      expect(r.store.db.query<{ id: string; state: string }, []>("SELECT id, state FROM outside_sends ORDER BY id").all()).toEqual([{ id: "a", state: "delivered" }, { id: "b", state: "lost" }, { id: "c", state: "cut" }]);
      expect(r.app().sends(s.id).map((x) => x.said)).toEqual(["Keel restarted while it went, and the session does not hold it: send it again", "Keel restarted while Codex worked: the turn stopped there"]);
      expect(r.app().dismiss(s.id, "c")).toBe(true);
      expect(readFileSync(r.rollout, "utf8").match(/it did not/g)).toBeNull();
      // Sent again by the owner, it replaces the lost one.
      const again = r.app().send(s.id, "it did not", "kd", "b");
      expect("send" in again ? again.send.state : again).toBe("stored");
      const asked = await until(() => {
        const gone = r.app().sends(s.id).find((x) => x.key === "kd" && (x.state === "lost" || x.state === "failed"));
        if (gone) throw new Error(`the send did not go: ${gone.said}`);
        return r.gate()!.approvals({ session: s.id, pending: true })[0];
      }, 15_000);
      r.gate()!.resolve(asked.id, s.id, { choice: "once", seen: "whole" });
      await until(() => readFileSync(r.rollout, "utf8").includes("The command was allowed: it did not"), 15_000);
      await until(() => !r.app().ours(s.id));
      expect(r.store.db.query<{ id: string }, []>("SELECT id FROM outside_sends WHERE id = 'b'").all()).toEqual([]);
    } finally { r.done(); }
  }, 30_000);
});
