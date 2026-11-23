import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { ask, HAIKU, shoot } from "./shots.ts";

// Feature: a log wait's wake carries what the log gained since the wait
// began, so the model answers from the wake and reads nothing. The model sets
// a log wait; lines are written to the log; the wake holds them, and the next
// step quotes one of them without a tool call. (The spec writes the log
// itself: the daemon reads the same disk.)
test("a log wait's wake carries the new lines, and the next step uses them without a read", async ({ page, request }) => {
  const dir = mkdtempSync(join(tmpdir(), "keel-wait-carries-"));
  const log = join(dir, "run.log");
  writeFileSync(log, "an old line, before the wait\n");
  try {
    const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
    const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await page.goto(`/s/${session.id}`);

    const wait = { kind: "log", path: log, match: "^DONE$", note: "the run's result" };
    await page.getByTestId("composer").fill(ask(
      `Use the WaitFor tool with kind log, path ${log} and match ^DONE$, then end your turn. When it fires, reply with only the line of the log that starts with RESULT, using no tool.`,
      `script:calls ${JSON.stringify([{ name: "wait_for", input: wait }])}\nscript:then-find RESULT`,
    ));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
    // The wait is set and says what its wake carries.
    const setReply = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "tool_result").at(-1);
    expect(JSON.stringify(setReply.data)).toContain("Its wake carries what the file gains from now on");

    appendFileSync(log, "step one ok\nRESULT 42 passed\nDONE\n");
    await expect(page.getByTestId("wake-notice")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("RESULT 42 passed");

    const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
    const wake = events.filter((e: any) => e.kind === "user").at(-1);
    expect(String(wake.data.text)).toContain(`What ${log} gained since the wait began`);
    expect(String(wake.data.text)).toContain("step one ok\nRESULT 42 passed\nDONE");
    expect(String(wake.data.text)).not.toContain("an old line");
    // The step after the wake made no call: it read nothing.
    const after = events.slice(events.indexOf(wake) + 1).filter((e: any) => e.kind === "assistant");
    expect(after.length).toBeGreaterThan(0);
    expect(after.flatMap((e: any) => (e.data.blocks ?? []).filter((b: any) => b.type === "tool_use"))).toEqual([]);

    await page.getByTestId("wake-notice").last().click();
    await expect(page.getByTestId("wake-notice").last()).toContainText("RESULT 42 passed");
    await shoot(page, "wait-carries-01-wake");
    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
