import { expect, test } from "./isolate.ts";
import { HAIKU, ask, scriptBash, shoot } from "./shots.ts";

// Feature: steers the owner is still typing go in one step. While a turn's command runs he sends a steer and
// starts typing the next one; the command ends while he types. The step that would take the first steer waits
// for the box (its status says so), and once he sends the second the step takes both: one model request
// reads them together, and only one reply follows them.
test("a steer sent while the owner types the next goes in the same step as the next", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Steers in one step" } })).json()).session.id as string;
  await page.goto(`/s/${s}`);
  const composer = page.getByTestId("composer");
  await composer.fill(ask("Run `sleep 2` with your shell tool in the foreground, then reply with the word done.", scriptBash("sleep 2")));
  await composer.press("Enter");
  await expect(page.getByTestId("tool-call")).toHaveCount(1, { timeout: 20_000 });

  // The first steer, and the second typed on through the command's end.
  await composer.fill("First steer: the table has two columns.");
  await composer.press("Enter");
  await composer.pressSequentially("Second steer: the third row is the total.", { delay: 80 });
  await shoot(page, "steer-gather-typing");
  await composer.press("Enter");

  const events = async () => (await (await request.get(`/api/sessions/${s}`)).json()).events as any[];
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  const ev = await events();
  const at = (text: string) => ev.findIndex((e) => e.kind === "user" && String(e.data.text).startsWith(text));
  const [one, two] = [at("First steer"), at("Second steer")];
  expect(one).toBeGreaterThan(0);
  expect(two).toBeGreaterThan(one);
  expect(ev[one].data.origin).toBe("steer");
  expect(ev[two].data.origin).toBe("steer");
  // Nothing the model said between them: the two went in one request.
  expect(ev.slice(one, two).filter((e) => e.kind === "assistant")).toEqual([]);
  expect(ev.filter((e) => e.kind === "turn_end")).toHaveLength(1);
  await shoot(page, "steer-gather-taken");
});
