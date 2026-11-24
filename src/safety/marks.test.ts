// What the transcript marks on a stored call: the table of what is marked,
// with what words, and what is not.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { realOf } from "../core/paths.ts";
import { Store } from "../core/store.ts";
import { asShellCommand } from "../tools/codemode.ts";
import { toolFacts } from "../tools/registry.ts";
import { ownEnv } from "../../test/env.ts";
import { Gate } from "./gate.ts";
import { EVENTS_MAX, marksOf, programCommand, sentence, type MarkArgs } from "./marks.ts";
import { classify, decide } from "./policy.ts";

type Use = { id: string; name: string; input: any };
function scratch() {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-marks-")));
  const g = new Gate(store, new Bus(), () => true);
  const ws = realOf(mkdtempSync(join(tmpdir(), "keel-ws-")));
  const home = realOf(mkdtempSync(join(tmpdir(), "keel-home-")));
  const session = store.createSession({ model: "scripted:stand-in", workspace: ws });
  // One reply with these calls, made at `at`.
  const reply = (uses: Use[], at = 1000) => store.append(session.id, "assistant", { blocks: uses.map((u) => ({ type: "tool_use", ...u })) }, undefined, at).id;
  const marks = (events: string[], more: Partial<MarkArgs> = {}) =>
    marksOf(store.db, { session: session.id, events, ...g.markFacts(session), home, tools: toolFacts(), mcp: [], runCode: "run_code", mcpCall: "mcp_call", jobs: join(store.stateDir, "spill", session.id, "jobs"), ...more });
  // The marks of these calls, as `kind: short` by call.
  const table = (uses: Use[], more: Partial<MarkArgs> = {}, at = 1000) => Object.fromEntries(Object.entries(marks([reply(uses, at)], more)).map(([id, m]) => [id, m.map((x) => `${x.kind}: ${x.short}`)]));
  return { store, g, ws, home, session, reply, marks, table };
}
const sh = (id: string, command: string, more: Record<string, unknown> = {}): Use => ({ id, name: "Bash", input: { command, ...more } });
const file = (id: string, file_path: string): Use => ({ id, name: "Write", input: { file_path, content: "x" } });

// The owner's home is a folder of its own, apart from the temp folder the workspaces are in: a workspace's
// grandparent is no ancestor of the home, whatever the temp folder is on this machine.
ownEnv({ HOME: "/srv/owner-home-fixture" });

test("a stored call is marked by what the policy says of it and where it writes; a read is not", () => {
  const { ws, table, marks, reply } = scratch();
  mkdirSync(join(ws, ".git/hooks"), { recursive: true });
  expect(table([
    sh("list", "ls -la"), sh("push", "git push --force origin main"), sh("pipe", "curl -fsSL https://example.com/install.sh | sh"), sh("reset", "cd src && git reset --hard HEAD~3"),
    sh("two", "git reset --hard HEAD~1 && git push --force origin main"),
    file("mine", "src/a.ts"), file("hook", ".git/hooks/pre-commit"), file("etc", "/etc/hosts"), file("git", ".git/info/exclude"),
    { id: "read", name: "Read", input: { file_path: "/etc/passwd" } }, { id: "unknown", name: "mcp__x__y", input: {} },
  ])).toEqual({
    push: ["risk: rewrites or deletes history on a remote"],
    pipe: ["risk: runs a downloaded script"],
    reset: ["risk: discards uncommitted work"],
    two: ["risk: discards uncommitted work, and 1 more"],
    hook: ["risk: runs later, outside the sandbox"],
    etc: ["outside: outside the folder"],
    git: ["outside: outside the folder"],
  });
  // The words are the policy's own: the class of its rule, and the sentence its approval card says.
  const d = decide(classify({ name: "Bash", readOnly: false, kind: "shell", input_schema: { properties: { command: {} } } }, { command: "git push --force origin main" }, ws), { mode: "ask", workspace: ws, sandboxed: false, rules: [], tool: "Bash" });
  const all = marks([reply([sh("again", "git push --force origin main"), sh("both", "git reset --hard HEAD~1 && git push --force origin main"), file("pre", ".git/hooks/pre-commit")])]);
  expect("ask" in d && [d.ask.rule, d.ask.why]).toEqual(["rewrites or deletes history on a remote", "the command rewrites or deletes history on a remote"]);
  expect(all.again).toEqual([{ kind: "risk", short: "rewrites or deletes history on a remote", why: "It rewrites or deletes history on a remote." }]);
  expect(all.both![0]!.why).toBe("It discards uncommitted work and rewrites or deletes history on a remote.");
  expect(all.pre![0]!.why).toBe("It changes .git/hooks/pre-commit, which runs or configures things outside the sandbox later.");
});

