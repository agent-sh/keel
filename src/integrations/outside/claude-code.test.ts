// A Claude Code session answered in place, against the stand-in of `claude -p` (test/e2e/fixtures/claude-code.ts)
// over a scratch Claude Code folder the mirror watches: a send resumes the session by its id with its own model and
// mode, the text on standard input, an environment with only the route its model names; the reply streams as
// deltas, the call Claude Code asks about is a one-call card, AskUserQuestion a question card, ExitPlanMode a plan
// card; the transcript holds the message and the reply and the child is gone after the turn. A session another
// process holds takes nothing. After a restart a send is looked for in the transcript.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { Bus } from "../../core/bus.ts";
import type { Frame } from "../../core/types.ts";
import { ownEnv } from "../../../test/env.ts";
import { answer, allPendingQuestions } from "../../tools/interact.ts";
import { Outside } from "./service.ts";
import { OUTSIDE_DEFAULTS } from "./settings.ts";
import { Gate } from "../../safety/gate.ts";
import { statFields } from "./writer.ts";
import type { CardGate } from "./codex-app.ts";
import { ClaudeCode } from "./claude-code.ts";
import type { Answer, PlanCard } from "../../server/routes/plan.ts";
import { answersOf, argsOf, cardOf, childEnv, holdsMessage, modeFor, planMode, questionsOf, readOut, routeOf, sessionFacts, turnEnded, userLine } from "./claude-wire.ts";

const top = mkdtempSync(join(tmpdir(), "keel-claude-code-"));
ownEnv({ KEEL_IMPORT_CODEX_DIR: undefined, KEEL_IMPORT_CLAUDE_DIR: undefined });
afterAll(() => rmSync(top, { recursive: true, force: true }));
const STANDIN = join(import.meta.dir, "../../../test/e2e/fixtures/claude-code.ts");

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
function rig(opts: { realGate?: boolean; model?: string; mode?: string } = {}) {
  const dir = join(top, String(k++));
  const config = join(dir, "claude");
  const projects = join(config, "projects");
  const cwd = join(dir, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "codex", "sessions"), { recursive: true });
  process.env.KEEL_IMPORT_CODEX_DIR = join(dir, "codex");
  process.env.KEEL_IMPORT_CLAUDE_DIR = projects;
  const project = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const store = new Store(join(dir, "state"));
  const bus = new Bus();
  const frames: Frame[] = [];
  bus.on((f) => void frames.push(f));
  let app: ClaudeCode | undefined;
  const o = new Outside({ store, bus, workspace: dir, settings: () => ({ ...OUTSIDE_DEFAULTS }), viewed: () => true, ours: (id) => !!app?.ours(id) });
  o.start();
  const cards: { name: string; input: any; why: string; shown?: string; notice?: string }[] = [];
  let decide: (name: string) => { deny: string } | void = () => undefined;
  const stub = { askOnce: async (_s, call, name, why, _held, shown, notice) => { cards.push({ name, input: call.input, why, shown, ...(notice ? { notice } : {}) }); return decide(name); }, approvals: () => [], settled: () => {}, harnessAnswers: () => [] } as CardGate;
  let real = opts.realGate ? new Gate(store, bus) : undefined;
  let gate: CardGate = real ?? stub;
  const plans: PlanCard[] = [];
  let planned: (c: PlanCard) => Answer = () => ({ approved: true, mode: "auto-edits", plan: "1. Rename the loader\n2. Run the tests" });
  const outside = { row: (id: string) => o.row(id), holderNow: (id: string) => o.holderNow(id), retell: (id: string) => o.retell(id) };
  // The daemon's environment as the child's is made from: a first-party session must not get these keys.
  // (KEEL_STANDIN_RECORD: the stand-in keeps a record of itself as a running Claude Code, which must not make it a holder.)
  const env = () => ({ ...process.env, KEEL_STANDIN_RECORD: "1", ANTHROPIC_API_KEY: "sk-test", AWS_BEARER_TOKEN_BEDROCK: "b-test", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_DEFAULT_MODEL: "global.anthropic.claude-x" });
  const make = () => (app = new ClaudeCode({ store, bus, outside, gate: () => gate, bin: () => STANDIN, configDir: () => config, env, trouble: (e) => { throw e; }, plan: async (c) => { plans.push(c); return planned(c); } }));
  make();
  const id = `0c1a0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
  const path = join(project, `${id}.jsonl`);
  let parent: string | null = null;
  const write = (r: object) => {
    const uuid = crypto.randomUUID();
    appendFileSync(path, JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.332", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, ...r }) + "\n");
    parent = uuid;
  };
  const done = () => { app?.stop(); o.stop(); store.db.close(); };
  // Written once the project's folder is watched: the mirror follows a transcript that grows while it watches.
  const session = async () => {
    await until(() => (o as any).watchers.has(project));
    write({ type: "user", message: { role: "user", content: "Start the work" }, permissionMode: opts.mode ?? "acceptEdits" });
    write({ type: "assistant", message: { id: "m0", role: "assistant", model: opts.model ?? "claude-opus-5-5", content: [{ type: "text", text: "Started." }], stop_reason: "end_turn" } });
    return until(() => store.sessions({ outside: true }).find((s) => s.outside?.source_id === id), 15_000);
  };
  const nextGate = () => (gate = real = new Gate(store, bus));
  const log = () => readFileSync(`${path}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { dir, config, cwd, store, bus, frames, o, gate: () => real, nextGate, app: () => app!, make, cards, setDecide: (f: typeof decide) => { decide = f; }, plans, setPlanned: (f: typeof planned) => { planned = f; }, id, path, write, session, done, log };
}

