import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, openPanel, shoot } from "./shots.ts";

// Feature: a rewind says what it cannot take back. The turns it goes back over made a git commit and push, wrote
// outside the folder, deleted a folder the checkpoint never held (ignored) and called an MCP tool that does not say
// it only reads. The rewind dialog, the revert from the Changes panel and each turn of its by-turn list name each
// of them, from the calls the session stored; a turn of edits only names none. No model is asked.
test.skip(!SCRIPTED, "needs the scripted stand-in: it makes the calls");

const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;
const sizes = [{ width: 1920, height: 1040 }, { width: 390, height: 844 }];
const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;

test.afterEach(async ({ request }) => {
  await request.delete("/api/mcp/servers/reach").catch(() => {});
});

async function turn(request: APIRequestContext, id: string, n: number, text: string) {
  await request.post(`/api/sessions/${id}/messages`, { data: { text } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(n);
}

test("a rewind names the commit, the push, the outside write, the ignored delete and the MCP call it cannot take back", async ({ page, request }) => {
  const base = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `reach-${Date.now().toString(36)}`);
  const ws = join(base, "ws"), remote = join(base, "remote.git"), out = join(base, "elsewhere");
  mkdirSync(join(ws, "data"), { recursive: true });
  mkdirSync(out, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["init", "-q", "--bare", remote]);
  writeFileSync(join(ws, ".gitignore"), "data/\n");
  writeFileSync(join(ws, "data", "rows.csv"), "1,2,3\n");

  // The stub MCP server: its `echo` does not say it only reads, its `add` does.
  const add = await request.post("/api/mcp/servers", { data: { name: "reach", command: "bun", args: [FIXTURE] } });
  expect(add.ok()).toBe(true);
  await expect.poll(async () => (await (await request.get("/api/mcp/servers")).json()).servers.find((s: any) => s.name === "reach")?.state, { timeout: 30_000 }).toBe("ready");

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in-strict" } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
  const git = `git -c user.name=t -c user.email=t@example.com`;
  await turn(request, id, 1, calls([
    { name: "Write", input: { file_path: "a.txt", content: "two\n" } },
    { name: "Bash", input: { command: `git add -A && ${git} commit -q -m work && git push -q ${remote} HEAD:main` } },
    { name: "Bash", input: { command: `echo x > ${join(out, "x")}` } },
    { name: "Bash", input: { command: "rm -rf data" } },
    { name: "mcp_call", input: { tool: "reach__echo", arguments: { text: "hi" } } },
    { name: "mcp_call", input: { tool: "reach__add", arguments: { a: 1, b: 2 } } },
  ]));
  expect(existsSync(join(ws, "data"))).toBe(false);
  await turn(request, id, 2, calls([{ name: "Write", input: { file_path: "b.txt", content: "edit\n" } }]));

  // The daemon's answer for each turn, before anything is clicked.
  const turns = (await (await request.get(`/api/sessions/${id}/checkpoints`)).json()).turns as { n: number; not_undone?: { kind: string; line: string; n: number }[] }[];
  expect(turns).toHaveLength(2);
  expect(turns[0]!.not_undone!.map((x) => x.kind)).toEqual(["git", "remote", "outside", "ignored", "mcp"]);
  expect(turns[0]!.not_undone!.map((x) => x.n)).toEqual([1, 1, 1, 1, 1]);
  expect(turns[0]!.not_undone![0]!.line).toContain("git commit");
  expect(turns[0]!.not_undone![1]!.line).toContain("git push");
  expect(turns[0]!.not_undone![1]!.line).toContain("remote.git");
  expect(turns[0]!.not_undone![2]!.line).toContain("elsewhere/x");
  expect(turns[0]!.not_undone![3]!.line).toContain("deleted data");
  expect(turns[0]!.not_undone![4]!.line).toContain("reach__echo");
  expect(turns[1]!.not_undone).toBeUndefined();

  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("user-message")).toHaveCount(2);

  // The by-turn list names them under the turn, with nothing clicked.
  await page.setViewportSize(sizes[0]!);
  await openPanel(page, "changes");
  const panel = page.getByTestId("changes-panel");
  await panel.getByTestId("tab-turns").click();
  await expect(panel.getByTestId("turn-checkpoint")).toHaveCount(2);
  const listed = panel.getByTestId("turn-not-undone");
  await expect(listed).toHaveCount(1);
  await expect(listed.getByTestId("not-undone-line")).toHaveCount(5);
  await expect(listed.getByTestId("not-undone-line").nth(3)).toContainText("deleted data");
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-reach-01-by-turn-${s.width}`); }
  await page.setViewportSize(sizes[0]!);

  // The rewind to before the first prompt: a.txt goes back, and the five stay.
  await page.getByTestId("composer").fill("/rewind");
  await page.getByTestId("composer").press("Enter");
  const dialog = page.getByTestId("rewind-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("rewind-prompt").first().click();
  await expect(dialog.getByTestId("rewind-files")).toContainText("a.txt");
  const said = dialog.getByTestId("rewind-not-undone").getByTestId("not-undone-line");
  await expect(said).toHaveCount(5);
  expect(await said.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).toEqual(["git", "remote", "outside", "ignored", "mcp"]);
  await expect(said.nth(1)).toContainText("git push");
  await expect(said.nth(2)).toContainText("elsewhere/x");
  await expect(said.nth(4)).toContainText("reach__echo");
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-reach-02-dialog-${s.width}`); }
  // On a phone each line stands under its label instead of squeezed beside it.
  const [label, words] = await Promise.all([said.first().locator("span").first().boundingBox(), said.first().locator("span").last().boundingBox()]);
  expect(words!.y).toBeGreaterThan(label!.y + label!.height - 1);
  await page.setViewportSize(sizes[0]!);

  // The rewind to before the second prompt, whose turn edited a file and nothing else: none.
  await dialog.getByTestId("rewind-prompt").last().click();
  await expect(dialog.getByTestId("rewind-files")).toContainText("b.txt");
  await expect(dialog.getByTestId("rewind-not-undone")).toHaveCount(0);
  await shoot(page, "rewind-reach-03-edits-only");
});
