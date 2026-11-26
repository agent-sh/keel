// A Claude Code session answered in place, against the stand-in of `claude -p` (test/e2e/fixtures/claude-code.ts)
// over a scratch Claude Code folder the mirror watches: a send resumes the session by its id with its own model and
// mode, the text on standard input, an environment with only the route its model names; the reply streams as
// deltas, the call Claude Code asks about is a one-call card, AskUserQuestion a question card, ExitPlanMode a plan
// card; the transcript holds the message and the reply and the child is gone after the turn. A session another
// process holds takes nothing. After a restart a send is looked for in the transcript.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Store } from "../../core/store.ts";
import { Bus } from "../../core/bus.ts";
import type { Frame } from "../../core/types.ts";
import { ownEnv } from "../../../test/env.ts";
import { answer, allPendingQuestions } from "../../tools/interact.ts";
import { Outside } from "./service.ts";
import { OUTSIDE_DEFAULTS } from "./settings.ts";
import { Gate } from "../../safety/gate.ts";
import { ownerClass } from "../../safety/delegate.ts";
import { HelperCards } from "../../helper/cards.ts";
import { forPeers } from "../../core/outside.ts";
import { statFields } from "./writer.ts";
import type { CardGate } from "./codex-app.ts";
import { ClaudeCode, mainRootOf } from "./claude-code.ts";
import type { Answer, PlanCard } from "../../server/routes/plan.ts";
import { answersOf, argsOf, Back, cardOf, childEnv, holdsMessage, modeFor, namesFolder, planMode, projectOf, questionsOf, readOut, routeMissing, routeOf, trusted, turnEnded, userLine } from "./claude-wire.ts";