describe("the wire, pure", () => {
  test("the route a model id names, and the environment that keeps only that route's variables", () => {
    expect(routeOf("claude-opus-5-5")).toBe("first-party");
    expect(routeOf("global.anthropic.claude-opus-5-5")).toBe("bedrock");
    expect(routeOf("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("bedrock");
    expect(routeOf("arn:aws:bedrock:us-east-1:1:application-inference-profile/x")).toBe("bedrock");
    expect(routeOf("claude-opus-4@20250514")).toBe("vertex");
    expect(routeOf("acme/claude-large")).toBe("gateway");
    expect(routeOf(undefined)).toBeUndefined();
    const daemon = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://gw", AWS_BEARER_TOKEN_BEDROCK: "b", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "x", CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_DEFAULT_MODEL: "global.anthropic.claude-x", ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-5-5", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDECODE: "1", NODE_OPTIONS: "--x" };
    // Signed in: no key, no gateway, no cloud switch; the sign-in token and the rest of the environment stay.
    expect(Object.keys(childEnv(daemon, "claude-opus-5-5")).sort()).toEqual(["AWS_REGION", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
    // Bedrock keeps its own switch, key and model defaults that name Bedrock models.
    expect(Object.keys(childEnv(daemon, "global.anthropic.claude-opus-5-5")).sort()).toEqual(["ANTHROPIC_DEFAULT_SONNET_MODEL", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "HOME", "PATH"]);
    expect(Object.keys(childEnv(daemon, "acme/claude-large")).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AWS_REGION", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"]);
    expect(childEnv(daemon, "claude-opus-5-5", "/c").CLAUDE_CONFIG_DIR).toBe("/c");
  });

  test("the transcript's last model and mode; never a bypass; the text never on the command line", () => {
    const recs = [
      { type: "user", cwd: "/a", permissionMode: "plan", message: { content: "x" } },
      { type: "assistant", cwd: "/b", message: { model: "claude-a" } },
      { type: "assistant", message: { model: "<synthetic>" } },
      { type: "user", permissionMode: "acceptEdits", message: { content: "y" } },
    ];
    expect(sessionFacts(recs)).toEqual({ cwd: "/b", model: "claude-a", mode: "acceptEdits" });
    expect(modeFor("bypassPermissions").mode).toBe("default");
    expect(modeFor("bypassPermissions").note).toBeTruthy();
    expect(modeFor("plan")).toEqual({ mode: "plan" });
    expect(modeFor("something-new")).toEqual({ mode: "default" });
    const argv = argsOf("claude", "sid", { model: "claude-a", mode: "default" });
    expect(argv).toEqual(["claude", "-p", "--resume", "sid", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--model", "claude-a", "--permission-mode", "default"]);
    expect(JSON.parse(userLine("update everything", "u1"))).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "update everything" }] }, parent_tool_use_id: null, uuid: "u1" });
    expect(planMode("auto-edits")).toEqual({ mode: "acceptEdits" });
    expect(planMode("full-auto").mode).toBe("default");
  });

  test("what a line of Claude Code's is", () => {
    expect(readOut({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash" } })).toEqual({ kind: "ask", id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    expect(readOut({ type: "control_response", response: { subtype: "error", request_id: "r2", error: "no" } })).toEqual({ kind: "answer", id: "r2", ok: false, error: "no" });
    expect(readOut({ type: "control_cancel_request", request_id: "r3" })).toEqual({ kind: "cancel", id: "r3" });
    expect(readOut({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } } })).toEqual({ kind: "delta", index: 1, text: "hi" });
    // A subagent's stream is not the row's reply.
    expect(readOut({ type: "stream_event", parent_tool_use_id: "t", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })).toEqual({ kind: "other" });
    expect(readOut({ type: "result", subtype: "success", is_error: false, user_message_uuids: ["u1"] })).toEqual({ kind: "result", uuids: ["u1"], error: false });
    expect(readOut({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] })).toEqual({ kind: "result", error: true, said: "interrupted" });
  });

  test("a message in the transcript, and the end of its turn", () => {
    const recs = [
      { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "go on" }] } },
      { type: "assistant", message: { stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", content: "go on" }] } },
    ];
    expect(holdsMessage(recs, " go on ")).toBe(true);
    expect(holdsMessage(recs, "other", "u1")).toBe(true);
    expect(holdsMessage([{ type: "assistant", message: { content: "go on" } }], "go on")).toBe(false);
    expect(turnEnded(recs, "go on")).toBe(false);
    expect(turnEnded([...recs, { type: "assistant", message: { stop_reason: "end_turn" } }], "go on")).toBe(true);
    expect(turnEnded([...recs, { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }], "go on")).toBe(true);
  });

  test("AskUserQuestion's answers by question text; a call's card by its tool", () => {
    const qs = questionsOf({ questions: [{ question: "Which?", header: "H", options: [{ label: "A", description: "" }, { label: "B" }], multiSelect: true }, { question: "Name?", options: [] }] });
    expect(answersOf(qs, { "0": { picked: ["A", "B"] }, "1": { picked: [], other: "Keel" } })).toEqual({ "Which?": "A, B", "Name?": "Keel" });
    expect(answersOf(qs, { "0": { picked: [], skipped: true } })).toEqual({});
    expect(cardOf("Bash", { command: "ls" }, "/w")).toMatchObject({ tool: { kind: "shell" }, input: { command: "ls", cwd: "/w" }, name: "Claude Code command" });
    expect(cardOf("Edit", { file_path: "/w/a.ts", old_string: "1", new_string: "2" }, "/w")).toMatchObject({ tool: { kind: "edit" }, input: { file_path: "/w/a.ts" }, shown: "/w/a.ts\n- 1\n+ 2" });
    expect(cardOf("mcp__x__y", { q: 1 }, "/w")).toMatchObject({ name: "Claude Code mcp__x__y", input: { q: 1 } });
  });
});

