process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-hook-events-config`;
// Each hook event Keel fires, with a stand-in hook that records what it is
// given: the event reaches the hook once, with the documented fields, and what
// the hook answers does what the README says.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { Engine } = await import("../engine/turn.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const { Gate } = await import("../safety/gate.ts");
const routes = await import("../server/routes/hooks.ts");
const { joinHooks } = routes;
const { EVENTS, NOT_FIRED, ifHolds, matches, parseHooks } = await import("./hooks.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "hk-ev-"));
const kept = process.env.KEEL_HOOKS;
const seenDir = join(dir, "seen");
mkdirSync(seenDir);

// The stand-in: it keeps the event it was given (one file each) and answers by the event and a word in it.
const script = join(dir, "hook.sh");
writeFileSync(script, `#!/usr/bin/env bash
input=$(cat)
case "$input" in *'"cwd":"${dir}'*) ;; *) exit 0 ;; esac
printf '%s' "$input" > "${seenDir}/$1.$$.$RANDOM.json"
has() { case "$input" in *"$1"*) return 0 ;; esac; return 1; }
case "$1" in
  SessionStart) echo "start-context for $1" ;;
  SubagentStart) echo '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"agent-context"}}' ;;
  UserPromptSubmit) if has w-refuse; then echo '{"decision":"block","reason":"not this prompt"}'; fi ;;
  UserPromptExpansion) if has w-refuse; then echo "not this command" >&2; exit 2; fi; echo "expansion-context" ;;
  PostToolUse) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"post-context"}}' ;;
  PostToolUseFailure) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"failure-context"}}' ;;
  PostToolBatch) if has w-halt; then echo '{"decision":"block","reason":"enough calls"}'; else echo "batch-context"; fi ;;
  Stop) if has w-more && ! has '"stop_hook_active":true'; then echo "one more pass" >&2; exit 2; fi ;;
  PermissionRequest)
    if has w-deny; then echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"policy says no"}}}'; fi
    if has w-allow; then echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'; fi ;;
  # Told only: an answer changes nothing.
  SessionEnd|Notification|PostCompact|PreCompact|SubagentStop|StopFailure|Interrupt|PermissionDenied|PreModelRequest|PostModelRequest) echo '{"decision":"block","reason":"ignored"}' ;;
