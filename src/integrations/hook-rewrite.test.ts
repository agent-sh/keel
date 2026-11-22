process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-hook-rewrite-config`;
// A PreToolUse hook that allows a call or changes its input: what the gate
// then judges, what runs, and what the model, the owner and the trace are told.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { Engine } = await import("../engine/turn.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const { Gate } = await import("../safety/gate.ts");
const { joinHooks, changedInput } = await import("../server/routes/hooks.ts");
const { Hooks } = await import("./hooks.ts");
const { configDir } = await import("../providers/config.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "hk-"));
const before = process.env.KEEL_HOOKS;
afterAll(() => {
  if (before === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = before;
  rmSync(dir, { recursive: true, force: true });
});

// The stand-in hook answers what the test last wrote for it, and only for this test's folder.
const answer = join(dir, "answer.json");
const script = join(dir, "pre.sh");
writeFileSync(script, `#!/usr/bin/env bash\ninput=$(cat)\ncase "$input" in *'"cwd":"${dir}'*) ;; *) exit 0 ;; esac\ncat "${answer}" 2>/dev/null\nexit 0\n`);
chmodSync(script, 0o755);
const pre = (o: Record<string, unknown>) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...o } });
const says = (o?: Record<string, unknown>) => writeFileSync(answer, o ? pre(o) : "");
const ALLOW = { permissionDecision: "allow", permissionDecisionReason: "fine here" };
const hooksFile = join(dir, "hooks.json");
const group = (command: string) => ({ hooks: [{ type: "command", command }] });
writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [group(script)] } }));
process.env.KEEL_HOOKS = hooksFile;

