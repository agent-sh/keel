import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realOf } from "../core/paths.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { emptyUsage, type Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { Gate, landing, type ReviewAsk } from "./gate.ts";
import { gptTools } from "../tools/gpt.ts";
import { makeJudge } from "./judge.ts";
import { classify, decide, type Mode } from "./policy.ts";
import { vault } from "./secrets.ts";

const kind = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask-${d.ask.risk}`);

test("an edit through a link is judged where it lands", () => {
  const ws = mkdtempSync(join(tmpdir(), "keel-ws-"));
  const out = mkdtempSync(join(tmpdir(), "keel-out-"));
  mkdirSync(join(ws, ".git/hooks"), { recursive: true });
  writeFileSync(join(ws, "notes.txt"), "");
  symlinkSync(out, join(ws, "escape"));
  symlinkSync(join(out, "f.txt"), join(ws, "f.txt"));
  symlinkSync(join(ws, ".git/hooks/pre-commit"), join(ws, "hook.sh"));
  symlinkSync(join(ws, "notes.txt"), join(ws, ".envrc"));
  const judge = (path: string, mode: Mode = "auto-edits") =>
    kind(decide(landing(classify({ name: "Write", readOnly: false, kind: "edit" }, { file_path: path }, ws)), { mode, workspace: realOf(ws), sandboxed: false, rules: [], tool: "Write" }));
  expect(judge("src/a.ts")).toBe("allow"); // a new file under a folder that does not exist yet
  expect(judge("notes.txt")).toBe("allow");
  expect(judge("escape/x.txt")).toBe("ask-low"); // a folder link out of the workspace
  expect(judge("f.txt")).toBe("ask-low"); // a file link out of it
  expect(judge("hook.sh")).toBe("ask-high"); // a link into .git/hooks
  expect(judge(".envrc")).toBe("ask-high"); // a file the repository runs, whatever it points at
  expect(judge("escape/x.txt", "full-auto")).toBe("allow");
});

// A gate over a scratch store whose sessions count as sandboxed.
const scratchGate = () => {
  const g = new Gate(new Store(mkdtempSync(join(tmpdir(), "keel-gate-"))), new Bus(), () => true);
  const session = { id: "s1", workspace: mkdtempSync(join(tmpdir(), "keel-ws-")) } as Session;
  const call = (tool: Tool, input: any, signal = new AbortController().signal): ToolCall =>
    ({ id: crypto.randomUUID(), tool, input, ctx: { sessionId: "s1", cwd: session.workspace, signal, spillDir: session.workspace, seen: new Map() } });
  return { g, session, call };
};
const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };
const runCode: Tool = { ...bash, name: "run_code", kind: undefined, target: async (input) => ({ name: "run_code", readOnly: false, input, cls: { kind: "shell", command: "bun program.js", escalate: input?.sandbox_permissions === "require_escalated" || undefined } }) };

test("confinement follows the class the gate judged, not an input field", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "full-auto", sandbox: "workspace-write" });
  // A shell tool that offers no escalation runs confined whatever its input says.
  const plain = await g.beforeTool(session, call(bash, { command: "npm test", sandbox_permissions: "require_escalated" }));
  expect(plain && "ctx" in plain && typeof plain.ctx?.wrapSpawn).toBe("function");
  // A program that asks to leave the sandbox goes to the judge in full auto,
  // never to a card: with no judge to answer it is refused at once.
  const asked = await g.beforeTool(session, call(runCode, { code: "1", sandbox_permissions: "require_escalated" }));
  expect(g.approvals({ session: "s1", pending: true })).toEqual([]);
  expect(asked).toHaveProperty("deny");
  // The judge allows it: it runs outside the sandbox.
  g.judge = async () => ({ allow: true, risk: "high", reason: "the owner asked for it", model: "m" });
  expect(await g.beforeTool(session, call(runCode, { code: "1", sandbox_permissions: "require_escalated" }))).toBeUndefined();
});

test("Auto discards pending permission when policy or cwd changes and does not transfer a retry", async () => {
  const { g, session, call } = scratchGate();
  g.setSandboxCheck(() => false);
  g.setPerm(session.id, { mode: "auto", sandbox: "off" });
  const a = mkdtempSync(join(session.workspace, "first-"));
  const b = mkdtempSync(join(session.workspace, "second-"));
  let cwd = a;
  const tool: Tool = { ...bash, cwdOf: () => cwd, autoShell: ({ command }) => ({ command, interpreter: "bash -c" }) };
  const command = "printf marker > scratch.txt";
  const run = () => g.check(session, call(tool, { command }));
  const pending = async (alter: () => void) => {
    cwd = a;
    const sent = Promise.withResolvers<string | undefined>();
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof g.judge>>>();
    g.judge = (r) => { sent.resolve(r.cwd); return reply.promise; };
    const checked = run();
    expect(await sent.promise).toBe(realOf(a));
    alter();
    reply.resolve({ allow: true, risk: "low", reason: "fixture", model: "m" });
    expect(await checked).toHaveProperty("deny");
  };
  await pending(() => {
    g.setPerm(session.id, { mode: "read-only" });
    g.setPerm(session.id, { mode: "auto" });
  });
  await pending(() => { cwd = b; });
  expect(g.approvals()).toEqual([]);

  cwd = a;
  g.judge = async () => ({ allow: false, risk: "low", reason: "fixture", model: "m" });
  expect(await run()).toHaveProperty("deny");
  g.allowRetry(session.id, g.blocked(session.id)[0]!.id);
  cwd = b;
  expect(await run()).toHaveProperty("deny");
  cwd = a;
  expect(await run()).toHaveProperty("cls");
});

test("Auto sends the whole supported invocation, not a clipped or different command", async () => {
  const { g, session, call } = scratchGate();
  g.setSandboxCheck(() => false);
  g.setPerm(session.id, { mode: "auto", sandbox: "off" });
  const exec = gptTools.find((t) => t.name === "exec_command")!;
  const requests: ReviewAsk[] = [];
  g.judge = async (a) => (requests.push(a), { allow: true, risk: "low", reason: "fixture", model: "m" });
  const cmd = "printf marker > scratch.txt";
  const allowed = { cmd, shell: "bash", login: false };
  for (const input of [ { cmd }, { cmd: "pwd", shell: "bash", login: true }, { ...allowed, shell: "sh" },
    { ...allowed, login: true, sandbox_permissions: "require_escalated" },
    { ...allowed, cmd: `printf '${"x".repeat(4000)}' > scratch.txt` }, { ...allowed, description: "x".repeat(2001) } ]) {
    expect(await g.check(session, call(exec, input))).toHaveProperty("deny");
  }
  const placeholder = "[value of " + "$FIXTURE_KEY]";
  const secret = await g.check(session, call(exec, { ...allowed, cmd: `printf '%s' '${placeholder}'` }));
  expect("deny" in secret ? secret.deny : "").toContain("requires secret substitution");
  expect(requests).toEqual([]);
  expect(await g.check(session, call(exec, allowed))).toHaveProperty("cls");
  expect(requests).toMatchObject([{ summary: cmd, interpreter: "bash -c", input: { shell: "bash", login: false } }]);
  expect(g.approvals()).toEqual([]);
});

test("Auto escalation shows and stays bound to the resolved invocation", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm(session.id, { mode: "auto", sandbox: "workspace-write" });
  const exec = gptTools.find((t) => t.name === "exec_command")!;
  const initial = mkdtempSync(join(session.workspace, "first-"));
  const later = mkdtempSync(join(session.workspace, "second-"));
  const link = join(session.workspace, "starting-dir");
  symlinkSync(initial, link);
  const pending = g.check(session, call(exec, { cmd: "pwd", shell: "bash", login: false, workdir: link, sandbox_permissions: "require_escalated" }));
  const [a] = g.approvals({ pending: true });
  expect(a?.summary).toBe(`pwd\n\nStarting directory: ${realOf(initial)}\nInterpreter: bash -c`);
  unlinkSync(link);
  symlinkSync(later, link);
  expect(g.resolve(a!.id, session.id, { choice: "once" })).toEqual({ ok: true });
  expect(await pending).toHaveProperty("deny");
});

test("Auto judge evidence is redacted without granting secrets to the reviewed session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-judge-"));
  const store = new Store(dir);
  const session = store.createSession({ workspace: dir, model: "fixture:m" });
  const other = store.createSession({ workspace: dir, model: "fixture:m" });
  const fixture = `inert-context-${crypto.randomUUID()}`;
  const entry = vault.add(fixture, "fixture", "output", other.id, "FIXTURE_CONTEXT_KEY");
  let sent = "";
  const providers = { resolve: async () => ({
    info: { name: "fixture", id: "fixture:m", model: "m", output: 100, efforts: [] },
    provider: { stream: async (req: any) => {
      sent = JSON.stringify([req.system, req.messages]);
      return { blocks: [{ type: "text", text: '{"decision":"deny","risk":"low","reason":"fixture"}' }], usage: emptyUsage() };
    } },
  }) } as any;
  try {
    const judge = makeJudge(store, providers, () => session.model, () => `Fixture policy ${fixture}`);
    await judge({ session, tool: "fixture", kind: "other", summary: "inert note", input: {}, mode: "auto", high: { why: "fixture", facts: `Fixture context ${fixture}` } });
    expect(sent).toContain(vault.placeholder(entry));
    expect(sent).not.toContain(fixture);
    expect(vault.list(session.id)).toEqual([]);
  } finally {
    vault.forget(entry.id);
  }
});

test("Auto does not reuse a parked approval or let it create a standing grant", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-gate-")));
  const g = new Gate(store, new Bus());
  const session = store.createSession({ workspace: store.stateDir, model: "fixture:m" });
  const stop = new AbortController();
  const call: ToolCall = {
    id: "parked", tool: bash, input: { command: "printf marker > scratch.txt" },
    ctx: { sessionId: session.id, cwd: session.workspace, signal: stop.signal, spillDir: session.workspace, seen: new Map() },
  };
  g.setPerm(session.id, { mode: "ask", sandbox: "off" });
  const checking = g.check(session, call);
  const [a] = g.approvals({ pending: true });
  g.park(session.id);
  stop.abort();
  await checking;
  g.setPerm(session.id, { mode: "auto" });
  expect(g.resolve(a!.id, session.id, { choice: "always" })).toHaveProperty("status", 409);
  expect(g.rules()).toEqual([]);
  const resumed = await g.check(session, { ...call, ctx: { ...call.ctx, signal: new AbortController().signal } });
  expect("deny" in resumed ? resumed.deny : "").toContain("Check the prior outcome");
});

test("full auto: a refused call is refused again without review, and a run of refusals stops the judging", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "full-auto", sandbox: "off" });
  let asked = 0;
  g.judge = async () => (asked++, { allow: false, risk: "high", reason: "it rewrites the default branch", model: "m" });
  const run = (command: string) => g.beforeTool(session, call(bash, { command }));
  const first = await run("git push -f origin main");
  expect(first && "deny" in first && first.deny).toContain("rewrites the default branch");
  const again = await run("git push -f origin main");
  expect(again && "deny" in again && again.deny).toContain("already refused");
  expect(asked).toBe(1);
  expect(g.blocked("s1")).toHaveLength(1);
  expect(g.blocked("s1")[0]!.count).toBe(2);
  // Two refusals in a row so far; one more reviewed refusal, then no more reviews this turn.
  await run("sudo systemctl stop x");
  const streak = await run("sudo reboot");
  expect(streak && "deny" in streak && streak.deny).toContain("in a row");
  expect(asked).toBe(2);
  // A new turn reviews again; the owner's one retry lets exactly that call through.
  g.turnStarted("s1");
  const b = g.blocked("s1").find((x) => x.summary === "git push -f origin main")!;
  g.allowRetry("s1", b.id);
  expect(await run("git push -f origin main")).toBeUndefined();
  expect(g.approvals({ session: "s1" })).toEqual([]);
});

test("open cards are read whole and in one order, however much history there is", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-gate-")));
  const g = new Gate(store, new Bus());
  const row = (id: string, session: string, state: string, created: number) =>
    store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?)").run(id, session, state, JSON.stringify({ id, session_id: session, state, created }), created);
  row("b", "child", "pending", 5); // same millisecond, inserted first
  row("a", "child", "pending", 5);
  for (let i = 0; i < 500; i++) row(`old${i}`, "other", "allowed", 10 + i);
  const ids = (l: { id: string }[]) => l.map((x) => x.id);
  expect(ids(g.approvals({ pending: true }))).toEqual(["a", "b"]);
  expect(ids(g.approvals({ session: "child", pending: true }))).toEqual(["a", "b"]);
  expect(g.approvals().length).toBe(500); // the history stays bounded
});

test("one retry the owner lets through is spent once; its blocked id never grants again", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "reviewer", sandbox: "off" });
  let judged = 0;
  g.judge = async () => (judged++, { allow: false, risk: "low", reason: "not needed", model: "m" }) as any;
  const run = async () => {
    const r = await g.beforeTool(session, call(bash, { command: "npm install left-pad" }));
    return r && "deny" in r ? "deny" : "allow";
  };
  expect(await run()).toBe("deny");
  const id = g.blocked("s1")[0]!.id;
  g.allowRetry("s1", id);
  g.allowRetry("s1", id); // a double click before it is used: still one retry
  expect(await run()).toBe("allow");
  expect(await run()).toBe("deny");
  g.allowRetry("s1", id); // the old id again, after its retry was used
  expect(await run()).toBe("deny");
  expect(judged).toBe(3);
});

test("an answered card takes its abort listener off the turn's shared signal", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "ask", sandbox: "off" });
  const stop = new AbortController();
  let live = 0;
  const add = stop.signal.addEventListener.bind(stop.signal), remove = stop.signal.removeEventListener.bind(stop.signal);
  stop.signal.addEventListener = ((t: string, f: any, o?: any) => (t === "abort" && live++, add(t, f, o))) as any;
  stop.signal.removeEventListener = ((t: string, f: any, o?: any) => (t === "abort" && live--, remove(t, f, o))) as any;
  for (const choice of ["once", "deny", "once"]) {
    const asked = g.beforeTool(session, call(bash, { command: "npm install left-pad" }, stop.signal));
    await Bun.sleep(5);
    const [card] = g.approvals({ session: "s1", pending: true });
    g.resolve(card!.id, "s1", { choice } as any);
    await asked;
    expect(live).toBe(0);
  }
});
