// The file tools of a session against what its sandbox allows, through the
// real gate: every family's tools, every mode, both profiles. A file tool
// runs in the daemon, outside the sandbox, so the gate is all that holds it
// to what the session's commands may read and write.
//
// - Keel's own state is never written by a session's tool, by path, through
//   a link, through a hard link or through `..`, in any mode, sandboxed or
//   not. Keel's own config (skills, hooks, MCP servers, settings) is the
//   owner's own card in the asking modes, and refused in Full auto.
// - In a sandboxed session a file tool reads what the sandbox shows; a
//   credential store or one of Keel's own files is the owner's card, and
//   refused in Full auto; anything else outside the view is the owner's card.
// - In a sandboxed Full auto session a file tool writes only inside the
//   session's writable folders, by where the file really is.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("Keel's own config is the owner's own card in the asking modes and refused in Full auto: every family's tools, a link, a hard link, a command's plain write", async () => {
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
    // Full auto: refused, with where to do it instead. No card.
    gate.setPerm(session.id, { mode: "full-auto", sandbox });
    for (const [way, path] of ways) for (const [label, name, input] of writers(path)) {
      expect([sandbox, way, label, await through(session, name, input)]).toEqual([sandbox, way, label, expect.stringMatching(/^refused: .*In Full auto no card reaches the owner.*do it in an asking mode/)]);
    }
    expect([sandbox, await through(session, "Bash", { command: `echo x >> ${join(configDir(), "hooks.json")}` })]).toEqual([sandbox, expect.stringMatching(/^refused: .*In Full auto no card reaches the owner/)]);
    // Read only: nothing is changed anywhere.
    gate.setPerm(session.id, { mode: "read-only", sandbox });
    expect([sandbox, await through(session, "Write", { file_path: join(configDir(), "hooks.json"), content: "{}" })]).toEqual([sandbox, expect.stringMatching(/^refused: .*read-only/)]);
  }
  rmSync(join(ws, "config-link.json"));
  rmSync(join(ws, "config-hard.json"));
}, 120_000);

test("a sandboxed session's file tools read what its sandbox shows: a store or Keel's own file is the owner's, refused in Full auto; the rest outside the view is the owner's", async () => {
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
      expect([sandbox, mode, what, label, got]).toEqual([sandbox, mode, what, label, expect.stringMatching(mode === "full-auto" ? /^refused: .*In Full auto nothing reads it/ : /^owner: it reads /)]);
    }
    for (const [what, path] of hidden) for (const [label, name, input] of readers(path)) {
      expect([sandbox, mode, what, label, await through(session, name, input)]).toEqual([sandbox, mode, what, label, expect.stringMatching(mode === "full-auto" ? /^refused: .*In Full auto a file tool reads only what the session's sandbox shows/ : /^owner: it reads .*which this session's sandbox does not show its commands/)]);
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
  }
  // In the asking modes a file with another name is the owner's; outside the folder is a card as before.
  for (const mode of ["ask", "auto-edits", "auto"] as Mode[]) {
    gate.setPerm(session.id, { mode, sandbox: "workspace-write" });
    expect([mode, await through(session, "Edit", { file_path: join(ws, "hard-out.txt"), old_string: "{}", new_string: "{ }" })]).toEqual([mode, expect.stringMatching(/^owner: it changes .*another name elsewhere \(a hard link\)/)]);
    expect([mode, await through(session, "Edit", { file_path: join(root, "outside/file.txt"), old_string: "{}", new_string: "{ }" })]).toEqual([mode, expect.stringMatching(/^card-|^owner: /)]);
  }
  // With no sandbox Full auto writes as it did (but never Keel's own files, above).
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "off" });
  expect(await through(session, "Edit", { file_path: join(root, "outside/file.txt"), old_string: "{}", new_string: "{ }" })).toBe("ran");
}, 120_000);
