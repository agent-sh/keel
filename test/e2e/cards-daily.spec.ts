import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask as openCard, create, folder, idle, scripted } from "./answering.ts";
import { shoot } from "./shots.ts";
import type { DailyCards } from "../../src/admin/cards-read.ts";

test("Health counts distinct owner cards and the API keeps their opening modes and build", async ({ page, request }) => {
  await scripted(request);
  const daily = async (): Promise<DailyCards> => {
    const r = await request.get("/api/cards/daily");
    expect(r.status()).toBe(200);
    return r.json();
  };
  const before = await daily();
  expect(before.time_zone).toBe("Asia/Jerusalem");
  expect(before.days).toHaveLength(7);
  const { build_id } = await (await request.get("/api/bootstrap")).json();
  const s = await create(request, "Daily cards", folder("daily-cards"));
  const mode = (mode: string) => request.put(`/api/sessions/${s}/permissions`, { data: { mode } });
  const stop = async () => {
    expect((await request.post(`/api/sessions/${s}/interrupt`, { data: { by: "owner" } })).ok()).toBe(true);
    await idle(request, s);
  };

  expect((await mode("full-auto")).ok()).toBe(true);
  await openCard(request, s, "question");
  await stop();
  await openCard(request, s, "approval");
  await stop();

  const { today, days } = await daily();
  const old = before.today;
  expect(today.cards).toBe(old.cards + 2);
  expect(today.by_kind.question).toBe(old.by_kind.question + 1);
  expect(today.by_kind.approval).toBe(old.by_kind.approval + 1);
  expect(today.interrupted_owner_turns).toBe(old.interrupted_owner_turns + 2);
  expect(today.agent_refusals).toBe(old.agent_refusals);
  expect(today.active_hours).toBeGreaterThan(0);
  const build = today.builds.find((b) => b.build === build_id);
  expect(build?.by_mode["full-auto"]?.by_kind.question).toBe((old.builds.find((b) => b.build === build_id)?.by_mode["full-auto"]?.by_kind.question ?? 0) + 1);
  expect(build?.by_mode.ask?.by_kind.approval).toBe((old.builds.find((b) => b.build === build_id)?.by_mode.ask?.by_kind.approval ?? 0) + 1);

  const trust = (await (await request.get("/api/trust/settings")).json()).new_files;
  const repo = folder("daily-trust");
  execFileSync("git", ["init", "-q", repo]);
  const file = join(repo, "AGENTS.md");
  const tell = async (title: string) => {
    const id = await create(request, title, repo);
    expect((await request.post(`/api/sessions/${id}/messages`, { data: { text: 'script:replies ["Done."]' } })).ok()).toBe(true);
    await expect.poll(async () => {
      const { events } = await (await request.get(`/api/sessions/${id}`)).json();
      return events.some((e: { kind: string; data: { kind?: string } }) => e.kind === "note" && e.data.kind === "trust");
    }).toBe(true);
    await idle(request, id);
  };
  try {
    expect((await request.put("/api/trust/settings", { data: { new_files: "ask" } })).ok()).toBe(true);
    writeFileSync(file, "First instruction set.\n");
    await tell("First notice");
    await tell("Same notice");
    expect((await daily()).today).toMatchObject({ cards: today.cards, trust_notices: today.trust_notices + 1 });
    writeFileSync(file, "Second instruction set.\n");
    await tell("Changed held set");
    expect((await daily()).today).toMatchObject({ cards: today.cards, trust_notices: today.trust_notices + 2 });
  } finally {
    expect((await request.put("/api/trust/settings", { data: { new_files: trust } })).ok()).toBe(true);
  }

  await page.goto("/settings/health");
  const row = page.locator('[data-row="cards:daily"]');
  await expect(row).toContainText(`Cards you saw: ${days.at(-1)!.cards} yesterday`);
  await expect(row).toContainText(`Trust notices: ${days.at(-1)!.trust_notices} yesterday`);
  await expect(row).toHaveAttribute("data-level", "ok");
  await row.scrollIntoViewIfNeeded();
  await shoot(page, "cards-daily-health");
});
