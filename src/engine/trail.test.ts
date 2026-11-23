// The artifact trail is made from the events alone: each file's last state,
// each command's exit code, branches and commits, the identifiers that recur;
// carried through compactions and held to its bound. The probe counts what a
// compaction kept by rule.
import { expect, test } from "bun:test";
import { KEPT_LOW, keptTotals, probeOf, spanOf, TRAIL_BYTES, trailOf, trailText } from "./trail.ts";

let seq = 0;
const ev = (kind: string, data: any) => ({ id: `e${++seq}`, session_id: "s", seq, ts: seq, kind, data }) as any;
const round = (name: string, input: any, content: string, is_error = false) => {
  const id = `c${++seq}`;
  return [ev("assistant", { blocks: [{ type: "tool_use", id, name, input }], stop: "tool_use" }), ev("tool_result", { results: [{ type: "tool_result", tool_use_id: id, content, is_error }] })];
};

const span = [
  ev("user", { text: "Fix the export in src/export.ts and keep MAX_ROWS as it is." }),
  ...round("Read", { file_path: "/w/src/export.ts" }, "1\tconst MAX_ROWS = 10;"),
  ...round("Write", { file_path: "/w/src/new.ts" }, "File created successfully at: /w/src/new.ts"),
  ...round("Edit", { file_path: "/w/src/export.ts" }, "The file /w/src/export.ts has been updated successfully."),
  ...round("Edit", { file_path: "/w/src/export.ts" }, "The file /w/src/export.ts has been updated successfully."),
  ...round("Edit", { file_path: "/w/src/broken.ts" }, "old_string not found", true),
  ...round("apply_patch", { input: "*** Begin Patch\n*** Add File: docs/notes.md\n+x\n*** Delete File: docs/old.md\n*** End Patch" }, "Done"),
  ...round("Bash", { command: "git checkout -b fix-export && rm /w/tmp/scratch.txt" }, "Switched to a new branch 'fix-export'"),
  ...round("Bash", { command: "bun test src/export.test.ts" }, "Exit code 1\n1 fail in src/export.test.ts (MAX_ROWS)", true),
  ...round("Bash", { command: "bun test src/export.test.ts" }, "3 pass"),
  ...round("Bash", { command: "git commit -am 'Fix the export'" }, "[fix-export 1a2b3c4d] Fix the export\n 2 files changed"),
  ...round("WebFetch", { url: "https://example.com" }, "MAX_ROWS"),
  ev("assistant", { blocks: [{ type: "text", text: "MAX_ROWS stays; src/export.ts is fixed in 1a2b3c4d." }], stop: "end_turn" }),
];

test("the trail holds each file's last state, the commands with their exit codes, branches and commits", () => {
  const t = trailOf(span);
  const f = Object.fromEntries(t.files.map((x) => [x.path, x]));
  expect(f["/w/src/new.ts"]).toEqual({ path: "/w/src/new.ts", created: true });
  expect(f["/w/src/export.ts"]).toEqual({ path: "/w/src/export.ts", reads: 1, edits: 2 });
  expect(f["/w/src/broken.ts"]).toBeUndefined(); // the edit failed
  expect(f["docs/notes.md"]!.created).toBe(true);
  expect(f["docs/old.md"]!.deleted).toBe(true);
  expect(f["/w/tmp/scratch.txt"]!.deleted).toBe(true);
  expect(t.commands).toEqual([
    { cmd: "git checkout -b fix-export && rm /w/tmp/scratch.txt", exit: 0, runs: 1 },
    { cmd: "bun test src/export.test.ts", exit: 0, runs: 2 },
    { cmd: "git commit -am 'Fix the export'", exit: 0, runs: 1 },
  ]);
  expect(t.branches).toEqual(["fix-export"]);
  expect(t.commits).toEqual([{ sha: "1a2b3c4d", branch: "fix-export", subject: "Fix the export" }]);
  expect(t.ids).toContain("MAX_ROWS");
  const text = trailText(t, "");
  expect(text).toContain("- /w/src/export.ts (edited 2 times)");
  expect(text).toContain("- docs/old.md (deleted)");
  expect(text).toContain("- bun test src/export.test.ts -> 0 (2 runs)");
  expect(text).toContain("- 1a2b3c4d Fix the export (fix-export)");
  // What the summary names already is not repeated.
  expect(text).toMatch(/nothing above names:.*MAX_ROWS/);
  expect(trailText(t, "MAX_ROWS")).not.toMatch(/nothing above names:.*MAX_ROWS/);
  // Carried through the next compaction: the earlier span's files stay, the new span's come first.
  const next = trailOf(round("Edit", { file_path: "/w/src/new.ts" }, "The file /w/src/new.ts has been updated successfully."), t);
  expect(next.files.find((x) => x.path === "/w/src/new.ts")).toEqual({ path: "/w/src/new.ts", created: true, edits: 1 });
  expect(next.files.at(-1)!.path).toBe("/w/src/new.ts");
  expect(trailText(next, "")).toMatch(/Files written \(newest first\):\n- \/w\/src\/new\.ts \(created, edited\)/);
});

