// The servers an editor passes with a session (ACP's mcpServers): whose they
// are, what they are called, and what never happens to the owner's own list.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSources } from "../tools/catalog.ts";
import { McpManager, sessionEnv } from "./manager.ts";
import { runnable } from "./project.ts";
import { startSseMcp } from "../../test/e2e/fixtures/legacy-sse-mcp.ts";
import { ownEnv } from "../../test/env.ts";

ownEnv({ PROBE_HELPER_TOKEN: "daemon-credential" });

const errors = { capture() {} } as any;
const at = (path: string) => ({ url: `http://127.0.0.1:9/${path}` }); // nothing listens there: no server starts

test("a session's own servers are offered to it alone, never written to the owner's file, and go with the session", () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-session-")), file = join(d, "mcp.json");
  const m = new McpManager(errors, join(d, "state"), "/", file);
  expect(m.add("notes", { command: "x", enabled: false })).toBeNull();
  const owners = readFileSync(file, "utf8");
  const own = (session?: string) => m.list(session).filter((x) => x.session).map((x) => x.name);

  const set = m.setSessionServers("s1", [
    { name: "notes", config: at("a") },                                  // the owner has a server of that name
    { name: "My Tools!", config: at("b") },                              // not a name a tool can carry
    { name: "web", config: at("c") },                                    // a built-in group's name
    { name: "old", config: { ...at("d"), transport: "sse" } },           // a transport Keel does not speak
    { name: "both", config: { command: "x", ...at("e") } },
  ], { cwd: "/" });
  expect(set.map((x) => [x.name, x.label ?? null, !!x.error])).toEqual([["notes", "notes-editor", false], ["My Tools!", "My-Tools", false], ["web", "web-editor", false], ["old", null, true], ["both", null, true]]);
  expect([own("s1"), own("s2"), own()]).toEqual([["My-Tools", "notes-editor", "web-editor"], [], []]);
  expect([catalogSources("s1"), catalogSources("s2"), catalogSources()].map((l) => l.filter((s) => s.session).length)).toEqual([3, 0, 0]);
  expect(readFileSync(file, "utf8")).toBe(owners);

  // The owner's routes cannot name one, and reading the file again leaves them.
  expect([m.has("notes"), m.has("notes-editor@s1"), m.has("notes-editor")]).toEqual([true, false, false]);
  m.reload();
  expect(own("s1")).toHaveLength(3);
  expect(readFileSync(file, "utf8")).toBe(owners);

  // Another session may pass the same name; each list is whole, so one not named again goes.
  m.setSessionServers("s2", [{ name: "My Tools!", config: at("b") }]);
  m.setSessionServers("s1", [{ name: "My Tools!", config: at("b") }]);
  expect([own("s1"), own("s2")]).toEqual([["My-Tools"], ["My-Tools"]]);
  m.releaseSession("s1");
  expect([own("s1"), own("s2"), catalogSources("s1").some((s) => s.session)]).toEqual([[], ["My-Tools"], false]);
  m.dispose();
});