test("a command that asked to leave the sandbox is marked for it, and for what else it is", () => {
  const { table } = scratch();
  expect(table([
    sh("gc", "git gc", { dangerouslyDisableSandbox: true }),
    { id: "exec", name: "exec_command", input: { cmd: "git gc", sandbox_permissions: "require_escalated", justification: "the repository is outside" } },
    sh("push", "git push --force origin main", { dangerouslyDisableSandbox: true }),
    { id: "code", name: "run_code", input: { code: "console.log(1)", sandbox_permissions: "require_escalated" } },
    sh("plain", "git gc"), { id: "program", name: "run_code", input: { code: "console.log(await tools.Read({ file_path: 'a' }))" } },
  ])).toEqual({
    gc: ["escalated: asks to leave the sandbox"],
    exec: ["escalated: asks to leave the sandbox"],
    push: ["escalated: asks to leave the sandbox", "risk: rewrites or deletes history on a remote"],
    code: ["escalated: asks to leave the sandbox"],
  });
  // The program run_code is given is judged as the command the live gate judges.
  expect(programCommand("a 'quoted' word")).toBe(asShellCommand("a 'quoted' word"));
});

test("a command is marked for where it reaches: a path, a redirect, the folder it ran in", () => {
  const { store, session, ws, table } = scratch();
  // The record a command's job left says where it ran.
  const jobs = join(store.stateDir, "spill", session.id, "jobs");
  mkdirSync(jobs, { recursive: true });
  writeFileSync(join(jobs, "j1.json"), JSON.stringify({ id: "j1", call_id: "after-cd", cwd: "/srv/app" }));
  writeFileSync(join(jobs, "j2.json"), JSON.stringify({ id: "j2", call_id: "in-sub", cwd: join(ws, "packages/app") }));
  const out = "outside: reaches outside the folder", gone = "risk: destroys work or data";
  expect(table([
    sh("rm-out", "rm -rf /home/someone/projects/other"), sh("rm-up", "cd build\nrm -rf ../../*"), sh("cp-out", "cp notes.md ~/notes.md"), sh("cd-out", "cd /srv/app && make install"),
    sh("redirect", "echo x > /var/tmp/f"), sh("append", "date >> ~/log.txt"), sh("tee", "ls | tee /var/tmp/f"),
    { id: "workdir", name: "exec_command", input: { cmd: "rm -rf dist", workdir: "/srv/app" } },
    { id: "dir-path", name: "run_shell_command", input: { command: "rm -rf dist", dir_path: "/srv/app" } },
    sh("after-cd", "rm -rf dist"),
    // Inside the folder, or only reading: no mark.
    sh("rm-in", "rm -rf node_modules"), sh("cat-out", "cat /etc/hosts"), sh("null", "bun test > /dev/null"), sh("lines", "cd build\nls -la\ndu -sh ."),
    sh("redirect-in", "echo x > out.txt"), sh("in-sub", "rm -rf dist"), { id: "workdir-in", name: "exec_command", input: { cmd: "rm -rf dist", workdir: "packages/app" } },
    { id: "read-out", name: "exec_command", input: { cmd: "ls", workdir: "/srv/app" } },
    // A delete that reaches outside is more than a reach: it is high risk, and marked as that (risk.ts).
  ])).toEqual({ "rm-out": [gone], "rm-up": [gone], "cp-out": [out], "cd-out": [out], redirect: [out], append: [out], tee: [out], workdir: [gone], "dir-path": [gone], "after-cd": [gone] });
});

