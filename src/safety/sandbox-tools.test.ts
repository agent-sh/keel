// The file tools of a session against what its sandbox allows, through the
// real gate: every family's tools, every mode, both profiles. A file tool
// runs in the daemon, outside the sandbox, so the gate is all that holds it
// to what the session's commands may read and write.
//
// - Keel's own state is never written by a session's tool, by path, through
//   a link, through a hard link or through `..`, in any mode, sandboxed or
//   not, Full auto included. Keel's own config (skills, hooks, MCP servers,
//   settings) is the owner's own card in the asking modes; Full auto checks
//   nothing, so there it runs.
// - A sandbox is containment, not a check, and it holds in Full auto too. In
//   a sandboxed session a file tool reads what the sandbox shows: anything
//   else is the owner's card, and refused in Full auto, where nobody is asked.
// - In a sandboxed Full auto session a file tool writes only inside the
//   session's writable folders, by where the file really is (Keel's config
//   is outside them).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../core/bus.ts";
import { gitViewsDir, setGitViews } from "../core/git.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { configDir } from "../providers/config.ts";
import { claudeTools } from "../tools/claude.ts";
import { geminiTools } from "../tools/gemini.ts";
import { gptTools } from "../tools/gpt.ts";
import { Gate } from "./gate.ts";
import { classOf } from "../acp/external.ts";
import type { Mode } from "./policy.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-tools-")));
const home = join(root, "home"), ws = join(root, "ws"), state = join(root, "state");
const was = { HOME: process.env.HOME, views: dirname(gitViewsDir()) };
let store: Store, gate: Gate, session: Session, other: Session, atHome: Session;
const put = (path: string, text = "x\n") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const tool = (name: string) => [...claudeTools, ...geminiTools, ...gptTools].find((t) => t.name === name)!;

