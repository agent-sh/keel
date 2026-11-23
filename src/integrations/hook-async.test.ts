process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-hook-async-config`;
// Hooks that run in the background (async, asyncRewake), and the answers
// Keel reads and does not act on (permissionDecision "defer"), as the Claude
// Code hooks reference says: code.claude.com/docs/en/hooks, "Run hooks in the
// background" and "Defer a tool call for later".
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";

const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { Engine } = await import("../engine/turn.ts");
const { allHooks } = await import("../engine/hooks.ts");
const { joinHooks } = await import("../server/routes/hooks.ts");
const { Hooks, parseHooks, portable, backgroundCount, stopBackground } = await import("./hooks.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "hk-async-"));
const hooksFile = join(dir, "hooks.json");
ownEnv({ KEEL_HOOKS: hooksFile });
const ws = join(dir, "ws");
mkdirSync(join(ws, ".git"), { recursive: true });
const store = new Store(join(dir, "state")), bus = new Bus();
const failed: string[] = [];
const hooks = new Hooks(store, (f) => failed.push(`${f.event}: ${f.why}`));
const woke: { session: string; text: string }[] = [];
hooks.rewake = (s, text) => void woke.push({ session: s.id, text });
const session = () => store.createSession({ model: "fixture:m", workspace: ws });

// A script that answers what it is told to, after a pause.
const script = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\ncat > /dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const file = (event: string, handlers: unknown[]) => writeFileSync(hooksFile, JSON.stringify({ hooks: { [event]: [{ hooks: handlers }] } }));
const pre = (s: { id: string }) => hooks.run("PreToolUse", s as any, { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "call-1" }, ["Bash"]);
const until = async (ok: () => boolean, ms = 5000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await Bun.sleep(20); return ok(); };

// The daemon's own joining of the hooks to the turn loop, on an engine that stores what it is sent.
const engine = new Engine(store, bus, {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
const messaged: { id: string; text: string; meta: any }[] = [];
(engine as any).message = (id: string, text: string, meta: any) => { messaged.push({ id, text, meta }); return {}; };
const registered = allHooks().length;
joinHooks({ store, bus, engine, errors: { capture: () => ({}) }, workspace: ws } as any, undefined);
const mine = allHooks().slice(registered);
const turnHooks = mine.find((h) => h.beforeRequest)!;
afterAll(() => {
  for (const x of mine) allHooks().splice(allHooks().indexOf(x), 1);
  rmSync(dir, { recursive: true, force: true });
});
const notes = (id: string) => store.lineage(id).filter((e) => e.kind === "note").map((e) => String(e.data.text));

test("the file's list says what Keel does with a background hook, and a wrong field is a problem", () => {
  const { groups, problems, notes } = parseHooks(JSON.stringify({ hooks: {
    PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "run-tests.sh", async: true }, { type: "command", command: "check.sh", asyncRewake: true }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: "x", async: "yes" }, { type: "http", url: "http://127.0.0.1:1/h", async: true }] }],
  } }));
  expect((groups.PostToolUse![0]!.hooks[0] as any).async).toBe(true);
  expect((groups.PostToolUse![0]!.hooks[1] as any).asyncRewake).toBe(true);
  expect(problems).toEqual(["PreToolUse: a command hook's async must be true or false"]);
  expect(notes.join("\n")).toContain("PostToolUse: run-tests.sh runs in the background");
  expect(notes.join("\n")).toContain("PostToolUse: check.sh runs in the background");
  expect(notes.join("\n")).toContain("exit code 2 wakes the session");
  expect(notes.join("\n")).toContain("PreToolUse: async is read on command hooks only");
});

test("an async hook: the event does not wait, its timeout does not hold, nothing it decides counts, and its words wait for the next turn", async () => {
  const s = session();
  const slow = script("slow.sh", `sleep 0.6\necho 'tests are running'\necho '{"decision":"block","continue":false,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","updatedInput":{"command":"rm -rf /"},"additionalContext":"tests passed"}}'`);
  file("PreToolUse", [{ type: "command", command: slow, async: true, timeout: 0.2 }]);
  const t0 = Date.now();
  const r = await pre(s);
  expect(Date.now() - t0).toBeLessThan(400);
  expect(r).toEqual({ context: [], ran: 1 });
  // Past its timeout it still finishes, and only its context is kept: the JSON on a line of its own.
  expect(await until(() => hooks.owed(s.id).length === 1)).toBe(true);
  expect(hooks.owed(s.id)[0]).toMatchObject({ event: "PreToolUse", text: "tests passed" });
  expect(failed).toEqual([]);
  // A later run of the same hook takes the place of words not yet delivered.
  await pre(s);
  await Bun.sleep(900);
  expect(hooks.owed(s.id).length).toBe(1);

  // The session's next turn reads it, once, and nothing woke the idle session.
  store.append(s.id, "user", { text: "next" });
  await turnHooks.beforeRequest!(s, { purpose: "turn", model: "m", system: "", messages: [], tools: [] } as any);
  expect(notes(s.id).join()).toContain("tests passed");
  expect(hooks.owed(s.id)).toEqual([]);
  expect(messaged).toEqual([]);
});

test("asyncRewake: exit code 2 wakes the session with its stderr, and its time limit holds", async () => {
  const s = session();
  const fail = script("fail.sh", `sleep 0.2\necho 'out text'\necho '3 tests failed' >&2\nexit 2`);
  file("PostToolUse", [{ type: "command", command: fail, asyncRewake: true }]);
  const r = await hooks.run("PostToolUse", s as any, { tool_name: "Bash" }, ["Bash"]);
  expect(r).toEqual({ context: [], ran: 1 });
  expect(await until(() => woke.length === 1)).toBe(true);
  expect(woke[0]).toMatchObject({ session: s.id, text: expect.stringContaining("3 tests failed") });
  // Over its timeout it is a failed hook, and wakes nothing.
  const long = script("long.sh", "sleep 2\nexit 2");
  file("PostToolUse", [{ type: "command", command: long, asyncRewake: true, timeout: 0.2 }]);
  await hooks.run("PostToolUse", s as any, { tool_name: "Bash" }, ["Bash"]);
  expect(await until(() => failed.length === 1)).toBe(true);
  expect(failed[0]).toStartWith("PostToolUse: it did not finish in time");
  expect(woke.length).toBe(1);

  // Through the daemon: the wake is a message stored for the session (held behind an owner's stop like any other).
  const t = session();
  file("Stop", [{ type: "command", command: fail, asyncRewake: true }]);
  store.append(t.id, "user", { text: "go" });
  await turnHooks.turnEnd!(t, "end_turn");
  expect(await until(() => messaged.length === 1)).toBe(true);
  expect(messaged[0]).toMatchObject({ id: t.id, text: expect.stringContaining("3 tests failed"), meta: { kind: "hook", event: "Stop" } });
});

// Whether a process still runs (one killed and not yet reaped by whoever took it in is gone too).
const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
const pidOf = async (p: string) => (await until(() => existsSync(p) && readFileSync(p, "utf8").trim() !== "") ? Number(readFileSync(p, "utf8").trim()) : 0);

test("an async hook that never ends is stopped with what it started when its session is archived or deleted", async () => {
  failed.length = 0;
  for (const how of ["archived", "deleted"] as const) {
    const s = session(), other = session();
    const mark = join(dir, `child-${how}`);
    // The hook leaves a child of its own and waits on it.
    file("PostToolUse", [{ type: "command", command: script(`forever-${how}.sh`, `sleep 300 &\necho $! > ${mark}\nwait`), async: true }]);
    await hooks.run("PostToolUse", s as any, { tool_name: "Bash" }, ["Bash"]);
    file("PostToolUse", [{ type: "command", command: script(`forever-other-${how}.sh`, "sleep 300"), async: true }]);
    await hooks.run("PostToolUse", other as any, { tool_name: "Bash" }, ["Bash"]);
    const child = await pidOf(mark);
    expect(child).toBeGreaterThan(0);
    expect([backgroundCount(s.id), backgroundCount(other.id)]).toEqual([1, 1]);
    // Through the daemon's own frame: the session went, its hook and the hook's child with it; the other session's stays.
    bus.emit(how === "deleted" ? { t: "session", session: s as any, deleted: true } : { t: "session", session: { ...s, archived: 1 } as any });
    expect(await until(() => !alive(child))).toBe(true);
    expect([backgroundCount(s.id), backgroundCount(other.id)]).toEqual([0, 1]);
    // The daemon's exit ends every one.
    expect(stopBackground()).toBe(1);
    expect(await until(() => backgroundCount() === 0)).toBe(true);
    expect(failed).toEqual([]); // stopped is not failed
    expect(hooks.owed(s.id)).toEqual([]);
  }
});

test("an async hook holds to the event's longest time limit", async () => {
  const s = session();
  failed.length = 0;
  // Interrupt's longest limit is three seconds.
  const long = script("long-async.sh", "sleep 30");
  file("Interrupt", [{ type: "command", command: long, async: true, timeout: 0.1 }]);
  const t0 = Date.now();
  await hooks.run("Interrupt", s as any, {});
  expect(await until(() => failed.length === 1, 8000)).toBe(true);
  expect(Date.now() - t0).toBeGreaterThan(2500);
  expect(failed[0]).toStartWith("Interrupt: it did not finish in time");
  failed.length = 0;
});

test("permissionDecision defer is not an allow: Keel's sessions are interactive, so the hook's answer is ignored", async () => {
  const s = session();
  const defer = script("defer.sh", `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer","updatedInput":{"command":"other"},"additionalContext":"later"}}'`);
  file("PreToolUse", [{ type: "command", command: defer }]);
  expect(await pre(s)).toEqual({ context: [], ran: 1 });
  // The file's list says it.
  const src = hooks.sources(ws).find((x) => x.scope === "owner")!;
  expect(hooks.said(src.path).join("\n")).toContain('answered permissionDecision "defer"');
});

test("a hook brought from Claude Code keeps the fields Keel reads", () => {
  expect(portable({ type: "command", command: "t.sh", async: true, asyncRewake: false, timeout: 30, if: "Edit(*.ts)", onFailure: "block", args: ["a"], statusMessage: "testing", shell: "bash" }))
    .toEqual({ type: "command", command: "t.sh", async: true, asyncRewake: false, timeout: 30, if: "Edit(*.ts)", onFailure: "block", args: ["a"] });
});