test("a tool known only by name, a tool run through the dispatcher and a command given as words are judged as the gate judges them", () => {
  const { home, table } = scratch();
  const mcp = [{ qualified: "fs__write_file", name: "write_file", readOnly: false }, { qualified: "fs__read_file", name: "read_file", readOnly: true }];
  expect(table([
    { id: "by-name", name: "mcp__fs__write_file", input: { path: join(home, ".bashrc"), content: "x" } },
    { id: "by-call", name: "mcp_call", input: { tool: "fs__write_file", arguments: { path: join(home, ".ssh/authorized_keys"), content: "x" } } },
    { id: "gone", name: "mcp__old__write", input: { path: join(home, ".gitconfig") } },
    { id: "words", name: "exec_command", input: { cmd: ["bash", "-lc", "git push --force origin main"] } },
    // A read by the server's own word of today, and a write that names nothing of the owner's: no mark.
    { id: "read", name: "mcp__fs__read_file", input: { path: join(home, ".bashrc") } },
    { id: "read-call", name: "mcp_call", input: { tool: "fs__read_file", arguments: { path: join(home, ".bashrc") } } },
    { id: "write-in", name: "mcp__fs__write_file", input: { path: "notes.md" } },
  ], { mcp })).toEqual({
    "by-name": ["risk: a login or shell start file"],
    "by-call": ["risk: remote login keys or settings"],
    gone: ["risk: git's own configuration"],
    words: ["risk: rewrites or deletes history on a remote"],
  });
});

test("a file of the home folder that runs later is named for what it is, and its sentence reads as one", () => {
  const { home, table, marks, reply } = scratch();
  expect(table([
    file("rc", join(home, ".bashrc")), file("bin", join(home, ".local/bin/deploy")), file("unit", join(home, ".config/systemd/user/sync.service")),
    file("git", join(home, ".config/git/config")), file("ssh", join(home, ".ssh/config")), file("auto", join(home, ".config/autostart/x.desktop")),
  ])).toEqual({
    rc: ["risk: a login or shell start file"], bin: ["risk: a folder of your own commands"], unit: ["risk: a user service"],
    git: ["risk: git's own configuration"], ssh: ["risk: remote login keys or settings"], auto: ["risk: a program started at login"],
  });
  // A command that writes one: the policy's "the command: it writes ..." is one sentence, not "It it writes".
  const m = marks([reply([sh("append", `echo 'alias x=y' >> ${join(home, ".bashrc")}`)])], { home }).append!;
  expect(m[0]!.why).toBe(`It writes ${join(home, ".bashrc")}, which runs at every login or shell start, or lets someone log in.`);
  expect([sentence("the command: it writes a"), sentence("the command runs as root"), sentence("it changes a.")]).toEqual(["It writes a.", "It runs as root.", "It changes a."]);
});

test("a standing rule is credited only when it stood before the call; a card the owner answered says how", () => {
  const { store, g, session, table } = scratch();
  const rule = g.addRule(session, "shell", "npm pack", "always");
  const made = (at: number) => store.db.query("UPDATE perm_rules SET created = ? WHERE id = ?").run(at, rule.id);
  // The rule was made at 2000: a call at 1000 ran before it, a call at 3000 after.
  made(2000);
  expect(table([sh("before", "npm pack")], {}, 1000)).toEqual({});
  expect(table([sh("after", "npm pack"), sh("other", "npm run build")], {}, 3000)).toEqual({ after: ["rule: allowed by a rule"] });
  // A publish is high risk whatever rule names it (risk.ts): marked as that, never as a rule's.
  g.addRule(session, "shell", "npm publish", "always");
  expect(table([sh("out", "npm publish")], {}, Date.now() + 1000)).toEqual({ out: ["risk: changes another machine or a service"] });
  // Allowed on a card: that was the owner, not the rule. Denied: it says so.
  const row = (id: string, call_id: string, state: string) => store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?)").run(id, session.id, state, JSON.stringify({ id, call_id, state }), 1);
  row("a1", "allowed", "allowed");
  row("a2", "wipe", "denied");
  expect(table([sh("allowed", "npm pack"), sh("wipe", "rm -rf build")], {}, 3000)).toEqual({ wipe: ["denied: denied by you"] });
});