const top = mkdtempSync(join(tmpdir(), "keel-claude-code-"));
ownEnv({ KEEL_IMPORT_CODEX_DIR: undefined, KEEL_IMPORT_CLAUDE_DIR: undefined });
afterAll(() => rmSync(top, { recursive: true, force: true }));
const STANDIN = join(import.meta.dir, "../../../test/e2e/fixtures/claude-code.ts");
const LAUNCHER = join(import.meta.dir, "../../../test/e2e/fixtures/claude-launcher.ts");
// Whether /proc says what a process's children and state are (Linux): the process tests need it.
const PROC = (() => { try { return readFileSync(`/proc/${process.pid}/stat`, "utf8").length > 0; } catch { return false; } })();
const lives = (pid: number) => { try { return statFields(readFileSync(`/proc/${pid}/stat`, "utf8"))?.state !== "Z"; } catch { return false; } };

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
function rig(opts: { realGate?: boolean; model?: string; mode?: string | null; bin?: string; env?: Record<string, string>; trust?: false; noBedrock?: true } = {}) {
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
  // Claude Code's own trust record for the session's folder (a print run asks nothing: Keel needs it).
  if (opts.trust !== false) writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
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
  const env = () => ({ ...process.env, KEEL_STANDIN_RECORD: "1", ANTHROPIC_API_KEY: "sk-test", AWS_BEARER_TOKEN_BEDROCK: "b-test", ...(opts.noBedrock ? {} : { CLAUDE_CODE_USE_BEDROCK: "1" }), ANTHROPIC_DEFAULT_MODEL: "global.anthropic.claude-x", ...opts.env });
  const make = () => (app = new ClaudeCode({ store, bus, outside, gate: () => gate, bin: () => opts.bin ?? STANDIN, configDir: () => config, runningDir: () => join(config, "sessions"), env, trouble: (e) => { throw e; }, plan: async (c) => { plans.push(c); return planned(c); } }));
  make();
  const id = `0c1a0000-0000-4000-8000-${String(k).padStart(12, "0")}`;
  const path = join(project, `${id}.jsonl`);
  let parent: string | null = null;
  const write = (r: object) => {
    const uuid = crypto.randomUUID();
    appendFileSync(path, JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.332", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, ...r }) + "\n");
    parent = uuid;
  };
  // The transcript as last written a minute ago: no process is in it now (a write of the last seconds holds a send).
  const quiet = () => { const t = new Date(Date.now() - 60_000); utimesSync(path, t, t); };
  const done = () => { app?.stop(); o.stop(); store.db.close(); };
  // Written once the project's folder is watched: the mirror follows a transcript that grows while it watches.
  const session = async () => {
    await until(() => (o as any).watchers.has(project));
    write({ type: "user", message: { role: "user", content: "Start the work" }, ...(opts.mode === null ? {} : { permissionMode: opts.mode ?? "acceptEdits" }) });
    write({ type: "assistant", message: { id: "m0", role: "assistant", model: opts.model ?? "claude-opus-5-5", content: [{ type: "text", text: "Started." }], stop_reason: "end_turn" } });
    const s = await until(() => store.sessions({ outside: true }).find((s) => s.outside?.source_id === id), 15_000);
    quiet();
    return s;
  };
  const nextGate = () => (gate = real = new Gate(store, bus));
  const log = () => { try { return readFileSync(`${path}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, config, cwd, store, bus, frames, o, gate: () => real, nextGate, app: () => app!, make, cards, setDecide: (f: typeof decide) => { decide = f; }, plans, setPlanned: (f: typeof planned) => { planned = f; }, id, path, write, quiet, session, done, log };
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
    // A context suffix names no route.
    expect(routeOf("claude-opus-5-5[1m]")).toBe("first-party");
    // The marks of a Claude Code that started the daemon (which session, job or host it runs as) never reach the child,
    // nor a Claude Code folder other than the one the mirror reads.
    const marks = { CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_KIND: "bg", CLAUDE_JOB_DIR: "/j", CLAUDE_BG_SOURCE: "spare", CLAUDE_CODE_SESSION_NAME: "n", CLAUDE_CODE_AGENT: "a", CLAUDE_CODE_SESSION_LOG: "/l", CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", CLAUDE_CODE_REMOTE_SESSION_ID: "r", CLAUDE_CODE_HOST_WORKTREE: "w", CLAUDE_CONFIG_DIR: "/elsewhere", CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES: "1" };
    expect(Object.keys(childEnv({ PATH: "/bin", ...marks }, "claude-opus-5-5")).sort()).toEqual(["CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES", "PATH"]);
    expect(childEnv({ ...marks }, "claude-opus-5-5", "/c").CLAUDE_CONFIG_DIR).toBe("/c");
    // A route the session ran on that this environment does not have is said, never taken for another.
    expect(routeMissing("bedrock", {})).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(routeMissing("bedrock", { CLAUDE_CODE_USE_BEDROCK: "true" })).toBeUndefined();
    expect(routeMissing("gateway", { ANTHROPIC_API_KEY: "k" })).toContain("ANTHROPIC_BASE_URL");
    expect(routeMissing("first-party", {})).toBeUndefined();
  });

  test("the session's project folder, its last model, context and mode, its trust; never a bypass; the text never on the command line", () => {
    const recs = [
      { type: "user", cwd: "/w/a", permissionMode: "plan", message: { content: "x" } },
      { type: "assistant", cwd: "/w/a/vendor/clone", message: { model: "claude-a", usage: { input_tokens: 10, cache_read_input_tokens: 230_000 } }, stop_reason: "end_turn" },
      { type: "assistant", isSidechain: true, cwd: "/elsewhere", message: { model: "claude-haiku" } },
      { type: "assistant", message: { model: "<synthetic>" } },
      { type: "user", permissionMode: "acceptEdits", message: { content: "y" } },
      { type: "user", isSidechain: true, permissionMode: "bypassPermissions", message: { content: "z" } },
    ];
    // Where it was started, the folder its transcript is kept under: not where its shell went, nor a subagent's.
    expect(projectOf(recs, "-w-a")).toBe("/w/a");
    expect(projectOf(recs, "-w-b")).toBeUndefined();
    expect(namesFolder(`/${"d".repeat(250)}`, `-${"d".repeat(199)}-x1y2`)).toBe(true);
    const b = new Back();
    for (const r of [...recs].reverse()) if (b.take(r)) break;
    expect([b.model, b.context, b.mode, b.open]).toEqual(["claude-a", 230_010, "acceptEdits", true]);
    // Over the base window it ran with the 1M one.
    expect(b.modelArg()).toBe("claude-a[1m]");
    // No user record names a mode: default, never what a first record or a subagent said.
    const none = new Back();
    for (const r of [{ type: "assistant", message: { model: "claude-a", stop_reason: "end_turn", usage: { input_tokens: 5 } } }, { type: "user", isSidechain: true, permissionMode: "plan" }]) none.take(r);
    expect([none.mode, modeFor(none.mode).mode, none.modelArg(), none.open]).toEqual([undefined, "default", "claude-a", false]);
    // Claude Code's own trust record: the folder or one above it, not above its repository.
    const cfg = { projects: { "/w": { hasTrustDialogAccepted: true }, "/r/repo/x": { hasTrustDialogAccepted: false } } };
    expect(trusted(cfg, "/w/a")).toBe(true);
    expect(trusted(cfg, "/w/a", "/w/a")).toBe(false);
    expect(trusted(cfg, "/r/repo/x")).toBe(false);
    expect(trusted({}, "/w")).toBe(false);
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
    // A reply that calls a tool waits for its result whatever its stop_reason says (a stop sequence cut after the call).
    const calls = { type: "assistant", message: { stop_reason: "stop_sequence", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "make all" } }] } };
    expect(turnEnded([...recs, calls], "go on")).toBe(false);
    const b = new Back();
    b.take(calls);
    expect(b.open).toBe(true);
    const ended = new Back();
    ended.take({ type: "assistant", message: { stop_reason: "stop_sequence", content: [{ type: "text", text: "Done." }] } });
    expect(ended.open).toBe(false);
  });

  test("AskUserQuestion's answers by question text; a call's card by its tool", () => {
    const qs = questionsOf({ questions: [{ question: "Which?", header: "H", options: [{ label: "A", description: "" }, { label: "B" }], multiSelect: true }, { question: "Name?", options: [] }] })!;
    expect(answersOf(qs, { "0": { picked: ["A", "B"] }, "1": { picked: [], other: "Keel" } })).toEqual({ "Which?": "A, B", "Name?": "Keel" });
    expect(answersOf(qs, { "0": { picked: [], skipped: true } })).toEqual({});
    // Questions Keel cannot show whole are not shown in part.
    for (const bad of [{}, { questions: [] }, { questions: [{ question: "Which?", options: [{ label: "A" }] }, { question: "", options: [] }] }, { questions: [{ question: "Which?", options: [{ label: 1 }] }] }, { questions: [{ question: "Which?" }] }]) expect(questionsOf(bad)).toBeUndefined();
    expect(cardOf("Bash", { command: "ls" }, "/w")).toMatchObject({ tool: { kind: "shell" }, input: { command: "ls", cwd: "/w" }, name: "Claude Code command" });
    expect(cardOf("Bash", { command: "  " }, "/w").shown).toBe("Claude Code asks to run a command it does not name");
    expect(cardOf("Bash", { command: "ls", run_in_background: true, dangerouslyDisableSandbox: true }, "/w").shown).toBe("ls\nClaude Code also asks for run_in_background: true, dangerouslyDisableSandbox: true");
    // The card holds the whole input the allow answers: the gate cuts what it shows, and says it did.
    const long = "y".repeat(30_000);
    expect(cardOf("Edit", { file_path: "/w/a.ts", old_string: "1", new_string: long }, "/w")).toEqual({ tool: { name: "Claude Code file change", kind: "edit" }, input: { file_path: "/w/a.ts", old_string: "1", new_string: long }, name: "Claude Code file change", why: "Claude Code writes this change if you allow it" });
    expect(cardOf("MultiEdit", { file_path: "/w/a.ts", edits: [{ old_string: "1", new_string: "2" }] }, "/w").input.patch).toBe("- 1\n+ 2");
    // A file change that names no file is no file change's card: its input as it is.
    expect(cardOf("Write", { content: "x" }, "/w")).toMatchObject({ tool: { name: "Claude Code Write" }, input: { content: "x" } });
    expect(cardOf("mcp__x__y", { q: long }, "/w")).toEqual({ tool: { name: "Claude Code mcp__x__y" }, input: { q: long }, name: "Claude Code mcp__x__y", why: "Claude Code runs its mcp__x__y tool if you allow it" });
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
      expect(r.cards).toEqual([{ name: "Claude Code command", input: { command: "make test", cwd: r.cwd, item: expect.stringMatching(/^toolu_/) }, why: "Claude Code runs this command in the session if you allow it", shown: undefined, notice: "Claude Code says: It runs the project's tests" }]);
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

  test("Stop interrupts the turn over the control channel and the child ends after it: what Claude Code queued behind it does not run", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id), 15_000);
      const pid = (r.store.db.query<{ pid: number }, []>("SELECT pid FROM outside_procs").get())!.pid;
      expect(r.app().route(s.id)).toBe("steer");
      // A send while the turn runs goes into the same child (Claude Code queues it behind the turn).
      r.app().send(s.id, "and then this", "k2");
      await until(() => r.log().filter((l) => l.in === "user").length === 2, 15_000);
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(r.log().filter((l) => l.argv).length).toBe(1);
      expect(r.log().filter((l) => l.in === "control_request" && l.subtype === "interrupt").length).toBe(1);
      const text = readFileSync(r.path, "utf8");
      expect(text).toContain("[Request interrupted by user]");
      expect(text).not.toContain("and then this");
      expect(r.app().sends(s.id).map((x) => [x.key, x.state, x.said])).toEqual([["k2", "failed", "Not run: you stopped the turn before Claude Code took it"]]);
      expect(r.log().find((l) => l.in === "control_request" && l.subtype === "interrupt")?.cancel_queued).toBe(true);
      // Not a failure of Claude Code's: the owner stopped it.
      expect(r.app().notes(s.id)).toEqual([]);
      expect(pid).toBeGreaterThan(1);
    } finally { r.done(); }
    // A Claude Code that does not know cancel_queued lists what survives: each is withdrawn by itself.
    const o = rig({ env: { KEEL_STANDIN_OLD_INTERRUPT: "1" } });
    try {
      const s = await o.session();
      o.app().send(s.id, "wait for me", "k1");
      await until(() => o.app().running(s.id), 15_000);
      o.app().send(s.id, "and then this", "k2");
      await until(() => o.log().filter((l) => l.in === "user").length === 2, 15_000);
      await o.app().interrupt(s.id);
      await until(() => !o.app().ours(s.id), 15_000);
      expect(o.log().some((l) => l.in === "control_request" && l.subtype === "cancel_async_message")).toBe(true);
      expect(readFileSync(o.path, "utf8")).not.toContain("and then this");
      expect(o.app().sends(s.id).map((x) => [x.key, x.state])).toEqual([["k2", "failed"]]);
    } finally { o.done(); }
  }, 40_000);

  test("a Stop while Claude Code is still starting: the send never runs, and no second child takes it", async () => {
    // Stopped before any child started (its folder and transcript still being read).
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "fix the build", "k1");
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      await Bun.sleep(300);
      expect(r.log()).toEqual([]);
      expect(r.app().sends(s.id).map((x) => [x.key, x.state, x.said])).toEqual([["k1", "failed", "Not run: you stopped the turn before Claude Code took it"]]);
    } finally { r.done(); }
    // Stopped while the child loads the session (it reads nothing for 1.5 s).
    const w = rig({ env: { KEEL_STANDIN_START_MS: "1500" } });
    try {
      const s = await w.session();
      w.app().send(s.id, "fix the build", "k1");
      await until(() => w.log().some((l) => l.argv), 15_000);
      expect(await w.app().interrupt(s.id)).toBe(true);
      await until(() => !w.app().ours(s.id), 15_000);
      await Bun.sleep(2500);
      expect(w.app().ours(s.id)).toBe(false);
      expect(w.log().filter((l) => l.argv).length).toBe(1);
      expect(w.log().filter((l) => l.in === "user")).toEqual([]);
      expect(readFileSync(w.path, "utf8")).not.toContain("fix the build");
      expect(w.app().sends(s.id).map((x) => [x.key, x.state, x.said])).toEqual([["k1", "failed", "Not run: you stopped the turn before Claude Code took it"]]);
    } finally { w.done(); }
  }, 40_000);

  test("a send after a Stop goes with a new child once the stopped one ended", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id), 15_000);
      void r.app().interrupt(s.id);
      r.app().send(s.id, "fix the build", "k2");
      await until(() => readFileSync(r.path, "utf8").includes("The command was allowed: fix the build"), 15_000);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(r.log().filter((l) => l.argv).length).toBe(2);
      expect(r.app().sends(s.id)).toEqual([]);
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
      const states = () => r.store.db.query<{ id: string; state: string }, []>("SELECT id, state FROM outside_sends ORDER BY id").all();
      await until(() => !states().some((x) => x.state === "started"));
      expect(states()).toEqual([{ id: "a", state: "delivered" }, { id: "b", state: "lost" }, { id: "c", state: "cut" }]);
      expect(readFileSync(r.path, "utf8").match(/it did not/g)).toBeNull();
      await until(() => left!.exitCode !== null || left!.signalCode !== null, 8000);
      // The rows of what is gone go; the row of a process that still lives (not Keel's to end) stays.
      await until(() => r.store.db.query("SELECT * FROM outside_procs").all().length === 1);
      expect(r.store.db.query("SELECT session_id FROM outside_procs").all()).toEqual([{ session_id: other }]);
      expect(orphan.exitCode).toBeNull();
    } finally { orphan.kill(); left?.kill(); r.done(); }
  }, 30_000);

  test("what Claude Code asks is judged as running with no sandbox of Keel's: high risk only for what is", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      // A session whose own commands run in Keel's sandbox: what Claude Code runs is not one of them.
      r.gate()!.setPerm(s.id, { sandbox: "workspace-write" });
      const risk = async (command: string, key: string) => {
        r.app().send(s.id, `run: ${command}`, key);
        const card = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0], 15_000);
        r.gate()!.resolve(card.id, s.id, { choice: "deny" });
        await until(() => !r.app().ours(s.id), 15_000);
        return [command, card.risk, card.why];
      };
      let n = 0;
      for (const c of ["rm -rf ~/projects", "chmod -R 777 /home/someone", "mv ~/.ssh ~/.ssh.bak"]) {
        const [, level, why] = await risk(c, `k${++n}`);
        expect([c, level]).toEqual([c, "high"]);
        expect(why).not.toBe("Claude Code runs this command in the session if you allow it");
      }
      expect(await risk("make test", "k9")).toEqual(["make test", "low", "Claude Code runs this command in the session if you allow it"]);
    } finally { r.done(); }
  }, 60_000);

  test("a call the owner denied is answered by its tool_use id: its line says denied by you", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      r.app().send(s.id, "wipe it", "k1");
      const card = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0], 15_000);
      const use = card.input?.item as string;
      expect(use).toMatch(/^toolu_/);
      expect(readFileSync(r.path, "utf8")).toContain(`"id":"${use}"`);
      r.gate()!.resolve(card.id, s.id, { choice: "deny", reason: "not on this box" });
      await until(() => !r.app().ours(s.id), 15_000);
      expect(r.app().answers(s.id)).toEqual({ [use]: { state: "denied", reason: "not on this box" } });
      const told = r.frames.filter((f) => f.t === "feature" && f.name === "outside_sends" && f.session_id === s.id).at(-1) as any;
      expect(told.data.answers).toEqual({ [use]: { state: "denied", reason: "not on this box" } });
    } finally { r.done(); }
  }, 30_000);

  test("a Claude Code card is the owner's alone: never the helper's, never a paired machine's", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      r.app().send(s.id, "fix the build", "k1");
      const card = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0], 15_000);
      expect(ownerClass(card, false)?.cls).toBe("owner-only");
      const h: any = { deps: { store: r.store, errors: { capture: () => {} } }, isHelper: () => false, isCards: () => false, state: () => ({ on: true, answer_cards: true }), session: () => ({ id: "helper" }) };
      const cards = new HelperCards(h, () => r.gate() as any, { send: (() => {}) as any, raise: (() => undefined) as any, untold: () => true });
      expect(cards.open()).toEqual([]);
      // Nothing of the session goes to a paired machine: its card, its sends, its reply's words.
      const peers = forPeers(r.store.db);
      const mine = r.frames.filter((f: any) => f.session_id === s.id || f.session?.id === s.id || f.data?.session_id === s.id);
      expect(mine.some((f: any) => f.t === "feature" && f.name === "approval")).toBe(true);
      expect(mine.map((f) => peers.relay(f as any)).filter(Boolean)).toEqual([]);
      expect(r.gate()!.resolve(card.id, s.id, { choice: "once", seen: "whole" })).toEqual({ ok: true });
      await until(() => !r.app().ours(s.id), 15_000);
    } finally { r.done(); }
  }, 30_000);

  test("a send taken just before Keel stops is kept for the next daemon, which sends it", async () => {
    const r = rig();
    try {
      const s = await r.session();
      expect("send" in r.app().send(s.id, "fix the build", "k1")).toBe(true);
      // The drain comes while the child starts.
      r.app().stop();
      await Bun.sleep(500);
      expect(r.app().sends(s.id).map((x) => x.state)).toEqual(["stored"]);
      r.make().start();
      await until(() => r.store.db.query<{ state: string }, []>("SELECT state FROM outside_sends").get()?.state === "delivered", 15_000);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(readFileSync(r.path, "utf8").split('"content":"fix the build"').length - 1).toBe(1);
    } finally { r.done(); }
  }, 30_000);

  test("a send that lands while the child ends goes with one new child, never two", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id), 15_000);
      const run = (r.app() as any).runs.get(s.id);
      void (r.app() as any).kill(run);
      r.app().send(s.id, "first after", "k2");
      r.app().send(s.id, "second after", "k3");
      await until(() => readFileSync(r.path, "utf8").includes("The command was allowed: second after"), 20_000);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(r.log().filter((l) => l.argv).length).toBe(2);
    } finally { r.done(); }
  }, 40_000);

  test.skipIf(!PROC)("a claude that is a launcher: a forced Stop ends what holds the session under it, never what Claude Code started", async () => {
    const helpers = join(top, `helpers-${k}`);
    writeFileSync(helpers, "");
    const r = rig({ bin: LAUNCHER, env: { KEEL_STANDIN_HELPERS: helpers } });
    const left: number[] = [];
    try {
      const s = await r.session();
      r.app().send(s.id, "stuck now", "k1");
      await until(() => r.frames.some((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")), 15_000);
      const launcher = (r.app() as any).runs.get(s.id).child.pid as number;
      // The native the launcher runs keeps the session's record: it holds the session, not the launcher.
      const native = (await until(() => r.o.holderNow(s.id) && readdirSync(join(r.config, "sessions")).map((n) => Number(n.split(".")[0])).find((p) => p !== launcher && lives(p))))!;
      left.push(native, ...readFileSync(helpers, "utf8").split("\n").filter(Boolean).map((l) => Number(l.split(" ")[1])));
      expect(left.length).toBe(3);
      // A Stop asks Claude Code, which does not answer; a second asks again, and ends nothing by itself.
      const first = r.app().interrupt(s.id);
      const second = r.app().interrupt(s.id);
      await until(() => r.log().filter((l) => l.in === "control_request" && l.subtype === "interrupt").length === 2);
      await Bun.sleep(300);
      expect([lives(launcher), lives(native)]).toEqual([true, true]);
      // Unanswered in a few seconds, the child is ended.
      expect(await second).toBe(true);
      await first;
      await until(() => !r.app().ours(s.id), 15_000);
      expect([lives(launcher), lives(native)]).toEqual([false, false]);
      // Its MCP servers and the turn's jobs are not Keel's to end, whatever their arguments say.
      expect(left.slice(1).map(lives)).toEqual([true, true]);
      expect(r.store.db.query("SELECT * FROM outside_procs").all()).toEqual([]);
    } finally { for (const p of left) try { process.kill(p, "SIGKILL"); } catch {} r.done(); }
  }, 40_000);

  test("the child starts in the session's project folder, never where its shell went; a folder Claude Code does not trust takes nothing", async () => {
    const r = rig();
    try {
      const s = await r.session();
      // The session's shell went into a clone under it, with project settings of its own a print run would load.
      const cloned = join(r.cwd, "vendor", "clone");
      mkdirSync(join(cloned, ".claude"), { recursive: true });
      r.write({ type: "user", message: { role: "user", content: "clone it and look inside" }, permissionMode: "acceptEdits" });
      r.write({ type: "assistant", cwd: cloned, message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "I am in it now." }], stop_reason: "end_turn" } });
      r.quiet();
      r.app().send(s.id, "fix the build", "k1");
      await until(() => r.log().length > 0 && !r.app().ours(s.id), 15_000);
      expect(r.log()[0].cwd).toBe(r.cwd);
    } finally { r.done(); }
    const u = rig({ trust: false });
    try {
      const s = await u.session();
      u.app().send(s.id, "fix the build", "k1");
      const failed = await until(() => u.app().sends(s.id).find((x) => x.state === "failed"), 15_000);
      expect(failed.said).toContain(`Claude Code's trust record does not cover ${u.cwd}`);
      expect(u.log()).toEqual([]);
    } finally { u.done(); }
    // A linked worktree of a repository the owner trusted: Claude Code reads the worktree's trust at the main one.
    const t = rig({ trust: false });
    try {
      const main = join(t.dir, "main");
      const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { PATH: process.env.PATH!, HOME: t.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
      mkdirSync(main);
      git(main, "init", "-q");
      writeFileSync(join(main, "a.txt"), "a");
      git(main, "add", "a.txt");
      git(main, "commit", "-q", "-m", "a");
      rmSync(t.cwd, { recursive: true });
      expect(git(main, "worktree", "add", "-q", t.cwd).exitCode).toBe(0);
      writeFileSync(join(t.config, ".claude.json"), JSON.stringify({ projects: { [main]: { hasTrustDialogAccepted: true } } }));
      const s = await t.session();
      t.app().send(s.id, "fix the build", "k1");
      await until(() => readFileSync(t.path, "utf8").includes("The command was allowed: fix the build"), 15_000);
      expect(mainRootOf(t.cwd)).toBe(main);
      expect(mainRootOf(main)).toBeUndefined();
      // A .git file whose worktree folder does not point back at it is no worktree of that repository.
      writeFileSync(join(main, ".git", "worktrees", basename(t.cwd), "gitdir"), join(t.dir, "elsewhere", ".git") + "\n");
      expect(mainRootOf(t.cwd)).toBeUndefined();
    } finally { t.done(); }
  }, 40_000);

  test("the mode is the last user record's, however far back, else default; a session over the base window goes on with the 1M one", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.write({ type: "user", message: { role: "user", content: "only plan from here on" }, permissionMode: "plan" });
      // A long turn after it: its last prompt is far before the transcript's last 64 KB.
      for (let i = 0; i < 30; i++) {
        r.write({ type: "assistant", message: { id: `t${i}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: "/w/a.ts" } }], stop_reason: "tool_use" } });
        r.write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: "y".repeat(4000) }] } });
      }
      // Its last request was sent 240,000 tokens: over the base window.
      r.write({ type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Here is the plan." }], stop_reason: "end_turn", usage: { input_tokens: 12, cache_read_input_tokens: 240_000 } } });
      r.quiet();
      r.app().send(s.id, "fix the build", "k1");
      await until(() => r.log().length > 0 && !r.app().ours(s.id), 15_000);
      expect(r.log()[0].argv.slice(-4)).toEqual(["--model", "claude-opus-5-5[1m]", "--permission-mode", "plan"]);
    } finally { r.done(); }
    const n = rig({ mode: null });
    try {
      const s = await n.session();
      n.app().send(s.id, "fix the build", "k1");
      await until(() => n.log().length > 0 && !n.app().ours(s.id), 15_000);
      expect(n.log()[0].argv.slice(-4)).toEqual(["--model", "claude-opus-5-5", "--permission-mode", "default"]);
    } finally { n.done(); }
  }, 40_000);

  test("a Bedrock session goes on only where Bedrock is set up: here, or in Claude Code's own settings", async () => {
    const r = rig({ model: "global.anthropic.claude-opus-5-5", noBedrock: true });
    try {
      const s = await r.session();
      r.app().send(s.id, "fix it", "k1");
      const failed = await until(() => r.app().sends(s.id).find((x) => x.state === "failed"), 15_000);
      expect(failed.said).toContain("it ran on Amazon Bedrock, and CLAUDE_CODE_USE_BEDROCK is not set here");
      expect(r.log()).toEqual([]);
      writeFileSync(join(r.config, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
      r.app().send(s.id, "fix it", "k2");
      await until(() => r.log().length > 0 && !r.app().ours(s.id), 15_000);
      expect(r.log()[0].argv).toContain("global.anthropic.claude-opus-5-5");
    } finally { r.done(); }
  }, 30_000);

  test("a long call's card holds its whole input, the part the allow sends", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.setDecide(() => ({ deny: "no" }));
      r.app().send(s.id, "write big", "k1");
      await until(() => r.cards.length > 0, 15_000);
      const c = r.cards[0]!;
      expect(c.name).toBe("Claude Code file change");
      expect(c.shown).toBeUndefined();
      expect(String(c.input.content).length).toBeGreaterThan(30_000);
      expect(String(c.input.content).endsWith("| sh\n")).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
    } finally { r.done(); }
  }, 30_000);

  test("a record of another pid domain holds the session", async () => {
    const r = rig();
    try {
      const s = await r.session();
      mkdirSync(join(r.config, "sessions"), { recursive: true });
      writeFileSync(join(r.config, "sessions", "4000123.json"), JSON.stringify({ pid: 4000123, sessionId: r.id, procStart: "777", kind: "interactive", entrypoint: "cli", pidDomain: "linux:0000aaaa:pid:[4026539999]", status: "busy" }));
      expect(r.o.holderNow(s.id)).toEqual({ kind: "terminal" });
      expect(r.app().route(s.id)).toBe("held");
      expect(r.app().send(s.id, "hello", "k1")).toMatchObject({ status: 409, holder: { kind: "terminal" } });
    } finally { r.done(); }
  });

  test("a transcript another process writes with no record of it holds a send: written seconds ago, or an open turn minutes ago", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.write({ type: "user", message: { role: "user", content: "go on" }, permissionMode: "default" });
      r.write({ type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 600" } }], stop_reason: "tool_use" } });
      expect(r.app().holder(s.id)).toEqual({ kind: "process" });
      expect(r.app().route(s.id)).toBe("held");
      const got = r.app().send(s.id, "edit the file", "k1");
      expect(got).toMatchObject({ status: 409, holder: { kind: "process" } });
      expect("error" in got && got.error).toContain("s ago and no record says which process runs it");
      const at = (ms: number) => { const t = new Date(Date.now() - ms); utimesSync(r.path, t, t); };
      at(2 * 60_000);
      expect("error" in r.app().send(s.id, "edit the file", "k2") && r.app().holder(s.id)).toEqual({ kind: "process" });
      at(11 * 60_000);
      expect(r.app().holder(s.id)).toEqual({ kind: "free" });
      expect(r.store.db.query("SELECT * FROM outside_sends").all()).toEqual([]);
    } finally { r.done(); }
  });

  test.skipIf(!PROC)("a terminal that opens the session while Keel's child runs a turn stops the sends that follow", async () => {
    const r = rig();
    const sleeper = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const s = await r.session();
      r.app().send(s.id, "wait here", "k1");
      await until(() => r.app().running(s.id), 15_000);
      expect(r.app().route(s.id)).toBe("steer");
      const start = statFields(readFileSync(`/proc/${sleeper.pid}/stat`, "utf8"))!.start;
      writeFileSync(join(r.config, "sessions", `${sleeper.pid}.json`), JSON.stringify({ pid: sleeper.pid, sessionId: r.id, procStart: start, kind: "interactive", entrypoint: "cli", status: "idle" }));
      expect(r.app().route(s.id)).toBe("held");
      expect(r.app().send(s.id, "and also this", "k2")).toMatchObject({ status: 409, holder: { kind: "terminal", pid: sleeper.pid } });
      await r.app().interrupt(s.id);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(r.log().filter((l) => l.in === "user").length).toBe(1);
      expect(r.app().holder(s.id)).toEqual({ kind: "terminal", pid: sleeper.pid });
    } finally { sleeper.kill(); r.done(); }
  }, 30_000);
});
