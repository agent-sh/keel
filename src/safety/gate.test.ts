import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realOf } from "../core/paths.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { emptyUsage, type Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { Gate, landing, type Approval, type ReviewAsk } from "./gate.ts";
import { gptTools } from "../tools/gpt.ts";
import { makeJudge } from "./judge.ts";
import { classify, decide, type Mode } from "./policy.ts";
import { vault } from "./secrets.ts";
import { scopes } from "./write-scope.ts";

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

test("a version query is a read where the program on the PATH is itself, and not where it is a shim", async () => {
  const { g, session, call } = scratchGate();
  g.setSandboxCheck(() => false);
  g.setPerm(session.id, { mode: "read-only", sandbox: "off" });
  const bin = mkdtempSync(join(tmpdir(), "keel-bin-"));
  const shim = mkdtempSync(join(tmpdir(), "keel-shim-"));
  writeFileSync(join(bin, "node"), "\x7fELF", { mode: 0o755 });
  writeFileSync(join(shim, "volta-shim"), "\x7fELF", { mode: 0o755 });
  symlinkSync(join(shim, "volta-shim"), join(shim, "node"));
  const before = { PATH: process.env.PATH, HOME: process.env.HOME };
  try {
    process.env.HOME = mkdtempSync(join(tmpdir(), "keel-home-"));
    process.env.PATH = bin;
    expect(await g.check(session, call(bash, { command: "node --version" }))).not.toHaveProperty("deny");
    // The writing forms of the same program are refused as ever.
    expect(await g.check(session, call(bash, { command: "node x.js" }))).toHaveProperty("deny");
    process.env.PATH = `${shim}:${bin}`;
    expect(await g.check(session, call(bash, { command: "node --version" }))).toHaveProperty("deny");
    // A session on another machine runs its commands there: what this machine holds says nothing.
    process.env.PATH = bin;
    expect(await g.check({ ...session, machine: "m1" } as Session, call(bash, { command: "node --version" }))).toHaveProperty("deny");
  } finally { Object.assign(process.env, before); }
});

test("confinement follows the class the gate judged, not an input field", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "full-auto", sandbox: "workspace-write" });
  // A shell tool that offers no escalation runs confined whatever its input says.
  const plain = await g.beforeTool(session, call(bash, { command: "npm test", sandbox_permissions: "require_escalated" }));
  expect(plain && "ctx" in plain && typeof plain.ctx?.wrapSpawn).toBe("function");
  // A program that asks to leave the sandbox runs outside it in full auto,
  // which checks nothing: no card, no judge.
  let judged = 0;
  g.judge = async () => (judged++, { allow: false, risk: "high", reason: "never asked", model: "m" });
  expect(await g.beforeTool(session, call(runCode, { code: "1", sandbox_permissions: "require_escalated" }))).toBeUndefined();
  expect([g.approvals({ session: "s1", pending: true }), judged]).toEqual([[], 0]);
});

test("Claude Code's Bash asks to leave the sandbox with its own parameter, and gets the same card", async () => {
  const { g, session, call } = scratchGate();
  const claudeBash: Tool = { ...bash, input_schema: { type: "object", properties: { command: {}, dangerouslyDisableSandbox: {} } } };
  g.setPerm("s1", { mode: "auto-edits", sandbox: "workspace-write" });
  // Without the parameter the command is confined.
  const plain = await g.beforeTool(session, call(claudeBash, { command: "git status" }));
  expect(plain && "ctx" in plain && typeof plain.ctx?.wrapSpawn).toBe("function");
  // With it the owner is asked, and nothing runs meanwhile.
  const stop = new AbortController();
  const asked = g.beforeTool(session, call(claudeBash, { command: "git gc", dangerouslyDisableSandbox: true }, stop.signal));
  await Bun.sleep(20);
  const cards = g.approvals({ session: "s1", pending: true });
  expect(cards.map((a) => [a.tool, a.risk, a.why])).toEqual([["Bash", "high", "the command asks to run outside the sandbox"]]);
  // Approved once: it runs with no confinement.
  expect(g.resolve(cards[0]!.id, "s1", { choice: "once", seen: "whole" })).toEqual({ ok: true });
  expect(await asked).toBeUndefined();
});

