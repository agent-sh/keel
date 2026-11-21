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
  // Keel held the answer against the files: its quotes are found word for word, and the note says nothing went unread.
  const checked = card.getByTestId("readers-checked");
  await expect(checked).toHaveText(/^\d+ of \d+ quotes at the lines cited$/);
  expect(await checked.getAttribute("data-verbatim")).toBe(await checked.getAttribute("data-quotes"));
  await expect(card.getByTestId("readers-notes")).toContainText("nothing was left unread");
  await expect(card.getByTestId("readers-notes")).toContainText("Keel checked the answer against the files");
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

// The job's budget comes from the model listing. On the scripted stand-in (no
// paid model) a log several times that budget is gathered only up to it:
// its tail and the file after it are named in the answer, never read first.
test("readers: material past the job's budget is named, not gathered", async ({ page, request }) => {
  const ids = ((await (await request.get("/api/models")).json()).models as any[]).map((m) => m.id);
  test.skip(!ids.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const dir = `${DIR}-budget`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `2026-11-20T10:00:00Z INFO ${tag} request ${i + 1} served`).join("\n") + "\n";
  // About 1.5 MB: more than four times what one job reads on the stand-in's window.
  const BIG_ROWS = 30_000;
  writeFileSync(join(dir, "a.log"), rows(60, "api"));
  writeFileSync(join(dir, "big.log"), rows(BIG_ROWS, "worker"));
  writeFileSync(join(dir, "c.log"), rows(60, "cron"));
  const whole = rows(60, "api").length + rows(BIG_ROWS, "worker").length + rows(60, "cron").length;

  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  // `script:quote`: each scripted reader quotes one line where it is and one four lines off.
  const call = { name: "ask_readers", input: { question: "script:quote Which service fails, and where?", paths: [dir] } };
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([call])}` } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 90_000 }).toBe(1);

  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const result = events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results)[0];
  const text = typeof result.content === "string" ? result.content : result.content.map((c: any) => c.text ?? "").join("\n");
  const job = events.flatMap((e) => (e.kind === "tool_result" && e.data.shown ? Object.values(e.data.shown) : [])).map((x: any) => x.readers).find(Boolean);
  const budget = Number(/past what one job reads, (\d+) characters/.exec(text)?.[1]);
  expect(budget).toBeGreaterThan(0);
  expect(budget).toBeLessThan(whole / 4);
  // What the readers were handed is within the budget; the rest is named.
  expect(job.sources).toBe(2);
  expect(job.chars).toBeLessThanOrEqual(budget);
  expect(text).toMatch(new RegExp(`big\\.log after line \\d+ \\(past what one job reads, ${budget} characters\\)`));
  expect(text).toContain(`c.log (past what one job reads, ${budget} characters)`);
  expect(job.unread).toHaveLength(2);

  await page.goto(`/s/${session.id}`);
  const card = page.locator('[data-tool="ask_readers"]').first();
  await card.getByRole("button").first().click();
  await expect(card).toContainText("2 unread");
  await expect(card.getByTestId("readers-notes")).toContainText("big.log after line");
  // The card leads with the count the note leads with: quotes at the lines cited, not quotes found anywhere.
  // Each part's reader gave two quotes, one of them four lines off: half are at the lines cited.
  const checked = (await card.getByTestId("readers-checked").textContent())!.match(/^(\d+) of (\d+) quotes at the lines cited$/)!;
  const [at, all] = [Number(checked[1]), Number(checked[2])];
  expect(at).toBeGreaterThan(0);
  expect(all).toBe(at * 2);
  await expect(card.getByTestId("readers-notes")).toContainText(`${at} of ${all} quotes are word for word at the lines they cite; ${at} more are word for word in the material but not on a line cited for them`);
  await card.scrollIntoViewIfNeeded();
  await shoot(page, "readers-02-past-budget");
  rmSync(dir, { recursive: true, force: true });
});