test("the trail's text holds to its bound and counts what it left out", () => {
  const many = Array.from({ length: 400 }, (_, k) => round(k % 2 ? "Write" : "Bash", k % 2 ? { file_path: `/w/a/very/long/folder/name/file-${k}.ts` } : { command: `make target-${k} && echo ${"x".repeat(80)}` }, k % 2 ? "File created successfully" : "ok")).flat();
  const text = trailText(trailOf(many));
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TRAIL_BYTES);
  expect(text).toMatch(/\(\d+ more entries past the trail's 5000-byte bound left out; the stored history keeps them\.\)/);
  // Both parts got room, newest first.
  expect(text).toContain("file-399.ts");
  expect(text).toContain("make target-398");
});

test("the probe counts the written files and recurring identifiers kept, and identifiers nothing supports", () => {
  const t = trailOf(span);
  const summary = "Fixed export.ts; MAX_ROWS kept. Next: PR #4512 and deadbeef99.";
  const text = trailText(t, summary);
  const p = probeOf(spanOf(span), summary, "", text, "");
  expect(p.files).toBe(5); // new.ts, export.ts, notes.md, old.md, scratch.txt (the failed edit is not one)
  expect(p.files_summary).toBe(1); // export.ts, by its name
  expect(p.files_kept).toBe(5);
  expect(p.anchors).toBeGreaterThan(0);
  expect(p.anchors_kept).toBe(p.anchors);
  expect(p.anchors_summary).toBeLessThan(p.anchors);
  expect(p.unsupported_ids).toEqual(["#4512", "deadbeef99"]);
  expect(p.trail_bytes).toBe(Buffer.byteLength(text));
});

test("a range's compactions: median shares kept, and the sessions under the bar named", () => {
  const p = (files: number, files_kept: number, anchors: number, anchors_kept: number, unsupported = 0) => ({ files, files_kept, files_summary: 0, anchors, anchors_kept, anchors_summary: 0, ids: 0, unsupported, trail_bytes: 0 });
  const t = keptTotals([
    { session_id: "a", title: "Good", probe: p(10, 10, 100, 60) },
    { session_id: "a", title: "Good", probe: p(10, 9, 100, 40, 2) },
    { session_id: "b", title: "Thin", probe: p(20, 2, 200, 20) },
    { session_id: "c", probe: null }, // from before the probe
  ]);
  expect(t).toMatchObject({ measured: 3, threshold: KEPT_LOW, unsupported: 1, files_kept: 0.9, anchors_kept: 0.4, files_summary: 0, anchors_summary: 0 });
  expect(t.low).toEqual([{ session_id: "b", title: "Thin", compactions: 1, files_kept: 0.1, anchors_kept: 0.1 }]);
});