describe("a Claude Code session answered in place", () => {
  test("a send resumes the session with its model and mode, streams the reply, asks the command as a card, and the child ends after the turn", async () => {
    const r = rig();
    try {
      const s = await r.session();
      expect(s.outside?.holder).toEqual({ kind: "free" });
      expect(r.app().route(s.id)).toBe("resume");
      const sent = r.app().send(s.id, "fix the build", "k1");
      expect("send" in sent && sent.send.state).toBe("stored");
      const again = r.app().send(s.id, "fix the build", "k1");
      expect("send" in again && "send" in sent && again.send.id === sent.send.id).toBe(true);
      // Keel's child holds it while it works, though Claude Code keeps a record of that child's own.
      await until(() => r.store.session(s.id)?.outside?.holder?.kind === "keel");
      expect(r.o.holderNow(s.id)).toEqual({ kind: "keel" });
      await until(() => !r.app().ours(s.id), 15_000);
      const text = readFileSync(r.path, "utf8");
      expect(text.split('"content":"fix the build"').length - 1).toBe(1);
      expect(text).toContain("The command was allowed: fix the build");
      expect(r.cards).toEqual([{ name: "Claude Code command", input: { command: "make test", cwd: r.cwd }, why: "Claude Code runs this command in the session if you allow it", shown: undefined, notice: "Claude Code says: It runs the project's tests" }]);
      const deltas = r.frames.filter((f): f is Extract<Frame, { t: "delta" }> => f.t === "delta" && f.session_id === s.id).map((f) => f.text).join("");
      expect(deltas).toContain("The command was allowed: fix the build");
      // Started with the session's id, model and mode; the text went on standard input; first party: no key, no Bedrock.
      const start = r.log()[0];
      expect(start.argv).toEqual(["-p", "--resume", r.id, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--model", "claude-opus-5-5", "--permission-mode", "acceptEdits"]);
      expect(start.argv.join(" ")).not.toContain("fix the build");
      expect(start.env).not.toContain("ANTHROPIC_API_KEY");
      expect(start.env).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
      expect(start.env).not.toContain("CLAUDE_CODE_USE_BEDROCK");
      expect(start.env).not.toContain("ANTHROPIC_DEFAULT_MODEL");
      expect(start.cwd).toBe(r.cwd);
      expect(r.log().find((l) => l.in === "user")).toMatchObject({ uuid: "send" in sent ? sent.send.id : "", content: [{ type: "text", text: "fix the build" }] });
      expect(r.app().sends(s.id)).toEqual([]);
      expect(r.store.db.query("SELECT * FROM outside_procs").all()).toEqual([]);
      expect(r.o.holderNow(s.id)).toEqual({ kind: "free" });
    } finally { r.done(); }
  }, 30_000);

  test("a Bedrock session keeps the Bedrock route; a bypassed one goes on asking and says so", async () => {
    const r = rig({ model: "global.anthropic.claude-opus-5-5", mode: "bypassPermissions" });
    try {
      const s = await r.session();
      r.setDecide(() => ({ deny: "not now" }));
      r.app().send(s.id, "fix it", "k1");
      await until(() => r.cards.length > 0, 15_000);
      expect(r.app().notes(s.id).join(" ")).toContain("Keel never turns the bypass on");
      await until(() => !r.app().ours(s.id), 15_000);
      const start = r.log()[0];
      expect(start.argv.slice(-4)).toEqual(["--model", "global.anthropic.claude-opus-5-5", "--permission-mode", "default"]);
      expect(start.env).toContain("AWS_BEARER_TOKEN_BEDROCK");
      expect(start.env).not.toContain("ANTHROPIC_API_KEY");
      expect(readFileSync(r.path, "utf8")).toContain("The command was declined: fix it");
    } finally { r.done(); }
  }, 30_000);

  test("AskUserQuestion is a question card; the answer goes back by question text", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "ask me the color", "k1");
      const q = await until(() => allPendingQuestions().find((x) => x.session_id === s.id), 15_000);
      expect(q.asked).toMatchObject({ from: "Claude Code", questions: [{ id: "0", header: "Color", question: "Which color should the button be?", options: [{ label: "Blue", description: "The brand color" }, { label: "Green", description: "Calm" }] }] });
      expect(answer(s.id, q.call_id, { "0": { picked: ["Green"] } }, false, q.asked!.id)).toBe(true);
      await until(() => readFileSync(r.path, "utf8").includes("You picked Green."), 15_000);
      await until(() => !r.app().ours(s.id), 15_000);
    } finally { r.done(); }
  }, 30_000);

  test("ExitPlanMode is a plan card; an approval goes on in the mode picked, never a bypass", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "plan the rename", "k1");
      await until(() => readFileSync(r.path, "utf8").includes("The plan was approved; going on in acceptEdits mode."), 15_000);
      expect(r.plans).toMatchObject([{ session_id: s.id, plan: "1. Rename the loader\n2. Run the tests" }]);
      await until(() => !r.app().ours(s.id), 15_000);
      r.setPlanned(() => ({ approved: false, feedback: "split it" }));
      r.app().send(s.id, "plan it again", "k2");
      await until(() => readFileSync(r.path, "utf8").includes("The plan was sent back: The owner did not approve the plan: split it"), 15_000);
    } finally { r.done(); }
  }, 30_000);

  test("Stop interrupts the turn over the control channel; a send while it runs goes into the same child", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id), 15_000);
      const pid = (r.store.db.query<{ pid: number }, []>("SELECT pid FROM outside_procs").get())!.pid;
      expect(r.app().route(s.id)).toBe("steer");
      r.app().send(s.id, "and then this", "k2");
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => readFileSync(r.path, "utf8").includes("The command was allowed: and then this"), 15_000);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(r.log().filter((l) => l.argv).length).toBe(1);
      expect(r.log().some((l) => l.in === "control_request" && l.subtype === "interrupt")).toBe(true);
      expect(readFileSync(r.path, "utf8")).toContain("[Request interrupted by user]");
      expect(pid).toBeGreaterThan(1);
    } finally { r.done(); }
  }, 30_000);

  test("a session a terminal holds takes nothing, and says who holds it", async () => {
    const r = rig();
    try {
      const s = await r.session();
      // A live Claude Code process of the owner's records the session (this test's own process stands in for it).
      const start = statFields(readFileSync(`/proc/${process.pid}/stat`, "utf8"))!.start;
      mkdirSync(join(r.config, "sessions"), { recursive: true });
      writeFileSync(join(r.config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: r.id, procStart: start, kind: "interactive", entrypoint: "cli", status: "idle" }));
      expect(r.o.holderNow(s.id)).toEqual({ kind: "terminal", pid: process.pid });
      expect(r.app().route(s.id)).toBe("held");
      const got = r.app().send(s.id, "hello", "k1");
      expect(got).toEqual({ error: `Open in a terminal (pid ${process.pid}): answer it there. Keel sends nothing to a session another process holds.`, status: 409, holder: { kind: "terminal", pid: process.pid } });
      expect(r.store.db.query("SELECT * FROM outside_sends").all()).toEqual([]);
      // A record whose process started at another moment is a pid taken again: the session is free.
      writeFileSync(join(r.config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: r.id, procStart: "1", kind: "interactive" }));
      expect(r.o.holderNow(s.id)).toEqual({ kind: "free" });
    } finally { r.done(); }
  });

  test("after a restart a send that started is looked for in the transcript, never sent again; a cut turn and its cards say so; an orphan child is ended", async () => {
    const r = rig({ realGate: true });
    const orphan = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let left: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const s = await r.session();
      const size = readFileSync(r.path).length;
      const put = r.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, ?, 'started', ?, NULL, ?)");
      put.run("a", s.id, "ka", "it went", size, Date.now());
      put.run("b", s.id, "kb", "it did not", size, Date.now());
      put.run("c", s.id, "kc", "it was cut", size, Date.now());
      r.write({ type: "user", message: { role: "user", content: "it went" } });
      r.write({ type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } });
      r.write({ type: "user", message: { role: "user", content: "it was cut" } });
      // Keel's child an earlier daemon left running, and a recorded pid that is another program now (never signalled).
      left = Bun.spawn([STANDIN, "-p", "--resume", r.id, "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio"], { cwd: r.cwd, stdin: "pipe", stdout: "ignore", stderr: "ignore", env: { ...process.env, CLAUDE_CONFIG_DIR: r.config } });
      await until(() => { try { return readFileSync(`/proc/${left!.pid}/cmdline`, "utf8").includes("--permission-prompt-tool"); } catch { return false; } });
      const startOf = (pid: number) => statFields(readFileSync(`/proc/${pid}/stat`, "utf8"))!.start;
      const put2 = r.store.db.query("INSERT INTO outside_procs (session_id, pid, start) VALUES (?, ?, ?)");
      put2.run(s.id, left.pid, startOf(left.pid));
      const other = r.store.createSession({ title: "Claude: other", model: "m", workspace: r.cwd }).id;
      r.store.db.query("INSERT INTO outside_sessions (session_id, harness, source_id, path, files, usage, failures) VALUES (?, 'claude', 'o-1', '/x', '[]', '{}', 0)").run(other);
      put2.run(other, orphan.pid, startOf(orphan.pid));
      const call = { id: "claude-x-t1", tool: { name: "Claude Code command", kind: "shell", description: "", readOnly: false, input_schema: { properties: { command: {} } }, run: async () => ({ content: "" }) }, input: { command: "make" }, ctx: { sessionId: s.id, cwd: r.cwd, signal: new AbortController().signal, spillDir: "", seen: new Map() } } as any;
      void r.gate()!.askOnce(r.store.session(s.id)!, call, "Claude Code command", "Claude Code asks", "harness");
      const card = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0]);
      r.app().stop();
      r.nextGate();
      r.make().start();
      expect(r.gate()!.approval(card.id)).toMatchObject({ state: "cancelled", reason: "Keel restarted while Claude Code worked: the turn stopped there" });
      expect(r.store.db.query<{ id: string; state: string }, []>("SELECT id, state FROM outside_sends ORDER BY id").all()).toEqual([{ id: "a", state: "delivered" }, { id: "b", state: "lost" }, { id: "c", state: "cut" }]);
      expect(readFileSync(r.path, "utf8").match(/it did not/g)).toBeNull();
      await until(() => r.store.db.query("SELECT * FROM outside_procs").all().length === 0);
      await until(() => left!.exitCode !== null || left!.signalCode !== null, 8000);
      expect(orphan.exitCode).toBeNull();
    } finally { orphan.kill(); left?.kill(); r.done(); }
  }, 30_000);
});
