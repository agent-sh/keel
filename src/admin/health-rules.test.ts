import { expect, test } from "bun:test";
import { DISK_BROKEN, diskRow, hookRows, layerRows, mcpRows, matcherVerdict, processRows, providerRows, sandboxRows, telemetryRows, type MatcherFacts } from "./health-rules.ts";

const facts: MatcherFacts = {
  tools: new Set(["Bash", "Edit", "Write", "Read", "shell", "mcp_call"]),
  values: { SessionStart: ["startup", "clear", "compact"], PreCompact: ["manual", "auto"] },
};

test("a hook matcher that can never match is broken, one that is ignored is a warning", () => {
  // Matches: exact names, alternatives, patterns, everything.
  for (const m of [undefined, "", "*", "Bash", "Edit|Write", "^(Bash|Read)$", "Re.d", "mcp__github__create_issue"]) expect([m, matcherVerdict("PreToolUse", m, facts)]).toEqual([m, null]);
  // A name no tool has (the plain form is exact and case sensitive), and a pattern that fits none.
  expect(matcherVerdict("PreToolUse", "bash", facts)?.level).toBe("broken");
  expect(matcherVerdict("PostToolUse", "Shell|Terminal", facts)?.level).toBe("broken");
  expect(matcherVerdict("PreToolUse", "^Run.*$", facts)?.level).toBe("broken");
  // An event with a fixed set of values.
  expect(matcherVerdict("SessionStart", "startup|clear", facts)).toBeNull();
  expect(matcherVerdict("SessionStart", "resume", facts)?.fix).toContain("startup, clear, compact");
  // An event that is never matched: the hook runs every time.
  expect(matcherVerdict("Stop", "Bash", facts)).toMatchObject({ level: "warning" });
  // Events whose values come and go are not judged.
  expect(matcherVerdict("SubagentStart", "reviewer", facts)).toBeNull();
});

test("hook rows: a dead matcher and a file's own problems are rows, a clean set is one ok row", () => {
  const rows = hookRows([
    { path: "/o/hooks.json", scope: "owner", active: true, problems: ["PreToolUse: matcher [ is not a regular expression"], groups: [{ path: "/o/hooks.json", event: "PreToolUse", matcher: "Bsh" }, { path: "/o/hooks.json", event: "PreToolUse", matcher: "Bash" }] },
    { path: "/r/.keel/hooks.json", scope: "project", active: false, problems: ["not pinned: the owner reads the file and pins it before it runs"], groups: [] },
  ], facts);
  expect(rows.map((r) => [r.level, r.title.slice(0, 40)])).toEqual([
    ["broken", "owner hooks file: PreToolUse: matcher [ "],
    ["broken", 'PreToolUse matcher "Bsh"'],
    ["warning", "project hooks file does not run"],
  ]);
  expect(rows[2]!.fix).toContain("pin");
  expect(hookRows([{ path: "/o/hooks.json", scope: "owner", active: true, problems: [], groups: [{ path: "/o/hooks.json", event: "PreToolUse", matcher: "Bash" }] }], facts)).toMatchObject([{ level: "ok", title: "1 hook group read, every matcher can match" }]);
});

test("the sandbox: broken when the profile needs it and it cannot start, a warning when nothing needs it", () => {
  const up = { platform: "linux", profile: "workspace-write", bwrap: "/usr/bin/bwrap", started: true, scope: true };
  expect(sandboxRows(up).map((r) => r.level)).toEqual(["ok"]);
  const dead = { ...up, started: false, said: "bwrap: setting up uid map: Permission denied" };
  expect(sandboxRows(dead)[0]).toMatchObject({ level: "broken", title: "bwrap cannot start a sandbox here" });
  expect(sandboxRows(dead)[0]!.detail).toContain("Permission denied");
  expect(sandboxRows({ ...dead, profile: "off" })[0]!.level).toBe("warning");
  expect(sandboxRows({ platform: "linux", profile: "read-only" })[0]).toMatchObject({ level: "broken", title: "bubblewrap (bwrap) is not installed" });
  expect(sandboxRows({ ...up, timedOut: true, started: false })[0]!.level).toBe("warning");
  expect(sandboxRows({ ...up, scope: false, scopeSaid: "no user manager" }).map((r) => r.id)).toEqual(["sandbox:ok", "sandbox:scope"]);
  expect(sandboxRows({ platform: "darwin", profile: "off" })[0]!.level).toBe("ok");
});

test("the daemon's own process: what its environment and the kernel's Yama setting leave open", () => {
  const ids = (f: Parameters<typeof processRows>[0]) => processRows(f).map((r) => `${r.level} ${r.id}`);
  expect(ids({ platform: "linux", held: [], yama: 1 })).toEqual(["ok sandbox:environment", "ok sandbox:ptrace"]);
  expect(processRows({ platform: "linux", held: [], yama: 1 })[1]!.title).toBe("ptrace limited to ancestors (Yama 1)");
  const open = processRows({ platform: "linux", held: ["OPENAI_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"], yama: 0 });
  expect(open.map((r) => r.level)).toEqual(["warning", "warning"]);
  expect(open[0]!.detail).toContain("OPENAI_API_KEY, AWS_BEARER_TOKEN_BEDROCK");
  expect(open[1]!.title).toBe("ptrace is not limited to ancestors (Yama 0)");
  // No Yama in the kernel is open; an environment that cannot be read says nothing of itself; other systems say nothing.
  expect(ids({ platform: "linux", held: null })).toEqual(["warning sandbox:ptrace"]);
  expect(processRows({ platform: "darwin", held: null })).toEqual([]);
});

