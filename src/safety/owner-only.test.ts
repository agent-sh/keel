// What is the owner's alone to change, however a call spells it: a patch's
// files as the patch tool reads them, a patch sent through the shell tool, a
// command whose plain shape writes such a file, and a tool given its path.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { applyPatchTool, gptTools } from "../tools/gpt.ts";
import type { Tool } from "../tools/types.ts";
import { Gate } from "./gate.ts";
import { classify, decide, pathsNamed, type Mode } from "./policy.ts";

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
    // Full auto runs it as it runs such an edit; Read only refuses it.
    expect([command, shell(command, "full-auto")]).toEqual([command, "allow"]);
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
      gate.resolve(card.id, sid, { choice: "once" });
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
    gate.resolve(card.id, sid, { choice: "once" });
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
