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

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-cov-")));
const home = join(root, "home"), ws = join(home, "ws"), state = join(root, "state");
const was = { HOME: process.env.HOME, config: process.env.KEEL_CONFIG_DIR, views: dirname(gitViewsDir()) };
let gate: Gate, owner: Session, agent: Session;
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
  linkSync(join(home, ".aws/credentials"), join(ws, "hard.txt"));
  symlinkSync(join(home, ".aws/credentials"), join(ws, "link.txt"));
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
  expect(isOwner(await through(owner, "Read", { file_path: join(ws, "hard.txt") }))).toBe(true);
  expect(isRefused(await through(agent, "Read", { file_path: join(ws, "hard.txt") }))).toBe(true);
  expect(isOwner(await bash("cat hard.txt"))).toBe(true);
  expect(await through(owner, "Read", { file_path: join(ws, "notes.txt") })).toBe("ran");
  const asked = await through(owner, "Read", { file_path: join(ws, "hard.txt") });
  expect(asked).toContain("another name for ~/.aws/credentials");
  // A search of the folder leaves it out, as it does the file it is a name of.
  const found = await ran(agent, "Grep", { pattern: "TEST_TOKEN", path: ws, output_mode: "content" });
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