test("telemetry: an exporter that is on and has nowhere to send is broken", () => {
  expect(telemetryRows({}, {}).map((r) => [r.id, r.level])).toEqual([["telemetry:ok", "ok"]]);
  expect(telemetryRows({}, { OTEL_METRICS_EXPORTER: "otlp" })).toMatchObject([{ id: "telemetry:metrics", level: "broken" }]);
  expect(telemetryRows({ otlp_events: true }, {})).toMatchObject([{ id: "telemetry:logs", level: "broken" }]);
  expect(telemetryRows({}, { OTEL_TRACES_EXPORTER: "otlp" })).toMatchObject([{ id: "telemetry:traces", level: "broken" }]);
  // An endpoint in the environment, or in the settings ending in /v1/traces, is somewhere to send.
  expect(telemetryRows({}, { OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }).map((r) => r.level)).toEqual(["ok"]);
  expect(telemetryRows({ otlp_endpoint: "http://c:4318/v1/traces", otlp_metrics: true }, {}).map((r) => r.level)).toEqual(["ok"]);
  // A traces endpoint of another shape gives the other signals no address.
  expect(telemetryRows({ otlp_endpoint: "http://c:4318/traces", otlp_metrics: true }, {})[0]!.detail).toContain("does not end in /v1/traces");
  expect(telemetryRows({ otlp_headers: { env: "X" } }, {})).toMatchObject([{ id: "telemetry:headers", level: "warning" }]);
});

test("settings layers: a setting that hides a variable, a file that is not loaded, an unreadable settings.json", () => {
  const none = { refused: [], observe: {}, env: {} };
  expect(layerRows(none)).toEqual([]);
  const rows = layerRows({
    unreadable: "Unexpected token",
    refused: [{ name: "KEEL_HOOKS", path: "/ws/hooks.json", folder: "/ws" }],
    observe: { otlp_endpoint: "http://a:4318/v1/traces", otlp_metrics: false },
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://b:4318", OTEL_METRICS_EXPORTER: "otlp" },
  });
  expect(rows.map((r) => [r.id, r.level])).toEqual([["settings:unreadable", "broken"], ["settings:refused:KEEL_HOOKS", "broken"], ["settings:otlp-endpoint", "warning"], ["settings:otlp-metrics", "warning"]]);
  expect(rows[1]!.link).toEqual({ section: "hooks" });
  // A setting and a variable that agree hide nothing.
  expect(layerRows({ ...none, observe: { otlp_metrics: true }, env: { OTEL_METRICS_EXPORTER: "otlp" } })).toEqual([]);
});

test("the disk: broken under a gibibyte, a warning while a backup copy would not fit", () => {
  const G = 1024 ** 3;
  const row = (free: number, database = 0.2 * G) => diskRow({ path: "/s", free, total: 100 * G, database });
  expect(row(DISK_BROKEN - 1).level).toBe("broken");
  expect(row(3 * G).level).toBe("warning");
  expect(row(20 * G).level).toBe("ok");
  // A large database needs twice its size free.
  expect(row(20 * G, 12 * G).level).toBe("warning");
});

test("MCP servers: a server that fails to start is broken, one that waits for a sign-in a warning, a disabled one is left out", () => {
  const rows = mcpRows([
    { name: "a", enabled: true, state: "ready" },
    { name: "b", enabled: true, state: "error", error: "spawn x ENOENT", transport: "stdio", target: "x --serve" },
    { name: "c", enabled: true, state: "needs_auth" },
    { name: "d", enabled: false, state: "disabled" },
    { name: "e", enabled: true, state: "ready", held: true },
    // A server Keel brings that is not set up (the browser bridge, the phone) is not a failure to start.
    { name: "chrome", enabled: true, bundled: true, state: "missing", error: "not installed" },
    { name: "phone", enabled: true, bundled: true, state: "unreachable" },
  ]);
  expect(rows.map((r) => [r.id, r.level])).toEqual([["mcp:b", "broken"], ["mcp:c", "warning"], ["mcp:e:held", "warning"]]);
  expect(rows[0]!.detail).toBe("spawn x ENOENT");
  expect(mcpRows([{ name: "a", enabled: true, state: "ready" }])).toMatchObject([{ level: "ok", title: "1 MCP server set up, none failing" }]);
});

test("providers: each row says which call was made and what came back", () => {
  const rows = providerRows([
    { id: "a", label: "A", how: "its model listing", result: { ms: 120, models: 9 } },
    { id: "b", label: "B", how: "its model listing", result: { error: "B: HTTP 401: invalid x-api-key" } },
    { id: "c", label: "C", how: "its model listing", result: { timedOut: 8000 } },
    { id: "d", label: "D", how: "no call made", result: { skipped: "answers locally" } },
    { id: "e", label: "E", how: "its model listing", result: { ms: 5, models: 1 }, problem: { kind: "billing", message: "out of credit", source: "turn" } },
  ]);
  expect(rows.map((r) => [r.id, r.level])).toEqual([["provider:a", "ok"], ["provider:b", "broken"], ["provider:c", "warning"], ["provider:d", "ok"], ["provider:e", "broken"]]);
  expect(rows[0]!.detail).toBe("9 models listed in 120 ms");
  expect(rows[1]!.fix).toContain("key");
  expect(rows[4]!.fix).toContain("credit");
  expect(providerRows([])[0]!.level).toBe("warning");
});
