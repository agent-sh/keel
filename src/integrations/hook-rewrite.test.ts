process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-hook-rewrite-config`;
// A PreToolUse hook that allows a call or changes its input: what the gate
// then judges, what runs, and what the model, the owner and the trace are told.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { Engine } = await import("../engine/turn.ts");
const { registerHooks } = await import("../engine/hooks.ts");
const { Gate } = await import("../safety/gate.ts");
const { hookRoutes, changedInput } = await import("../server/routes/hooks.ts");
const { Hooks } = await import("./hooks.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "hk-"));
const before = process.env.KEEL_HOOKS;
afterAll(() => {
  if (before === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = before;
  rmSync(dir, { recursive: true, force: true });
});

// The stand-in hook: it answers by a word in the command, and only for this test's folder.
const script = join(dir, "pre.sh");
writeFileSync(script, `#!/usr/bin/env bash
input=$(cat)
case "$input" in *'"cwd":"${dir}'*) ;; *) exit 0 ;; esac
out() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse",%s}}' "$1"; }
case "$input" in
  *w-plain*) exit 0 ;;
  *w-low*) out '"permissionDecision":"allow","permissionDecisionReason":"installs are fine here"' ;;
  *w-high*) out '"permissionDecision":"allow"' ;;
  *w-change-high*) out '"permissionDecision":"allow","updatedInput":{"command":"sudo rm -rf /var/lib/thing"}' ;;
  *w-change*) out '"permissionDecision":"allow","updatedInput":{"command":"npm install right-pad"}' ;;
  *w-string*) out '"updatedInput":"echo no"' ;;
  *w-deny*) out '"permissionDecision":"deny","permissionDecisionReason":"not this one"' ;;
esac
exit 0
`);
chmodSync(script, 0o755);
const allowAll = join(dir, "allow.sh");
writeFileSync(allowAll, `#!/usr/bin/env bash\ncat > /dev/null\nprintf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'\n`);
chmodSync(allowAll, 0o755);
const hooksFile = join(dir, "hooks.json");
const group = (command: string) => ({ matcher: "Bash", hooks: [{ type: "command", command }] });
writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [group(script)] } }));
process.env.KEEL_HOOKS = hooksFile;

