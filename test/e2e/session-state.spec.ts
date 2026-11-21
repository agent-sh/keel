import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: the state of a session is one fact. The daemon works it out in one
// place (what the session waits on, why, since when) and every surface reads
// it: the list row, the pane band, the folded rail and its card, the tab's
// count, the inbox, `keel sessions` and the session tools. The scripted
// stand-in sends the exact calls.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/state`;
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.some((m) => m.id === STAND_IN);
}
const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
async function start(request: APIRequestContext, title: string, mode = "full-auto", workspace = WS) {
  mkdirSync(workspace, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
  return session.id as string;
}
const send = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const stateOf = async (request: APIRequestContext, id: string) => ((await (await request.get("/api/state")).json()).states ?? {})[id] as { watch: string; why?: string; text?: string; since?: number } | undefined;
async function drop(request: APIRequestContext, ids: string[]) {
  for (const id of ids) {
    await request.post(`/api/sessions/${id}/interrupt`).catch(() => {});
    await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
}

test("a plan waiting for approval reads Needs you on the row, the pane, the tab and in the inbox", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    const other = await start(request, "A quiet session to watch from");
    const planner = await start(request, "Plan the move to resumable uploads", "plan");
    made.push(other, planner);
    await send(request, planner, script([{ name: "present_plan", input: { title: "Resumable uploads", plan: "1. Add a chunk table.\n2. Resume from the last chunk." } }]));
    await expect.poll(async () => (await (await request.get(`/api/sessions/${planner}/plan`)).json()).open.length, { timeout: 30_000 }).toBe(1);

    // From another session's page: the row says who waits and why.
    await page.goto(`/s/${other}`);
    const r = row(page, planner);
    await expect(r).toHaveAttribute("data-watch", "need");
    await expect(r.getByTestId("row-state")).toContainText("Needs you");
    await expect(page).toHaveTitle(/^\(\d+\) /);
    // The inbox holds it until it is answered.
    const inbox = async () => ((await (await request.get("/api/alerts?limit=100&with_unread")).json()).alerts as { session_id: string; data?: { plan_id?: string }; read: boolean }[]).filter((a) => a.session_id === planner && a.data?.plan_id);
    expect((await inbox()).filter((a) => !a.read)).toHaveLength(1);
    // The daemon says the same, with the reason and since when.
    const st = await stateOf(request, planner);
    expect(st).toMatchObject({ watch: "need", why: "plan" });
    expect(st!.since).toBeGreaterThan(Date.now() - 120_000);

    // Its own pane: the band and the word.
    await page.goto(`/s/${planner}`);
    await expect(page.getByTestId("plan-card")).toBeVisible();
    await expect(page.getByTestId("station-word")).toContainText("Needs you");
    await expect(page.locator(`[data-station="${planner}"]`)).toHaveAttribute("data-watch", "need");
    await shoot(page, "session-state-01-plan-needs-you");

    // Approved: the wait is over everywhere.
    const open = (await (await request.get(`/api/sessions/${planner}/plan`)).json()).open;
    await request.post(`/api/sessions/${planner}/plan/${open[0].id}`, { data: { approve: true, mode: "full-auto" } });
    await expect(row(page, planner)).not.toHaveAttribute("data-watch", "need");
    await expect.poll(async () => (await inbox()).filter((a) => !a.read).length).toBe(0);
  } finally {
    await drop(request, made);
  }
});
