// The words of the daemon's own lines in its log: bounded, and a settings
// change never shows a value that could be a secret.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SECRET_KINDS } from "../core/conceal.test.ts";
import { agentLine, answeredLine, approvalLine, backupLine, cutCommandLine, drainLine, exitLine, failedLine, hookLine, judgedLine, loopLine, mcpLine, messageLine, providersLine, retryLine, say, sayAt, settingsChanges, settingsLine, startLine, stopLine, waitEndLine, waitSetLine } from "./daemon-log.ts";
import { runMode } from "../core/runmode.ts";
import { installLogs, logAt, parseLines } from "./logs.ts";

test("a start, the providers and the MCP servers are one bounded line each", () => {
  expect(startLine({ revision: "abc123", pid: 7, url: "http://127.0.0.1:1", state: "/s", config: "/c" })).toBe("[daemon] started: Keel abc123, pid 7, at http://127.0.0.1:1; state /s; config /c");
  expect(providersLine({ available: [{ id: "one", models: 12 }, { id: "two", models: 1 }], failed: ["three"], unset: 4 })).toBe("[daemon] providers found: one (12 models), two (1 model); listing failed: three; 4 not set up");
  expect(providersLine({ available: [], failed: [], unset: 0 })).toBe("[daemon] providers found: none");
  expect(mcpLine([])).toBe("[daemon] MCP servers: none configured");
  expect(mcpLine([{ name: "a", state: "ready" }, { name: "b", state: "error" }, { name: "c", state: "disabled" }, { name: "d", state: "connecting" }, { name: "e", state: "needs_auth" }]))
    .toBe("[daemon] MCP servers: 5 configured; connected: a; failed: b; need sign-in: e; 1 disabled; 1 not connected yet");
  const many = mcpLine(Array.from({ length: 300 }, (_, i) => ({ name: `server-with-a-long-name-${i}`, state: "ready" })));
  expect(many.length).toBeLessThanOrEqual(400);
  expect(many).toContain("and 292 more");
});

test("a drain, its backup, a restart and a clean stop each say what happened", () => {
  expect(drainLine({ restart: true, running: 2, timeoutMs: 120_000, reason: "keel restart from a terminal" })).toBe("[daemon] draining for a restart (keel restart from a terminal): 2 turns running get up to 2 min");
  expect(drainLine({ restart: false, running: 0, timeoutMs: 10_000 })).toBe("[daemon] draining for a stop: no turn is running");
  expect(backupLine({ ok: true, ms: 1200, name: "2026-11-22-restart" })).toBe("[daemon] backup before the restart made in 1 s: 2026-11-22-restart");
  expect(backupLine({ ok: true, ms: 40, owed: "there is no full backup to hold the changes since" })).toBe("[daemon] no backup before the restart, it is made after the start: there is no full backup to hold the changes since");
  expect(backupLine({ ok: false, ms: 300, error: "disk full" })).toBe("[daemon] backup before the restart failed after 300 ms: disk full; the restart is called off");
  expect(exitLine({ restart: true, parked: 3, upMs: 3_600_000, reason: "an upgrade" })).toBe("[daemon] restarting (an upgrade) after 1 h up: 3 turns parked for the next start");
  expect(exitLine({ restart: false, parked: 0, upMs: 90_000 })).toBe("[daemon] stopping cleanly after 2 min up");
});

test("a settings change names what changed and never shows a text or a secret-shaped value", () => {
  const before = { observe: { otlp_endpoint: "", otlp_headers: "", otlp_metrics: false }, backup: { before_restart: true, keep: 5 } };
  const after = { observe: { otlp_endpoint: "http://collector:4318?api_key=sk-planted-0123456789abcdef", otlp_headers: "authorization=Bearer sk-planted-0123456789abcdef", otlp_metrics: true }, backup: { before_restart: true, keep: 9 } };
  const changes = settingsChanges(before, after);
  expect(changes).toEqual(["observe.otlp_endpoint set", "observe.otlp_headers set", "observe.otlp_metrics false -> true", "backup.keep 5 -> 9"]);
  const line = settingsLine(changes);
  expect(line).toBe("[daemon] settings changed: observe.otlp_endpoint set, observe.otlp_headers set, observe.otlp_metrics false -> true, backup.keep 5 -> 9");
  expect(line).not.toContain("planted");
  // A number under a secret-shaped name is not shown either; a removed text says removed.
  expect(settingsChanges({ a: { token_ttl: 5, name: "x" } }, { a: { token_ttl: 6 } })).toEqual(["a.token_ttl changed", "a.name removed"]);
  // A setting that was not set (null) and now holds a text is set; back to null it is removed.
  expect(settingsChanges({ observe: { otlp_endpoint: null } }, { observe: { otlp_endpoint: "http://collector:4318/v1/traces" } })).toEqual(["observe.otlp_endpoint set"]);
  expect(settingsChanges({ observe: { otlp_endpoint: "http://collector:4318/v1/traces" } }, { observe: { otlp_endpoint: null } })).toEqual(["observe.otlp_endpoint removed"]);
  expect(settingsChanges(before, before)).toEqual([]);
});

