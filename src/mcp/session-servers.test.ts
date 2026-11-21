// The servers an editor passes with a session (ACP's mcpServers): whose they
// are, what they are called, and what never happens to the owner's own list.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSources } from "../tools/catalog.ts";
import { McpManager, sessionEnv } from "./manager.ts";

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
    expect(sent[1]).toEqual({ kind: "http", url: "http://127.0.0.1:9/${KEEL_TEST_PROBE_VALUE}", headers: { Authorization: "Bearer ${KEEL_TEST_PROBE_VALUE}" }, pinned: true });
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
  // A sandbox this machine cannot give: the command is not started outside one, and the list says why.
  profile = "none here";
  m.setSessionServers("s1", [{ name: "slow", config: { command: "sh", args: ["-c", `echo never >> ${runs}`] } }], { cwd: d });
  expect(await until(() => m.list("s1").find((x) => x.session)?.state === "error")).toBe(true);
  expect([m.list("s1").find((x) => x.session)?.error, readFileSync(runs, "utf8")]).toEqual(["this machine cannot give a sandbox", "read-only\nworkspace-write\n"]);
  // The session's sandbox is turned off: the command it was refused for is started.
  profile = "off";
  m.sessionPermChanged("s1");
  expect(await until(() => readFileSync(runs, "utf8").endsWith("never\n"))).toBe(true);
  // The editor's socket closed: everything it held ends.
  m.setSessionServers("s2", [{ name: "held", config: at("h") }], { holder: "h1" });
  m.setSessionServers("s3", [{ name: "kept", config: at("k") }], { holder: "h2" });
  m.releaseHolder("h1");
  expect([m.list("s2").filter((x) => x.session).length, m.list("s3").filter((x) => x.session).length]).toEqual([0, 1]);
  m.dispose();
}, 30_000);