const store = new Store(join(dir, "state")), bus = new Bus();
const ws = join(dir, "ws");
mkdirSync(join(ws, ".git"), { recursive: true });
const s = store.createSession({ model: "fixture:m", workspace: ws });
const errors = { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any;
const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
// `confines`: whether the session's sandbox can confine a command (it is on only when the session's permissions name one).
let confines = false;
let gate = new Gate(store, bus, () => confines);
const judged: string[] = [];
const judge = async (a: { summary: string }) => { judged.push(a.summary); return { allow: true, risk: "low", reason: "the stand-in judge allows", model: "m" }; };
gate.judge = judge;
// The order the daemon registers them in: the gate, then the owner's hooks (which prepare the call before the gate judges it).
const registered = allHooks().length;
registerHooks({ beforeTool: (session, c) => (session.id === s.id ? gate.beforeTool(s, c) : undefined) });
joinHooks({ store, bus, engine, errors, workspace: ws } as any, gate);
const seen: { input: any; hook: any; ctx: any }[] = [];
registerHooks({ toolRan: (session, c) => { if (session.id === s.id) seen.push({ input: c.input, hook: c.hook, ctx: c.ctx }); } });
// What this file joined to the turn loop leaves with it.
const mine = allHooks().slice(registered);
afterAll(() => { for (const h of mine) allHooks().splice(allHooks().indexOf(h), 1); });

const said = (input: any) => ({ content: `ran: ${JSON.stringify(input)}` });
const tools = [
  { name: "Bash", description: "", kind: "shell", readOnly: false, input_schema: { type: "object", properties: { command: {} } }, run: async (input: any) => said(input) },
  { name: "Write", description: "", kind: "edit", readOnly: false, input_schema: { type: "object", properties: { file_path: {}, content: {} } }, run: async (input: any) => said(input) },
  { name: "mcp__mail__send", description: "", readOnly: false, input_schema: { type: "object", properties: {} }, run: async (input: any) => said(input) },
] as any[];
let n = 0;
const run = (name: string, input: any, id = `call-${++n}`, signal = new AbortController().signal) => {
  const p = (engine as any).runTool(s, tools, { type: "tool_use", id, name, input }, { sessionId: s.id, cwd: ws, signal, spillDir: dir, seen: new Map() }) as Promise<any>;
  return { id, result: p, shown: () => (engine as any).shown.get(id) };
};
const bash = (command: unknown, id?: string, signal?: AbortSignal) => run("Bash", { command }, id, signal);
const write = (path: string) => run("Write", { file_path: path, content: `c${++n}` });
const text = (r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const pending = () => gate.approvals({ session: s.id, pending: true });
// How a call ends: it ran, a card opened (answered here), the judge was asked, or it was refused.
const outcome = async (c: { id: string; result: Promise<any> }, choice: "deny" | "once" = "deny") => {
  let done: any;
  c.result.then((r) => (done = r));
  const j0 = judged.length, r0 = seen.length;
  for (let i = 0; i < 400 && !done && !pending().some((a) => a.call_id === c.id); i++) await Bun.sleep(5);
  const card = pending().find((a) => a.call_id === c.id);
  if (card) gate.resolve(card.id, s.id, { choice });
  const result = await c.result;
  const ran = seen.length > r0;
  return { what: card ? `card ${card.risk}` : judged.length > j0 ? "judge" : ran ? "ran" : "refused", card, result, ran };
};
const mode = (m: string, sandbox = "off") => { gate.setPerm(s.id, { mode: m as any, sandbox: sandbox as any }); gate.turnStarted(s.id); };

test("a hook's allow answers the card the owner would have got, for a call inside the session's scope, and nothing else", async () => {
  const within = () => join(ws, `in-${++n}.txt`), outside = () => join(dir, `out-${++n}.txt`);
  mode("ask");
  // Without a hook's answer an edit in the workspace waits on a card. With the allow it runs, and its card says a hook answered.
  says();
  expect((await outcome(write(within()))).what).toBe("card low");
  says(ALLOW);
  const own = write(within());
  expect((await outcome(own)).what).toBe("ran");
  expect(own.shown()).toEqual({ hook: { allowed: "fine here" } });
  expect(seen.at(-1)!.hook).toMatchObject({ allowed: "fine here", skipped: true });
  // What leaves the session's scope still asks: an edit outside the workspace, a command nothing confines, a tool.
  expect((await outcome(write(outside()))).what).toBe("card low");
  expect((await outcome(bash("npm install left-pad"))).what).toBe("card low");
  expect((await outcome(bash("mv build /var/lib/thing"))).what).toBe("card low");
  // (A delete outside the session's folder is high risk, which no hook answers.)
  expect((await outcome(bash("rm -rf /var/lib/thing"))).what).toBe("card high");
  // A command whose plain shape writes a start file is the owner's alone: a card no grant is offered on.
  const start = await outcome(bash(`echo x >> ${homedir()}/.bashrc`));
  expect([start.what, start.card?.suggest]).toEqual(["card high", []]);
  expect((await outcome(run("mcp__mail__send", { to: "someone" }))).what).toBe("card low");
  // A command the sandbox confines runs, confined.
  confines = true;
  mode("ask", "workspace-write");
  expect((await outcome(bash("npm install left-pad"))).what).toBe("ran");
  expect(typeof seen.at(-1)!.ctx.wrapSpawn).toBe("function");
  confines = false;
  // What is the owner's alone stays theirs, hook or no hook: Keel's own config, a shell's start file, the login keys, a file the repository runs.
  for (const m of ["ask", "auto-edits"]) {
    mode(m);
    for (const p of [join(configDir(), "hooks.json"), join(configDir(), "mcp.json"), join(homedir(), ".bashrc"), join(homedir(), ".ssh/authorized_keys"), join(ws, ".git/hooks/pre-commit")]) {
      const o = await outcome(write(p));
      expect([m, p, o.what, o.card?.suggest]).toEqual([m, p, "card high", []]);
    }
  }
  // A high-risk command still gets its card.
  mode("ask");
  expect((await outcome(bash("sudo rm -rf /var/lib/thing"))).what).toBe("card high");
  // In Auto and Reviewer there is no owner card to answer: the judge still reviews, as without the hook.
  for (const m of ["auto", "reviewer"]) {
    mode(m);
    expect([m, (await outcome(write(outside()))).what]).toEqual([m, "judge"]);
    expect([m, (await outcome(run("mcp__mail__send", { to: "someone" }))).what]).toEqual([m, "judge"]);
  }
  mode("reviewer");
  expect((await outcome(bash("npm install left-pad"))).what).toBe("judge");
  // Read only refuses it whatever the hook says, and in Auto a command that never runs without the owner is refused.
  mode("read-only");
  expect(text((await outcome(write(within()))).result)).toContain("read-only");
  // (In Auto; Full auto checks nothing, so there it would run.)
  mode("auto");
  expect(text((await outcome(bash("rm -rf ~"))).result)).toContain("never runs without the owner");
});

test("a changed input is what the gate judges, what runs and what everyone is told", async () => {
  mode("ask");
  // An edit changed to another file of the workspace, and allowed: the changed one runs, and the model is told.
  const target = join(ws, "changed.txt");
  says({ ...ALLOW, updatedInput: { file_path: target, content: "from the hook" } });
  const asked = { file_path: join(ws, "asked.txt"), content: "from the model" };
  const r = run("Write", asked);
  const out = text((await outcome(r)).result);
  expect(out).toStartWith(`ran: ${JSON.stringify({ file_path: target, content: "from the hook" })}`);
  expect(out).toContain(`It ran with:\n${JSON.stringify({ file_path: target, content: "from the hook" })}`);
  expect(r.shown()).toEqual({ hook: { input: { file_path: target, content: "from the hook" }, allowed: "fine here" } });
  expect(seen.at(-1)).toMatchObject({ input: { file_path: target }, hook: { from: asked } });
  // Changed to a file outside the workspace: the allow does not answer for it. The card shows the changed path.
  says({ ...ALLOW, updatedInput: { file_path: join(dir, "elsewhere.txt"), content: "x" } });
  const moved = await outcome(run("Write", asked));
  expect(moved.what).toBe("card low");
  expect(moved.card!.summary).toContain("elsewhere.txt");
  // A read changed into a high-risk command: its card shows the changed command and names the model's.
  says({ ...ALLOW, updatedInput: { command: "sudo rm -rf /var/lib/thing" } });
  const high = bash("echo harmless");
  const o = await outcome(high);
  expect(o.card).toMatchObject({ summary: "sudo rm -rf /var/lib/thing", risk: "high" });
  expect(o.card!.notice).toContain("The model asked for: echo harmless");
  // The refusal names what was judged, and does not say it ran.
  expect(o.result.is_error).toBe(true);
  expect(text(o.result)).toContain('It did not run. The input that was judged:\n{"command":"sudo rm -rf /var/lib/thing"}');
  expect(text(o.result)).not.toContain("It ran with");
  expect(high.shown()).toEqual({ hook: { input: { command: "sudo rm -rf /var/lib/thing" } } });
  // In Read only the changed command is the one refused.
  mode("read-only");
  says({ ...ALLOW, updatedInput: { command: "npm install right-pad" } });
  expect(text((await outcome(bash("echo harmless"))).result)).toContain("npm install right-pad");
  // An input that is not an object runs nothing; nor does a shell command that is a list or an object, in any mode.
  for (const m of ["read-only", "ask", "full-auto"]) {
    mode(m);
    says({ updatedInput: "echo no" });
    expect(text((await outcome(bash("echo harmless"))).result)).toContain("not an object");
    for (const command of [["echo", "$(touch marker)"], { run: "touch marker" }]) {
      says({ ...ALLOW, updatedInput: { command } });
      const refused = await outcome(bash("echo harmless"));
      expect([m, refused.what, refused.ran]).toEqual([m, "refused", false]);
      expect(text(refused.result)).toContain("Bash takes its command as one string");
    }
  }
});

test("between hooks a deny beats an ask and an ask beats an allow, and an allow counts only with its own input", async () => {
  const hook = (name: string, o: Record<string, unknown>, wait = 0) => {
    const p = join(dir, `${name}.sh`);
    writeFileSync(p, `#!/usr/bin/env bash\ncat > /dev/null\n${wait ? `sleep ${wait}\n` : ""}echo '${pre(o)}'\n`);
    chmodSync(p, 0o755);
    return group(p);
  };
  const hooks = new Hooks(store);
  const first = (...groups: unknown[]) => {
    writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: groups } }));
    return hooks.run("PreToolUse", s, { tool_name: "Bash", tool_input: { command: "echo x" }, tool_use_id: "x" }, ["Bash"]);
  };
  const allow = hook("allow", { permissionDecision: "allow", permissionDecisionReason: "B allows what it saw" });
  expect(await first(allow)).toMatchObject({ allow: "B allows what it saw" });
  const deny = await first(allow, hook("deny", { permissionDecision: "deny", permissionDecisionReason: "not this one" }));
  expect([deny.block, deny.allow]).toEqual(["not this one", undefined]);
  const ask = await first(allow, hook("ask", { permissionDecision: "ask", permissionDecisionReason: "look at it" }));
  expect([ask.ask, ask.allow]).toEqual(["look at it", undefined]);
  // The first hook in file order changes the input and allows nothing (it also answers last): the second hook's allow was for another input.
  const a = hook("a", { updatedInput: { command: "npm install first-hook" } }, 0.3);
  const other = await first(a, allow);
  expect([other.input, other.allow]).toEqual([{ command: "npm install first-hook" }, undefined]);
  const both = await first(a, hook("b", { permissionDecision: "allow", updatedInput: { command: "npm install second-hook" } }));
  expect([both.input, both.allow]).toEqual([{ command: "npm install first-hook" }, undefined]);
  // The hook whose input won allowed it.
  const won = await first(hook("c", { permissionDecision: "allow", permissionDecisionReason: "mine", updatedInput: { command: "npm install third" } }), allow);
  expect([won.input, won.allow]).toEqual([{ command: "npm install third" }, "mine"]);
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [group(script)] } }));
});