test("the owner's Stop and an agent's start and end", () => {
  // A stop nobody named is a stop, and nobody's: it read "stopped by the owner".
  expect([stopLine("owner"), stopLine(undefined), stopLine("hook"), stopLine("send_now")]).toEqual(["[turn] stopped by the owner", "[turn] stopped", "[turn] stopped by a hook", "[turn] ended when the owner sent a new message"]);
  const a = { title: "Tool lane 3", type: "general", status: "running" as const, created: 1000, ended: null, end_reason: null, background: true, machine: null };
  expect(agentLine(a, undefined)).toBe('[agent] started: "Tool lane 3" (general, in the background)');
  // The same state again says nothing; its end says how and after how long.
  expect(agentLine(a, "running")).toBeNull();
  expect(agentLine({ ...a, status: "failed", ended: 8000, end_reason: "error" }, "running")).toBe('[agent] ended: "Tool lane 3" failed after 7 s (error)');
  expect(agentLine({ ...a, status: "completed", ended: 4000, end_reason: "end_turn" }, "running")).toBe('[agent] ended: "Tool lane 3" reported after 3 s');
  expect(agentLine({ ...a, status: "completed", ended: 4000 }, "completed")).toBeNull();
});

// A daemon that starts again hears of every agent it holds. It says "started" only of one
// made in this process, and "ended" only of one that ended in it.
test("after a restart an agent that was already running or had ended is not said again", () => {
  const began = 50_000;
  const a = { title: "Writer", type: "general", status: "running" as const, created: 1000, ended: null, end_reason: null, background: true, machine: null };
  // Still running, parked or ended before this process began: nothing, however often it is heard of.
  expect(agentLine(a, undefined, began)).toBeNull();
  expect(agentLine({ ...a, status: "waiting" as any }, undefined, began)).toBeNull();
  expect(agentLine({ ...a, status: "completed", ended: 40_000, end_reason: "end_turn" }, undefined, began)).toBeNull();
  // It ends in this process: said once.
  expect(agentLine({ ...a, status: "completed", ended: 60_000, end_reason: "end_turn" }, "running", began)).toBe('[agent] ended: "Writer" reported after 59 s');
  expect(agentLine({ ...a, status: "completed", ended: 60_000, end_reason: "end_turn" }, "completed", began)).toBeNull();
  // One made in this process is said as before.
  expect(agentLine({ ...a, created: 55_000 }, undefined, began)).toBe('[agent] started: "Writer" (general, in the background)');
});