esac
exit 0
`);
chmodSync(script, 0o755);
const hooksFile = join(dir, "hooks.json");
writeFileSync(hooksFile, JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: `${script} ${e}` }] }]])) }));
process.env.KEEL_HOOKS = hooksFile;

const store = new Store(join(dir, "state")), bus = new Bus();
const ws = join(dir, "ws");
mkdirSync(ws);
const errors = { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any;
const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
const gate = new Gate(store, bus);
const sent: { id: string; text: string }[] = [];
const stopped: string[] = [];
(engine as any).send = (id: string, text: string) => void sent.push({ id, text });
(engine as any).interrupt = async (id: string) => void stopped.push(id);
const registered = allHooks().length;
registerHooks({ beforeTool: (session, c) => (store.session(session.id) ? gate.beforeTool(session, c) : undefined) });
joinHooks({ store, bus, engine, errors, workspace: ws } as any, gate);
const mine = allHooks().slice(registered);
const h = mine[1]!;
afterAll(() => {
  for (const x of mine) allHooks().splice(allHooks().indexOf(x), 1);
  if (kept === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = kept;
  rmSync(dir, { recursive: true, force: true });
});

// What the stand-in was given for an event, once `n` of them are there (the hooks that are only told run by themselves).
async function given(event: string, n = 1): Promise<any[]> {
  const read = () => readdirSync(seenDir).filter((f) => f.startsWith(`${event}.`)).map((f) => { try { return JSON.parse(readFileSync(join(seenDir, f), "utf8")); } catch { return null; } }).filter(Boolean);
  for (let i = 0; i < 300 && read().length < n; i++) await Bun.sleep(10);
  return read();
}
const clear = () => { for (const f of readdirSync(seenDir)) rmSync(join(seenDir, f)); };
const session = () => store.createSession({ model: "fixture:m", workspace: ws });
const prompt = async (s: any, text: string) => {
  store.append(s.id, "user", { text });
  return h.beforeRequest!(s, { purpose: "turn", model: "m", system: "", messages: [], tools: [] } as any);
};
const notes = (id: string) => store.lineage(id).filter((e) => e.kind === "note").map((e) => String(e.data.text));
const bash = { name: "Bash", description: "", kind: "shell", readOnly: false, input_schema: { type: "object", properties: { command: {} } },
  run: async (input: any) => { if (String(input.command).includes("w-throw")) throw new Error("the tool broke"); return { content: `ran: ${input.command}`, is_error: String(input.command).includes("w-fail") || undefined }; } } as any;
let n = 0;
const run = (s: any, command: string) => {
  const id = `call-${++n}`;
  return { id, result: (engine as any).runTool(s, [bash], { type: "tool_use", id, name: "Bash", input: { command } }, { sessionId: s.id, cwd: ws, signal: new AbortController().signal, spillDir: dir, seen: new Map() }) as Promise<any> };
};

test("every event of the three harnesses loads: it fires, or the file says why it never runs", () => {
  const all = [...EVENTS, ...Object.keys(NOT_FIRED)];
  // Claude Code's 33 and the three only Codex has.
  expect(all.length).toBe(36);
  const { groups, problems } = parseHooks(JSON.stringify({ hooks: Object.fromEntries([...all, "Nonsense"].map((e) => [e, [{ hooks: [{ type: "command", command: "true" }] }]])) }));
  expect(Object.keys(groups).sort()).toEqual([...EVENTS].sort());
  expect(problems.filter((p) => p.includes("never runs here")).length).toBe(Object.keys(NOT_FIRED).length);
  expect(problems.filter((p) => !p.includes("never runs here"))).toEqual(["Nonsense: not an event of Claude Code, Codex or Keel"]);
});

test("a matcher is exact alternatives or a regular expression, and `if` narrows a tool's hook", () => {
  expect(matches(undefined, ["Bash"])).toBe(true);
  expect(matches("*", ["Bash"])).toBe(true);
  expect(matches("Edit|Write", ["Write"])).toBe(true);
  expect(matches("Edit", ["MultiEdit"])).toBe(false); // exact, not a part of the name
  expect(matches("startup|resume|clear|compact|fork", ["compact"])).toBe(true);
  expect(matches("mcp__.*", ["mcp__fs__read"])).toBe(true);
  expect(matches("^Bash$", ["BashOutput"])).toBe(false);
  expect(matches("Notebook.*", ["Read"])).toBe(false);
  expect(ifHolds("Bash(rm *)", ["Bash"], { command: "cd x && FOO=1 rm -rf build" }, ws)).toBe(true);
  expect(ifHolds("Bash(rm *)", ["Bash"], { command: "npm test" }, ws)).toBe(false);
  expect(ifHolds("Bash(git *)", ["Edit"], { file_path: "a.ts" }, ws)).toBe(false);
  expect(ifHolds("Edit(*.ts)", ["Edit"], { file_path: join(ws, "src/a.ts") }, ws)).toBe(true);
  expect(ifHolds("Edit(*.ts)", ["Edit"], { file_path: "a.md" }, ws)).toBe(false);
});

test("SessionStart, UserPromptSubmit: the first prompt, and again after a clear or a compaction", async () => {
  clear();
  const s = session();
  await prompt(s, "hello");
  const [start] = await given("SessionStart");
  expect(start).toMatchObject({ session_id: s.id, cwd: ws, hook_event_name: "SessionStart", source: "startup", model: "fixture:m", permission_mode: "default", transcript_path: null });
  expect((await given("UserPromptSubmit"))[0]).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "hello" });
  expect(notes(s.id).join()).toContain("start-context for SessionStart");
  // A later prompt starts nothing.
  await prompt(s, "again");
  expect((await given("UserPromptSubmit", 2)).length).toBe(2);
  expect((await given("SessionStart")).length).toBe(1);
  // After a compaction and after a clear the session starts again, with that source.
  store.append(s.id, "compaction", { mode: "summary", summary: "so far" });
  await prompt(s, "after the summary");
  store.append(s.id, "compaction", { mode: "clear" });
  await prompt(s, "after the clear");
  expect((await given("SessionStart", 3)).map((x) => x.source).sort()).toEqual(["clear", "compact", "startup"]);
  // A refused prompt never reaches the model.
  expect(prompt(s, "w-refuse this")).rejects.toThrow("A hook refused this prompt: not this prompt");
});

test("PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch", async () => {
  clear();
  const s = session();
  gate.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
  const ok = run(s, "echo fine");
  expect(await ok.result).toMatchObject({ content: expect.stringContaining("post-context") });
  expect((await given("PreToolUse"))[0]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo fine" }, tool_use_id: ok.id, permission_mode: "bypassPermissions", keel_permission_mode: "full-auto" });
  const [post] = await given("PostToolUse");
  expect(post).toMatchObject({ tool_name: "Bash", tool_input: { command: "echo fine" }, tool_use_id: ok.id, tool_response: "ran: echo fine" });
  expect(typeof post.duration_ms).toBe("number");
  // A result that says it failed, and a tool that threw: PostToolUseFailure, not PostToolUse.
  const failed = run(s, "echo w-fail");
  expect(await failed.result).toMatchObject({ is_error: true, content: expect.stringContaining("failure-context") });
  const threw = run(s, "echo w-throw");
  expect(await threw.result).toMatchObject({ is_error: true, content: expect.stringContaining("failure-context") });
  const failures = await given("PostToolUseFailure", 2);
  expect(failures.map((x) => x.error).sort()).toEqual(["ran: echo w-fail", "the tool broke"]);
  expect(failures[0]).toMatchObject({ tool_name: "Bash", is_interrupt: false });
  expect((await given("PostToolUse")).length).toBe(1);

  // The step's calls together, once they have all returned.
  store.append(s.id, "user", { text: "go" });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }, { type: "tool_use", id: "b2", name: "Bash", input: { command: "pwd" } }], stop: "tool_use" });
  store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "b1", content: "a.txt" }] });
  store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "b2", content: "/w" }] });
  await h.stepDone!(s);
  expect((await given("PostToolBatch"))[0].tool_calls).toEqual([
    { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "b1", tool_response: "a.txt" },
    { tool_name: "Bash", tool_input: { command: "pwd" }, tool_use_id: "b2", tool_response: "/w" },
  ]);
  expect(notes(s.id).join()).toContain("batch-context");
  expect(stopped).toEqual([]);
  // A block here stops the turn before the next model request.
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "echo w-halt" } }], stop: "tool_use" });
  store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "b3", content: "x" }] });
  await h.stepDone!(s);
  expect(stopped).toEqual([s.id]);
  expect(notes(s.id).join()).toContain("A hook stopped the turn: enough calls");
});

test("Stop, StopFailure, Interrupt", async () => {
  clear();
  const s = session();
  store.append(s.id, "user", { text: "go" });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "all done" }], stop: "end_turn" });
  await h.turnEnd!(s, "end_turn");
  expect((await given("Stop"))[0]).toMatchObject({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "all done" });
  expect(sent).toEqual([]);
  // Exit code 2 sends the session back to work with the hook's words, once.
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "w-more to do" }], stop: "end_turn" });
  await h.turnEnd!(s, "end_turn");
  expect(sent).toEqual([{ id: s.id, text: "[hook] one more pass" }]);
  await h.turnEnd!(s, "end_turn");
  expect((await given("Stop", 3)).filter((x) => x.stop_hook_active).length).toBe(1);
  expect(sent.length).toBe(1);
  // A turn a provider's error ended, and one the owner stopped.
  store.append(s.id, "turn_start", {});
  store.append(s.id, "error", { message: "429 slow down", kind: "rate" });
  await h.turnEnd!(s, "error");
  expect((await given("StopFailure"))[0]).toMatchObject({ error: "rate_limit", error_details: "429 slow down", last_assistant_message: "w-more to do" });
  await h.turnEnd!(s, "interrupted");
  expect((await given("Interrupt"))[0]).toMatchObject({ hook_event_name: "Interrupt", session_id: s.id });
  expect((await given("Stop")).length).toBe(3);
});

test("SubagentStart, SubagentStop: a subagent's events name it and carry its parent's session", async () => {
  clear();
  const parent = session();
  const child = session();
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT"); // the agents module's column
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, child.id);
  const c = store.session(child.id)!;
  await prompt(c, "the task");
  expect((await given("SubagentStart"))[0]).toMatchObject({ hook_event_name: "SubagentStart", session_id: parent.id, agent_id: child.id, agent_type: "general-purpose", agent_session_id: child.id });
  expect(notes(child.id).join()).toContain("agent-context");
  store.append(child.id, "assistant", { blocks: [{ type: "text", text: "the report" }], stop: "end_turn" });
  await h.turnEnd!(c, "end_turn");
  expect((await given("SubagentStop"))[0]).toMatchObject({ session_id: parent.id, agent_id: child.id, agent_type: "general-purpose", last_assistant_message: "the report", stop_hook_active: false });
  // Neither SessionStart nor Stop runs inside a subagent.
  expect(await given("SessionStart", 0)).toEqual([]);
  expect(await given("Stop", 0)).toEqual([]);
});

test("PreCompact, PostCompact", async () => {
  clear();
  const s = session();
  await h.beforeCompact!(s, { auto: false, focus: "keep the plan" });
  expect((await given("PreCompact"))[0]).toMatchObject({ trigger: "manual", custom_instructions: "keep the plan" });
  h.afterCompact!(s, { id: "c1", session_id: s.id, seq: 1, parent: null, kind: "compaction", ts: 0, data: { mode: "summary", summary: "what happened", auto: true } });
  expect((await given("PostCompact"))[0]).toMatchObject({ trigger: "auto", compact_summary: "what happened" });
});

test("SessionEnd, Notification: once each, from what the daemon announces", async () => {
  clear();
  const s = session();
  bus.emit({ t: "session", session: s });
  bus.emit({ t: "session", session: { ...s, archived: true } });
  bus.emit({ t: "session", session: { ...s, archived: true } });
  const alert = { id: "alert-1", kind: "approval", session_id: s.id, title: "Approval needed", body: "Bash: npm install" };
  bus.emit({ t: "feature", name: "automation", data: { kind: "alert", data: alert } });
  bus.emit({ t: "feature", name: "automation", data: { kind: "alert", data: { ...alert, delivery: {} } } });
  expect((await given("SessionEnd"))[0]).toMatchObject({ hook_event_name: "SessionEnd", session_id: s.id, reason: "other", keel_reason: "archived" });
  expect((await given("Notification"))[0]).toMatchObject({ message: "Approval needed: Bash: npm install", title: "Approval needed", notification_type: "permission_prompt", keel_kind: "approval" });
  await Bun.sleep(150);
  expect((await given("SessionEnd")).length).toBe(1);
  expect((await given("Notification")).length).toBe(1);
});

test("PermissionRequest, PermissionDenied", async () => {
  clear();
  const s = session();
  gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
  // A card is about to open: the hook's deny refuses the call, its allow answers a low-risk card.
  expect(await run(s, "npm install w-deny").result).toMatchObject({ is_error: true, content: expect.stringContaining("policy says no") });
  expect((await run(s, "npm install w-allow").result).content).toStartWith("ran: npm install w-allow");
  expect(gate.approvals({ session: s.id, pending: true })).toEqual([]);
  const asked = await given("PermissionRequest", 2);
  expect(asked.find((x) => x.tool_input.command.includes("w-allow"))).toMatchObject({ hook_event_name: "PermissionRequest", tool_name: "Bash", keel_risk: "low" });
  // A high-risk card still opens whatever the hook allows.
  const stop = new AbortController();
  const high = (engine as any).runTool(s, [bash], { type: "tool_use", id: "high", name: "Bash", input: { command: "sudo rm -rf /var/lib/w-allow" } }, { sessionId: s.id, cwd: ws, signal: stop.signal, spillDir: dir, seen: new Map() });
  for (let i = 0; i < 300 && !gate.approvals({ session: s.id, pending: true }).length; i++) await Bun.sleep(10);
  expect(gate.approvals({ session: s.id, pending: true })[0]).toMatchObject({ risk: "high" });
  stop.abort();
  await high;
  // The judge refuses a call without the owner: the hook is told why.
  gate.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
  gate.judge = async () => ({ allow: false, risk: "high", reason: "it deletes system files", model: "m" });
  const refused = run(s, "sudo rm -rf /var/lib/thing");
  expect(await refused.result).toMatchObject({ is_error: true });
  expect((await given("PermissionDenied"))[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "sudo rm -rf /var/lib/thing" }, tool_use_id: refused.id, reason: "it deletes system files" });
});

test("UserPromptExpansion, PreModelRequest, PostModelRequest", async () => {
  clear();
  const s = session();
  const r = await routes.promptExpansion!(s, { name: "deploy", args: "staging", source: "project", prompt: "Deploy to staging." });
  expect(r).toMatchObject({ context: ["expansion-context"] });
  expect((await given("UserPromptExpansion"))[0]).toMatchObject({ expansion_type: "slash_command", command_name: "deploy", command_args: "staging", command_source: "project", prompt: "Deploy to staging." });
  expect((await routes.promptExpansion!(s, { name: "deploy", args: "w-refuse", source: "project", prompt: "x" })).block).toBe("not this command");
  const req = { model: "m", purpose: "turn" } as any;
  h.requestSent!(s, req);
  h.requestDone!(s, req, { usage: { input: 10, output: 2 } } as any);
  h.requestFailed!(s, req, new Error("503"), false);
  expect((await given("PreModelRequest"))[0]).toMatchObject({ model: "m", purpose: "turn" });
  expect((await given("PostModelRequest", 2)).map((x) => x.status).sort()).toEqual(["completed", "failed"]);
});
