// What Keel knows about a tool call before asking the memory store about it:
// the rules are read off what the store's hook does with a call.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callKey, changesSomething, filesOf, inCheckout, namesStore, neverAnswered, Nothing, NOTHING_FOR_MS, Searches } from "./tacit-tools.ts";

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const edit = (file_path: string) => ({ tool_name: "Edit", tool_input: { file_path } });
const patch = (...files: string[]) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`).join("\n")}\n*** End Patch` } });
const mcp = (name: string) => ({ tool_name: `mcp__${name}`, tool_input: { path: "x", command: "y" } });

test("a call's key is what the store's answer depends on, and nothing else", () => {
  const cwd = "/work/repo";
  // An edit and a write of a file, a command line, an MCP tool's name; the session's folder.
  expect(callKey(cwd, edit("src/a.ts"))).toBe(callKey(cwd, edit("src/a.ts")));
  expect(callKey(cwd, edit("src/a.ts"))).not.toBe(callKey(cwd, edit("src/b.ts")));
  expect(callKey(cwd, edit("src/a.ts"))).not.toBe(callKey("/work/other", edit("src/a.ts")));
  expect(callKey(cwd, bash("git status"))).not.toBe(callKey(cwd, bash("git status -s")));
  // A patch by the files it writes, whatever its text; an MCP tool by its name, whatever its input.
  expect(filesOf(patch("b.ts", "a.ts"))).toEqual(["b.ts", "a.ts"]);
  expect(callKey(cwd, patch("b.ts", "a.ts"))).toBe(callKey(cwd, patch("a.ts", "b.ts")));
  expect(callKey(cwd, patch("a.ts"))).not.toBe(callKey(cwd, patch("a.ts", "b.ts")));
  expect(callKey(cwd, mcp("drive__list"))).toBe(callKey(cwd, { tool_name: "mcp__drive__list", tool_input: { other: 1 } }));
  expect(callKey(cwd, mcp("drive__list"))).not.toBe(callKey(cwd, mcp("drive__read")));
});