// The judge is sent the start of a long action. A command that asks to leave
// the sandbox with its write past that part would run unread.
test("full auto runs a long action unread, for both families' way out of the sandbox; Reviewer sends a long one to the owner", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "full-auto", sandbox: "workspace-write" });
  const read: string[] = [];
  g.judge = async (a) => (read.push(a.summary), { allow: true, risk: "high", reason: "it looks fine", model: "m" });
  const claudeBash: Tool = { ...bash, input_schema: { type: "object", properties: { command: {}, dangerouslyDisableSandbox: {} } } };
  const codexShell: Tool = { ...bash, name: "exec_command", input_schema: { type: "object", properties: { command: {}, sandbox_permissions: {} } } };
  const long = `echo ${"harmless ".repeat(500)}; echo owned > /etc/keel-outside`;
  expect(long.length).toBeGreaterThan(4000);
  for (const [tool, input] of [[claudeBash, { command: long, dangerouslyDisableSandbox: true }], [codexShell, { command: long, sandbox_permissions: "require_escalated" }]] as const) {
    expect(await g.beforeTool(session, call(tool, input))).toBeUndefined();
  }
  // (It stays in the sandbox and runs there: confined, not refused.)
  expect(await g.beforeTool(session, call(bash, { command: `git push --force origin main # ${"x".repeat(4000)}` }))).not.toHaveProperty("deny");
  expect(await g.beforeTool(session, call(claudeBash, { command: "git gc", dangerouslyDisableSandbox: true }))).toBeUndefined();
  // Full auto asks no judge, of a long action or a short one.
  expect(read).toEqual([]);

  // Reviewer mode: a low-risk action too long for the reviewer goes to the owner's card, unread by the reviewer.
  g.setPerm("s1", { mode: "reviewer", sandbox: "off" });
  read.length = 0;
  const stop = new AbortController();
  const asked = g.beforeTool(session, call(bash, { command: `./build.sh ${"--flag ".repeat(700)}` }, stop.signal));
  await Bun.sleep(20);
  expect([read, g.approvals({ session: "s1", pending: true }).map((a) => a.notice)]).toEqual([[], ["Too long for the reviewer to read whole. The owner answers this one."]]);
  stop.abort();
  await asked;
});

// A key the owner gave that looks like a word (eight letters or more) is still
// a secret to Auto: a call that holds it as a word is the owner's to approve,
// not the judge's to review. A shorter word, or one inside a longer word, is not.
test("Auto does not review a call that holds an ordinary value the owner gave as a whole word", async () => {
  const { g, session, call } = scratchGate();
  g.setSandboxCheck(() => false);
  g.setPerm(session.id, { mode: "auto", sandbox: "off" });
  const entry = vault.add("pinecones", "given secret", "card", session.id, undefined, { given: true });
  const tool: Tool = { ...bash, cwdOf: () => session.workspace, autoShell: ({ command }) => ({ command, interpreter: "bash -c" }) };
  const judged: string[] = [];
  g.judge = async (r) => { judged.push(r.summary); return { allow: true, risk: "low", reason: "fixture", model: "m" }; };
  try {
    const held = await g.check(session, call(tool, { command: "printf pinecones > a.txt" }));
    expect("deny" in held ? held.deny : "").toContain("Auto cannot review an action that contains a secret");
    expect(judged).toEqual([]);
    expect(await g.check(session, call(tool, { command: "printf pineconesx > a.txt" }))).not.toHaveProperty("deny");
    expect(judged.length).toBe(1);
  } finally {
    vault.forget(entry.id);
  }
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
  expect(g.resolve(a!.id, session.id, { choice: "once", seen: "whole" })).toEqual({ ok: true });
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
  expect(g.resolve(a!.id, session.id, { choice: "always", seen: "whole" })).toHaveProperty("status", 409);
  expect(g.rules()).toEqual([]);
  const resumed = await g.check(session, { ...call, ctx: { ...call.ctx, signal: new AbortController().signal } });
  expect("deny" in resumed ? resumed.deny : "").toContain("Check the prior outcome");
});

// A card whose turn was just parked for a stop is the next daemon's to
// answer: taken by the daemon on its way out, the answer would be lost (the
// card would read allowed and the call would never run). A card of a call a
// program made closes at the park instead: the program is gone with the daemon.
test("a parked card takes no answer until the next daemon; a program's card closes at the park", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-gate-")));
  const g = new Gate(store, new Bus());
  const session = store.createSession({ workspace: store.stateDir, model: "fixture:m" });
  g.setPerm(session.id, { mode: "ask", sandbox: "off" });
  const stop = new AbortController();
  const ctx = { sessionId: session.id, cwd: session.workspace, signal: stop.signal, spillDir: session.workspace, seen: new Map() };
  const own = g.check(session, { id: "own", tool: bash, input: { command: "printf a > a.txt" }, ctx });
  const inner = g.check(session, { id: "inner", tool: bash, input: { command: "printf b > b.txt" }, ctx: { ...ctx, nestedIn: "program" } });
  await Bun.sleep(5);
  const cards = g.approvals({ pending: true });
  const card = cards.find((a) => a.call_id === "own")!, nested = cards.find((a) => a.call_id === "inner")!;
  expect(g.awaitsOwner(session.id, "own")).toBe(true);
  g.park(session.id);
  stop.abort();
  await Promise.all([own, inner]);
  // On its way out: neither an allow nor a denial is taken, and the card stays open.
  expect(g.resolve(card.id, session.id, { choice: "once", seen: "whole" })).toHaveProperty("status", 503);
  expect(g.resolve(card.id, session.id, { choice: "deny", reason: "not this one" })).toHaveProperty("status", 503);
  expect(g.approval(card.id)!.state).toBe("pending");
  expect(g.callOutcome(session.id, "own")).toBe("waiting");
  // The program's card is closed, and says why.
  expect(g.approval(nested.id)!.state).toBe("cancelled");
  expect(g.resolve(nested.id, session.id, { choice: "once", seen: "whole" })).toHaveProperty("status", 409);
  expect(g.callOutcome(session.id, "inner")).toBe("not_run");
  // The next daemon takes the answer.
  const next = new Gate(store, new Bus());
  expect(next.resolve(card.id, session.id, { choice: "deny", reason: "not this one" })).toEqual({ ok: true });
  expect(next.approval(card.id)).toMatchObject({ state: "denied", reason: "not this one" });
});