test("a session's command gets what the editor gave, as given, and of the daemon's environment only what any program needs", () => {
  const daemon = {
    HOME: "/home/o", PATH: "/bin", LANG: "C.UTF-8", LC_ALL: "C", TMPDIR: "/t", USER: "o", XDG_RUNTIME_DIR: "/run/user/1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x", SSH_AUTH_SOCK: "/s",
    PROBE_API_KEY: "v-apikey", ANTHROPIC_PROBE_SETTING: "v-anthropic", AWS_PROBE_REGION: "v-aws", XAI_BASE: "v-xai", OPENROUTER_SITE: "v-or", OLLAMA_HOST: "v-ollama", VERTEX_PROJECT: "v-vertex", KEEL_STATE_DIR: "/state", PLAIN_SETTING: "v-plain",
  };
  const given = { command: "srv", env: { MINE: "1", NAMED: "${PROBE_API_KEY}", HOME: "/editor/home" } };
  // The editor's own value for a name wins; a name of the daemon's inside a value stays those characters.
  expect(sessionEnv(given, false, daemon)).toEqual({ HOME: "/editor/home", PATH: "/bin", LANG: "C.UTF-8", LC_ALL: "C", TMPDIR: "/t", USER: "o", MINE: "1", NAMED: "${PROBE_API_KEY}" });
  // Inside the sandbox its launcher also gets the way to the user's service manager.
  expect(Object.keys(sessionEnv({ command: "srv" }, true, daemon)).sort()).toEqual(["DBUS_SESSION_BUS_ADDRESS", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "USER", "XDG_RUNTIME_DIR"]);

  // The same holds for what reaches the process and the wire: nothing is expanded, no header or sign-in of the daemon's is added.
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-session-"));
  const m = new McpManager(errors, join(d, "state"), "/");
  process.env.KEEL_TEST_PROBE_VALUE = "v-probe";
  try {
    m.setSessionServers("s1", [
      { name: "cmd", config: { command: "${KEEL_TEST_PROBE_VALUE}", args: ["--key=${KEEL_TEST_PROBE_VALUE}"], env: { K: "${KEEL_TEST_PROBE_VALUE}" }, env_vars: ["KEEL_TEST_PROBE_VALUE"], cwd: "/elsewhere" } as any },
      { name: "web", config: { url: "http://127.0.0.1:9/${KEEL_TEST_PROBE_VALUE}", headers: { Authorization: "Bearer ${KEEL_TEST_PROBE_VALUE}" }, headers_env: { X: "KEEL_TEST_PROBE_VALUE" }, bearer_env: "KEEL_TEST_PROBE_VALUE", headers_helper: "echo '{}'" } as any },
    ], { cwd: "/" });
    const sent = [...(m as any).entries.values()].map((e: any) => (m as any).transport(e));
    expect(JSON.stringify(sent)).not.toContain("v-probe");
    expect(sent[0]).toMatchObject({ kind: "stdio", command: "${KEEL_TEST_PROBE_VALUE}", args: ["--key=${KEEL_TEST_PROBE_VALUE}"], cwd: "/" });
    expect([sent[0].env.K, "KEEL_TEST_PROBE_VALUE" in sent[0].env]).toEqual(["${KEEL_TEST_PROBE_VALUE}", false]);
    expect(sent[1]).toEqual({ kind: "http", url: "http://127.0.0.1:9/${KEEL_TEST_PROBE_VALUE}", headers: { Authorization: "Bearer ${KEEL_TEST_PROBE_VALUE}" } });
    // What the editor may not set is not kept at all.
    expect([...(m as any).entries.values()].map((e: any) => Object.keys(e.config).sort())).toEqual([["args", "command", "cwd", "env"], ["headers", "url"]]);
  } finally {
    delete process.env.KEEL_TEST_PROBE_VALUE;
    m.dispose();
  }
});

test("a session whose tools run on another machine gets no command of the editor's, and a name the owner takes later is the owner's", () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-session-")), file = join(d, "mcp.json");
  const m = new McpManager(errors, join(d, "state"), "/", file);
  const set = m.setSessionServers("far", [{ name: "cmd", config: { command: "srv" } }, { name: "web", config: at("a") }], { cwd: "/", remote: "peer-1" });
  expect(set.map((x) => [x.name, x.label ?? null, x.error ?? null])).toEqual([["cmd", null, expect.stringContaining("another machine (peer-1)")], ["web", "web-editor", null]]);

  // The editor's server came first under a name the owner then gives a server of their own.
  m.setSessionServers("s1", [{ name: "later", config: at("b") }]);
  m.setSessionServers("s2", [{ name: "later", config: at("b") }]);
  expect(m.add("later", { command: "x", enabled: false })).toBeNull();
  const names = (session?: string) => m.list(session).filter((x) => /^later/.test(x.name)).map((x) => [x.name, !!x.session]);
  expect([names("s1"), names("s2"), names()]).toEqual([[["later", false], ["later-editor", true]], [["later", false], ["later-editor", true]], [["later", false]]]);
  // And the shared sources come first in what a session is offered.
  expect(catalogSources("s1").map((s) => !!s.session)).toEqual([...catalogSources().map(() => false), true]);
  // The same when the owner's file gains the name and is read again.
  m.setSessionServers("s3", [{ name: "filed", config: at("c") }]);
  writeFileSync(file, JSON.stringify({ servers: { later: { command: "x", enabled: false }, filed: { command: "y", enabled: false } } }));
  m.reload();
  expect(m.list("s3").filter((x) => /^filed/.test(x.name)).map((x) => [x.name, !!x.session])).toEqual([["filed", false], ["filed-editor", true]]);
  m.dispose();
});