// The log has two sinks: its file and the daemon's standard output (the journal, under a
// service unit). Both get one text, scrubbed before either: a secret of any of the six kinds,
// in any field a line carries, is in neither.
test("no secret reaches the log file or standard output, in any field a line carries", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "log-sinks-"));
  const G = globalThis as any;
  const had = G.__keelLogs;
  const methods = ["log", "info", "debug", "warn", "error"] as const;
  const saved = Object.fromEntries(methods.map((m) => [m, (console as any)[m]]));
  const printed: string[] = [];
  for (const m of methods) (console as any)[m] = (...a: unknown[]) => { printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  delete G.__keelLogs;
  const S = "01a1fd57-0861-7438-b6d5-030fa4213433";
  let lines = 0;
  let wordless = 0; // lines that print no value at all
  try {
    installLogs(dir);
    for (const [, secret] of SECRET_KINDS) {
      const agent = { title: `Deploy ${secret}`, type: "general", status: "running" as const, created: 1000, ended: null, end_reason: null, background: true, machine: `box ${secret}` };
      const texts: [string, ("info" | "warn")?][] = [
        // Titles, a machine's name and an end's reason.
        [agentLine(agent, undefined)!], [agentLine({ ...agent, status: "failed", ended: 9000, end_reason: `refused: ${secret}` }, "running")!, "warn"],
        // A setting's name and its value.
        [settingsLine(settingsChanges({ observe: { [`header ${secret}`]: "", otlp_endpoint: "" } }, { observe: { [`header ${secret}`]: secret, otlp_endpoint: secret } }))],
        // MCP server names, providers whose listing failed.
        [mcpLine([{ name: `srv ${secret}`, state: "error" }, { name: secret, state: "ready" }])], [providersLine({ available: [], failed: [`p ${secret}`], unset: 0 })],
        // Reasons, a backup's name and failure, the folders of a start, who stopped a turn.
        [drainLine({ restart: true, running: 1, timeoutMs: 1000, reason: `asked with ${secret}` })], [backupLine({ ok: false, ms: 1, error: `cannot write: ${secret}` }), "warn"], [backupLine({ ok: true, ms: 1, name: secret })],
        [exitLine({ restart: true, parked: 0, upMs: 1, reason: secret })], [startLine({ revision: "r", pid: 1, url: "http://127.0.0.1:1", state: `/state/${secret}`, config: "/c" })],
        // What a session went through: titles, a hook's reason, a tool's name, a loop's reason, a provider's message.
        [hookLine({ event: "PreToolUse", did: "refused Bash", reason: `no pushes with ${secret}`, title: `Lane ${secret}` }), "warn"],
        [approvalLine({ id: "a1", tool: `Bash ${secret}`, risk: "high", state: "pending", created: 1 }, undefined, `Lane ${secret}`)!],
        [failedLine({ cls: "rate limit", status: 429, title: `Lane ${secret}` }), "warn"],
        [messageLine({ id: "m1", from: `From ${secret}`, to: `To ${secret}`, state: "dropped", why: `refused: ${secret}` }), "warn"],
        [loopLine({ name: `Nightly ${secret}`, said: `failed: ${secret}`, title: `Lane ${secret}` })],
        [retryLine({ attempt: 1, max: 9, inMs: 1000, message: `401 invalid credentials: ${secret}`, title: `Lane ${secret}` }), "warn"],
      ];
      for (const [text, level] of texts) { say(text, level); lines++; }
      // (A stopper is one of a fixed set of words: one that is not is said as a stop, and never printed.)
      sayAt({ session: S }, stopLine(`a hook that printed ${secret}`)); lines++; wordless++;
      // Lines of other code: an MCP server's environment and stderr, a provider's error as text, as an Error and as an object.
      console.error(`[mcp] leaky failed to start with env GITHUB_TOKEN=${secret}: ${secret}`); lines++;
      console.error("[provider]", new Error(`401 invalid credentials: ${secret}`)); lines++;
      console.warn("[provider] request failed", { error: { message: `echoed ${secret}` }, headers: { authorization: secret } }); lines++;
      // A title so long that its cut would leave half a key: the value is scrubbed before it is cut.
      say(agentLine({ ...agent, title: `${"x".repeat(30)} ${secret}` }, undefined)!); lines++;
    }
    const file = readdirSync(join(dir, "logs")).map((f) => readFileSync(join(dir, "logs", f), "utf8")).join("");
    const kept = parseLines(file);
    expect(printed).toHaveLength(lines);
    // (A value the vault of this process already knows, from a test before this one, is its placeholder: hidden all the same.)
    const hidden = (l: string) => l.replace(/\[secret:[0-9a-f]{8}\]/g, "<redacted>");
    // One text for both sinks.
    expect(kept.map((l) => l.text)).toEqual(printed);
    for (const [kind, , mark] of SECRET_KINDS) {
      expect(`${kind}: ${printed.filter((l) => l.includes(mark)).join(" | ")}`).toBe(`${kind}: `);
      expect(`${kind}: ${file.includes(mark)}`).toBe(`${kind}: false`);
    }
    // The lines are still what they say: the words around the value stay.
    expect(hidden(printed[0]!)).toBe('[agent] started: "Deploy <redacted>" (general, in the background, on box <redacted>)');
    expect(printed.filter((l) => hidden(l).includes("<redacted>")).length).toBe(lines - wordless);
  } finally {
    for (const m of methods) (console as any)[m] = saved[m];
    if (had) G.__keelLogs = had; else delete G.__keelLogs;
    rmSync(dir, { recursive: true, force: true });
  }
});