test("full auto runs a flagged call unreviewed, asks no judge, keeps no refusal, and says what ran", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "full-auto", sandbox: "off" });
  let asked = 0;
  g.judge = async () => (asked++, { allow: false, risk: "high", reason: "it rewrites the default branch", model: "m" });
  const said: { outcome: string; reason: string }[] = [];
  (g as unknown as { bus: { on(f: (x: any) => void): void } }).bus.on((x) => { if (x.t === "feature" && x.name === "judged") said.push({ outcome: x.data.outcome, reason: x.data.reason }); });
  const run = (command: string) => g.beforeTool(session, call(bash, { command }));
  for (const command of ["git push -f origin main", "git push -f origin main", "sudo systemctl stop x", "sudo reboot"]) expect([command, await run(command)]).toEqual([command, undefined]);
  expect([asked, g.blocked("s1"), g.approvals({ session: "s1" })]).toEqual([0, [], []]);
  expect(said.length).toBe(4);
  expect(said.every((x) => x.outcome === "unreviewed" && x.reason.length > 0)).toBe(true);
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

// The end of a turn that reaches the gate after the next turn began (a hook that awaited) closes
// nothing of the next turn: its card stays open and takes one answer.
test("a late end of turn N leaves the card of turn N+1 open and answerable once", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "ask", sandbox: "off" });
  // Turn N: a call waits on the owner, the turn is stopped.
  g.turnStarted("s1");
  const stopN = new AbortController();
  const askedN = g.beforeTool(session, call(bash, { command: "npm install left-pad" }, stopN.signal));
  await Bun.sleep(5);
  const [cardN] = g.approvals({ session: "s1", pending: true });
  stopN.abort();
  expect(await askedN).toHaveProperty("deny");
  expect(g.approvals({ session: "s1" }).find((a) => a.id === cardN!.id)?.state).toBe("cancelled");
  // Turn N+1 raises card B.
  g.turnStarted("s1");
  const askedB = g.beforeTool(session, call(bash, { command: "npm install right-pad" }, new AbortController().signal));
  await Bun.sleep(5);
  const [cardB] = g.approvals({ session: "s1", pending: true });
  expect(cardB?.summary).toContain("right-pad");
  // Turn N's end arrives now.
  g.turnEnded("s1");
  await Bun.sleep(5);
  expect(g.approvals({ session: "s1", pending: true }).map((a) => a.id)).toEqual([cardB!.id]);
  expect(g.resolve(cardB!.id, "s1", { choice: "once", seen: "whole" })).toEqual({ ok: true });
  expect(await askedB).toBeUndefined();
  // The second answer to the same card is refused.
  expect(g.resolve(cardB!.id, "s1", { choice: "once", seen: "whole" })).not.toEqual({ ok: true });
});

