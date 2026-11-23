import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";
const shell = (command: string) => ({ name: "Bash", input: { command } });
type Row = { key: string; reviewed: number; refused: number; taken_back: number };

test("Auto keeps the judge's verdicts and the refusals the owner took back, and Settings > Safety counts them", async ({ page, request }) => {
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "judge-precision-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Keel Test", "-c", "user.email=test@example.com", ...args], { cwd: work });
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "notes.txt"), "committed\n");
  git("add", "notes.txt");
  git("commit", "-q", "-m", "first");
  // Work nobody saved: a hard reset would lose it.
  writeFileSync(join(work, "notes.txt"), "uncommitted\n");

  const stats = async () => (await (await request.get("/api/permissions/judge?days=7")).json()) as { total: Row; classes: Row[] };
  const before = await stats();
  const of = (s: { classes: Row[] }, key: string) => s.classes.find((c) => c.key === key) ?? { key, reviewed: 0, refused: 0, taken_back: 0 };

  const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: MODEL, title: "Judge precision" } })).json();
  const base = `/api/sessions/${session.id}`;
  expect((await request.put(`${base}/permissions`, { data: { mode: "auto", sandbox: "off" } })).ok()).toBe(true);
  const blocked = async () => (await (await request.get(`${base}/blocked`)).json()).blocked as { id: string; by: string; summary: string; reason: string; retry?: boolean }[];
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([shell("printf marker > judge-allow.txt"), shell("printf marker > judge-deny.txt"), shell("git reset --hard")])}`);
  await page.getByTestId("composer").press("Enter");
  await expect.poll(async () => (await blocked()).length).toBe(2);
  await expect.poll(async () => {
    const r = await (await request.get(base)).json();
    return !r.running && r.events.some((e: any) => e.kind === "turn_end");
  }).toBe(true);

  // The judge allowed one and refused one; Keel's rules refused the reset, which would lose the edit, without a judge.
  expect(readFileSync(join(work, "judge-allow.txt"), "utf8")).toBe("marker");
  expect(existsSync(join(work, "judge-deny.txt"))).toBe(false);
  expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("uncommitted\n");
  const list = await blocked();
  const rule = list.find((b) => b.by === "rule")!;
  expect(rule.summary).toBe("git reset --hard");
  expect(rule.reason).toContain("1 uncommitted tracked change");
  const judged = list.find((b) => b.by === "judge")!;
  expect(judged.summary).toBe("printf marker > judge-deny.txt");

  // The owner takes the judge's refusal back: one retry of it.
  const card = page.getByTestId("blocked").filter({ hasText: "judge-deny.txt" });
  await card.getByTestId("blocked-retry").click();
  await expect.poll(async () => (await blocked()).find((b) => b.id === judged.id)?.retry).toBe(true);

  const after = await stats();
  expect(after.total.reviewed - before.total.reviewed).toBe(3);
  expect(after.total.refused - before.total.refused).toBe(2);
  expect(after.total.taken_back - before.total.taken_back).toBe(1);
  const ordinary = "judge:ordinary:own", reset = "rule:destroys:own";
  expect(of(after, ordinary).refused - of(before, ordinary).refused).toBe(1);
  expect(of(after, ordinary).taken_back - of(before, ordinary).taken_back).toBe(1);
  expect(of(after, reset).refused - of(before, reset).refused).toBe(1);
  expect(of(after, reset).taken_back - of(before, reset).taken_back).toBe(0);

  await page.goto("/settings/safety");
  const box = page.getByTestId("judge-precision");
  await box.scrollIntoViewIfNeeded();
  const total = box.getByTestId("judge-precision-total");
  await expect(total).toContainText(String(after.total.reviewed));
  const stood = after.total.refused - after.total.taken_back;
  await expect(total).toContainText(after.total.refused >= 5 ? `${Math.round((stood / after.total.refused) * 100)}%` : `${stood} of ${after.total.refused}`);
  const row = box.locator(`[data-testid="judge-precision-class"][data-key="${reset}"]`);
  await expect(row).toContainText("Keel's rules");
  await expect(row).toContainText("destroys work or data, in the session's own folders");
  await expect(box.getByTestId("judge-precision-day").first()).toBeVisible();
  await shoot(page, "judge-precision-01-settings");
});
