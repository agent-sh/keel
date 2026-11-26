import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { made, markSeen, shown } from "./shell-seen.ts";
import { guardOverwrite, writeFile } from "./files.ts";
import type { ToolContext } from "./types.ts";

test("the files a command prints whole, and how many lines it prints at most", () => {
  expect(shown("cat a.ts", "/w")).toEqual([{ path: "/w/a.ts", lines: Infinity }]);
  expect(shown("cd sub && cat -n a.ts b.ts", "/w").map((s) => s.path)).toEqual(["/w/sub/a.ts", "/w/sub/b.ts"]);
  expect(shown("sed -n '1,$p' a.ts", "/w")).toEqual([{ path: "/w/a.ts", lines: Infinity }]);
  expect(shown("sed -n 1,200p /x/a.ts", "/w")).toEqual([{ path: "/x/a.ts", lines: 200 }]);
  expect(shown("head -n 500 a.ts", "/w")).toEqual([{ path: "/w/a.ts", lines: 500 }]);
  expect(shown("tail -50 a.ts", "/w")).toEqual([{ path: "/w/a.ts", lines: 50, end: true }]);
  // A range from the middle, a filter, a copy to a file and a script that edits are no whole read.
  expect(shown("sed -n 5,10p a.ts", "/w")).toEqual([]);
  expect(shown("cat a.ts | head -3", "/w")).toEqual([]);
  expect(shown("cat a.ts > b.ts", "/w")).toEqual([]);
  expect(shown("sed -i s/a/b/ a.ts", "/w")).toEqual([]);
  expect(shown("cat $F", "/w")).toEqual([]);
  // The error stream sent away shows the same lines; the output sent away, to /dev/null included, shows none.
  for (const yes of ["cat a.ts 2>/dev/null", "cat a.ts 2>&1", "cat a.ts 2> err.log", "head -n 5 a.ts 2>>err.log"]) expect(shown(yes, "/w").map((s) => s.path)).toEqual(["/w/a.ts"]);
  for (const no of ["cat a.ts > /dev/null", "cat a.ts 1>/dev/null", "cat a.ts >/dev/null 2>&1", "cat a.ts &>/dev/null", "cat a.ts &> out.log", "cat a.ts >> b.ts", "head -n 5 a.ts 2>&1 >/dev/null", "cat a.ts >&2"]) expect(shown(no, "/w")).toEqual([]);
});

test("the files a command makes with a redirect or tee", () => {
  expect(made("cat > out.txt <<'EOF'\nbody > not a file\nEOF", "/w")).toEqual(["/w/out.txt"]);
  expect(made("echo hi >> /x/log.txt && ls", "/w")).toEqual(["/x/log.txt"]);
  expect(made("make 2>&1 | tee build.log", "/w")).toEqual(["/w/build.log"]);
  expect(made("echo hi > /dev/null", "/w")).toEqual([]);
});

test("a file a command showed whole or made is one a Write may replace at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-seen-"));
  const ctx = { cwd: dir, seen: new Map<string, number>(), sessionId: "s" } as unknown as ToolContext;
  const f = (n: string, body: string) => { writeFileSync(join(dir, n), body); return join(dir, n); };
  const whole = f("whole.txt", "a\nb\nc\n"), long = f("long.txt", "a\nb\nc\nd\n"), mine = f("mine.txt", "made by the command\n");
  markSeen(ctx, "cat whole.txt && head -n 2 long.txt", dir, "a\nb\nc\na\nb\n");
  markSeen(ctx, "echo made > mine.txt", dir, "");
  expect(await guardOverwrite(whole, ctx)).toBeNull();
  expect(await guardOverwrite(mine, ctx)).toBeNull();
  expect(await guardOverwrite(long, ctx)).toContain("was not read in this session");
  // A head that covers the file counts; a file changed since is read again.
  markSeen(ctx, "head -n 4 long.txt", dir, "a\nb\nc\nd\n");
  expect(await guardOverwrite(long, ctx)).toBeNull();
  writeFileSync(whole, "changed\n", { flag: "a" });
  const later = new Date(Date.now() + 5000);
  (await import("node:fs")).utimesSync(whole, later, later);
  expect(await guardOverwrite(whole, ctx)).toContain("changed on disk");
});

test("the refusal of an unread file says how to go on in one call, and a file this session wrote is one it knows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-seen-"));
  const ctx = { cwd: dir, seen: new Map<string, number>(), sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;
  const old = join(dir, "old.txt"), mine = join(dir, "mine.txt");
  writeFileSync(old, "kept\n");
  const said = (await guardOverwrite(old, ctx))!;
  expect(said).toContain("send the same Write again now");
  expect(said).toContain("Read it first");
  expect(said).toContain("Edit");
  expect(await guardOverwrite(old, ctx)).toBeNull();
  // A file the session made with Write is known to it: the second Write is not refused.
  expect(await guardOverwrite(mine, ctx)).toBeNull();
  expect(await writeFile(mine, "one\n", ctx)).toBeUndefined();
  expect(await guardOverwrite(mine, ctx)).toBeNull();
});
