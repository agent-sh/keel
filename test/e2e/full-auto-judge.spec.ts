import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";
const shell = (command: string) => ({ name: "Bash", input: { command } });
const write = (file_path: string, content: string) => ({ name: "Write", input: { file_path, content } });

test("Auto reviews uncovered work while Full auto reviews only flagged calls", async ({ page, request }) => {
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "permission-review-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: MODEL, title: "Automatic permission review" } })).json();
  const base = `/api/sessions/${session.id}`;
  const cards = async () => (await (await request.get(`${base}/approvals?all`)).json()).approvals;
  const blocked = async () => (await (await request.get(`${base}/blocked`)).json()).blocked;
  const turnsDone = (n: number) => expect.poll(async () => {
    const r = await (await request.get(base)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }).toBe(n);
  const send = async (...calls: ReturnType<typeof shell | typeof write>[]) => {
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify(calls)}`);
    await page.getByTestId("composer").press("Enter");
  };
  const choose = async (name: string, label: string) => {
    await page.getByTestId("permission-menu").click();
    await page.getByTestId(`mode-${name}`).click();
    await expect(page.getByTestId("permission-mode")).toHaveText(label);
    await page.keyboard.press("Escape");
  };
  const clean = "git clean -fn"; // dry run; even an allowed call cannot delete files
  const denied = "printf marker > judge-deny.txt";

  expect((await request.put(`${base}/permissions`, { data: { mode: "ask", sandbox: "off" } })).ok()).toBe(true);
  await page.goto(`/s/${session.id}`);
  await choose("full-auto", "Full auto");
  await send(shell(clean));
  await turnsDone(1);
  const { items } = await (await request.get(`/api/activity?kind=approval&session_id=${session.id}&limit=50`)).json();
  expect(items.map((a: any) => a.sub)).toContain("allowed by a rule");
  expect(await blocked()).toEqual([]);
  expect(await cards()).toEqual([]);

  await choose("auto", "Auto");
  await page.getByTestId("permission-menu").click();
  await expect(page.getByText("Ordinary calls run without review.", { exact: false })).toBeVisible();
  await shoot(page, "permission-review-01-modes");
  await page.keyboard.press("Escape");

  await send(shell(clean), write("workspace.txt", "in scope"), shell("printf marker > judge-allow.txt"), shell(denied), shell("printf marker > judge-unavailable.txt"));
  await turnsDone(2);
  expect(readFileSync(join(work, "workspace.txt"), "utf8")).toBe("in scope");
  expect(readFileSync(join(work, "judge-allow.txt"), "utf8")).toBe("marker");
  expect(existsSync(join(work, "judge-deny.txt"))).toBe(false);
  expect(existsSync(join(work, "judge-unavailable.txt"))).toBe(false);
  expect(await blocked()).toMatchObject([
    { by: "unavailable", summary: "printf marker > judge-unavailable.txt" },
    { by: "judge", summary: denied },
    { by: "judge", summary: clean },
  ]);
  expect(await cards()).toEqual([]);
  await expect(page.getByTestId("blocked")).toHaveCount(3);
  await shoot(page, "permission-review-02-auto-refused");

  // The same ordinary command is not judged in Full auto, even after Auto refused it.
  await choose("full-auto", "Full auto");
  await send(shell(denied));
  await turnsDone(3);
  expect(readFileSync(join(work, "judge-deny.txt"), "utf8")).toBe("marker");

  await choose("auto", "Auto");
  await send(write(".envrc", "# Inert approval fixture\n"));
  const card = page.getByTestId("approval");
  await expect(card.getByTestId("approval-summary")).toContainText(".envrc");
  await expect(card.getByTestId("allow-always")).toHaveCount(0);
  expect(existsSync(join(work, ".envrc"))).toBe(false);
  await shoot(page, "permission-review-03-owner-only");
  await card.getByTestId("allow-once").click();
  await turnsDone(4);
  expect(readFileSync(join(work, ".envrc"), "utf8")).toBe("# Inert approval fixture\n");
  expect(await cards()).toMatchObject([{ risk: "high", autoOwner: true, state: "allowed" }]);
});
