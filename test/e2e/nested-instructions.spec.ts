import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot, SCRIPTED } from "./shots.ts";

const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);
const results = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[])
    .filter((e) => e.kind === "tool_result")
    .flatMap((e) => e.data.results)
    .map((r: any) => (typeof r.content === "string" ? r.content : r.content.map((c: any) => c.text ?? "").join("\n")));

// Feature: an AGENTS.md below the session's folder loads when the work
// reaches its folder: appended once to the result of the call that got there,
// shown on that call's card, and listed in the Profile tab.
test("nested instruction files load when the work reaches their folder", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to read two files and follow the instructions loaded on the way");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `nested-${Date.now()}`);
  const pkg = join(ws, "packages", "engine");
  mkdirSync(pkg, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  writeFileSync(join(ws, "AGENTS.md"), "# Repository rules\n\nKeep replies short.\n");
  writeFileSync(join(pkg, "AGENTS.md"), "# Engine package\n\nThe release code word for this package is MARIGOLD.\n");
  writeFileSync(join(pkg, "notes.txt"), "Engine notes: nothing here names the code word.\n");
  writeFileSync(join(pkg, "more.txt"), "More engine notes.\n");

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: "Read packages/engine/notes.txt, then packages/engine/more.txt, one call each. Then reply with only the release code word your instructions give for that package." },
  });
  await turnsDone(request, session.id, 1);

  // Loaded once, with the first read there; the model used it.
  const outs = await results(request, session.id);
  const marked = outs.filter((t) => t.includes(`<nested-instructions path="${join(pkg, "AGENTS.md")}">`));
  expect(marked).toHaveLength(1);
  expect(outs.join("\n")).not.toContain(`<nested-instructions path="${join(ws, "AGENTS.md")}">`); // the prompt has the root's
  const evs = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const answer = evs.filter((e) => e.kind === "assistant").at(-1).data.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  expect(answer).toContain("MARIGOLD");

  await page.goto(`/s/${session.id}`);
  const card = page.getByTestId("tool-call").filter({ has: page.getByTestId("tool-nested") });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("tool-nested")).toContainText("packages/engine/AGENTS.md");
  await card.locator("button").first().click();
  await card.getByTestId("nested-instructions").locator("summary").click();
  await expect(card.getByTestId("nested-instructions")).toContainText("MARIGOLD");
  await expect(card.locator("pre").first()).not.toContainText("nested-instructions");
  await shoot(page, "nested-01-card");

  await openPanel(page, "profile");
  const row = page.getByTestId("profile-instructions").locator('li[data-scope="nested"]');
  await expect(row.locator("[title]").first()).toHaveAttribute("title", join(pkg, "AGENTS.md")); // a long path is cut in its middle; the title holds it whole
  await expect(row).toContainText("on reach");
  await shoot(page, "nested-02-profile");

  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});