test("a session's command runs where the session's sandbox says, is started again when that changes, and ends at once when dropped while it connects", async () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-session-"));
  const m = new McpManager(errors, join(d, "state"), "/");
  const pid = join(d, "pid"), runs = join(d, "runs");
  // What the route gives: the argv wrapped for the session's sandbox, or a refusal. Here the wrap counts its runs.
  let profile = "read-only";
  m.sessionSandbox = (_s, argv) => (profile === "none here" ? { refuse: "this machine cannot give a sandbox" } : { argv: ["sh", "-c", `echo ${profile} >> ${runs}; exec "$@"`, "wrapped", ...argv], as: profile });
  // A command that never answers the handshake.
  m.setSessionServers("s1", [{ name: "slow", config: { command: "sh", args: ["-c", `echo $$ > ${pid}; exec sleep 60`] } }], { cwd: d });
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(50); return ok(); };
  expect(await until(() => existsSync(pid))).toBe(true);
  const first = Number(readFileSync(pid, "utf8"));
  expect([alive(first), readFileSync(runs, "utf8"), m.list("s1").find((x) => x.session)?.state]).toEqual([true, "read-only\n", "connecting"]);
  // The sandbox changed: the old process ends and the command starts under the new one. The same profile again starts nothing.
  profile = "workspace-write";
  m.sessionPermChanged("s1");
  expect(await until(() => !alive(first) && readFileSync(runs, "utf8") === "read-only\nworkspace-write\n")).toBe(true);
  m.sessionPermChanged("s1");
  await Bun.sleep(150);
  expect(readFileSync(runs, "utf8")).toBe("read-only\nworkspace-write\n");
  const second = Number(readFileSync(pid, "utf8"));
  // Dropped while it still connects: gone now, not when the handshake would have given up.
  m.setSessionServers("s1", []);
  expect(await until(() => !alive(second))).toBe(true);
  // A sandbox this machine cannot give: refused by name when the list is set, like the other refusals, and nothing is started or kept.
  profile = "none here";
  expect(m.setSessionServers("s1", [{ name: "slow", config: { command: "sh", args: ["-c", `echo never >> ${runs}`] } }], { cwd: d })).toEqual([{ name: "slow", error: "this machine cannot give a sandbox" }]);
  expect(m.list("s1").filter((x) => x.session)).toEqual([]);
  // One that runs when the session then asks for such a sandbox is stopped, not left outside it, and the list says why.
  profile = "off";
  m.setSessionServers("s1", [{ name: "slow", config: { command: "sh", args: ["-c", `echo again >> ${runs}; echo $$ > ${pid}; exec sleep 60`] } }], { cwd: d });
  expect(await until(() => readFileSync(runs, "utf8").endsWith("write\nagain\n"))).toBe(true);
  const third = Number(readFileSync(pid, "utf8"));
  profile = "none here";
  m.sessionPermChanged("s1");
  expect(await until(() => !alive(third) && m.list("s1").find((x) => x.session)?.state === "error")).toBe(true);
  expect(m.list("s1").find((x) => x.session)?.error).toBe("this machine cannot give a sandbox");
  // The sandbox is one the machine has again: the command is started again.
  profile = "off";
  m.sessionPermChanged("s1");
  expect(await until(() => readFileSync(runs, "utf8").endsWith("again\nagain\n"))).toBe(true);
  // The editor's socket closed: everything it held ends.
  m.setSessionServers("s2", [{ name: "held", config: at("h") }], { holder: "h1" });
  m.setSessionServers("s3", [{ name: "kept", config: at("k") }], { holder: "h2" });
  m.releaseHolder("h1");
  expect([m.list("s2").filter((x) => x.session).length, m.list("s3").filter((x) => x.session).length]).toEqual([0, 1]);
  m.dispose();
}, 30_000);

test("what a session's own server does is told as it happens: its start with what runs, a failure in one line, its end; never a value of its environment or headers", async () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-session-"));
  const m = new McpManager(errors, join(d, "state"), "/");
  const told: string[] = [];
  m.onSessionServer = (e) => void told.push(`${e.what} ${e.name}: ${e.target}${e.error ? ` (${e.error})` : ""}`);
  const fixture = join(import.meta.dir, "../../test/e2e/fixtures/editor-mcp.ts");
  // An address that redirects, and where it points: no server is followed there.
  let hits = 0;
  const there = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return new Response("{}"); } });
  const here = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`http://127.0.0.1:${there.port}/mcp`, 307) });
  try {
    m.setSessionServers("s1", [
      { name: "notes", config: { command: "bun", args: [fixture, "--flag"], env: { NOTES_TOKEN: "env-value-1" } } },
      { name: "gone", config: { command: join(d, "no-such-server") } },
      { name: "moved", config: { url: `http://127.0.0.1:${here.port}/mcp?key=query-value-3`, headers: { Authorization: "Bearer header-value-4" } } },
    ], { cwd: d });
    const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(50); return ok(); };
    expect(await until(() => told.length >= 3)).toBe(true);
    expect(told.sort()).toEqual([
      expect.stringMatching(/^failed gone: .*no-such-server \(.+\)$/),
      expect.stringMatching(new RegExp(`^failed moved: http://127\\.0\\.0\\.1:${here.port}/mcp \\(http://127\\.0\\.0\\.1:${here.port} answered with a redirect to http://127\\.0\\.0\\.1:${there.port}/mcp, which is not followed`)),
      `started notes: bun ${fixture} --flag`,
    ]);
    expect(hits).toBe(0);
    // The list a session's view reads shows the same and no more.
    const shown = m.list("s1").filter((x) => x.session).map((x) => [x.name, x.state, x.target, (x.error ?? "").includes("\n")]);
    expect(shown).toEqual([["gone", "error", join(d, "no-such-server"), false], ["moved", "error", `http://127.0.0.1:${here.port}/mcp`, false], ["notes", "ready", `bun ${fixture} --flag`, false]]);
    // It ends with its session, and that is told for the one that ran.
    m.releaseSession("s1");
    expect(told.filter((t) => t.startsWith("ended"))).toEqual([`ended notes: bun ${fixture} --flag`]);
    for (const value of ["env-value-1", "query-value-3", "header-value-4"]) expect(JSON.stringify([told, shown])).not.toContain(value);
  } finally {
    m.dispose();
    here.stop(true);
    there.stop(true);
  }
}, 30_000);