test("a card a restart left open approves only the input it shows", async () => {
  mode("ask");
  // The next daemon: a new gate over the same store.
  const restart = () => { gate = new Gate(store, bus, () => confines); gate.judge = judge; mode("ask"); };
  const parked = async (command: string, id: string) => {
    const stop = new AbortController();
    const first = bash(command, id, stop.signal);
    for (let i = 0; i < 400 && !pending().length; i++) await Bun.sleep(5);
    const card = pending()[0]!;
    gate.park(s.id);
    stop.abort();
    await first.result;
    return card;
  };
  // The hook changed the command and the card showed that. After the restart the hook answers another command, and the owner allows the card they see.
  says({ updatedInput: { command: "npm install safe-replacement" } });
  const card = await parked("echo from-model", "R1");
  expect(card.summary).toBe("npm install safe-replacement");
  restart();
  says({ updatedInput: { command: "sudo rm -rf /var/lib/thing" } });
  gate.resolve(card.id, s.id, { choice: "once", seen: "whole" });
  const again = await outcome(bash("echo from-model", "R1"));
  expect([again.what, again.card?.summary, again.ran]).toEqual(["card high", "sudo rm -rf /var/lib/thing", false]);
  expect(gate.approval(card.id)).toMatchObject({ state: "cancelled", reason: "the call changed since this card opened" });
  // The card showed the hook's replacement; after the restart the hook is silent, and the model's own command comes back.
  says({ updatedInput: { command: "npm install safe-replacement-2" } });
  const second = await parked("sudo rm -rf /var/lib/asked-by-model", "R2");
  expect(second.summary).toBe("npm install safe-replacement-2");
  restart();
  says();
  gate.resolve(second.id, s.id, { choice: "once", seen: "whole" });
  const silent = await outcome(bash("sudo rm -rf /var/lib/asked-by-model", "R2"));
  expect([silent.what, silent.card?.summary, silent.ran]).toEqual(["card high", "sudo rm -rf /var/lib/asked-by-model", false]);
  // The same input back after a restart keeps its card and the owner's answer.
  says();
  const same = await parked("npm install kept", "R3");
  restart();
  gate.resolve(same.id, s.id, { choice: "once", seen: "whole" });
  const kept = await outcome(bash("npm install kept", "R3"));
  expect([kept.what, kept.ran]).toEqual(["ran", true]);
});

test("a dispatcher's call is changed in the arguments its hooks saw", () => {
  const args = { path: "a" };
  expect(changedInput(args, args, { path: "b" })).toEqual({ path: "b" });
  expect(changedInput({ tool: "fs__read", arguments: args }, args, { path: "b" })).toEqual({ tool: "fs__read", arguments: { path: "b" } });
  expect(changedInput({ tool: "fs__read" }, {}, { path: "b" })).toBeUndefined();
});
