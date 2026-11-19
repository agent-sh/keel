import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a call that keeps answering the same way. The third identical
// answer in a row carries a note to change approach or wait instead; the sixth
// identical call is refused before it runs; a changed call runs again.
test("the same call with the same answer is noted, then refused", async ({ page, request }) => {
  const ids = ((await (await request.get("/api/models")).json()).models as any[]).map((m) => m.id);
  test.skip(!ids.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const same = { name: "Bash", input: { command: "echo still-running", description: "Check the job" } };
  const calls = [...Array(7).fill(same), { name: "Bash", input: { command: "echo changed", description: "Something else" } }];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(1);

  const evs = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const outs: { text: string; error: boolean }[] = evs.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results)
    .map((r: any) => ({ text: typeof r.content === "string" ? r.content : r.content.map((c: any) => c.text ?? "").join("\n"), error: !!r.is_error }));
  expect(outs).toHaveLength(8);
  expect(outs.slice(0, 2).every((o) => !o.text.includes("same result"))).toBe(true);
  expect(outs[2]!.text).toContain("returned the same result 3 times in a row");
  expect(outs[2]!.text).toContain("WaitFor");
  expect(outs.slice(3, 5).every((o) => o.text.includes("still-running") && !o.text.startsWith("Not run"))).toBe(true);
  expect(outs[5]!.text).toContain("Not run: this exact Bash call returned the same result 5 times");
  expect(outs[6]!.text).toContain("Not run");
  expect(outs[7]!.text).toContain("changed");

  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("tool-call")).toHaveCount(8);
  await page.getByTestId("tool-call").nth(5).locator("button").first().click();
  await shoot(page, "repeat-01-refused");
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});
