import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { HAIKU, SCRIPTED, shoot } from "./shots.ts";

// Feature: a file read through a reader. The model's Read of a long text file
// comes back as its reader model's compiled reading, with the file's own
// lines where the reader marked them; `raw` gives the file itself; an edit of
// lines the reading did not show is refused once with the read to make first,
// and applied after it. The reader's request is booked to the session.
const line = (n: number) => `export const v${n} = ${n}; // the value of line ${n}`;

test("a long file is read through the reader; raw is the file; an edit of lines not shown is held once", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted reader: what a real reader writes and marks cannot be told ahead");
  const { models } = await (await request.get("/api/models")).json();
  const own = (models as any[]).find((m) => m.id === HAIKU);
  const reader = (models as any[]).find((m) => m.id !== HAIKU && m.provider === own?.provider && !m.hidden && m.model === "stand-in-backup")?.id;
  test.skip(!reader, "needs a second scripted model to read with: the listing has none");
  expect((await request.patch("/api/settings", { data: { small_models: { ids: [reader] } } })).ok()).toBe(true);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `read-through-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const file = join(ws, "values.ts");
  writeFileSync(file, Array.from({ length: 600 }, (_, i) => line(i + 1)).join("\n") + "\n");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  const edit = (n: number) => ({ name: "Edit", input: { file_path: file, old_string: line(n), new_string: `export const v${n} = 0;` } });
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([
    // (The prompt names the file, and a file the owner's prompt names is read as it is: the call asks for the reading.)
    { name: "Read", input: { file_path: file, raw: false, for: "where v120 is set script:read-lines 120-122" } },
    edit(121),
    edit(300),
    { name: "Read", input: { file_path: file, raw: true, offset: 300, limit: 3 } },
    edit(300),
  ])}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });

  // What each call answered, from the stored events.
  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const results = events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as any[]);
  expect(results).toHaveLength(5);
  const [reading, shown, held, raw, applied] = results.map((r) => ({ text: typeof r.content === "string" ? r.content : JSON.stringify(r.content), error: !!r.is_error }));
  expect(reading!.text).toMatch(/^\[Compiled reading of values\.ts, lines 1-600 of 600, by Scripted backup: not the file's text\./);
  expect(reading!.text).toContain(`120\t${line(120)}\n121\t${line(121)}\n122\t${line(122)}`);
  expect(reading!.text).not.toContain(line(300));
  expect(reading!.text.length).toBeLessThan(4_000);
  expect(shown!.error).toBe(false);
  expect(held!.error).toBe(true);
  expect(held!.text).toContain("line 300 that this edit changes is not among the lines it showed. Read them first (Read with raw: true, offset 300, limit 1)");
  expect(raw!.text).toBe([300, 301, 302].map((n) => `${n}\t${line(n)}`).join("\n"));
  expect(applied!.error).toBe(false);
  const now = readFileSync(file, "utf8");
  expect(now).toContain("export const v121 = 0;\n");
  expect(now).toContain("export const v300 = 0;\n");

  // The reader's one request is the session's, booked as a reader call.
  const tokens = await (await request.get(`/api/telemetry/tokens?session_id=${session.id}`)).json();
  expect(tokens.by_purpose.find((p: any) => p.purpose === "reader")?.calls).toBe(1);

  // The transcript: the read opens to the reading, and the held edit says why on its line.
  const reads = page.locator('[data-testid="tool-call"][data-tool="Read"]');
  await expect(reads).toHaveCount(2);
  const closed = page.locator('[data-testid="work-step"] > .k-line[aria-expanded="false"]');
  for (let n = await closed.count(); n > 0; n--) await closed.first().click();
  await reads.first().locator(".k-line").click();
  await expect(reads.first()).toContainText("Compiled reading of values.ts");
  await expect(page.locator('[data-testid="tool-call"][data-tool="Edit"]').nth(1).getByTestId("tool-why")).toContainText("Not applied");
  await shoot(page, "read-through-01-reading-and-held-edit");
});