test("one answer for several cards covers none that must be read alone", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "ask", sandbox: "off" });
  const save: Tool = { ...bash, name: "notes__save", kind: undefined };
  const asked = [
    g.beforeTool(session, call(bash, { command: "npm install left-pad" })),
    g.beforeTool(session, call(bash, { command: "npm install right-pad" })),
    g.beforeTool(session, call(bash, { command: "sudo npm install -g left-pad" })),
    g.beforeTool(session, call(save, { text: "x".repeat(500) })),
    g.beforeTool(session, call(save, { text: "short" })),
  ];
  await Bun.sleep(5);
  const open = () => g.approvals({ session: "s1", pending: true });
  const find = (words: string) => open().find((a) => (a.kind === "shell" ? a.summary : JSON.stringify(a.input)).startsWith(words))!;
  const [left, right, root, long, short] = ["npm install left", "npm install right", "sudo", '{"text":"xxx', '{"text":"short'].map(find) as [Approval, Approval, Approval, Approval, Approval];
  expect([left.risk, right.risk, root.risk, long.risk, short.risk]).toEqual(["low", "low", "high", "low", "low"]);
  // A summary that is the start of a longer input says so; a whole one does not.
  expect([long.summary.length, long.cut, short.cut, left.cut]).toEqual([400, true, undefined, undefined]);

  // A list that names a high-risk card, or one shown in part, is refused whole: nothing is allowed.
  expect(g.resolveMany("s1", [left.id, root.id])).toMatchObject({ status: 400, alone: [root.id] });
  expect(g.resolveMany("s1", [left.id, long.id, right.id])).toMatchObject({ status: 400, alone: [long.id] });
  expect(open().length).toBe(5);
  // Each of those is still answered on its own.
  expect(g.resolve(root.id, "s1", { choice: "once", seen: "whole" })).toEqual({ ok: true });
  expect(g.resolve(long.id, "s1", { choice: "deny" })).toEqual({ ok: true });

  // The rest together, in the order given; one that is no longer open, or of another session, is passed over and said.
  const r = g.resolveMany("s1", [right.id, root.id, "no-such-card", left.id, right.id]);
  expect(r).toEqual({ results: [
    { id: right.id, ok: true },
    { id: root.id, error: expect.any(String), status: 409, state: "allowed" },
    { id: "no-such-card", error: "no such approval", status: 404, state: undefined },
    { id: left.id, ok: true },
  ] });
  expect(open().map((a) => a.id)).toEqual([short.id]);
  expect(g.approval(right.id)).toMatchObject({ state: "allowed", choice: "once" });

  // A card written before cards were marked has no flag: a summary exactly as long as the cut counts as cut.
  const old = { ...short, id: "written-before", call_id: "old-call", summary: "y".repeat(400), cut: undefined };
  (g as any).store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?)").run(old.id, "s1", "pending", JSON.stringify(old), old.created);
  expect(g.resolveMany("s1", [short.id, old.id])).toMatchObject({ status: 400, alone: [old.id] });
  expect(g.approval(short.id)!.state).toBe("pending");

  // Answering one of a list throws: the reply still says how each went, the ones before it stay
  // allowed, the ones after it are answered, and the failure is handed on to be recorded.
  const more = [g.beforeTool(session, call(bash, { command: "npm install is-odd" })), g.beforeTool(session, call(bash, { command: "npm install is-even" }))];
  await Bun.sleep(5);
  const [odd, even] = ["npm install is-odd", "npm install is-even"].map(find) as [Approval, Approval];
  const resolve = g.resolve.bind(g);
  g.resolve = (id, ...rest) => { if (id === even.id) throw new Error("the store would not take it"); return resolve(id, ...rest); };
  const recorded: string[] = [];
  expect(g.resolveMany("s1", [odd.id, even.id, short.id], (e, id) => recorded.push(`${id}: ${(e as Error).message}`))).toEqual({ results: [
    { id: odd.id, ok: true },
    { id: even.id, error: "the store would not take it", status: 500, state: "pending" },
    { id: short.id, ok: true },
  ] });
  expect(recorded).toEqual([`${even.id}: the store would not take it`]);
  g.resolve = resolve;
  g.resolve(even.id, "s1", { choice: "deny" });
  await Promise.all([...asked, ...more]);
});

// While the store takes no writes a card is still answered (the answer is owed to the store), but
// only for its one call or with a denial: an answer that would widen what the session may do from
// here on is never owed, so it is refused with the reason, and the card waits.
test("a card takes a one-time answer or a denial while the store takes no writes, and no standing one", async () => {
  const { g, session, call } = scratchGate();
  const store = (g as unknown as { store: Store }).store;
  g.setSandboxCheck(() => false);
  g.setPerm(session.id, { mode: "ask", sandbox: "off" });
  const pending = g.check(session, call(bash, { command: "touch made.txt" }));
  for (let n = 0; n < 200 && !g.approvals({ pending: true }).length; n++) await Bun.sleep(5);
  const [a] = g.approvals({ pending: true });
  store.db.exec("PRAGMA query_only = ON");
  store.refuse(true);
  for (const choice of ["always", "session"] as const) {
    const r = g.resolve(a!.id, session.id, { choice, rules: [{ kind: "shell", pattern: "touch *" }] });
    expect(r).toMatchObject({ status: 503 });
    expect("error" in r ? r.error : "").toContain("a standing answer cannot be kept: allow this once, or deny it");
  }
  expect([g.approvals({ pending: true }).length, g.rules().length, store.owes]).toEqual([1, 0, 0]);
  expect(g.resolve(a!.id, session.id, { choice: "once" })).toEqual({ ok: true });
  expect(await pending).not.toHaveProperty("deny");
  // The answer is owed, and made when the store takes writes again.
  expect(store.owes).toBe(1);
  store.db.exec("PRAGMA query_only = OFF");
  store.refuse(false);
  expect([store.owes, g.approval(a!.id)?.state]).toEqual([0, "allowed"]);
});

