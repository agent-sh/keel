// Where credentials are kept (credentials.ts), through the real gate: the ways to a listed file that a file tool's
// path or a plain `cat` does not show. A session of the owner's asks the owner; an agent is refused; a command
// that reads nothing of the kind runs. Made-up values in a scratch home.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { vault } from "./secrets.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-cov-")));
const home = join(root, "home"), ws = join(home, "ws"), proj = join(home, "proj"), ws2 = join(home, "ws2"), state = join(root, "state");
const ghToken = "GH_TOKEN_" + "ghp9Zq7Lm2Xv", dockToken = "DOCK_TOKEN_" + "x9Zq3Lm7Kd";
const was = { HOME: process.env.HOME, config: process.env.KEEL_CONFIG_DIR, views: dirname(gitViewsDir()) };
let gate: Gate, owner: Session, agent: Session, owner2: Session, agent2: Session;
const put = (path: string, text = "x\n") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const tool = (name: string) => [...claudeTools, ...geminiTools, ...gptTools].find((t) => t.name === name)!;

beforeAll(() => {
  process.env.HOME = home;
  // (The config folder is the file's own: the files below are not left in the one the run shares.)
  process.env.KEEL_CONFIG_DIR = join(root, "config");
  setGitViews(state);
  const store = new Store(state);
  gate = new Gate(store, new Bus(), () => false);
  mkdirSync(ws, { recursive: true });
  owner = store.createSession({ model: "fixture:m", workspace: ws });
  agent = { ...store.createSession({ model: "fixture:m", workspace: ws }), parent_id: owner.id } as Session;
  owner2 = store.createSession({ model: "fixture:m", workspace: ws2 });
  agent2 = { ...store.createSession({ model: "fixture:m", workspace: ws2 }), parent_id: owner2.id } as Session;
  gate.setPerm(owner.id, { mode: "ask", sandbox: "off" });
  gate.setPerm(agent.id, { mode: "auto", sandbox: "off" });
  const token = "TEST_TOKEN_" + "abc123Zq9";
  put(join(home, ".aws/credentials"), `[default]\naws_secret_access_key = ${token}\n`);
  put(join(home, ".bash_history"), `export X=${token}\n`);
  put(join(home, ".ssh/id_ed25519"), "KEY\n");
  put(join(ws, ".envrc"), `export K=${token}\n`);
  put(join(ws, ".env"), `K=${token}\n`);
  put(join(ws, "notes.txt"), "plain notes\n");
  put(join(ws, "src/main.ts"), "export {};\n");
  put(join(ws, "secrets/readme.txt"), "a folder named secrets\n");
  put(join(state, "keel.db"), "db");
  for (const f of ["api-token", "secret-key", "mcp-oauth.json"]) put(join(state, f), token);
  put(join(configDir(), "mcp.json"), `{"servers":{"x":{"env":{"API_KEY":"${token}"}}}}`);
  put(join(configDir(), "providers.toml"), `key = "${token}"`);
  put(join(configDir(), "AGENTS.md"), "# notes\n");
  // (Another folder of the home: names for a listed file, which a search of the session's own folder does not meet.)
  mkdirSync(proj, { recursive: true });
  linkSync(join(home, ".aws/credentials"), join(proj, "hard.txt"));
  symlinkSync(join(home, ".aws/credentials"), join(proj, "link.txt"));
  put(join(proj, "plain.txt"), "plain\n");
  // (A folder of the owner's, with a store opened for the sandbox and one that stays hidden.)
  put(join(home, ".config/gh/hosts.yml"), `github.com:\n  oauth_token: ${ghToken}\n`);
  put(join(home, ".config/other/readme.txt"), "other\n");
  // (A second session folder with names for a listed file inside it, in every shape.)
  mkdirSync(ws2, { recursive: true });
  put(join(home, ".docker/config.json"), `{"auths":{"r":{"auth":"${dockToken}"}}}\n`);
  linkSync(join(home, ".docker/config.json"), join(ws2, "hl.txt"));
  symlinkSync(join(home, ".docker/config.json"), join(ws2, "sym.txt"));
  symlinkSync(join(home, ".docker/config.json"), join(ws2, ".env"));
  put(join(ws2, "plain.txt"), "plain\n");
});
afterAll(() => {
  if (was.HOME === undefined) delete process.env.HOME; else process.env.HOME = was.HOME;
  if (was.config === undefined) delete process.env.KEEL_CONFIG_DIR; else process.env.KEEL_CONFIG_DIR = was.config;
  setGitViews(was.views);
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
// What the gate does with one call: "ran", "refused: why", "owner: why" (a card only the owner answers) or another card's risk.
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
// What a search tool returns when the gate let it run: its context from the gate, then the tool itself.
async function ran(s: Session, name: string, input: Record<string, unknown>): Promise<string> {
  const ctx: any = { sessionId: s.id, cwd: s.workspace, signal: new AbortController().signal, spillDir: join(state, "spill", s.id), seen: new Map() };
  const call: any = { id: `c${n++}`, tool: tool(name), input, ctx };
  const gated: any = await gate.beforeTool(s, call);
  if (gated && "deny" in gated) return `refused: ${gated.deny}`;
  if (gated?.ctx) Object.assign(ctx, gated.ctx);
  const r = await call.tool.run(input, ctx);
  return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
}
const bash = (command: string) => through(owner, "Bash", { command });
const agentBash = (command: string) => through(agent, "Bash", { command });
const isOwner = (v: string) => v.startsWith("owner: ");
const isRefused = (v: string) => v.startsWith("refused: ");

test("a file with more than one name is judged by what it is", async () => {
  expect(isOwner(await through(owner, "Read", { file_path: join(proj, "hard.txt") }))).toBe(true);
  expect(isRefused(await through(agent, "Read", { file_path: join(proj, "hard.txt") }))).toBe(true);
  expect(isOwner(await bash("cat ../proj/hard.txt"))).toBe(true);
  expect(await through(owner, "Read", { file_path: join(ws, "notes.txt") })).toBe("ran");
  const asked = await through(owner, "Read", { file_path: join(proj, "hard.txt") });
  expect(asked).toContain("another name for ~/.aws/credentials");
  // A search of the folder leaves it out, as it does the file it is a name of.
  const found = await ran(agent, "Grep", { pattern: "TEST_TOKEN", path: proj, output_mode: "content" });
  expect(found).not.toContain("hard.txt:");
  expect(found).not.toContain("TEST_TOKEN");
  expect(found).toContain("Left out");
  expect(found).toContain("hard.txt");
});

test("a command that reads a listed file through a helper, a wildcard, a folder entered after a semicolon or a copy asks the owner and refuses an agent", async () => {
  const reading = [
    "echo ~/.aws/credentials | xargs cat", "find ~/.aws -type f -exec cat {} +", "find ~/.aws -type f -execdir cat {} \\;", "find ~/.aws -type f -print0 | xargs -0 cat",
    "cat $(echo ~/.aws/credentials)", "cat ~/.aw*/cred*", "cd ~/.aws; cat *", "(cd ~/.aws; cat *)", "git diff --no-index /dev/null ~/.aws/credentials",
    "cp ~/.aws/credentials .", "mv ~/.aws/credentials .", "rsync -a ~/.aws/ ../copy/", "ln ~/.aws/credentials copy.txt", "install ~/.aws/credentials ../copy.txt",
  ];
  for (const c of reading) {
    const [o, a] = [await bash(c), await agentBash(c)];
    expect([c, isOwner(o) ? "owner" : o]).toEqual([c, "owner"]);
    expect([c, isRefused(a) ? "refused" : a]).toEqual([c, "refused"]);
  }
  for (const c of ["echo notes.txt | xargs cat", "find . -name '*.ts' -exec cat {} +", "cat $(echo notes.txt)", "cat src/*.ts", "cd src; cat *", "cp notes.txt copy.txt", "git diff --no-index notes.txt src/main.ts"]) {
    const [o, a] = [await bash(c), await agentBash(c)];
    expect([c, isOwner(o) || isRefused(o), /credential/.test(a)]).toEqual([c, false, false]);
  }
});

test("a recursive shell search of a project folder asks or is told to leave the key files out", async () => {
  for (const c of ["grep -r TEST_TOKEN .", "rg --hidden TEST_TOKEN", "grep -rn x src ."]) {
    expect([c, isOwner(await bash(c))]).toEqual([c, true]);
    expect([c, isRefused(await agentBash(c))]).toEqual([c, true]);
  }
  const said = await agentBash("grep -r TEST_TOKEN .");
  expect(said).toContain("Leave them out of the search");
  for (const c of ["grep -r TEST_TOKEN . --exclude=.env --exclude=.envrc", "rg TEST_TOKEN -g '!.env' -g '!.envrc' --hidden", "grep -r x src", "rg x src"]) {
    expect([c, await bash(c)]).toEqual([c, expect.not.stringMatching(/^owner:/)]);
    expect([c, isRefused(await agentBash(c))]).toEqual([c, false]);
  }
});

test("a listed file read through names the line sets is the owner's card, refused to an agent, and its values go to the vault when it runs", async () => {
  for (const c of ["p=~/.config; q=$p/gh; cat $q/hosts.yml", "export G=~/.config/gh; bash -c 'cat $G/hosts.yml'", "ls ~/.config/gh | while read y; do cat ~/.config/gh/$y; done", "for d in ~/.config/gh; do cat $d/hosts.yml; done"]) {
    const [o, a] = [await bash(c), await agentBash(c)];
    expect([c, isOwner(o) ? "owner" : o]).toEqual([c, "owner"]);
    expect([c, isRefused(a) ? "refused" : a]).toEqual([c, "refused"]);
  }
  // Full auto asks nobody and runs it: what the file holds is kept in the vault for that session first, so it sees placeholders.
  const free = (gate as any).store.createSession({ model: "fixture:m", workspace: ws }) as Session;
  gate.setPerm(free.id, { mode: "full-auto", sandbox: "off" });
  const held = () => vault.list(free.id).filter((e) => e.kind === "credential file").length;
  expect(held()).toBe(0);
  expect(await through(free, "Bash", { command: "p=~/.aws; q=$p; cat $q/credentials" })).toBe("ran");
  expect(held()).toBeGreaterThan(0);
  // A name nobody shows in a store of credentials may be any of its files: the store's own are kept.
  const other = (gate as any).store.createSession({ model: "fixture:m", workspace: ws }) as Session;
  gate.setPerm(other.id, { mode: "full-auto", sandbox: "off" });
  const kept = () => vault.list(other.id).filter((e) => e.kind === "credential file").length;
  expect(await through(other, "Bash", { command: "read y; cat ~/.aws/$y" })).toBe("ran");
  expect(kept()).toBeGreaterThan(0);
});

test(".envrc, history and Keel's own files: refused to an agent; the servers and providers say where the masked view is", async () => {
  for (const p of [join(ws, ".envrc"), join(home, ".bash_history"), join(state, "keel.db"), join(state, "api-token"), join(state, "secret-key"), join(state, "mcp-oauth.json")]) {
    expect([p, isOwner(await through(owner, "Read", { file_path: p }))]).toEqual([p, true]);
    const said = await through(agent, "Read", { file_path: p });
    expect([p, isRefused(said), said.includes("Keel's API")]).toEqual([p, true, false]);
  }
  for (const [p, cmd] of [[join(configDir(), "mcp.json"), "keel mcp list"], [join(configDir(), "providers.toml"), "keel providers"]] as const) {
    expect(isOwner(await through(owner, "Read", { file_path: p }))).toBe(true);
    const said = await through(agent, "Read", { file_path: p });
    expect([p, isRefused(said), said.includes(cmd), said.includes("values")]).toEqual([p, true, true, true]);
    expect(isRefused(await agentBash(`cat ${p}`))).toBe(true);
  }
  expect(await through(agent, "Read", { file_path: join(configDir(), "AGENTS.md") })).toBe("ran");
});

test("a folder named like a key file is not one", async () => {
  expect(await through(owner, "Read", { file_path: join(ws, "secrets/readme.txt") })).toBe("ran");
  expect(await through(owner, "Glob", { pattern: "*", path: join(ws, "secrets") })).toBe("ran");
  expect(await bash("ls secrets")).toBe("ran");
});

test("a command that runs in the sandbox asks nobody for what the sandbox hides, and runs a credential file it shows with its values given to the vault", async () => {
  const boxed = gate as any;
  // (Sessions whose sandbox is on: the gate's check says so for these.)
  const sb = new Gate((gate as any).store, new Bus(), (_s, p) => p.sandbox !== "off");
  const run = async (s: Session, command: string) => {
    const stop = new AbortController();
    let done: unknown = "waiting";
    const asked = sb.beforeTool(s, { id: `c${n++}`, tool: tool("Bash"), input: { command }, ctx: { sessionId: s.id, cwd: s.workspace, signal: stop.signal, spillDir: join(state, "spill", s.id), seen: new Map() } }).then((r) => (done = r));
    const open = () => sb.approvals({ session: s.id, pending: true });
    for (let i = 0; i < 100 && done === "waiting" && !open().length; i++) await Bun.sleep(5);
    const card = open()[0];
    if (card) sb.resolve(card.id, s.id, { choice: "deny" });
    await asked;
    return card ? "card" : done && typeof done === "object" && "deny" in done ? "refused" : "ran";
  };
  void boxed;
  sb.setPerm(owner.id, { mode: "auto-edits", sandbox: "workspace-write" });
  sb.setPerm(agent.id, { mode: "auto", sandbox: "workspace-write" });
  // The workspace's own `.env` and what the sandbox hides: no card, for the owner and for an agent.
  for (const c of ["cat .env", "cat ~/.ssh/id_ed25519; cat .env", `ls ${state}/keel.db; cat ${state}/keel.db`, "cat ~/.aws/credentials", "grep -r TEST_TOKEN ~", "cat .envrc"])
    expect([c, await run(owner, c), await run(agent, c)]).toEqual([c, "ran", "ran"]);
  // Off the sandbox, or out of it, the owner is asked as before.
  sb.setPerm(owner.id, { mode: "auto-edits", sandbox: "off" });
  expect(await run(owner, "cat .env")).toBe("card");
  expect(await run(owner, "cat ~/.aws/credentials")).toBe("card");
});

// A gate whose sessions have a sandbox, and what its Bash call comes to: "ran", "card" or "refused".
function sandboxed() {
  const sb = new Gate((gate as any).store, new Bus(), (_s, p) => p.sandbox !== "off");
  const run = async (s: Session, command: string) => {
    const stop = new AbortController();
    let done: unknown = "waiting";
    const asked = sb.beforeTool(s, { id: `c${n++}`, tool: tool("Bash"), input: { command }, ctx: { sessionId: s.id, cwd: s.workspace, signal: stop.signal, spillDir: join(state, "spill", s.id), seen: new Map() } }).then((r) => (done = r));
    const open = () => sb.approvals({ session: s.id, pending: true });
    for (let i = 0; i < 100 && done === "waiting" && !open().length; i++) await Bun.sleep(5);
    const card = open()[0];
    if (card) sb.resolve(card.id, s.id, { choice: "deny" });
    await asked;
    return card ? "card" : done && typeof done === "object" && "deny" in done ? "refused" : "ran";
  };
  return { sb, run };
}

test("names for a listed file are found by a search of a folder, however they are called, and a folder that is only like one is not", async () => {
  const hit = [
    "rg TEST_TOKEN proj", "grep -r TEST_TOKEN proj", "grep -R TEST_TOKEN proj", "rg -L TEST_TOKEN proj", "rg --follow TEST_TOKEN proj", "find proj -type f -exec cat {} +", "find -L proj -type f -exec cat {} +",
    "cd proj; ls | xargs cat", "cd proj && ls | xargs cat", "find proj -type f | xargs cat",
  ];
  for (const c of hit) {
    const [o, a] = [await bash(`cd ${home} && ${c}`), await agentBash(`cd ${home} && ${c}`)];
    expect([c, isOwner(o) ? "owner" : o, isRefused(a) ? "refused" : a]).toEqual([c, "owner", "refused"]);
  }
  // The folder's other files are no reason to ask.
  for (const c of ["cat proj/plain.txt", "grep -r plain proj/plain.txt", "ls proj"]) expect([c, await bash(`cd ${home} && ${c}`)]).toEqual([c, "ran"]);
});

test("Keel's own folders are read by a search of them, or of a folder above them, as they are by a file tool", async () => {
  for (const c of [`grep -r KEY ${configDir()}`, `find ${configDir()} -type f -exec cat {} +`, `rg KEY ${state}`, `grep -r x ${root}`, `cd ${configDir()} && grep -r KEY .`]) {
    const [o, a] = [await bash(c), await agentBash(c)];
    expect([c, isOwner(o) ? "owner" : o, isRefused(a) ? "refused" : a]).toEqual([c, "owner", "refused"]);
  }
});

test("a command in the sandbox that searches above a store the owner opened reads it: an agent is refused, the owner's values go to the vault", async () => {
  const { sb, run } = sandboxed();
  sb.setPerm(owner.id, { mode: "auto-edits", sandbox: "workspace-write" });
  sb.setPerm(agent.id, { mode: "auto", sandbox: "workspace-write" });
  const config = join(configDir(), "sandbox.json");
  put(config, JSON.stringify({ read: [join(home, ".config/gh")] }));
  try {
    for (const c of ["grep -r GH_TOKEN ~/.config", "rg GH_TOKEN ~/.config", "find ~/.config -type f -exec cat {} +", "cd ~/.config && grep -r GH_TOKEN .", "cat ~/.config/gh/hosts.yml"]) {
      const [o, a] = [await run(owner, c), await run(agent, c)];
      expect([c, o, a]).toEqual([c, "ran", "refused"]);
    }
    // What the owner's run read is in the vault: the value is a placeholder wherever the session sees it.
    expect(vault.redact(`oauth_token: ${ghToken}`, owner.id, "output")).not.toContain(ghToken);
    // The store that stays hidden is not read by the same search, and a search of what holds no store is not held.
    for (const c of ["grep -r x ~/.config/other", "cat ~/.aws/credentials"]) expect([c, await run(agent, c)]).toEqual([c, "ran"]);
  } finally { rmSync(config, { force: true }); }
});

test("a link to a listed file in the session's folder is not the folder's own file: the sandbox gives it to the vault, an agent is refused", async () => {
  const { sb, run } = sandboxed();
  sb.setPerm(owner2.id, { mode: "auto-edits", sandbox: "workspace-write" });
  sb.setPerm(agent2.id, { mode: "auto", sandbox: "workspace-write" });
  for (const c of ["cat hl.txt", "grep -r DOCK_TOKEN .", "rg DOCK_TOKEN .", "find . -type f -exec cat {} +"]) {
    expect([c, await run(owner2, c)]).toEqual([c, "ran"]);
    expect([c, await run(agent2, c)]).toEqual([c, "refused"]);
  }
  expect(vault.redact(`auth: ${dockToken}`, owner2.id, "output")).not.toContain(dockToken);
  // (A link that lands in the hidden home reads nothing in the sandbox, named by its own name.)
  for (const c of ["cat plain.txt", "cat sym.txt", "cat .env"]) expect([c, await run(agent2, c)]).toEqual([c, "ran"]);
});
