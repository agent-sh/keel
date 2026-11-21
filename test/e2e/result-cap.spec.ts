import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: no tool stores more than the one cap. A search asked for five
// thousand matching lines returns half a megabyte: the session keeps its
// head, its tail and the path of the file with all of it, and the turn ends
// (a result that long used to fill the window, and the turn compacted and
// asked again without end).
const MODEL = "scripted:stand-in";
const CAP = 30_000;

test("a result past the cap is kept as its head, its tail and a file", async ({ page, request }) => {
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Result cap ${Date.now()}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const dir = join(s.workspace, `cap-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const line = (i: number) => `export function parse(input: string): string[] { return input.split("\\n").filter(Boolean); } // row ${i}`;
  writeFileSync(join(dir, "big.ts"), Array.from({ length: 4000 }, (_, i) => line(i)).join("\n") + "\n");
  const calls = [{ name: "Grep", input: { pattern: "parse", path: dir, output_mode: "content", head_limit: 5000 } }];
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  const events = async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events as any[];
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);

  const ev = await events();
  const results = ev.filter((e) => e.kind === "tool_result");
  expect([results.length, ev.filter((e) => e.kind === "compaction").length]).toEqual([1, 0]);
  const text = results[0].data.results[0].content as string;
  expect(text.length).toBeLessThanOrEqual(CAP);
  expect(text).toContain("row 0");
  expect(text).toContain("row 3999");
  const saved = /full output \(\d+ lines\) saved to (\S+) \.\.\.\]/.exec(text)![1]!;
  expect(existsSync(saved)).toBe(true);
  const whole = readFileSync(saved, "utf8");
  expect(whole.length).toBeGreaterThan(400_000);
  expect(whole).toContain("row 2000");

  await page.goto(`/s/${s.id}`);
  const call = page.getByTestId("tool-call").first();
  await call.getByRole("button").first().click();
  await expect(call).toContainText("saved to");
  await shoot(page, "result-cap-01");
});