// The risk classes read what git says of a folder a command deletes (risk.ts): the gate asks git before it decides.
test("a delete inside the folder is high risk by what git cannot bring back there, and a card that waits is judged again with the same answer", async () => {
  const { g, session, call } = scratchGate();
  g.setSandboxCheck(() => false);
  const ws = session.workspace;
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: ws, stdout: "ignore", stderr: "ignore" });
  git("init", "-q");
  for (const f of ["build/gen.sh", "build/pack.sh", "kept/a.ts", "kept/b.ts", "out/a.o", "out/b.o", "fresh/one.ts", "fresh/two.ts", "single/only.ts", "lib/nested/.git/HEAD"]) { mkdirSync(join(ws, f, ".."), { recursive: true }); writeFileSync(join(ws, f), "x\n"); }
  writeFileSync(join(ws, ".gitignore"), "out/\n");
  git("add", "build", "kept", ".gitignore");
  git("commit", "-q", "-m", "first");
  // Two committed files changed since: git has the old ones only.
  for (const f of ["build/gen.sh", "build/pack.sh"]) writeFileSync(join(ws, f), "changed\n");
  expect(existsSync(join(ws, ".git"))).toBe(true);
  g.setPerm("s1", { mode: "ask", sandbox: "off" });
  const open = () => g.approvals({ session: "s1", pending: true });
  const card = async (command: string) => {
    const asked = g.beforeTool(session, call(bash, { command }));
    for (let i = 0; i < 100 && !open().length; i++) await Bun.sleep(10);
    const [a] = open();
    return { a: a!, asked };
  };
  const answer = async (c: Awaited<ReturnType<typeof card>>) => { g.resolve(c.a.id, "s1", { choice: "deny" }); await c.asked; };
  // A file git was told not to look at (assume-unchanged, skip-worktree) and that changed since: git lists
  // nothing under its folder, and cannot bring the change back.
  for (const [dir, flag] of [["quiet", "--assume-unchanged"], ["skipped", "--skip-worktree"]] as const) {
    mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, dir, "a.ts"), "x\n");
    git("add", dir);
    git("commit", "-q", "-m", dir);
    git("update-index", flag, `${dir}/a.ts`);
    writeFileSync(join(ws, dir, "a.ts"), "changed\n");
  }
  // A folder git ignores is build output, and one whose every file is committed and unchanged comes back from
  // git; changed files, new ones nobody has added yet and a repository of its own do not.
  const lost = "destroys work or data";
  for (const [command, risk, rule] of [["rm -rf out", "low", undefined], ["rm -rf kept", "low", undefined], ["rm -rf quiet", "high", lost], ["rm -rf skipped", "high", lost], ["rm -rf build", "high", lost], ["rm -rf fresh", "high", lost], ["rm -rf single", "high", lost], ["rm -rf lib/nested", "high", lost],
    ["find . -name '*.sh' -delete", "high", lost], ["find . -name '*.o' -delete", "low", undefined], ["find . -name '*.ts' -delete", "high", lost]] as const) {
    const c = await card(command);
    expect([command, c.a.risk, c.a.rule]).toEqual([command, risk, rule]);
    await answer(c);
  }
  // The card for the changed folder stays the owner's when a grant that names rm arrives, though its name alone reads as build output.
  const held = await card("rm -rf build");
  const other = g.beforeTool(session, call(bash, { command: "rm stale.txt" }));
  for (let i = 0; i < 100 && open().length < 2; i++) await Bun.sleep(10);
  const low = open().find((a) => a.summary === "rm stale.txt")!;
  expect([low.risk, low.suggest]).toEqual(["low", [{ kind: "shell", pattern: "rm *" }]]);
  g.resolve(low.id, "s1", { choice: "session" });
  await other;
  expect(open().map((a) => a.id)).toEqual([held.a.id]);
  await answer(held);
  // Full auto: everything runs, the high-risk lines too, and no judge is asked.
  let judged: string[] = [];
  g.judge = async (r) => (judged.push(r.summary), { allow: true, risk: "high", reason: "fixture", model: "m" });
  g.setPerm("s1", { mode: "full-auto", sandbox: "off" });
  // (The changed files are put back first: a reset over them is not the rules' to settle, and with them back the folder is git's to bring back.)
  git("checkout", "--", "build");
  for (const command of ["rm -rf out", "git reset --hard", "rm -rf build", "rm -rf fresh", "git reset --hard && npm publish"]) expect([command, await g.beforeTool(session, call(bash, { command }))]).toEqual([command, undefined]);
  // (Full auto checks nothing: no judge is asked.)
  expect(judged).toEqual([]);
});

// A web fetch takes a method and a body: a session with no network reaches the web through no tool of the daemon's.
test("a session whose network is off gets no web tool, however it is called", async () => {
  const { g, session, call } = scratchGate();
  const tool = (name: string): Tool => ({ name, readOnly: true, description: "", input_schema: { type: "object", properties: {} }, run: async () => ({ content: "" }) });
  const asks: [string, any][] = [
    ["WebFetch", { url: "https://example.com", method: "POST", body: "x" }], ["WebSearch", { query: "q" }], ["web_fetch", { url: "https://example.com" }],
    ["google_web_search", { query: "q" }], ["mcp_call", { tool: "web__webfetch", arguments: { url: "https://example.com" } }],
    ["mcp__web__websearch", { query: "q" }], ["AskReaders", { question: "q", urls: ["https://example.com"] }],
  ];
  g.setPerm(session.id, { mode: "read-only", sandbox: "read-only", network: false });
  for (const [name, input] of asks) expect([name, ((await g.beforeTool(session, call(tool(name), input))) as any)?.deny ?? ""]).toEqual([name, expect.stringContaining("no network")]);
  // Readers over local files, and the same tools with the network on, are the gate's ordinary judgment.
  expect(((await g.beforeTool(session, call(tool("AskReaders"), { question: "q", paths: ["a.txt"] }))) as any)?.deny ?? "").not.toContain("no network");
  g.setPerm(session.id, { mode: "read-only", sandbox: "read-only", network: true });
  for (const [name, input] of asks) expect([name, ((await g.beforeTool(session, call(tool(name), input))) as any)?.deny ?? ""]).toEqual([name, expect.not.stringContaining("no network")]);
});

