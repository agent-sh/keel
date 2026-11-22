// The words of the daemon's own lines in its log: bounded, and a settings
// change never shows a value that could be a secret.
import { expect, test } from "bun:test";
import { agentLine, backupLine, drainLine, exitLine, mcpLine, providersLine, settingsChanges, settingsLine, startLine, stopLine } from "./daemon-log.ts";

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
  expect([stopLine("owner"), stopLine(undefined), stopLine("hook")]).toEqual(["[turn] stopped by the owner", "[turn] stopped by the owner", "[turn] stopped by a hook"]);
  const a = { title: "Tool lane 3", type: "general", status: "running" as const, created: 1000, ended: null, end_reason: null, background: true, machine: null };
  expect(agentLine(a, undefined)).toBe('[agent] started: "Tool lane 3" (general, in the background)');
  // The same state again says nothing; its end says how and after how long.
  expect(agentLine(a, "running")).toBeNull();
  expect(agentLine({ ...a, status: "failed", ended: 8000, end_reason: "error" }, "running")).toBe('[agent] ended: "Tool lane 3" failed after 7 s (error)');
  expect(agentLine({ ...a, status: "completed", ended: 4000, end_reason: "end_turn" }, "running")).toBe('[agent] ended: "Tool lane 3" reported after 3 s');
  expect(agentLine({ ...a, status: "completed", ended: 4000 }, "completed")).toBeNull();
});
