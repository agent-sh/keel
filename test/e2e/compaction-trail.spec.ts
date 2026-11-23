import { expect, test } from "./isolate.ts";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: a compaction keeps the artifact trail of the work. Beside the
// model's summary it stores a block made from the events by the harness: the
// files written and read with their last state, the commands with their exit
// codes, the branches and commits, the identifiers that recur. A probe with
// no model counts what the compaction kept of the span (with the trail, and
// of the summary alone); the transcript, the session's timeline and Usage >
// Compactions show it. The session is a long imported history of file work,
// compacted by the owner; the stand-in's summary names no file, as summaries
// so often do (only the owner's own words, kept with it, name a file).
test("a compaction keeps the work's artifact trail and says what it kept", async ({ page, request }) => {
  const lines: any[] = [];
  const add = (kind: string, data: any) => lines.push({ ref: `e${lines.length + 1}`, kind, data, ts: 1_700_000_000_000 + lines.length });
  let n = 0;
  const round = (name: string, input: any, content: string, is_error = false) => {
    const id = `call-${++n}`;
    add("assistant", { blocks: [{ type: "text", text: `Step ${n}.` }, { type: "tool_use", id, name, input }], stop: "tool_use", imported: true });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: id, content, is_error }] });
  };
  add("user", { text: "Fix the export in /work/app/src/export.ts. Keep MAX_ROWS as it is." });
  round("Read", { file_path: "/work/app/BRIEF.md" }, "1\t# Brief\n2\tKeep MAX_ROWS at 500.");
  round("Bash", { command: "git checkout -b fix-export" }, "Switched to a new branch 'fix-export'");
  for (let k = 1; k <= 8; k++) {
    const file = `/work/app/src/part-${k}.ts`;
    round("Write", { file_path: file, content: `export const MAX_ROWS_${k} = ${k};` }, `File created successfully at: ${file}`);
    round("Edit", { file_path: file, old_string: "1", new_string: "2" }, `The file ${file} has been updated successfully.`);
    add("user", { text: `Part ${k} is in; MAX_ROWS still holds.` });
  }
  round("Edit", { file_path: "/work/app/src/export.ts", old_string: "a", new_string: "b" }, "The file /work/app/src/export.ts has been updated successfully.");
  round("Bash", { command: "bun test src/export.test.ts" }, "Exit code 1\n1 fail: MAX_ROWS", true);
  round("Edit", { file_path: "/work/app/src/export.ts", old_string: "b", new_string: "c" }, "The file /work/app/src/export.ts has been updated successfully.");
  round("Bash", { command: "bun test src/export.test.ts" }, "9 pass");
  round("Bash", { command: "git commit -am 'Fix the export'" }, "[fix-export 1a2b3c4d5e] Fix the export\n 9 files changed");
  add("assistant", { blocks: [{ type: "text", text: "The export is fixed on fix-export in 1a2b3c4d5e; MAX_ROWS is unchanged." }], stop: "end_turn", imported: true });
  const file = [{ keel_export: 2, events: lines.length, scope: "current branch", title: "Trail check", model: HAIKU, workspace: "", created: 1_700_000_000_000 }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n";
  const made = await (await request.post("/api/sessions/import", { data: file, headers: { "content-type": "application/x-ndjson" } })).json();
  const id = made.session.id;

  await page.goto(`/s/${id}`);
  await page.getByTestId("context-meter").click();
  await page.getByTestId("compact-now").click();
  await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");

  // Stored with the compaction: the trail, as data and as the text the next requests carry, and the probe.
  const events = (await (await request.get(`/api/sessions/${id}/events`)).json()).events as any[];
  const cp = events.findLast((e) => e.kind === "compaction").data;
  expect(cp.trail_text).toContain("- /work/app/src/export.ts (edited 2 times)");
  expect(cp.trail_text).toContain("- /work/app/src/part-8.ts (created, edited)");
  expect(cp.trail_text).toContain("- bun test src/export.test.ts -> 0 (2 runs)");
  expect(cp.trail_text).toContain("- 1a2b3c4d5e Fix the export (fix-export)");
  expect(cp.trail_text).toContain("- /work/app/BRIEF.md");
  expect(cp.probe).toMatchObject({ files: 9, files_kept: 9, unsupported: 0 });
  expect(cp.probe.files_summary).toBeLessThan(2); // the owner's first message, kept word for word, names one
  expect(cp.probe.anchors_kept).toBe(cp.probe.anchors);
  expect(cp.probe.anchors_summary).toBeLessThan(cp.probe.anchors);

  // The transcript: the summary, what it kept, and the trail under it.
  await page.getByTestId("compacted").locator("summary").click();
  const probe = `kept 9 of 9 files written and ${cp.probe.anchors} of ${cp.probe.anchors} recurring identifiers (without the trail ${cp.probe.files_summary} and ${cp.probe.anchors_summary})`;
  await expect(page.getByTestId("compacted-probe")).toContainText(probe);
  await expect(page.getByTestId("compacted-trail")).toContainText("Artifact trail, made from the events by the harness");
  await expect(page.getByTestId("compacted-trail")).toContainText("/work/app/src/export.ts (edited 2 times)");
  await expect(page.getByTestId("compacted-trail")).toContainText("Fix the export (fix-export)");
  await page.getByTestId("compacted-trail").scrollIntoViewIfNeeded();
  await shoot(page, "compaction-trail-01-transcript");

  // The session's timeline counts it, with no path or identifier of the session in the row.
  await openPanel(page, "timeline");
  const row = page.getByTestId("timeline-panel").locator('[data-testid="timeline-row"]').filter({ hasText: "Context compacted by the owner" });
  await expect(row).toContainText(probe);
  await expect(row).not.toContainText("export.ts");
  await shoot(page, "compaction-trail-02-timeline");

  // A session whose compaction kept little (a stored probe, as one cut by the trail's bound would read) is named in Usage.
  const now = Date.now();
  const thin = [{ keel_export: 2, events: 3, scope: "current branch", title: "Thin keeper", model: HAIKU, workspace: "", created: now },
    { ref: "t1", kind: "user", data: { text: "Go on with the work." }, ts: now - 2 },
    { ref: "t2", kind: "assistant", data: { blocks: [{ type: "text", text: "Going on." }], stop: "end_turn", imported: true }, ts: now - 1 },
    { ref: "t3", kind: "compaction", data: { mode: "summary", summary: "Goal: the work.", auto: true, trigger: "threshold", probe: { files: 40, files_kept: 2, files_summary: 2, anchors: 300, anchors_kept: 30, anchors_summary: 30, ids: 4, unsupported: 0, trail_bytes: 0 } }, ts: now }];
  await request.post("/api/sessions/import", { data: thin.map((l) => JSON.stringify(l)).join("\n") + "\n", headers: { "content-type": "application/x-ndjson" } });

  // Usage > Compactions: what the range's compactions kept, and each one's share.
  await page.goto("/settings/usage");
  const usage = page.getByTestId("usage-panel");
  await usage.getByRole("radio", { name: "Compactions" }).click();
  await expect(usage.getByTestId("compactions-kept")).toContainText("Files kept");
  await expect(usage.getByTestId("compactions-kept-ids")).toContainText("without trail");
  const line = usage.getByTestId("compactions-list").locator("tbody tr").filter({ hasText: "Trail check" }).first();
  await expect(line).toContainText("100% files, 100% ids");
  await expect(usage.getByTestId("compactions-low")).toContainText("One session's compactions keep less than 15% of the files they wrote or the identifiers that recur in their work");
  await expect(usage.getByTestId("compactions-low")).toContainText("Thin keeper (5.0% of files, 10% of identifiers)");
  await expect(usage.getByTestId("compactions-low")).not.toContainText("Trail check");
  await line.click();
  await expect(usage.getByTestId("compaction-detail")).toContainText(`9 of 9 files written and ${cp.probe.anchors} of ${cp.probe.anchors} recurring identifiers, with a trail of`);
  await shoot(page, "compaction-trail-03-usage");
});