test("what a session's Read would get without asking: a file of its folder here, nothing here when its files are on another machine", () => {
  const { g, session } = scratchGate();
  g.setPerm(session.id, { mode: "ask", sandbox: "off" });
  const file = join(session.workspace, "run.log");
  writeFileSync(file, "x\n");
  expect(g.readable(session, file)).toBe(true);
  // (Its tools run on another machine: a file at that path here is not its file.)
  expect(g.readable({ ...session, machine: "box-b" } as Session, file)).toBe(false);
});

// A session tree over a scratch store, as agents.ts makes one: each agent's session names its parent.
const treeGate = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-gate-tree-")));
  store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const g = new Gate(store, new Bus());
  g.setSandboxCheck(() => false);
  const ws = mkdtempSync(join(tmpdir(), "keel-ws-"));
  const make = (title: string, parent?: Session) => {
    const s = store.createSession({ workspace: ws, model: "fixture:m", title });
    if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    return s;
  };
  const call = (s: Session, command: string): ToolCall =>
    ({ id: crypto.randomUUID(), tool: bash, input: { command }, ctx: { sessionId: s.id, cwd: ws, signal: new AbortController().signal, spillDir: ws, seen: new Map() } });
  const opened = async (s: Session) => {
    for (let n = 0; n < 200 && !g.approvals({ session: s.id, pending: true }).length; n++) await Bun.sleep(5);
    return g.approvals({ session: s.id, pending: true })[0]!;
  };
  return { store, g, ws, make, call, opened };
};

// RSH-M20: a parent's permission change reaches its agent tree. A tighter one caps every agent below it at once,
// live or ended, and judges their open cards again; a looser one reaches the agents that follow their parent,
// never past the mode a definition asks for, and never one whose settings were set on it.
test("a parent's tighter change caps its whole agent tree, and a looser one reaches only the agents that follow it", async () => {
  const { g, make, call, opened } = treeGate();
  const root = make("root"), child = make("child", root), grand = make("grand", child), planner = make("planner", root), own = make("own", root);
  g.setPerm(root.id, { mode: "ask", sandbox: "off", network: true });
  const inherit = (s: Session, parent: Session, mode: Mode, want?: string) => g.setPerm(s.id, { mode, sandbox: g.perm(parent.id).sandbox, network: g.perm(parent.id).network }, { follows: true, ...(want ? { want } : {}) });
  inherit(child, root, "ask");
  inherit(grand, child, "ask");
  inherit(planner, root, "plan", "plan");
  g.setPerm(own.id, { mode: "ask", sandbox: "read-only", network: true }); // a session set on its own, as a review's
  const mode = (s: Session) => g.perm(s.id).mode;
  // The grandchild asks; the root moves to read-only: the card is judged again and refused, and every agent below is capped.
  const asking = g.check(grand, call(grand, "touch made.txt"));
  const card = await opened(grand);
  g.setPerm(root.id, { mode: "read-only" });
  expect(await asking).toHaveProperty("deny");
  expect(g.approval(card.id)!.state).toBe("denied");
  expect([mode(child), mode(grand), mode(planner), mode(own)]).toEqual(["read-only", "read-only", "plan", "read-only"]);
  // The sandbox on and the network off reach every agent too; a tighter sandbox of an agent's own stays.
  g.setPerm(root.id, { sandbox: "workspace-write", network: false });
  expect([child, grand, planner, own].map((s) => [g.perm(s.id).sandbox, g.perm(s.id).network])).toEqual([["workspace-write", false], ["workspace-write", false], ["workspace-write", false], ["read-only", false]]);
  // Looser: the agents that follow take the mode, the planner keeps its definition's plan, the one set on its own
  // stays capped. The sandbox off and the network on reach no agent through the tree (the sandbox is the backstop
  // of a write scope): only the owner's change on the agent itself loosens them.
  g.setPerm(root.id, { mode: "auto", sandbox: "off", network: true });
  expect([mode(child), mode(grand), mode(planner), mode(own)]).toEqual(["auto", "auto", "plan", "read-only"]);
  expect([child, grand, planner, own].map((s) => [g.perm(s.id).sandbox, g.perm(s.id).network])).toEqual([["workspace-write", false], ["workspace-write", false], ["workspace-write", false], ["read-only", false]]);
  // The owner sets the child itself: from then on its settings are its own, and the grandchild follows the child.
  g.setPerm(child.id, { mode: "ask" });
  expect(mode(grand)).toBe("ask");
  g.setPerm(root.id, { mode: "full-auto" });
  expect([mode(child), mode(grand)]).toEqual(["ask", "ask"]);
  // Its tie is carried as written (a successor takes its predecessor's).
  expect([g.tieOf(planner.id), g.tieOf(child.id), g.tieOf(grand.id)]).toEqual([{ follows: true, want: "plan" }, { follows: false }, { follows: true }]);
  // The owner's change on an agent itself still loosens its sandbox and network.
  g.setPerm(grand.id, { sandbox: "off", network: true });
  expect([g.perm(grand.id).sandbox, g.perm(grand.id).network]).toEqual(["off", true]);
});

