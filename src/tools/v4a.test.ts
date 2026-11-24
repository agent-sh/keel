// Fixtures of the V4A engine, ported from the Rust Keel's v4a_patch tests
// (which follow openai/codex apply-patch's reference cases).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anchorText, applyPatch, buildDiff, extractShellApplyPatch, parsePatch, parseShellApplyPatch, patchTargetPaths, patchTargets, seekSequence } from "./v4a.ts";
import { homeDir } from "../core/paths";

const SCRATCH = join(homeDir(), ".cache/keel-work/bun/tools-lane/v4a-scratch");
mkdirSync(SCRATCH, { recursive: true });
const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(SCRATCH, "t-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
const put = (dir: string, rel: string, text: string) => writeFileSync(join(dir, rel), text);
const P = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const chunk = (o: Partial<{ anchor: string | null; old_lines: string[]; new_lines: string[]; context: [number, number][]; is_end_of_file: boolean }>) => ({
  anchor: null, old_lines: [], new_lines: [], context: [], is_end_of_file: false, ...o,
});

test("the parser matches the reference cases", () => {
  expect(parsePatch(P("*** Add File: path/add.py\n+abc\n+def\n*** Delete File: path/delete.py\n*** Update File: path/update.py\n*** Move to: path/update2.py\n@@ def f():\n-    pass\n+    return 123"))).toEqual([
    { type: "add", path: "path/add.py", contents: "abc\ndef\n" },
    { type: "delete", path: "path/delete.py" },
    { type: "update", path: "path/update.py", move_to: "path/update2.py", chunks: [chunk({ anchor: "def f():", old_lines: ["    pass"], new_lines: ["    return 123"] })] },
  ]);

  // An update followed by another file; a first chunk without `@@`.
  const h = parsePatch(P("*** Update File: file.py\n@@\n+line\n*** Add File: other.py\n+content\n*** Update File: file2.py\n import foo\n+bar"));
  expect(h.length).toBe(3);
  expect(h[2]).toEqual({ type: "update", path: "file2.py", move_to: null, chunks: [chunk({ old_lines: ["import foo"], new_lines: ["import foo", "bar"], context: [[0, 0]] })] });

  // End of File marker followed by a blank line.
  expect(parsePatch(P("*** Update File: file.txt\n@@\n+quux\n*** End of File\n"))).toEqual([
    { type: "update", path: "file.txt", move_to: null, chunks: [chunk({ new_lines: ["quux"], is_end_of_file: true })] },
  ]);

  // Bare empty lines are empty context; indented markers are context.
  const ind = parsePatch(P("*** Update File: a.txt\n@@\n context before\n\n context after\n-old a\n+new a\n *** Update File: b.txt\n@@\n-old b\n+new b"));
  expect(ind.length).toBe(1);
  const u = ind[0]!;
  if (u.type !== "update") throw new Error("not an update");
  expect(u.chunks.length).toBe(2);
  expect(u.chunks[0]!.old_lines).toEqual(["context before", "", "context after", "old a", "*** Update File: b.txt"]);

  // CRLF patch text inside a heredoc wrapper; an environment preamble.
  expect(parsePatch("<<'EOF'\r\n*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\nEOF\r\n")).toEqual([
    { type: "update", path: "file.txt", move_to: null, chunks: [chunk({ old_lines: ["old"], new_lines: ["new"] })] },
  ]);
  expect(parsePatch(P("*** Environment ID: remote\n*** Add File: hello.txt\n+hello"))).toEqual([{ type: "add", path: "hello.txt", contents: "hello\n" }]);
});

test("unified-diff ranges are not anchors", () => {
  expect(anchorText("@@")).toBeNull();
  expect(anchorText("@@ fn main() {")).toBe("fn main() {");
  expect(anchorText("@@ -3,7 +3,8 @@")).toBeNull();
  expect(anchorText("@@ -3,7 +3,8 @@ fn main() {")).toBe("fn main() {");
  expect(anchorText("@@ -x + y @@")).toBe("-x + y @@");
});

test("the parser rejects what the reference rejects", () => {
  const err = (p: string) => { try { parsePatch(p); } catch (e) { return (e as Error).message; } return "parsed"; };
  expect(err("bad")).toContain("The first line of the patch must be '*** Begin Patch'");
  expect(err("*** Begin Patch\nbad")).toContain("The last line of the patch must be '*** End Patch'");
  expect(err(P("bad"))).toContain("is not a valid hunk header");
  expect(err(P("*** Add File: f\nbad"))).toContain("is not a valid hunk header");
  expect(err(P("*** Delete File: f\nbad"))).toContain("is not a valid hunk header");
  expect(err(P("*** Update File: test.py"))).toContain("Update file hunk for path 'test.py' is empty");
  expect(err(P("*** Update File: f\n@@"))).toContain("Update hunk does not contain any lines");
  expect(err(P("*** Update File: f\n@@\n*** End of File"))).toContain("Update hunk does not contain any lines");
  expect(err(P("*** Update File: f\n@@\n@@"))).toContain("Unexpected line found in update hunk: '@@'");
  expect(err(P("*** Update File: f\n@@\n-old\nbad"))).toContain("Expected update hunk to start with a @@ context marker, got: 'bad'");
  expect(err(P("*** Update File: f\n@@\n*** Update File: g\n@@\n-a"))).toContain("Update hunk does not contain any lines");
});

test("target paths come from the parser, or from the headers of a broken patch", () => {
  expect(patchTargetPaths(P("*** Add File:nospace.txt\n+hi\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** Delete File: c.txt"))).toEqual(["nospace.txt", "a.txt", "b.txt", "c.txt"]);
  expect(patchTargetPaths("*** Begin Patch\n*** Update File: only.txt\n")).toEqual(["only.txt"]);
});

test("seek passes relax in order and never go back", () => {
  const lines = ["foo   ", "    bar\t", "say “hi” – ok"];
  expect(seekSequence(lines, ["foo"], 0, false)).toBe(0);
  expect(seekSequence(lines, ["bar"], 0, false)).toBe(1);
  expect(seekSequence(lines, ['say "hi" - ok'], 0, false)).toBe(2);
  expect(seekSequence(lines, ["a", "b", "c", "d"], 0, false)).toBeNull();
  expect(seekSequence(lines, [], 2, false)).toBe(2);
  expect(seekSequence(lines, ["foo"], 1, false)).toBeNull();
  expect(seekSequence(["x", "y", "x"], ["x"], 0, true)).toBe(2);
  expect(seekSequence(["x", "y", "x"], ["x"], 0, false)).toBe(0);
});

test("the end-of-file marker in updates and added files", async () => {
  const d = tmp();
  put(d, "a.txt", "one\ntwo\n");
  put(d, "b.txt", "x\n");
  await applyPatch(d, P("*** Update File: a.txt\n@@\n one\n-two\n+three\n*** End of File\n*** Update File: b.txt\n@@\n-x\n+y\n*** Add File: c.txt\n+new\n*** End of File"));
  expect(read(d, "a.txt")).toBe("one\nthree\n");
  expect(read(d, "b.txt")).toBe("y\n");
  expect(read(d, "c.txt")).toBe("new\n");
  await applyPatch(d, P("*** Update File: a.txt\n@@\n+tail\n*** End of File"));
  expect(read(d, "a.txt")).toBe("one\nthree\ntail\n");
  put(d, "d.txt", "dup\nmid\ndup\n");
  await applyPatch(d, P("*** Update File: d.txt\n@@\n-dup\n+last\n*** End of File"));
  expect(read(d, "d.txt")).toBe("dup\nmid\nlast\n");
});

const TWO_FNS = "fn first() {\n    let x = 1;\n    x\n}\n\nfn second() {\n    let x = 1;\n    x\n}\n";

test("anchors position chunks and pure additions; a miss writes nothing", async () => {
  const d = tmp();
  put(d, "m.rs", TWO_FNS);
  await applyPatch(d, P("*** Update File: m.rs\n@@ fn second() {\n-    let x = 1;\n+    let x = 2;"));
  expect(read(d, "m.rs")).toBe(TWO_FNS.replace("fn second() {\n    let x = 1;", "fn second() {\n    let x = 2;"));

  put(d, "n.rs", TWO_FNS);
  await applyPatch(d, P("*** Update File: n.rs\n@@ fn second() {\n+    // added"));
  expect(read(d, "n.rs")).toBe(TWO_FNS.replace("fn second() {\n", "fn second() {\n    // added\n"));
  await applyPatch(d, P("*** Update File: n.rs\n@@\n+// trailer"));
  expect(read(d, "n.rs").endsWith("}\n// trailer\n")).toBe(true);

  put(d, "o.rs", "keep\n");
  const before = read(d, "n.rs");
  const e = await applyPatch(d, P("*** Update File: o.rs\n@@\n-keep\n+changed\n*** Update File: n.rs\n@@ fn nowhere() {\n+    // lost")).catch((x) => x as Error);
  expect((e as Error).message).toContain("Failed to find context 'fn nowhere() {'");
  expect(read(d, "n.rs")).toBe(before);
  expect(read(d, "o.rs")).toBe("keep\n");

  put(d, "p.rs", TWO_FNS);
  await applyPatch(d, P("*** Update File: p.rs\n@@ fn first() {\n-    let x = 1;\n+    let x = 10;\n@@ fn second() {\n-    let x = 1;\n+    let x = 20;"));
  const p = read(d, "p.rs");
  expect(p).toContain("fn first() {\n    let x = 10;");
  expect(p).toContain("fn second() {\n    let x = 20;");
});

test("a context miss names the hunk and the line that differs", async () => {
  const d = tmp();
  put(d, "q.rs", TWO_FNS);
  const e = (await applyPatch(d, P("*** Update File: q.rs\n@@\n fn first() {\n-    let x = 9;\n+    let x = 2;")).catch((x) => x)) as Error;
  expect(e.message).toContain("Failed to find expected lines in q.rs: hunk 1 of 1.");
  expect(e.message).toContain("Line 2 of the hunk, 'let x = 9;', differs from line 2 of the file: the file has 'let x = 1;'");
  // Hunks out of file order are told apart from text that is not there.
  const o = (await applyPatch(d, P("*** Update File: q.rs\n@@ fn second() {\n-    x\n+    y\n@@\n-fn first() {\n+fn one() {")).catch((x) => x)) as Error;
  expect(o.message).toContain("above line");
});

test("every action, one record per file, and Codex's summary", async () => {
  const d = tmp();
  put(d, "old.txt", "a\nb\n");
  put(d, "gone.txt", "bye\n");
  put(d, "t.txt", "1\n2\n3\n4\n");
  const out = await applyPatch(d, P("*** Add File: nested/dir/new.txt\n+hello\n\n+world\n*** Delete File: gone.txt\n*** Update File: old.txt\n*** Move to: renamed/new-name.txt\n@@\n a\n-b\n+B\n*** Update File: t.txt\n@@\n-1\n+one\n*** Update File: t.txt\n@@\n-4\n+four"));
  expect(read(d, "nested/dir/new.txt")).toBe("hello\n\nworld\n");
  expect(existsSync(join(d, "gone.txt"))).toBe(false);
  expect(existsSync(join(d, "old.txt"))).toBe(false);
  expect(read(d, "renamed/new-name.txt")).toBe("a\nB\n");
  expect(read(d, "t.txt")).toBe("one\n2\n3\nfour\n");
  expect(out.files.map((f) => [f.path, f.kind])).toEqual([
    ["nested/dir/new.txt", "add"], ["gone.txt", "delete"], ["old.txt", "delete"], ["renamed/new-name.txt", "move"], ["t.txt", "update"],
  ]);
  const t = out.files.find((f) => f.path === "t.txt")!;
  expect([t.added, t.removed]).toEqual([2, 2]);
  expect(t.diff).toBe("--- a/t.txt\n+++ b/t.txt\n@@ -1,4 +1,4 @@\n-1\n+one\n 2\n 3\n-4\n+four\n");
  expect(out.summary).toBe("Success. Updated the following files:\nA nested/dir/new.txt (+3 -0)\nD gone.txt (+0 -1)\nR old.txt -> renamed/new-name.txt (+1 -1)\nM t.txt (+2 -2)");
  expect(readdirSync(d).filter((n) => n.includes("keel-tmp"))).toEqual([]);

  // A pure rename is allowed; later actions see earlier ones.
  await applyPatch(d, P("*** Update File: t.txt\n*** Move to: u.txt\n*** Add File: t.txt\n+fresh\n*** Update File: t.txt\n@@\n-fresh\n+fresher"));
  expect(read(d, "u.txt")).toBe("one\n2\n3\nfour\n");
  expect(read(d, "t.txt")).toBe("fresher\n");
  // A patch that changes nothing says so.
  expect((await applyPatch(d, P("*** Update File: t.txt\n@@\n-fresher\n+fresher")).catch((x) => x) as Error).message).toContain("changes nothing");
});

test("mode and line endings survive; overwrites are refused", async () => {
  const d = tmp();
  put(d, "run.sh", "#!/bin/sh\necho one\n");
  chmodSync(join(d, "run.sh"), 0o755);
  await applyPatch(d, P("*** Update File: run.sh\n*** Move to: bin/run.sh\n@@\n-echo one\n+echo two"));
  expect(statSync(join(d, "bin/run.sh")).mode & 0o777).toBe(0o755);

  put(d, "w.txt", "a\r\nb\r\nc\r\n");
  await applyPatch(d, P("*** Update File: w.txt\n@@\n a\n-b\n+B\n+B2"));
  expect(read(d, "w.txt")).toBe("a\r\nB\r\nB2\r\nc\r\n");

  put(d, "f.txt", "keep me   \nold\n");
  await applyPatch(d, P("*** Update File: f.txt\n@@\n keep me\n-old\n+new"));
  expect(read(d, "f.txt")).toBe("keep me   \nnew\n");

  put(d, "nonl.txt", "no newline at end");
  await applyPatch(d, P("*** Update File: nonl.txt\n@@\n-no newline at end\n+first line\n+second line"));
  expect(read(d, "nonl.txt")).toBe("first line\nsecond line\n");

  put(d, "exists.txt", "keep\n");
  const msg = async (p: string) => ((await applyPatch(d, p).catch((x) => x)) as Error).message ?? "applied";
  expect(await msg(P("*** Add File: exists.txt\n+clobber"))).toContain("already exists");
  expect(await msg(P("*** Update File: w.txt\n*** Move to: exists.txt\n@@\n-c\n+C"))).toContain("already exists");
  expect(read(d, "exists.txt")).toBe("keep\n");
  expect(await msg(P("*** Delete File: missing.txt"))).toContain("does not exist");
  expect(await msg(P("*** Update File: missing.txt\n@@\n-a\n+b"))).toContain("does not exist");
});

test("symlinks and .. cannot carry a patch out of the workspace", async () => {
  const ws = tmp();
  const outside = tmp();
  put(outside, "victim.txt", "secret\n");
  put(ws, "inside.txt", "mine\n");
  symlinkSync(outside, join(ws, "link"));
  symlinkSync(join(outside, "victim.txt"), join(ws, "file-link"));
  for (const p of [
    P("*** Add File: link/new.txt\n+escaped"),
    P("*** Update File: link/victim.txt\n@@\n-secret\n+changed"),
    P("*** Delete File: link/victim.txt"),
    P("*** Update File: inside.txt\n*** Move to: link/moved.txt\n@@\n-mine\n+stolen"),
    P("*** Update File: file-link\n@@\n-secret\n+changed"),
    P("*** Add File: ../escape.txt\n+x"),
  ]) {
    const e = (await applyPatch(ws, p).catch((x) => x)) as Error;
    expect(e.message).toContain("outside the workspace");
  }
  expect(read(outside, "victim.txt")).toBe("secret\n");
  expect(existsSync(join(outside, "new.txt"))).toBe(false);
  expect(read(ws, "inside.txt")).toBe("mine\n");

  // An absolute path that is really inside is fine; a gate can clear an outside path.
  await applyPatch(ws, P(`*** Update File: ${join(ws, "inside.txt")}\n@@\n-mine\n+ours`));
  expect(read(ws, "inside.txt")).toBe("ours\n");
  await applyPatch(ws, P("*** Add File: link/new.txt\n+allowed"), { allowOutside: [join(realpathSync(outside), "new.txt")] });
  expect(read(outside, "new.txt")).toBe("allowed\n");
});

test("the tool writes a file outside the session's folder once the gate let the call through", async () => {
  // The gate judges a patch's files where they land (policy.ts), as it does a Write's; what reaches the tool was let through.
  const { applyPatchTool, gptTools } = await import("./gpt.ts");
  const exec = gptTools.find((t) => t.name === "exec_command")!;
  const ws = tmp(), other = tmp();
  put(other, "a.txt", "one\n");
  const ctx = { sessionId: "v4a-outside", cwd: ws, seen: new Map(), signal: new AbortController().signal } as any;
  const out = (r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
  const r = await applyPatchTool.run({ input: P(`*** Update File: ${join(other, "a.txt")}\n@@\n-one\n+two`) }, ctx);
  expect([r.is_error ?? false, out(r)]).toEqual([false, expect.stringContaining("a.txt")]);
  expect(read(other, "a.txt")).toBe("two\n");
  const s = await exec.run({ cmd: `cd ${other} && apply_patch <<'EOF'\n${P("*** Add File: b.txt\n+new")}\nEOF` }, ctx);
  expect([s.is_error ?? false, read(other, "b.txt")]).toEqual([false, "new\n"]);
});

test("relative paths start at the base directory; records name the workspace path", async () => {
  const ws = tmp();
  mkdirSync(join(ws, "sub"));
  put(ws, "top.txt", "top\n");
  const out = await applyPatch(ws, P("*** Add File: made.txt\n+hi\n*** Update File: ../top.txt\n@@\n-top\n+TOP"), { base: join(ws, "sub") });
  expect(read(ws, "sub/made.txt")).toBe("hi\n");
  expect(read(ws, "top.txt")).toBe("TOP\n");
  expect(out.files.map((f) => f.path)).toEqual(["sub/made.txt", "top.txt"]);
  const targets = await patchTargets(ws, join(ws, "sub"), P("*** Add File: ../../out.txt\n+x"));
  expect(targets[0]!.inside).toBe(false);
});

test("shell forms follow Codex", () => {
  const body = P("*** Add File: n.txt\n+hi");
  const ok = (cd: string | null = null) => ({ kind: "patch" as const, patch: body, cd });
  const p = parseShellApplyPatch;
  expect(p(`apply_patch <<'EOF'\n${body}\nEOF`)).toEqual(ok());
  expect(p(`apply_patch <<EOF\n${body}\nEOF\n`)).toEqual(ok());
  expect(p(`apply_patch <<EOF\n${body}\n`)).toEqual(ok());
  expect(p(`applypatch <<"PATCH"\n${body}\nPATCH`)).toEqual(ok());
  expect(p(`cd foo && apply_patch <<'EOF'\n${body}\nEOF`)).toEqual(ok("foo"));
  expect(p(`cd 'foo bar' && apply_patch <<'EOF'\n${body}\nEOF`)).toEqual(ok("foo bar"));
  expect(p(`apply_patch "${body}"`)).toEqual(ok());
  expect(p(`apply_patch '${body}'`)).toEqual(ok());
  for (const bad of [
    `apply_patch <<'EOF'\n${body}\nEOF\n && cargo test`,
    `apply_patch <<'EOF'\n${body}\nEOF\ncargo test`,
    `apply_patch <<'EOF' && cargo test\n${body}\nEOF`,
    `cd foo; apply_patch <<'EOF'\n${body}\nEOF`,
    `cd foo || apply_patch <<'EOF'\n${body}\nEOF`,
    `cd foo bar && apply_patch <<'EOF'\n${body}\nEOF`,
    `cd foo && cd bar && apply_patch <<'EOF'\n${body}\nEOF`,
    `echo foo && apply_patch <<'EOF'\n${body}\nEOF`,
    `apply_patch "${body}" && echo done`,
    `apply_patch <<'EOF'\n${body}\nEOF && cargo test`,
    `apply_patch <<'EOF'\n${body}\nEOF; rm -rf x`,
    "apply_patch",
  ]) {
    expect(p(bad).kind).toBe("rejected");
    expect(extractShellApplyPatch(bad)).toBeNull();
  }
  for (const other of ["ls -la", "git apply fix.patch", "cat > notes.md <<'EOF'\napply_patch <<'X'\nEOF", "echo apply_patch"]) {
    expect(p(other)).toEqual({ kind: "not_patch" });
  }
});

test("buildDiff gives unified hunks with three lines of context", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const after = before.replace("l2\n", "L2\n").replace("l18\n", "");
  const d = buildDiff("x.txt", before, after);
  expect([d.added, d.removed]).toEqual([1, 2]);
  expect(d.diff).toBe("--- a/x.txt\n+++ b/x.txt\n@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n@@ -15,6 +15,5 @@\n l15\n l16\n l17\n-l18\n l19\n l20\n");
  expect(buildDiff("n.txt", "", "a\nb\n").diff).toBe("--- a/n.txt\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  expect(buildDiff("s.txt", "same\n", "same\n").diff).toBe("");
  // Only the final newline changed: it shows, and an identical file stays unchanged.
  const eol = buildDiff("e.txt", "same", "same\n");
  expect([eol.added, eol.removed]).toEqual([1, 1]);
  expect(eol.diff).toBe("--- a/e.txt\n+++ b/e.txt\n@@ -1,1 +1,1 @@\n-same\n\\ No newline at end of file\n+same\n");
  expect(buildDiff("e.txt", "same", "same").diff).toBe("");
  expect(buildDiff("e.txt", "old\nlast", "new\nlast\n").added).toBe(2);
});