const store = new Store(join(dir, "state")), bus = new Bus();
const ws = join(dir, "ws");
mkdirSync(ws);
const s = store.createSession({ model: "fixture:m", workspace: ws });
const errors = { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any;
const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
const gate = new Gate(store, bus);
// The order the daemon registers them in: the owner's hooks prepare the call, then the gate judges it.
registerHooks({ beforeTool: (session, c) => (session.id === s.id ? gate.beforeTool(s, c) : undefined) });
hookRoutes({ store, bus, engine, errors, workspace: ws } as any);
const seen: { input: any; hook: any }[] = [];
registerHooks({ toolRan: (session, c) => { if (session.id === s.id) seen.push({ input: c.input, hook: c.hook }); } });

const bash = { name: "Bash", description: "", kind: "shell", readOnly: false, input_schema: { type: "object", properties: { command: {} } }, run: async (input: any) => ({ content: `ran: ${input.command}` }) } as any;
let n = 0;
const run = (command: string, signal = new AbortController().signal) => {
  const id = `call-${++n}`;
  const p = (engine as any).runTool(s, [bash], { type: "tool_use", id, name: "Bash", input: { command } }, { sessionId: s.id, cwd: ws, signal, spillDir: dir, seen: new Map() }) as Promise<any>;
  return { id, result: p, shown: () => (engine as any).shown.get(id) };
};
const text = (r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const pending = () => gate.approvals({ session: s.id, pending: true });
const card = async () => { for (let i = 0; i < 200 && !pending().length; i++) await Bun.sleep(10); return pending()[0]!; };

test("a hook's allow answers a low-risk ask and nothing else", async () => {
  gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
  // Without a hook's answer the command waits on a card.
  const asked = run("npm install w-plain");
  expect((await card()).summary).toContain("w-plain");
  gate.resolve(pending()[0]!.id, s.id, { choice: "deny" });
  expect((await asked.result).is_error).toBe(true);
  // The hook allows it: no card, it runs, and the card of the call says a hook answered.
  const low = run("npm install w-low");
  expect(text(await low.result)).toBe("ran: npm install w-low");
  expect(pending()).toEqual([]);
  expect(low.shown()).toEqual({ hook: { allowed: "installs are fine here" } });
  expect(seen.at(-1)!.hook).toMatchObject({ allowed: "installs are fine here", skipped: true });
  // A high-risk command still gets its card.
  const high = run("sudo rm -rf /var/lib/w-high");
  expect((await card()).risk).toBe("high");
  gate.resolve(pending()[0]!.id, s.id, { choice: "deny" });
  expect((await high.result).is_error).toBe(true);
  // Read only refuses it whatever the hook says.
  gate.setPerm(s.id, { mode: "read-only" });
  expect(text(await run("npm install w-low").result)).toContain("read-only");
  // A command that never runs without the owner is refused in a mode with a judge.
  gate.setPerm(s.id, { mode: "full-auto" });
  expect(text(await run("rm -rf ~ # w-high").result)).toContain("never runs without the owner");
  // The sandbox still confines what a hook allowed.
  gate.setPerm(s.id, { mode: "ask", sandbox: "workspace-write" });
  const confined = { id: "confined", tool: bash, input: { command: "npm install w-low" }, ctx: { sessionId: s.id, cwd: ws, signal: new AbortController().signal, spillDir: dir, seen: new Map() }, hook: { allowed: "" } };
  const g = await new Gate(store, bus, () => true).beforeTool(s, confined as any);
  expect(g && "ctx" in g && typeof g.ctx?.wrapSpawn).toBe("function");
});

test("a changed input is what the gate judges, what runs and what everyone is told", async () => {
  gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
  // A read-only command changed into an install: judged as the install, which the hook's allow answers.
  const r = run("echo w-change");
  const out = text(await r.result);
  expect(out).toStartWith("ran: npm install right-pad");
  expect(out).toContain('It ran with:\n{"command":"npm install right-pad"}');
  expect(r.shown()).toEqual({ hook: { input: { command: "npm install right-pad" }, allowed: "" } });
  expect(seen.at(-1)).toMatchObject({ input: { command: "npm install right-pad" }, hook: { from: { command: "echo w-change" } } });
  // Changed into a high-risk command: the card shows the changed command, and a refusal names it to the model.
  const high = run("echo w-change-high");
  const c = await card();
  expect(c.summary).toBe("sudo rm -rf /var/lib/thing");
  expect(c.risk).toBe("high");
  expect(c.notice).toContain("The model asked for: echo w-change-high");
  gate.resolve(c.id, s.id, { choice: "deny" });
  const refused = await high.result;
  expect(refused.is_error).toBe(true);
  expect(text(refused)).toContain("sudo rm -rf /var/lib/thing");
  expect(high.shown()).toEqual({ hook: { input: { command: "sudo rm -rf /var/lib/thing" } } });
  // In Read only the changed command is the one refused.
  gate.setPerm(s.id, { mode: "read-only" });
  expect(text(await run("echo w-change").result)).toContain("npm install right-pad");
  // An input that is not an object runs nothing.
  gate.setPerm(s.id, { mode: "full-auto" });
  expect(text(await run("echo w-string").result)).toContain("not an object");
});

test("between hooks a deny beats an ask and an ask beats an allow", async () => {
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [group(allowAll), group(script)] } }));
  const hooks = new Hooks(store);
  const pre = (command: string) => hooks.run("PreToolUse", s, { tool_name: "Bash", tool_input: { command }, tool_use_id: "x" }, ["Bash"]);
  expect(await pre("echo w-plain")).toMatchObject({ allow: "" });
  const denied = await pre("echo w-deny");
  expect(denied.block).toBe("not this one");
  expect(denied.allow).toBeUndefined();
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [group(script)] } }));
});

test("a dispatcher's call is changed in the arguments its hooks saw", () => {
  const args = { path: "a" };
  expect(changedInput(args, args, { path: "b" })).toEqual({ path: "b" });
  expect(changedInput({ tool: "fs__read", arguments: args }, args, { path: "b" })).toEqual({ tool: "fs__read", arguments: { path: "b" } });
  expect(changedInput({ tool: "fs__read" }, {}, { path: "b" })).toBeUndefined();
});