// RSH-S48: a grant "for this session" covers the session's whole agent tree (Claude Code's sub-agents doc: such a
// choice on a subagent's prompt applies to the whole session). A grant on the root covers its agents and theirs,
// one answered on an agent covers the root and its siblings, a session of another tree still asks, and a grant
// never widens an agent's write scope.
test("a grant for this session covers the session's whole agent tree, and no other", async () => {
  const { g, make, call, opened } = treeGate();
  const root = make("root"), child = make("child", root), sibling = make("sibling", root), grand = make("grand", child), other = make("other");
  for (const s of [root, child, sibling, grand, other]) g.setPerm(s.id, { mode: "ask", sandbox: "off", network: true });
  const grantOn = async (s: Session, command: string, pattern: string) => {
    const asking = g.check(s, call(s, command));
    const card = await opened(s);
    expect(g.resolve(card.id, s.id, { choice: "session", rules: [{ kind: "shell", pattern }] })).toEqual({ ok: true });
    expect(await asking).not.toHaveProperty("deny");
  };
  // Runs without a card: the check settles at once.
  const unasked = async (s: Session, command: string) => {
    const r = await Promise.race([g.check(s, call(s, command)), Bun.sleep(300).then(() => "asked" as const)]);
    return r !== "asked" && !("deny" in r);
  };
  await grantOn(root, "touch a.txt", "touch *");
  expect([await unasked(child, "touch b.txt"), await unasked(grand, "touch c.txt"), await unasked(sibling, "touch d.txt")]).toEqual([true, true, true]);
  await grantOn(child, "mkdir one", "mkdir *");
  expect([await unasked(root, "mkdir two"), await unasked(sibling, "mkdir three"), await unasked(grand, "mkdir four")]).toEqual([true, true, true]);
  // Another tree asks for both.
  for (const command of ["touch e.txt", "mkdir five"]) {
    const asking = g.check(other, call(other, command));
    const card = await opened(other);
    expect(g.resolve(card.id, other.id, { choice: "deny", reason: "not here" })).toEqual({ ok: true });
    expect(await asking).toHaveProperty("deny");
  }
  // An agent given a write scope is refused a write outside it, whatever the root granted.
  const before = { of: scopes.of, ask: scopes.ask };
  try {
    scopes.of = (id) => (id === grand.id ? { places: [{ path: join(mkdtempSync(join(tmpdir(), "keel-scope-")), "mine") }] } : undefined);
    scopes.ask = (_id, paths) => `Refused: ${paths.join(", ")} is outside the paths this agent may write.`;
    const r = await g.check(grand, call(grand, "touch /var/lib/keel-scope-probe/x.txt"));
    expect("deny" in r ? r.deny : "").toContain("outside the paths this agent may write");
  } finally { Object.assign(scopes, before); }
});

// A session's grants go with it: a grant for this session stays in perm_rules no longer than its session (a later
// test, or another session of the same tree, must not find it), and rows a delete left before are dropped at start.
test("a deleted session's grants are deleted with it", async () => {
  const { store, g, make, call, opened } = treeGate();
  const root = make("root"), child = make("child", root);
  for (const s of [root, child]) g.setPerm(s.id, { mode: "ask", sandbox: "off", network: true });
  const asking = g.check(child, call(child, "touch a.txt"));
  const card = await opened(child);
  expect(g.resolve(card.id, child.id, { choice: "session", rules: [{ kind: "shell", pattern: "touch *" }] })).toEqual({ ok: true });
  await asking;
  expect(g.rules().filter((r) => r.session_id === child.id)).toHaveLength(1);
  store.deleteSession(child.id);
  expect(g.rules().filter((r) => r.session_id === child.id)).toHaveLength(0);
  // A row left by a delete from before the trigger: gone at the start that makes it.
  store.db.query("DROP TRIGGER perm_gone").run();
  store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created) VALUES ('left', 'shell', 'touch *', '/', 'session', 'gone-session', 0)").run();
  new Gate(store, new Bus());
  expect(g.rules().map((r) => r.id)).not.toContain("left");
});