test("calls the store records as steps are always made; edits outside every checkout and empty commands never are", () => {
  // The store's own tools and its command line: it logs them, whatever it answers.
  for (const c of [mcp("tacit__tacit_fact"), mcp("tacit__tacit_search"), bash("tacit fact some-name"), bash("cd /x && ~/.local/bin/tacit tree --depth 2"), bash("FOO=1 tacit search words")]) {
    expect(namesStore(c)).toBe(true);
    expect(neverAnswered("/nowhere", c)).toBe(false);
  }
  for (const c of [mcp("drive__list"), bash("git status"), bash("cat tacit-standin.sh"), edit("a.ts")]) expect(namesStore(c)).toBe(false);

  const root = mkdtempSync(join(tmpdir(), "keel-checkout-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(root, "scratch"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "x");
    // A file under a folder with a .git entry is in a checkout, a new file in a new folder of it too.
    expect(inCheckout(repo, "src/a.ts")).toBe(true);
    expect(inCheckout(repo, "new/dir/b.ts")).toBe(true);
    expect(neverAnswered(repo, edit("src/a.ts"))).toBe(false);
    expect(neverAnswered(join(root, "scratch"), edit(join(repo, "src/a.ts")))).toBe(false);
    expect(neverAnswered(repo, patch("src/a.ts", join(root, "scratch/n.txt")))).toBe(false);
    // The scratch folder is outside every checkout unless the temp folder itself sits in one.
    if (!inCheckout(root, "scratch/n.txt")) {
      expect(neverAnswered(repo, edit(join(root, "scratch/n.txt")))).toBe(true);
      expect(neverAnswered(join(root, "scratch"), { tool_name: "Write", tool_input: { file_path: "n.txt" } })).toBe(true);
      expect(neverAnswered(join(root, "scratch"), patch("n.txt", "m.txt"))).toBe(true);
      // A path is read as the store reads it. A link outside every checkout
      // that points at a file in one is that file; a path through ".." and a
      // folder that does not exist is the cleaned path.
      symlinkSync(join(repo, "src/a.ts"), join(root, "scratch/link.ts"));
      expect(neverAnswered(join(root, "scratch"), edit("link.ts"))).toBe(false);
      expect(neverAnswered(join(root, "scratch"), edit(join(root, "scratch/missing/../../repo/src/a.ts")))).toBe(false);
      // A link in a checkout that points out of every one is the file outside.
      symlinkSync(join(root, "scratch/n.txt"), join(repo, "src/out.txt"));
      writeFileSync(join(root, "scratch/n.txt"), "x");
      expect(neverAnswered(repo, edit("src/out.txt"))).toBe(true);
      // A checkout made a moment ago is one at once.
      mkdirSync(join(root, "scratch/.git"));
      expect(neverAnswered(join(root, "scratch"), edit("n.txt"))).toBe(false);
      rmSync(join(root, "scratch/.git"), { recursive: true });
    }
    // A shell command is answered anywhere (areas are not tied to a repository), unless it is empty.
    expect(neverAnswered(join(root, "scratch"), bash("make deploy"))).toBe(false);
    expect(neverAnswered(repo, bash("   "))).toBe(true);
    expect(neverAnswered(join(root, "scratch"), mcp("drive__list"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool's result is held for the answer only when the call changes something", () => {
  for (const c of ["cat a.ts", "git status", "git log --oneline | head -5", "cd src && grep -rn foo . | wc -l", "ls -la; rg -n bar src"]) expect([c, changesSomething(bash(c))]).toEqual([c, false]);
  for (const c of ["touch a", "git commit -m x", "cat a > b", "make deploy", "cd src && rm a.ts", "echo $(rm -rf x)", "bun test"]) expect([c, changesSomething(bash(c))]).toEqual([c, true]);
  // A command that writes is never a read, however its redirect is written:
  // alone, after a group or a loop, to a descriptor, read and write.
  for (const c of ["> f", "{ echo a; } > f", "for i in 1 2; do echo $i; done > f", "if true; then echo a; fi > f", "echo x >&f", "cat <>f", "cat a 2>/dev/null"]) expect([c, changesSomething(bash(c))]).toEqual([c, true]);
  // A command the parser makes nothing of counts as a change; no command at all is none.
  expect(changesSomething(bash("("))).toBe(true);
  expect(changesSomething(bash("  "))).toBe(false);
  expect(changesSomething(edit("a.ts"))).toBe(true);
  expect(changesSomething({ tool_name: "Write", tool_input: { file_path: "a.ts" } })).toBe(true);
  expect(changesSomething(patch("a.ts"))).toBe(true);
  // An MCP tool by what its server says of it; unknown counts as a change.
  expect(changesSomething(mcp("drive__list"), { readOnly: true })).toBe(false);
  expect(changesSomething(mcp("drive__delete"), { readOnly: false })).toBe(true);
  expect(changesSomething(mcp("drive__list"))).toBe(true);
  expect(changesSomething(mcp("drive__list"), null)).toBe(true);
});

test("an empty answer is believed for a while, then asked for again", () => {
  const n = new Nothing();
  const t0 = 1_000_000;
  expect(n.known("a", t0)).toBe(false);
  n.remember("a", t0);
  expect(n.known("a", t0 + 1)).toBe(true);
  expect(n.known("b", t0 + 1)).toBe(false);
  expect(n.known("a", t0 + NOTHING_FOR_MS - 1)).toBe(true);
  // The store may have changed by now: the call is asked again.
  expect(n.known("a", t0 + NOTHING_FOR_MS)).toBe(false);
  expect(n.size).toBe(0);
  // Remembered again from the new answer; bounded however many calls a session makes.
  n.remember("a", t0 + NOTHING_FOR_MS);
  expect(n.known("a", t0 + NOTHING_FOR_MS + 10)).toBe(true);
  for (let i = 0; i < 5_000; i++) n.remember(`k${i}`, t0 + NOTHING_FOR_MS + 20);
  expect(n.size).toBeLessThanOrEqual(1_000);
  expect(n.known("k4999", t0 + NOTHING_FOR_MS + 30)).toBe(true);
});

test("an empty answer counts as the store's nothing only when it took as long as a search", () => {
  const s = new Searches();
  // Before enough calls are seen, nothing is known about how long a search takes.
  for (let i = 0; i < 19; i++) { expect(s.searched(200)).toBe(false); s.add(200 + i); }
  s.add(230);
  // A search takes about 210 ms here: an answer in 12 ms came from no search (a stale index answers at once).
  expect(s.searched(12)).toBe(false);
  expect(s.searched(104)).toBe(false);
  expect(s.searched(106)).toBe(true);
  expect(s.searched(240)).toBe(true);
  // The window moves with the store: fifty fast searches later, fast is what a search takes.
  for (let i = 0; i < 50; i++) s.add(20);
  expect(s.searched(12)).toBe(true);
  expect(s.searched(8)).toBe(false);
});