beforeAll(() => {
  process.env.HOME = home;
  setGitViews(state);
  store = new Store(state);
  // (A session is sandboxed when its profile says so: no sandbox program is run here.)
  gate = new Gate(store, new Bus(), (_s, p) => p.sandbox !== "off");
  mkdirSync(ws, { recursive: true });
  session = store.createSession({ model: "fixture:m", workspace: ws });
  other = store.createSession({ model: "fixture:m", workspace: join(root, "elsewhere") });
  atHome = store.createSession({ model: "fixture:m", workspace: home });
  // The owner's: a key, a sign-in file no list names, another project's secrets.
  put(join(home, ".ssh/id_ed25519"), "KEY\n");
  put(join(home, ".config/pypoetry/auth.toml"), "TOKEN\n");
  put(join(home, "projects/other/.env"), "ENV\n");
  // Keel's own: the state's files, the config, another session's files, this session's files.
  put(join(state, "api-token"), "TOKEN\n");
  put(join(state, "settings.json"), "{}\n");
  put(join(configDir(), "sandbox.json"), "{}\n");
  put(join(configDir(), "skills/x/SKILL.md"), "# skill\n");
  put(join(state, "spill", other.id, "out.txt"), "OTHER\n");
  put(join(state, "artifacts", other.id, "a.md"), "OTHER\n");
  put(join(state, "spill", session.id, "out.txt"), "MINE\n");
  put(join(state, "artifacts", session.id, "a.md"), "MINE\n");
  // In the workspace: an ordinary file, and three other ways to one of Keel's files and to the key.
  put(join(ws, "src/a.ts"), "export const a = 1;\n");
  put(join(ws, "nb.ipynb"), '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n');
  symlinkSync(join(state, "settings.json"), join(ws, "link.json"));
  symlinkSync(state, join(ws, "statedir"));
  linkSync(join(state, "settings.json"), join(ws, "hard.json"));
  symlinkSync(join(home, ".ssh"), join(ws, "keys"));
});
afterAll(() => {
  if (was.HOME === undefined) delete process.env.HOME; else process.env.HOME = was.HOME;
  setGitViews(was.views);
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
// What the gate does with one call: "ran" (no card), "refused: why", "owner: why" (a card only the owner answers), or another card's risk.
async function through(s: Session, name: string, input: Record<string, unknown>): Promise<string> {
  const stop = new AbortController();
  let done: unknown = "waiting";
  const asked = gate.beforeTool(s, { id: `c${n++}`, tool: tool(name), input, ctx: { sessionId: s.id, cwd: s.workspace, signal: stop.signal, spillDir: join(state, "spill", s.id), seen: new Map() } }).then((r) => (done = r));
  const open = () => gate.approvals({ session: s.id, pending: true });
  for (let i = 0; i < 400 && done === "waiting" && !open().length; i++) await Bun.sleep(5);
  const card = open()[0];
  if (card) gate.resolve(card.id, s.id, { choice: "deny" });
  await asked;
  if (!card) return done === undefined || (done && typeof done === "object" && !("deny" in done)) ? "ran" : `refused: ${JSON.stringify(done)}`;
  return card.risk === "high" && !card.suggest.length ? `owner: ${card.why}` : `card-${card.risk}`;
}

const MODES: Mode[] = ["ask", "auto-edits", "auto", "reviewer", "full-auto"];
const PROFILES = ["off", "workspace-write", "read-only"] as const;
const patch = (body: string) => ({ input: `*** Begin Patch\n${body}\n*** End Patch` });
// Every family's way to change one file.
const writers = (path: string): [string, string, Record<string, unknown>][] => [
  ["Write", "Write", { file_path: path, content: "{}" }],
  ["Edit", "Edit", { file_path: path, old_string: "{}", new_string: "{ }" }],
  ["NotebookEdit", "NotebookEdit", { notebook_path: path, new_source: "x" }],
  ["write_file", "write_file", { file_path: path, content: "{}" }],
  ["replace", "replace", { file_path: path, instruction: "x", old_string: "{}", new_string: "{ }" }],
  ["apply_patch add", "apply_patch", patch(`*** Add File: ${path}\n+{}`)],
  ["apply_patch update", "apply_patch", patch(`*** Update File: ${path}\n@@\n-{}\n+{ }`)],
  ["apply_patch delete", "apply_patch", patch(`*** Delete File: ${path}`)],
  ["apply_patch move", "apply_patch", patch(`*** Update File: ${join(ws, "src/a.ts")}\n*** Move to: ${path}\n@@\n-export const a = 1;\n+export const a = 2;`)],
];

test("Keel's own state is never written by a session's tool: by path, a link, a hard link and .., every family's tools, every mode, sandboxed or not", async () => {
  const before = readFileSync(join(state, "settings.json"), "utf8");
  const ways: [string, string][] = [
    ["by path", join(state, "settings.json")],
    ["a new file there", join(state, "planted.json")],
    ["through a link", join(ws, "link.json")],
    ["through a linked folder", join(ws, "statedir/settings.json")],
    ["through a hard link", join(ws, "hard.json")],
    // (Spelled with the dots in it: the tool is given the path as written.)
    ["through ..", `${ws}/../state/settings.json`],
    ["another session's artifact", join(state, "artifacts", other.id, "a.md")],
    ["another session's output", join(state, "spill", other.id, "out.txt")],
  ];
  for (const sandbox of PROFILES) {
    for (const mode of MODES) {
      gate.setPerm(session.id, { mode, sandbox });
      for (const [way, path] of ways) for (const [label, name, input] of writers(path)) {
        const got = await through(session, name, input);
        expect([sandbox, mode, way, label, got]).toEqual([sandbox, mode, way, label, expect.stringMatching(/^refused: .*Keel's own files/)]);
      }
      // A command whose plain shape writes there is refused the same way.
      if (mode !== "auto") expect([sandbox, mode, await through(session, "Bash", { command: `echo x >> ${join(state, "settings.json")}` })]).toEqual([sandbox, mode, expect.stringMatching(/^refused: /)]);
    }
  }
  expect(readFileSync(join(state, "settings.json"), "utf8")).toBe(before);
  // The session's own artifacts folder is its own to write.
  gate.setPerm(session.id, { mode: "auto-edits", sandbox: "off" });
  expect(await through(session, "Write", { file_path: join(state, "artifacts", session.id, "report.md"), content: "x" })).toBe("ran");
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "workspace-write" });
  expect(await through(session, "Write", { file_path: join(state, "artifacts", session.id, "report.md"), content: "x" })).toBe("ran");
}, 120_000);

test("Keel's own config is the owner's own card in the asking modes; in Full auto it runs, and a sandbox there keeps its file tools out of it: every family's tools, a link, a hard link, a command's plain write", async () => {
  // A link and a hard link to a config file, in the workspace.
  symlinkSync(join(configDir(), "sandbox.json"), join(ws, "config-link.json"));
  linkSync(join(configDir(), "sandbox.json"), join(ws, "config-hard.json"));
  const ways: [string, string][] = [
    ["a settings file", join(configDir(), "sandbox.json")],
    ["a new hook", join(configDir(), "hooks.json")],
    ["a skill", join(configDir(), "skills/x/SKILL.md")],
    ["a new skill", join(configDir(), "skills/new/SKILL.md")],
    ["through a link", join(ws, "config-link.json")],
    ["through a hard link", join(ws, "config-hard.json")],
    ["through ..", `${ws}/${"../".repeat(ws.split("/").length)}${configDir().slice(1)}/sandbox.json`],
  ];
  for (const sandbox of PROFILES) {
    // The asking modes: a card only the owner answers (no standing rule is offered, no judge is asked).
    for (const mode of ["ask", "auto-edits", "auto", "reviewer"] as Mode[]) {
      gate.setPerm(session.id, { mode, sandbox });
      for (const [way, path] of ways) for (const [label, name, input] of writers(path)) {
        expect([sandbox, mode, way, label, await through(session, name, input)]).toEqual([sandbox, mode, way, label, expect.stringMatching(/^owner: it changes /)]);
      }
      if (mode !== "auto") expect([sandbox, mode, await through(session, "Bash", { command: `echo x >> ${join(configDir(), "hooks.json")}` })]).toEqual([sandbox, mode, expect.stringMatching(/^owner: the command: /)]);
    }
    // Full auto checks nothing: with no sandbox the edit runs, and no card is made. A sandbox still holds there:
    // Keel's config is outside what its commands can write, so its file tools do not write it either.
    gate.setPerm(session.id, { mode: "full-auto", sandbox });
    for (const [way, path] of ways) for (const [label, name, input] of writers(path)) {
      expect([sandbox, way, label, await through(session, name, input)]).toEqual([sandbox, way, label, sandbox === "off" ? "ran" : expect.stringMatching(/^refused: .*a sandbox confines the session's file tools as it confines its commands, in Full auto too/)]);
    }
    // (A command runs; inside a sandbox the sandbox is what refuses its write.)
    expect([sandbox, await through(session, "Bash", { command: `echo x >> ${join(configDir(), "hooks.json")}` })]).toEqual([sandbox, "ran"]);
    // Read only: nothing is changed anywhere.
    gate.setPerm(session.id, { mode: "read-only", sandbox });
    expect([sandbox, await through(session, "Write", { file_path: join(configDir(), "hooks.json"), content: "{}" })]).toEqual([sandbox, expect.stringMatching(/^refused: .*read-only/)]);
  }
  rmSync(join(ws, "config-link.json"));
  rmSync(join(ws, "config-hard.json"));
}, 120_000);

test("a sandboxed session's file tools read what its sandbox shows: anything else is the owner's, and refused in Full auto where the sandbox still holds", async () => {
  // Every family's way to read one file or folder.
  const readers = (path: string): [string, string, Record<string, unknown>][] => [
    ["Read", "Read", { file_path: path }],
    ["read_file", "read_file", { file_path: path }],
    ["view_image", "view_image", { path }],
    ["Grep", "Grep", { pattern: "x", path }],
    ["Glob", "Glob", { pattern: "*", path: dirname(path) }],
    ["glob", "glob", { pattern: "*", dir_path: dirname(path) }],
    ["grep_search", "grep_search", { pattern: "x", dir_path: dirname(path) }],
    ["list_directory", "list_directory", { dir_path: dirname(path) }],
  ];
  const stores: [string, string][] = [
    ["the key", join(home, ".ssh/id_ed25519")],
    ["the key through a link in the workspace", join(ws, "keys/id_ed25519")],
    ["a sign-in file", join(home, ".config/pypoetry/auth.toml")],
    ["Keel's token", join(state, "api-token")],
    ["Keel's settings through a link", join(ws, "link.json")],
    ["Keel's config", join(configDir(), "sandbox.json")],
    ["another session's output", join(state, "spill", other.id, "out.txt")],
    ["another session's artifact", join(state, "artifacts", other.id, "a.md")],
  ];
  const hidden: [string, string][] = [["another project's .env", join(home, "projects/other/.env")], ["a file in the home", join(home, "notes.txt")]];
  const shown: [string, string][] = [
    ["a file of the workspace", join(ws, "src/a.ts")], ["the system", "/etc/hostname"], ["its own output", join(state, "spill", session.id, "out.txt")],
    ["its own artifact", join(state, "artifacts", session.id, "a.md")], ["a skill Keel offers", join(configDir(), "skills/x/SKILL.md")],
  ];
  for (const sandbox of ["workspace-write", "read-only"] as const) for (const mode of [...MODES, "read-only", "plan"] as Mode[]) {
    gate.setPerm(session.id, { mode, sandbox });
    // (A link in the workspace is read by its own name: the folder it lies in is the workspace.)
    for (const [what, path] of stores) for (const [label, name, input] of readers(path).filter(([, , i]) => !path.startsWith(`${ws}/`) || JSON.stringify(i).includes(path))) {
      const got = await through(session, name, input);
      expect([sandbox, mode, what, label, got]).toEqual([sandbox, mode, what, label, expect.stringMatching(mode === "full-auto" ? /^refused: .*a sandbox confines the session's file tools as it confines its commands, in Full auto too\. They read only what its commands can read/ : /^owner: it reads /)]);
    }
    for (const [what, path] of hidden) for (const [label, name, input] of readers(path)) {
      expect([sandbox, mode, what, label, await through(session, name, input)]).toEqual([sandbox, mode, what, label, expect.stringMatching(mode === "full-auto" ? /^refused: .*which this session's sandbox does not show its commands\. .*This session has a sandbox, and a sandbox confines the session's file tools/ : /^owner: it reads .*which this session's sandbox does not show its commands/)]);
    }
    for (const [what, path] of shown) for (const [label, name, input] of readers(path).slice(0, 4)) {
      expect([sandbox, mode, what, label, await through(session, name, input)]).toEqual([sandbox, mode, what, label, "ran"]);
    }
  }
  // A pattern that reaches a store from a folder that is not one.
  gate.setPerm(session.id, { mode: "auto-edits", sandbox: "workspace-write" });
  expect(await through(session, "Glob", { pattern: ".ssh/*", path: home })).toMatch(/^owner: it reads ~/);
  gate.setPerm(atHome.id, { mode: "auto-edits", sandbox: "workspace-write" });
  expect(await through(atHome, "Glob", { pattern: ".ssh/*", path: home })).toMatch(/^owner: it reads ~\/\.ssh/);
  expect(await through(atHome, "Glob", { pattern: ".ssh/*" })).toMatch(/^owner: it reads ~\/\.ssh/);
  expect(await through(session, "Glob", { pattern: `${home}/.ssh/*.pub` })).toMatch(/^owner: it reads ~\/\.ssh/);
  expect(await through(session, "Glob", { pattern: "**/*.ts" })).toBe("ran");
  // A session whose folder is the home: the stores and Keel's folders are checked before the folder is.
  for (const mode of ["ask", "auto-edits", "auto"] as Mode[]) {
    gate.setPerm(atHome.id, { mode, sandbox: "workspace-write" });
    expect([mode, await through(atHome, "Read", { file_path: join(home, ".ssh/id_ed25519") })]).toEqual([mode, expect.stringMatching(/^owner: it reads ~\/\.ssh\/id_ed25519/)]);
    expect([mode, await through(atHome, "Read", { file_path: join(home, "projects/other/.env") })]).toEqual([mode, "ran"]);
  }
  gate.setPerm(atHome.id, { mode: "full-auto", sandbox: "workspace-write" });
  expect(await through(atHome, "Read", { file_path: join(home, ".ssh/id_ed25519") })).toMatch(/^refused: /);
  // With no sandbox a read is a read.
  gate.setPerm(session.id, { mode: "ask", sandbox: "off" });
  expect(await through(session, "Read", { file_path: join(home, ".ssh/id_ed25519") })).toBe("ran");
}, 180_000);

test("a link whose name holds a glob character is a link: a path is cut at a wildcard only when it came from a pattern", async () => {
  // Links to the key folder under names a pattern would stop at.
  const names = ["l[x", "q*", "b{c", "w?y"];
  for (const name of names) symlinkSync(join(home, ".ssh"), join(ws, name));
  try {
    for (const sandbox of ["workspace-write", "read-only"] as const) {
      for (const mode of ["ask", "auto-edits", "auto"] as Mode[]) {
        gate.setPerm(session.id, { mode, sandbox });
        for (const name of names) {
          for (const [tool, input] of [["Read", { file_path: join(ws, name, "id_ed25519") }], ["read_file", { file_path: `${name}/id_ed25519` }], ["view_image", { path: join(ws, name, "id_ed25519") }], ["Grep", { pattern: "KEY", path: join(ws, name) }], ["Glob", { pattern: "*", path: join(ws, name) }]] as [string, Record<string, unknown>][]) {
            expect([sandbox, mode, name, tool, await through(session, tool, input)]).toEqual([sandbox, mode, name, tool, expect.stringMatching(/^owner: it reads .*\.ssh/)]);
          }
        }
      }
      gate.setPerm(session.id, { mode: "full-auto", sandbox });
      for (const name of names) expect([sandbox, name, await through(session, "Read", { file_path: join(ws, name, "id_ed25519") })]).toEqual([sandbox, name, expect.stringMatching(/^refused: /)]);
    }
    // A pattern is still read from the folder it looks in: one that reaches the key folder by a plain start is the key folder's.
    gate.setPerm(session.id, { mode: "auto-edits", sandbox: "workspace-write" });
    expect(await through(session, "Glob", { pattern: "keys/*" })).toMatch(/^owner: it reads .*\.ssh/);
    expect(await through(session, "Glob", { pattern: "src/*.ts" })).toBe("ran");
    expect(await through(session, "Glob", { pattern: "**/*.[tj]s", path: join(ws, "src") })).toBe("ran");
  } finally {
    for (const name of names) rmSync(join(ws, name), { force: true });
  }
});

test("a reading tool known only by its flag (an MCP server's, an ACP agent's read) is judged by the files its input names", async () => {
  const mcpRead = (input: Record<string, unknown>): any => ({ name: "mcp_call", readOnly: false, input_schema: { type: "object" }, description: "", run: async () => ({ content: "" }), target: async () => ({ name: "files__read_file", readOnly: true, input }) });
  const ask = async (t: any, input: Record<string, unknown>) => {
    let done: unknown = "waiting";
    const asked = gate.beforeTool(session, { id: `m${n++}`, tool: t, input, ctx: { sessionId: session.id, cwd: ws, signal: new AbortController().signal, spillDir: join(state, "spill", session.id), seen: new Map() } as any }).then((r) => (done = r));
    const open = () => gate.approvals({ session: session.id, pending: true });
    for (let i = 0; i < 400 && done === "waiting" && !open().length; i++) await Bun.sleep(5);
    const card = open()[0];
    if (card) gate.resolve(card.id, session.id, { choice: "deny" });
    await asked;
    return card ? `card: ${card.why}` : done && typeof done === "object" && "deny" in (done as any) ? "refused" : "ran";
  };
  gate.setPerm(session.id, { mode: "auto-edits", sandbox: "workspace-write" });
  expect(await ask(mcpRead({ path: join(home, ".ssh/id_ed25519") }), {})).toMatch(/^card: it reads .*\.ssh/);
  expect(await ask(mcpRead({ path: join(ws, "keys/id_ed25519") }), {})).toMatch(/^card: it reads .*\.ssh/);
  expect(await ask(mcpRead({ path: join(ws, "src/a.ts") }), {})).toBe("ran");
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "workspace-write" });
  expect(await ask(mcpRead({ path: join(home, ".ssh/id_ed25519") }), {})).toBe("refused");
  // Every string of the input that names a file is judged: a file: URL, a key no list knows, a value nested inside.
  gate.setPerm(session.id, { mode: "auto-edits", sandbox: "workspace-write" });
  const key = join(home, ".ssh/id_ed25519");
  for (const input of [{ uri: `file://${key}` }, { url: `file://${key}` }, { target: key }, { source: key }, { files: [key] }, { options: { path: key } }, { anything: { deep: [{ at: key }] } }, { path: "keys/../.ssh/id_ed25519" }]) {
    expect([JSON.stringify(input), await ask(mcpRead(input), {})]).toEqual([JSON.stringify(input), expect.stringMatching(/^card: it reads .*\.ssh/)]);
  }
  // One that names no file reads where it chooses: the owner is asked. Full auto checks nothing and no sandbox
  // holds such a tool: there it runs.
  expect(await ask(mcpRead({ query: "KEY" }), {})).toMatch(/^card: files__read_file is a reading tool that names no file/);
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "workspace-write" });
  expect(await ask(mcpRead({ query: "KEY" }), {})).toBe("ran");
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "off" });
  expect(await ask(mcpRead({ query: "KEY" }), {})).toBe("ran");
  // An ACP agent's read names its files in its locations and its raw input.
  expect(classOf({ kind: "read", locations: [{ path: join(home, ".ssh/id_ed25519") }] }, ws)).toEqual({ kind: "read", paths: [join(home, ".ssh/id_ed25519")] });
  expect(classOf({ kind: "search", rawInput: { path: "keys" } }, ws)).toEqual({ kind: "read", paths: [join(ws, "keys")] });
});

test("in Full auto a sandboxed session's file tools write only where its commands can, by where the file really is", async () => {
  put(join(root, "outside/file.txt"), "{}\n");
  symlinkSync(join(root, "outside"), join(ws, "out"));
  put(join(ws, "plain.json"), "{}\n");
  linkSync(join(root, "outside/file.txt"), join(ws, "hard-out.txt"));
  const outside: [string, string][] = [
    ["by path", join(root, "outside/file.txt")], ["through a linked folder", join(ws, "out/file.txt")], ["through ..", `${ws}/../outside/file.txt`],
    ["through a hard link", join(ws, "hard-out.txt")], ["the home", join(home, "notes.txt")], ["the repository's hooks", join(ws, ".git/hooks/pre-commit")],
  ];
  for (const sandbox of ["workspace-write", "read-only"] as const) {
    gate.setPerm(session.id, { mode: "full-auto", sandbox });
    for (const [way, path] of outside) for (const [label, name, input] of writers(path)) {
      // (A move's source is a workspace file: the patch is refused for where it lands.)
      expect([sandbox, way, label, await through(session, name, input)]).toEqual([sandbox, way, label, expect.stringMatching(/^refused: /)]);
    }
    for (const [label, name, input] of writers(join(ws, "plain.json")).slice(0, 2)) expect([sandbox, label, await through(session, name, input)]).toEqual([sandbox, label, "ran"]);
    // A file of the session's folder that runs later (a CI workflow, the project's own hooks file): its commands can
    // write it, so its file tools do, and nothing is checked.
    for (const later of [join(ws, ".github/workflows/ci.yml"), join(ws, ".keel/hooks.json"), join(ws, ".envrc")]) {
      expect([sandbox, later, await through(session, "Write", { file_path: later, content: "x" })]).toEqual([sandbox, later, "ran"]);
    }
  }
  // In the asking modes a file with another name is the owner's; outside the folder is a card as before.
  for (const mode of ["ask", "auto-edits", "auto"] as Mode[]) {
    gate.setPerm(session.id, { mode, sandbox: "workspace-write" });
    expect([mode, await through(session, "Edit", { file_path: join(ws, "hard-out.txt"), old_string: "{}", new_string: "{ }" })]).toEqual([mode, expect.stringMatching(/^owner: it changes .*another name elsewhere \(a hard link\)/)]);
    expect([mode, await through(session, "Edit", { file_path: join(root, "outside/file.txt"), old_string: "{}", new_string: "{ }" })]).toEqual([mode, expect.stringMatching(/^card-|^owner: /)]);
  }
  // With no sandbox Full auto runs everything (but never a write into Keel's own state, above): a file outside the
  // folder, a file that runs later.
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "off" });
  expect(await through(session, "Edit", { file_path: join(root, "outside/file.txt"), old_string: "{}", new_string: "{ }" })).toBe("ran");
  for (const later of [join(home, ".bashrc"), join(ws, ".git/hooks/pre-commit"), join(ws, ".github/workflows/ci.yml")]) {
    expect([later, await through(session, "Write", { file_path: later, content: "x" })]).toEqual([later, "ran"]);
  }
}, 120_000);

// The gate looks at a path, then the tool opens it: a command that runs beside the call can change what the name is
// in between. The tool opens the file the gate judged (the gate hands it the judged paths, as the engine passes
// them on) and nothing else.
async function judgedThenRun(s: Session, name: string, input: Record<string, unknown>, between?: () => void): Promise<{ gate: string; out: string }> {
  const ctx = { sessionId: s.id, cwd: s.workspace, signal: new AbortController().signal, spillDir: join(state, "spill", s.id), seen: new Map<string, number>() } as any;
  let r: any = "waiting";
  const asked = gate.beforeTool(s, { id: `r${n++}`, tool: tool(name), input, ctx }).then((x) => (r = x));
  const open = () => gate.approvals({ session: s.id, pending: true });
  for (let i = 0; i < 400 && r === "waiting" && !open().length; i++) await Bun.sleep(5);
  const card = open()[0];
  if (card) gate.resolve(card.id, s.id, { choice: "deny" });
  await asked;
  if (card) return { gate: `card: ${card.why}`, out: "" };
  if (r && "deny" in r) return { gate: "refused", out: "" };
  between?.();
  // (As the engine runs a call: with what the gate's hook added to its context.)
  const res = await tool(name).run(input, { ...ctx, ...(r?.ctx ?? {}) });
  return { gate: "ran", out: typeof res.content === "string" ? res.content : JSON.stringify(res.content) };
}

test("a name that changes between the gate's look and the tool's open: the tool opens the file that was judged, or nothing", async () => {
  gate.setPerm(session.id, { mode: "auto-edits", sandbox: "workspace-write" });
  const flip = join(ws, "flip"), plain = join(ws, "plain-a"), key = join(home, ".ssh/id_ed25519"), hooks = join(configDir(), "hooks.json");
  put(plain, "plain\n");
  put(hooks, "{}\n");
  const toPlain = () => { rmSync(flip, { force: true }); writeFileSync(flip, "plain\n"); };
  const toLink = (target: string) => () => { rmSync(flip, { force: true }); symlinkSync(target, flip); };
  // Reads, every family: the file becomes a link to the key after the gate looked.
  for (const [name, input] of [["Read", { file_path: flip }], ["read_file", { file_path: flip }], ["read_file", { file_path: flip, start_line: 1, end_line: 2 }], ["view_image", { path: flip }]] as [string, Record<string, unknown>][]) {
    toPlain();
    const got = await judgedThenRun(session, name, input, toLink(key));
    expect([name, got.gate, got.out.includes("KEY")]).toEqual([name, "ran", false]);
    expect([name, got.out]).toEqual([name, expect.stringContaining("is not the file this call was checked for")]);
  }
  // A folder above the file becomes a link.
  put(join(ws, "dir/note.txt"), "note\n");
  put(join(home, ".ssh/note.txt"), "KEY-NOTE\n");
  const swap = await judgedThenRun(session, "Read", { file_path: join(ws, "dir/note.txt") }, () => { rmSync(join(ws, "dir"), { recursive: true }); symlinkSync(join(home, ".ssh"), join(ws, "dir")); });
  expect([swap.gate, swap.out.includes("KEY-NOTE")]).toEqual(["ran", false]);
  rmSync(join(ws, "dir"));
  // Writes, every family: the file becomes a link to Keel's hooks file after the gate looked; nothing is written there.
  for (const [label, name, input] of writers(flip).filter(([l]) => l !== "NotebookEdit" && l !== "apply_patch add")) {
    toPlain();
    writeFileSync(flip, "{}");
    const before = readFileSync(hooks, "utf8");
    const got = await judgedThenRun(session, name, input, toLink(hooks));
    expect([label, got.gate, readFileSync(hooks, "utf8")]).toEqual([label, "ran", before]);
  }
  // A new file: the name is a link to a file that does not exist yet by the time the tool creates it.
  for (const [name, input] of [["Write", { file_path: flip, content: "PLANTED" }], ["write_file", { file_path: flip, content: "PLANTED" }], ["apply_patch", patch(`*** Add File: ${flip}\n+PLANTED`)]] as [string, Record<string, unknown>][]) {
    rmSync(flip, { force: true });
    const planted = join(configDir(), "planted.json");
    const got = await judgedThenRun(session, name, input, toLink(planted));
    expect([name, got.gate, existsSync(planted)]).toEqual([name, "ran", false]);
  }
  // The same with a command flipping the name as fast as it can, as a background command of the session would: no read returns the key.
  toPlain();
  const flipper = Bun.spawn(["python3", "-c", `import os\nws=${JSON.stringify(ws)}; key=${JSON.stringify(key)}\nwhile True:\n    os.symlink(ws+"/plain-a", ws+"/t1"); os.rename(ws+"/t1", ws+"/flip")\n    os.symlink(key, ws+"/t2"); os.rename(ws+"/t2", ws+"/flip")`], { stdout: "ignore", stderr: "ignore" });
  try {
    await Bun.sleep(200);
    let leaks = 0, ran = 0, read = 0;
    for (let i = 0; i < 300; i++) {
      const got = await judgedThenRun(session, "Read", { file_path: flip });
      if (got.gate !== "ran") continue;
      ran++;
      if (got.out.includes("KEY")) leaks++;
      if (got.out.includes("plain")) read++;
    }
    expect([leaks, ran > 0]).toEqual([0, true]);
  } finally {
    flipper.kill();
    await flipper.exited;
    rmSync(flip, { force: true });
    for (const t of ["t1", "t2"]) rmSync(join(ws, t), { force: true });
  }
}, 120_000);

test("after the gate's look a tool does no I/O on a name: a file that cannot be opened, a folder that is not there, a pipe, another file's hard link, a replaced session folder", async () => {
  gate.setPerm(session.id, { mode: "auto-edits", sandbox: "workspace-write" });
  const key = join(home, ".ssh/id_ed25519"), name = join(ws, "swap.txt");
  const fresh = () => { rmSync(name, { force: true }); writeFileSync(name, "plain\n"); };
  // A file nobody may read stands at the name when the gate looks; a link to the key takes its place before the open.
  fresh();
  chmodSync(name, 0o000);
  for (const tool of ["Read", "read_file"]) {
    const got = await judgedThenRun(session, tool, { file_path: name }, () => { rmSync(name, { force: true }); symlinkSync(key, name); }).catch((e) => ({ gate: "ran", out: String(e) }));
    expect([tool, got.out.includes("KEY")]).toEqual([tool, false]);
    rmSync(name, { force: true });
    writeFileSync(name, "plain\n");
    chmodSync(name, 0o000);
  }
  rmSync(name, { force: true });
  // The folder is not there when the gate looks; it is a link to the key folder by the time of the open.
  const dir = join(ws, "later");
  for (const [tool, input] of [["Read", { file_path: join(dir, "id_ed25519") }], ["read_file", { file_path: join(dir, "id_ed25519") }], ["view_image", { path: join(dir, "id_ed25519") }]] as [string, Record<string, unknown>][]) {
    rmSync(dir, { recursive: true, force: true });
    const got = await judgedThenRun(session, tool, input, () => symlinkSync(join(home, ".ssh"), dir));
    expect([tool, got.gate, got.out.includes("KEY")]).toEqual([tool, "ran", false]);
  }
  rmSync(dir, { force: true });
  // A folder that is there when the gate looks and a link to the key folder at the open: not listed (Glob,
  // list_directory), and a missing file's hint names nothing in it.
  for (const [tool, input] of [["Glob", { pattern: "*", path: dir }], ["list_directory", { dir_path: dir }], ["Read", { file_path: join(dir, "id_ed2551") }]] as [string, Record<string, unknown>][]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const got = await judgedThenRun(session, tool, input, () => { rmSync(dir, { recursive: true }); symlinkSync(join(home, ".ssh"), dir); });
    expect([tool, got.gate, got.out.includes("id_ed25519") ? got.out : ""]).toEqual([tool, "ran", ""]);
  }
  rmSync(dir, { force: true });
  // A write to a new file in a folder that is not there yet: the folder is made under the session's own folder, never
  // through a link that took a name of the way.
  const outside = join(root, "outside-tree");
  mkdirSync(outside, { recursive: true });
  const way = join(ws, "deep");
  const made = await judgedThenRun(session, "Write", { file_path: join(way, "a/b/new.txt"), content: "x" }, () => symlinkSync(outside, way));
  expect([made.gate, readdirSync(outside)]).toEqual(["ran", []]);
  rmSync(way, { force: true });
  const plain = await judgedThenRun(session, "Write", { file_path: join(way, "a/b/new.txt"), content: "x" });
  expect([plain.gate, readFileSync(join(way, "a/b/new.txt"), "utf8")]).toEqual(["ran", "x"]);
  rmSync(way, { recursive: true, force: true });
  // A named pipe at the name: every tool answers at once, and says what it is.
  const pipe = join(ws, "pipe.ts");
  Bun.spawnSync(["mkfifo", pipe]);
  for (const [tool, input] of [["Read", { file_path: pipe }], ["read_file", { file_path: pipe }], ["view_image", { path: pipe }], ["Write", { file_path: pipe, content: "x" }], ["Edit", { file_path: pipe, old_string: "a", new_string: "b" }], ["write_file", { file_path: pipe, content: "x" }]] as [string, Record<string, unknown>][]) {
    const t0 = performance.now();
    const got = await Promise.race([judgedThenRun(session, tool, input), Bun.sleep(3_000).then(() => ({ gate: "hung", out: "" }))]);
    expect([tool, got.gate, got.out, performance.now() - t0 < 1_000]).toEqual([tool, "ran", expect.stringContaining("is a named pipe, not a file"), true]);
  }
  rmSync(pipe, { force: true });
  // Another file's hard link takes the name after the gate looked: not the file that was judged.
  const elsewhere = join(root, "outside-tree/secret.txt");
  writeFileSync(elsewhere, "OUTSIDE-SECRET\n");
  for (const [tool, input] of [["Read", { file_path: name }], ["Write", { file_path: name, content: "PLANTED" }], ["Edit", { file_path: name, old_string: "OUTSIDE", new_string: "PLANTED" }]] as [string, Record<string, unknown>][]) {
    fresh();
    const got = await judgedThenRun(session, tool, input, () => { rmSync(name); linkSync(elsewhere, name); });
    expect([tool, got.gate, got.out.includes("OUTSIDE-SECRET"), readFileSync(elsewhere, "utf8")]).toEqual([tool, "ran", false, "OUTSIDE-SECRET\n"]);
    expect([tool, got.out]).toEqual([tool, expect.stringContaining("is not the file this call was checked for")]);
  }
  rmSync(name, { force: true });
  // The session's folder itself is replaced by a link to the key folder: nothing runs in it any more.
  const folder = join(root, "moving-ws");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "id_ed25519"), "plain\n");
  const moving = store.createSession({ model: "fixture:m", workspace: folder });
  gate.setPerm(moving.id, { mode: "auto-edits", sandbox: "workspace-write" });
  expect((await judgedThenRun(moving, "Read", { file_path: join(folder, "id_ed25519") })).out).toContain("plain");
  renameSync(folder, `${folder}.was`);
  symlinkSync(join(home, ".ssh"), folder);
  const after = await judgedThenRun(moving, "Read", { file_path: join(folder, "id_ed25519") });
  expect([after.gate, after.out]).toEqual(["refused", ""]);
  expect(await through(moving, "Read", { file_path: join(folder, "id_ed25519") })).toMatch(/^refused: .*this session's folder is not the folder the session was made in/);
  rmSync(folder, { force: true });
  renameSync(`${folder}.was`, folder);
  expect((await judgedThenRun(moving, "Read", { file_path: join(folder, "id_ed25519") })).out).toContain("plain");
}, 120_000);