// A deleted session's settings go with it as its grants do, and the Undo of a revoke made before the delete
// does not make its grant again. A store with the first trigger (grants only) gets the one that covers both.
test("a deleted session's settings go with it, and an undo of its revoked grant makes nothing", async () => {
  const { store, g, make, call, opened } = treeGate();
  const root = make("root"), child = make("child", root);
  for (const s of [root, child]) g.setPerm(s.id, { mode: "ask", sandbox: "off", network: true });
  const asking = g.check(child, call(child, "touch a.txt"));
  const card = await opened(child);
  expect(g.resolve(card.id, child.id, { choice: "session", rules: [{ kind: "shell", pattern: "touch *" }] })).toEqual({ ok: true });
  await asking;
  const grant = g.rules().find((r) => r.session_id === child.id)!;
  expect(g.revoke(grant.id)).toBe(true);
  const settings = () => store.db.query<{ session_id: string }, []>("SELECT session_id FROM perm_sessions").all().map((r) => r.session_id).sort();
  expect(settings()).toEqual([root.id, child.id].sort());
  store.deleteSession(child.id);
  expect(settings()).toEqual([root.id]);
  expect(g.restore(grant.id)).toBe("gone");
  expect(g.rules().filter((r) => r.session_id === child.id)).toEqual([]);
  // A store of the first trigger, with settings a delete left: they go at the start that makes the new one.
  store.db.query("DROP TRIGGER perm_gone").run();
  store.db.query("CREATE TRIGGER perm_rules_gone AFTER DELETE ON sessions BEGIN DELETE FROM perm_rules WHERE session_id = old.id; END").run();
  store.db.query("INSERT INTO perm_sessions (session_id, mode) VALUES ('gone-session', 'ask')").run();
  new Gate(store, new Bus());
  expect(settings()).toEqual([root.id]);
  const triggers = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'perm%'").all().map((r) => r.name);
  expect(triggers).toEqual(["perm_gone"]);
});

// A store whose start stopped between the two columns of an agent's tie (follows added, want not) takes the
// other at the next start, and settings are written again.
test("the columns of an agent's tie are added each on its own", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-gate-tie-")));
  store.migrate("CREATE TABLE perm_sessions (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, sandbox TEXT NOT NULL DEFAULT 'off', network INTEGER NOT NULL DEFAULT 1, follows INTEGER NOT NULL DEFAULT 0)");
  const g = new Gate(store, new Bus());
  const s = store.createSession({ workspace: mkdtempSync(join(tmpdir(), "keel-ws-")), model: "fixture:m", title: "t" });
  expect(g.setPerm(s.id, { mode: "ask" }, { follows: true, want: "plan" }).mode).toBe("ask");
  expect(g.tieOf(s.id)).toEqual({ follows: true, want: "plan" });
});

// A session's sandbox /tmp is a folder under its own spill folder, which goes with the session.
test("each session's sandbox temp folder is under its spill folder", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-gate-")));
  const g = new Gate(store, new Bus(), () => true);
  const a = store.createSession({ workspace: store.stateDir, model: "fixture:m" });
  const b = store.createSession({ workspace: store.stateDir, model: "fixture:m" });
  const at = (s: Session) => g.readOpts(s, "workspace-write").tmp;
  expect(at(a)).toBe(join(store.stateDir, "spill", a.id, "tmp"));
  expect(at(b)).toBe(join(store.stateDir, "spill", b.id, "tmp"));
  expect(existsSync(at(a)!)).toBe(true);
  // A session on another machine has no sandbox of this one's: nothing is made for it.
  expect(g.readOpts({ ...a, machine: "desk" } as Session, "workspace-write").tmp).toBeUndefined();
});

test("the cards of one reply list in the order the model wrote the calls, whichever check ends first", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm(session.id, { mode: "ask", sandbox: "off", network: true });
  // The first call's check is the slow one: its card opens after the second's.
  g.requestHook = async (_s, c) => { if ((c.input as any).command === "touch a.txt") await Bun.sleep(80); };
  const at = (command: string, index: number): ToolCall => { const c = call(bash, { command }); c.ctx.reply = { seq: 7, index }; return c; };
  const a = at("touch a.txt", 0), b = at("touch b.txt", 1);
  const checks = [g.check(session, a), g.check(session, b)];
  for (let i = 0; i < 200 && g.approvals({ session: session.id, pending: true }).length < 2; i++) await Bun.sleep(10);
  const listed = g.approvals({ session: session.id, pending: true });
  expect(listed.map((x) => x.call_id)).toEqual([a.id, b.id]);
  // Opened the other way round, as the timing made it.
  expect(listed[0]!.created).toBeGreaterThan(listed[1]!.created);
  // The same order for the list across sessions.
  expect(g.approvals({ pending: true }).map((x) => x.call_id)).toEqual([a.id, b.id]);
  for (const x of listed) g.resolve(x.id, session.id, { choice: "deny" });
  await Promise.all(checks);
});