// A daemon a command runs inside its own process (keel run with no daemon answering) has the
// command's standard output: the answer, or a protocol's lines. None of the daemon's own lines is
// written there, of any kind; what the command itself prints goes out as it was given.
test("inside a command's process no line of the daemon's own reaches standard output", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "log-client-"));
  const G = globalThis as any;
  const had = G.__keelLogs, was = runMode.client;
  const methods = ["log", "info", "debug", "warn", "error"] as const;
  const saved = Object.fromEntries(methods.map((m) => [m, (console as any)[m]]));
  const out: unknown[][] = [], err: unknown[][] = [];
  for (const m of methods) (console as any)[m] = (...a: unknown[]) => { (m === "warn" || m === "error" ? err : out).push(a); };
  delete G.__keelLogs;
  const S = "01a1fd57-0861-7438-b6d5-030fa4213433";
  try {
    installLogs(dir);
    runMode.client = true;
    const agent = { title: "Lane", type: "general", status: "running" as const, created: 1000, ended: null, end_reason: null, background: true, machine: null };
    // Every kind of line the daemon says of itself, through the three ways it says one.
    for (const line of [
      startLine({ revision: "r", pid: 1, url: "http://127.0.0.1:1", state: "/s", config: "/c" }), providersLine({ available: [{ id: "one", models: 1 }], failed: [], unset: 0 }), mcpLine([{ name: "a", state: "ready" }]),
      drainLine({ restart: false, running: 0, timeoutMs: 1000, reason: "a stop signal" }), backupLine({ ok: true, ms: 1, name: "b" }), exitLine({ restart: false, parked: 0, upMs: 1 }),
      settingsLine(["a.b set"]), "[daemon] 2 spans the last daemon left running were closed as interrupted; 2 queued for the collector",
    ]) say(line);
    sayAt({ session: S }, stopLine("owner"));
    sayAt({ session: S }, agentLine(agent, undefined)!);
    sayAt({ session: S }, agentLine({ ...agent, status: "completed", ended: 5000, end_reason: "end_turn" }, "running")!);
    logAt({ session: S }, "[turn] context compacted by itself, from 9000 tokens");
    logAt({ session: S }, "[turn] continued after the restart");
    logAt({ session: S }, "[turn] cut at step 1, during Bash, after 2 s: a daemon stop parked it");
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    // The lines said with a session are kept in the log's file; the serving daemon's story is not told at all.
    const file = readdirSync(join(dir, "logs")).map((f) => readFileSync(join(dir, "logs", f), "utf8")).join("");
    expect(parseLines(file).map((l) => [l.level, l.session, l.text])).toEqual([
      ["info", S, "[turn] context compacted by itself, from 9000 tokens"], ["info", S, "[turn] continued after the restart"], ["info", S, "[turn] cut at step 1, during Bash, after 2 s: a daemon stop parked it"],
    ]);
    // A warning still goes to standard error; what the command prints is its own, byte for byte.
    logAt({ session: S }, "[turn] not continued after the restart: held for the owner", "warn");
    const line = JSON.stringify({ type: "result", result: "sk-not-a-key and key=value pairs" });
    console.log(line);
    expect([out, err]).toEqual([[[line]], [["[turn] not continued after the restart: held for the owner"]]]);
  } finally {
    runMode.client = was;
    for (const m of methods) (console as any)[m] = saved[m];
    if (had) G.__keelLogs = had; else delete G.__keelLogs;
    rmSync(dir, { recursive: true, force: true });
  }
});

