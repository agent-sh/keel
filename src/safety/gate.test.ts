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
import { Gate, landing, type Approval, type ReviewAsk } from "./gate.ts";
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
  expect(g.resolve(cards[0]!.id, "s1", { choice: "once" })).toEqual({ ok: true });
  expect(await asked).toBeUndefined();
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
  expect(g.resolve(card.id, session.id, { choice: "once" })).toHaveProperty("status", 503);
  expect(g.resolve(card.id, session.id, { choice: "deny", reason: "not this one" })).toHaveProperty("status", 503);
  expect(g.approval(card.id)!.state).toBe("pending");
  expect(g.callOutcome(session.id, "own")).toBe("waiting");
  // The program's card is closed, and says why.
  expect(g.approval(nested.id)!.state).toBe("cancelled");
  expect(g.resolve(nested.id, session.id, { choice: "once" })).toHaveProperty("status", 409);
  expect(g.callOutcome(session.id, "inner")).toBe("not_run");
  // The next daemon takes the answer.
  const next = new Gate(store, new Bus());
  expect(next.resolve(card.id, session.id, { choice: "deny", reason: "not this one" })).toEqual({ ok: true });
  expect(next.approval(card.id)).toMatchObject({ state: "denied", reason: "not this one" });
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
  expect(g.resolve(root.id, "s1", { choice: "once" })).toEqual({ ok: true });
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