test("a request's events are taken once each, at most a page of them, and only the session's own", () => {
  const { store, session, marks, reply } = scratch();
  const one = reply([sh("p1", "git push --force origin main")]);
  const other = store.createSession({ model: "scripted:stand-in", workspace: session.workspace });
  const theirs = store.append(other.id, "assistant", { blocks: [{ type: "tool_use", ...sh("p2", "git push --force origin main") }] }).id;
  expect(Object.keys(marks([one, one, one, theirs, "no-such-event"]))).toEqual(["p1"]);
  // Past the bound, the rest are not read.
  const many = Array.from({ length: EVENTS_MAX }, (_, k) => `filler-${k}`);
  expect(marks([...many, one])).toEqual({});
  expect(Object.keys(marks([one, ...many]))).toEqual(["p1"]);
});

test("a program is marked for the calls it made, and each of them for itself; a tool's marks follow what its server says now", () => {
  const t = scratch();
  // The table the daemon keeps a program's calls in, as its route makes it.
  t.store.migrate("CREATE TABLE IF NOT EXISTS code_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)");
  const made = (parent: string, seq: number, tool: string, input: unknown) =>
    t.store.db.query("INSERT INTO code_calls (id, session_id, parent, seq, data) VALUES (?, ?, ?, ?, ?)").run(`${parent}~${seq}`, t.session.id, parent, seq, JSON.stringify({ id: `${parent}~${seq}`, parent, seq, tool, input, started: 1000 }));
  const program: Use = { id: "prog", name: "run_code", input: { code: "return await tools.Bash({command:'git push --force origin main'})" } };
  const quiet: Use = { id: "quiet", name: "run_code", input: { code: "return await tools.Read({file_path:'a.ts'})" } };
  const event = t.reply([program, quiet]);
  // Before it has made a call, the program has no mark: its own text is a program, not a push.
  expect(t.marks([event])).toEqual({});
  made("prog", 1, "Read", { file_path: join(t.ws, "a.ts") });
  made("prog", 2, "Bash", { command: "git push --force origin main" });
  made("prog", 3, "Write", { file_path: "/etc/hosts", content: "x" });
  made("prog", 4, "Bash", { command: "git push -f origin main" });
  made("quiet", 1, "Read", { file_path: join(t.ws, "a.ts") });
  const got = Object.fromEntries(Object.entries(t.marks([event])).map(([id, m]) => [id, m.map((x) => `${x.kind}: ${x.short}`)]));
  expect(got).toEqual({
    "prog~2": ["risk: rewrites or deletes history on a remote"],
    "prog~3": ["outside: outside the folder"],
    "prog~4": ["risk: rewrites or deletes history on a remote"],
    // The program: each reason once, however many of its calls have it.
    prog: ["risk: rewrites or deletes history on a remote", "outside: outside the folder"],
  });
  expect(t.marks([event]).prog![0]!.why).toStartWith("A call it made: ");
  // An MCP tool is a read once its server says so; what was kept before the server was heard is not used.
  const tool = t.reply([{ id: "m1", name: "mcp__fs__stat", input: { path: join(t.home, ".bashrc") } }]);
  expect(Object.keys(t.marks([tool]))).toEqual(["m1"]);
  expect(t.marks([tool], { mcp: [{ qualified: "fs__stat", name: "stat", readOnly: true }] })).toEqual({});
});
