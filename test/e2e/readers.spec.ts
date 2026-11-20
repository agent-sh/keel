import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: readers. The working model hands a folder of logs and one question
// to the readers tool; the logs are split into parts read side by side by the
// reader model, the findings are compiled into one answer with path:line
// references, and the transcript shows the parts, the cost and the answer.
const DIR = join(process.env.HOME!, ".cache/keel-work/bun/readers-fixture");

function logs(): { code: string; retry: string } {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const svc = ["api", "worker", "cron", "auth", "billing"];
  for (let f = 1; f <= 4; f++) {
    const rows: string[] = [];
    for (let i = 1; i <= 1_400; i++) {
      const s = svc[(i * 7 + f) % svc.length];
      rows.push(`2026-11-20T10:${String(i % 60).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}Z INFO ${s} request ${f}-${i} served in ${(i * 37) % 900} ms`);
    }
    if (f === 3) rows[911] = "2026-11-20T10:51:12Z ERROR billing payment gateway refused the charge: certificate expired (code E4417)";
    if (f === 1) rows[287] = "2026-11-20T10:47:08Z WARN worker retry budget exhausted after 7 attempts for job sync-ledger";
    writeFileSync(join(DIR, `app-${f}.log`), rows.join("\n") + "\n");
  }
  return { code: "app-3.log:912", retry: "app-1.log:288" };
}

test("readers: a folder of logs is read in parts and compiled into one answer", async ({ page, request }) => {
  const planted = logs();
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  await page.goto("/");
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();
  await page.getByTestId("composer").fill(
    `Call AskReaders once with paths ["${DIR}"] and the question "Which error code does the billing payment gateway report, ` +
    `and after how many attempts was a retry budget exhausted, in any service? Give file:line for each.". Then reply with only the code, the number of attempts and their file:line.`,
  );
  await page.keyboard.press("Enter");
  const card = page.locator('[data-tool="AskReaders"]').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText("E4417");
  await expect(page.getByTestId("assistant-text").last()).toContainText("7");

  await card.getByRole("button").first().click();
  await expect(card.getByTestId("readers-part-list").locator("li")).toHaveCount(4);
  await expect(card.getByTestId("readers-part-list").locator('li[data-state="read"]')).toHaveCount(2);
  await expect(card.getByTestId("readers-part-list").locator('li[data-state="nothing"]')).toHaveCount(2);
  await expect(card.getByTestId("readers-answer")).toContainText("E4417");
  await expect(card.getByTestId("readers-answer")).toContainText(planted.code);
  await expect(card.getByTestId("readers-answer")).toContainText(planted.retry);
  // Parts that held nothing were read: the compiled answer does not call them unread.
  await expect(card.getByTestId("readers-answer")).not.toContainText(/not (been )?read/i);
  await expect(card.getByTestId("readers-summary")).toContainText("4 sources");
  await expect(card.getByTestId("readers-summary")).toContainText("findings compiled");
  // A priced reader shows its cost; one on a plan says so.
  await expect(card.getByTestId("readers-cost")).toContainText(/\$|on plan/);
  await card.scrollIntoViewIfNeeded();
  await shoot(page, "readers-01-compiled-answer");

  // Every reader request is booked as a reader call, apart from the turn's own.
  const id = new URL(page.url()).pathname.split("/s/")[1]!;
  const tokens = await (await request.get(`/api/telemetry/tokens?session_id=${id}`)).json();
  expect(tokens.by_purpose.find((p: any) => p.purpose === "reader")?.calls).toBeGreaterThanOrEqual(4);
  // A reader's request is sent once: it writes nothing to the provider's cache.
  const events = (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
  const job = events.flatMap((e) => (e.kind === "tool_result" && e.data.shown ? Object.values(e.data.shown) : [])).map((x: any) => x.readers).find(Boolean);
  expect(job.usage.input).toBeGreaterThan(100_000);
  expect(job.usage.cache_write).toBe(0);
  rmSync(DIR, { recursive: true, force: true });
});