// INT-S23: a project's .mcp.json entry runs as Claude Code runs it once the owner approved it: its older SSE
// transport, its headers helper (in the project's folder, told the server's name and address, with no credential
// of the daemon's, in the session's sandbox) and its call time limit. An editor's server gets none of that.
test("an approved project server keeps its SSE transport, headers helper and time limit; an editor's server does not", async () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-project-"));
  writeFileSync(join(d, "token.txt"), "from-the-project");
  const s = startSseMcp();
  const m = new McpManager(errors, join(d, "state"), "/");
  const wrapped: string[][] = [];
  m.sessionSandbox = (_s, argv) => (wrapped.push(argv), { argv: ["sh", "-c", 'exec "$@"', "wrapped", ...argv], as: "read-only" });
  const helper = `printf '{"Authorization":"Bearer %s|%s|%s|%s"}' "$(cat token.txt)" "$CLAUDE_CODE_MCP_SERVER_NAME" "$CLAUDE_CODE_MCP_SERVER_URL" "$PROBE_HELPER_TOKEN"`;
  const entry = { type: "sse", url: s.url, headersHelper: helper, timeout: 120_000 };
  try {
    expect(m.setSessionServers("s1", [{ name: "events", config: runnable(entry) }], { cwd: d, project: d })).toEqual([{ name: "events", label: "events" }]);
    const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(50); return ok(); };
    expect(await until(() => m.list("s1").find((x) => x.session)?.state === "ready")).toBe(true);
    expect((await s.stats()).authorization).toEqual([`Bearer from-the-project|events|${s.url}|`]);
    expect(wrapped).toEqual([["sh", "-c", helper]]);
    const e = [...(m as any).entries.values()].find((x: any) => x.session === "s1");
    expect([e.config.tool_max_secs, e.config.tool_timeout_secs]).toEqual([120, 120]);
    // A time limit under a second is ignored, as Claude Code ignores it.
    expect(runnable({ ...entry, timeout: 500 }).tool_max_secs).toBeUndefined();
    // The same entry from an editor: its SSE is refused by name, and no helper or time limit is taken.
    expect(m.setSessionServers("s2", [{ name: "events", config: runnable(entry) }], { cwd: d })).toEqual([{ name: "events", error: expect.stringContaining("SSE") }]);
    m.setSessionServers("s3", [{ name: "plain", config: runnable({ ...entry, type: "http" }) }], { cwd: d });
    const plain = [...(m as any).entries.values()].find((x: any) => x.session === "s3");
    expect([plain.config.headers_helper, plain.config.tool_max_secs]).toEqual([undefined, undefined]);
  } finally {
    m.dispose();
    s.stop();
  }
}, 30_000);

// Review of round 3, P2-c: a helper that hangs, or leaves a child holding its output, is stopped whole.
test("a headers helper is stopped with what it started: past its time, and when it ends leaving a child behind", async () => {
  const { helperHeaders } = await import("./manager.ts");
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-helper-"));
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const pid = (f: string) => Number(readFileSync(join(d, f), "utf8"));
  // Hangs, with a child in the background: refused at its time, and neither is left running.
  let t0 = Date.now();
  await expect(helperHeaders(`sleep 30 & echo $! > ${d}/bg; echo $$ > ${d}/sh; sleep 30; echo '{}'`, 500)).rejects.toThrow("did not finish within 1 s");
  expect(Date.now() - t0).toBeLessThan(3000);
  for (let i = 0; i < 40 && (alive(pid("bg")) || alive(pid("sh"))); i++) await Bun.sleep(25);
  expect([alive(pid("bg")), alive(pid("sh"))]).toEqual([false, false]);
  // Prints its headers and ends, its child still holding the output: the headers come at once, and the child is stopped.
  t0 = Date.now();
  expect(await helperHeaders(`sleep 30 & echo $! > ${d}/left; echo '{"Authorization":"Bearer t"}'`, 5000)).toEqual({ Authorization: "Bearer t" });
  expect(Date.now() - t0).toBeLessThan(2500);
  for (let i = 0; i < 40 && alive(pid("left")); i++) await Bun.sleep(25);
  expect(alive(pid("left"))).toBe(false);
}, 20_000);