// The lines an incident is read from: an approval asked and answered with where from, the judge, a
// failed turn's class, a hook's reason, a message's state, a wait (late or not), a loop, a retry and the
// provider answering again, a cut command's fate. None quotes what was said or run.
test("what a session went through is one bounded line each, in plain words", () => {
  const card = { id: "01a2-card-e7a066d2", tool: "Bash", risk: "low", state: "pending", created: 1_000, reason: "the owner's own words" };
  expect(approvalLine(card, undefined, "Deny lane")).toBe('[approval] asked: Bash in "Deny lane" [card e7a066d2]');
  expect(approvalLine({ ...card, state: "denied", choice: "deny", resolved: 121_000 }, "the command line", "Deny lane")).toBe('[approval] denied from the command line after 2 min: Bash in "Deny lane", with a reason [card e7a066d2]');
  expect(approvalLine({ ...card, state: "allowed", choice: "session", resolved: 4_000, reason: undefined }, "the phone (Pixel)", "Allow lane")).toBe('[approval] allowed for the session from the phone (Pixel) after 3 s: Bash in "Allow lane" [card e7a066d2]');
  expect(judgedLine({ outcome: "refused", tool: "Bash", model: "judge-model" }, "Auto lane")).toBe('[approval] the judge refused Bash (judge-model) in "Auto lane"');
  expect(judgedLine({ outcome: "rule", tool: "Bash" }, "Auto lane")).toBeNull();
  expect(failedLine({ cls: "rate limit", status: 429, title: "Quota lane 1", steps: 1 })).toBe('[turn] failed: rate limit (HTTP 429) in "Quota lane 1", after 1 step');
  expect(hookLine({ event: "PostToolBatch", did: "stopped the turn", reason: "  the audit\nhook said stop  ", title: "Coordinator" })).toBe('[hook] PostToolBatch hook stopped the turn in "Coordinator": the audit hook said stop');
  expect(messageLine({ id: "01a2-msg-0000aaaa", from: "Msg sender", to: "Msg busy receiver", state: "queued", sent: true })).toBe('[message] sent from "Msg sender" to "Msg busy receiver": queued [message 0000aaaa]');
  expect(messageLine({ id: "01a2-msg-0000aaaa", from: "Msg sender", to: "Receiver", machine: "peerbox", state: "delivered", sent: true })).toBe('[message] sent from "Msg sender" to "Receiver" on peerbox: delivered [message 0000aaaa]');
  expect(messageLine({ id: "01a2-msg-0000aaaa", from: "Msg sender", to: "Gone", state: "dropped", why: "its session was archived before it was read" })).toBe('[message] to "Gone" from "Msg sender": not delivered (its session was archived before it was read) [message 0000aaaa]');
  expect(messageLine({ id: "", from: "Msg sender", to: "01a2046f-97f2", state: "refused", why: "that session is archived", sent: true })).toBe('[message] sent from "Msg sender" to "01a2046f-97f2": not sent (that session is archived)');
  expect(waitSetLine({ id: "9bd7cddf21cf", on: "a timer", due: 0, timer: true, title: "Parked lane 2", clock: () => "20:52" })).toBe('[wait] set on a timer in "Parked lane 2", due at 20:52 [wait 9bd7cddf21cf]');
  expect(waitEndLine({ id: "9bd7cddf21cf", on: "a timer", status: "fired", ms: 54 * 60_000, late: "14 min late: the daemon was down from 20:23 to 21:06", title: "Parked lane 2" }))
    .toBe('[wait] on a timer fired after 54 min, 14 min late: the daemon was down from 20:23 to 21:06 in "Parked lane 2" [wait 9bd7cddf21cf]');
  expect(loopLine({ name: "Broke loop", said: "failed: billing", title: "Loop home" })).toBe('[loop] "Broke loop" run failed: billing in "Loop home"');
  expect(retryLine({ attempt: 1, max: 9, inMs: 1000, message: "Lab: Unable to connect.", title: "Lab lane 5a" })).toBe('[provider] retrying the model request in "Lab lane 5a": try 2 of 10 in 1 s after Lab: Unable to connect.');
  expect(answeredLine({ tries: 6, ms: 62_000, title: "Lab lane 5a" })).toBe('[provider] answered again in "Lab lane 5a" after 6 tries over 1 min');
  expect(failedLine({ cls: "provider out of reach", title: "Lab lane 5a", tried: { tries: 10, ms: 127_000 } })).toBe('[turn] failed: provider out of reach in "Lab lane 5a", the request given up after 10 tries over 2 min');
  expect(cutCommandLine("The daemon restarted while this command ran. The command was not interrupted: it still runs in the background (ID: b8q9t5). Its output is being written to /home/x/spill/s/jobs/b8q9t5.log. Do not start it again: you are told when it ends.", "Long tool"))
    .toBe('[turn] the command a restart cut in "Long tool": The command was not interrupted: it still runs in the background (ID: b8q9t5).');
  expect(cutCommandLine("The daemon restarted while this command ran. The command was not interrupted: it exited with code 0 after 4 min; it ended at 20:27, while the daemon was down. Its output is in /x/y.log. Do not run it again for its result.", "Long tool"))
    .toBe('[turn] the command a restart cut in "Long tool": The command was not interrupted: it exited with code 0 after 4 min; it ended at 20:27, while the daemon was down.');
});
