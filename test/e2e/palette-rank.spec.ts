import { expect, test, type APIRequestContext } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the search palette lists what needs the owner first. With nothing typed, its sessions are
// ranked the sessions that wait for the owner, then the failed ones, then the newest, whatever the
// recency; an agent's row says whose agent it is in the place of its worktree's folder.

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });

async function make(request: APIRequestContext, title: string, mode: "ask" | "full-auto", text: string) {
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode, sandbox: "off" } });
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
  return s.id as string;
}

test("the palette lists what needs you, then what failed, and names the parent of an agent", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const mark = Date.now().toString(36);
  const ids: string[] = [];
  try {
    // The oldest two: one waits for the owner, one failed.
    const need = `Waits ${mark}`, failed = `Failed ${mark}`, parent = `Parent ${mark}`, agent = `Agent ${mark}`;
    ids.push(await make(request, need, "ask", calls([bash("rm -rf dist")])));
    ids.push(await make(request, failed, "full-auto", "script:billing"));
    // Then an agent with its parent, and idle sessions, all newer: more than the palette lists at rest.
    ids.push(await make(request, parent, "full-auto", calls([{ name: "spawn_agent", input: { message: `${agent}\n${calls([bash("echo done")])}`, isolation: "none" } }, { name: "wait_agent", input: {} }])));
    for (let i = 1; i <= 7; i++) ids.push(await make(request, `Idle ${i} ${mark}`, "full-auto", calls([bash("echo idle")])));
    await expect.poll(async () => (await (await request.get("/api/sessions")).json()).sessions.filter((s: any) => s.title.includes(mark) && s.phase !== "working").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(9);

    await page.goto("/");
    await page.keyboard.press("Control+k");
    const rows = page.getByRole("option");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText(need);
    await expect(rows.nth(1)).toContainText(failed);
    await shoot(page, "palette-rank-01");

    await page.getByTestId("palette-input").fill(agent);
    const row = rows.filter({ hasText: agent }).first();
    await expect(row).toContainText(`agent of ${parent}`);
    await shoot(page, "palette-rank-02-agent");
  } finally {
    for (const id of ids) {
      await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
      await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
  }
});
