import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { peerProblem } from "./peer.ts";
import { shoot } from "./shots.ts";

// Feature: what a session row tells at a glance. A parent whose turn ended
// while an agent it started still works reads as working, with the agent
// count, on the row, the pane head, the palette and in keel__sessions_list,
// and its finished alert waits for that agent. A session placed on another
// machine carries the machine's name in its colour on the row, the headers
// and the palette, and says when that machine does not answer; a local
// session carries nothing. The scripted stand-in sends the exact calls.
const STAND_IN = "scripted:stand-in";
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47994";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-rowstate-peer/root`;
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws`;
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.some((m) => m.id === STAND_IN);
}
const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);

test("a parent with an agent at work reads as working until the agent ends", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // Every finish is an alert here, also for the session on screen.
  await request.put("/api/alerts/settings", { data: { completion: "always" } });
  mkdirSync(WS, { recursive: true });
  const gate = `${WS}/rowstate-${Date.now().toString(36)}.go`;
  const made: string[] = [];
  const session = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    made.push(session.id);
    return session.id as string;
  };
  try {
    const parent = await session("Parent with an agent at work");
    // The agent works until the spec lets it go.
    const child = `Slow helper\n${script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo released` } }])}`;
    await request.post(`/api/sessions/${parent}/messages`, { data: { text: script([{ name: "spawn_agent", input: { message: child, isolation: "none" } }]) } });
    const agents = async () => (await (await request.get(`/api/sessions/${parent}/agents`)).json()).agents as { status: string }[];
    const parentIdle = async () => {
      const d = await (await request.get(`/api/sessions/${parent}`)).json();
      return !d.running && d.events.at(-1)?.kind === "turn_end";
    };
    await expect.poll(async () => (await agents())[0]?.status, { timeout: 30_000 }).toBe("running");
    await expect.poll(parentIdle, { timeout: 30_000 }).toBe(true);
    expect((await agents())[0]!.status).toBe("running");

    // Its own turn is over, its agent is not: working, with the count.
    await page.goto(`/s/${parent}`);
    const r = row(page, parent);
    await expect(r).toHaveAttribute("data-watch", "work");
    await expect(r.getByTestId("row-state")).toHaveText("Working · 1 agent");
    await expect(page.getByTestId("station-word")).toHaveText("Working · 1 agent");
    // The palette's mark says the same.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Parent with an agent");
    await expect(page.getByRole("option").filter({ hasText: "Parent with an agent at work" }).locator('[title="Working · 1 agent"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await shoot(page, "session-rows-01-agent-working");

    // No finished alert while the agent works.
    const finished = async () => ((await (await request.get("/api/alerts?limit=100")).json()).alerts as { kind: string; session_id: string }[]).filter((a) => a.kind === "finished" && a.session_id === parent).length;
    expect(await finished()).toBe(0);

    // The session tools say working too.
    const asker = await session("Asks for the sessions");
    await request.post(`/api/sessions/${asker}/messages`, { data: { text: script([{ name: "keel__sessions_list", input: {} }]) } });
    const listed = async () => {
      const d = await (await request.get(`/api/sessions/${asker}`)).json();
      const res = (d.events as any[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
      const text = res.map((x: any) => (typeof x.content === "string" ? x.content : x.content.map((b: any) => b.text ?? "").join(""))).join("\n");
      return text.split("\n").find((l: string) => l.startsWith(`${parent}\t`)) ?? "";
    };
    await expect.poll(listed, { timeout: 30_000 }).toContain("working, 1 agent is still at work");
    expect(await finished()).toBe(0);

    // The agent ends: its report is the parent's next turn, and then it is done.
    writeFileSync(gate, "go\n");
    await expect.poll(async () => (await agents())[0]?.status, { timeout: 30_000 }).toBe("completed");
    await expect.poll(finished, { timeout: 30_000 }).toBe(1);
    await expect.poll(parentIdle, { timeout: 30_000 }).toBe(true);
    await expect(r).toHaveAttribute("data-watch", "done");
    await expect(r.getByTestId("row-state")).toHaveCount(0);
    await expect(page.getByTestId("station-word")).toHaveText("Done");
    await shoot(page, "session-rows-02-agent-done");
    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, "go\n");
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

test("sessions on another machine sit under that machine's separator; a local one stays above", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  mkdirSync(ROOT, { recursive: true });
  // Start clean: no old record of that daemon, nor sessions placed on one.
  const old = (await (await request.get("/api/fleet/machines")).json()).machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  const added = await request.post("/api/fleet/machines", { data: { name: "rowbox", daemon_url: PEER, workspace_root: ROOT } });
  expect(added.status()).toBe(201);
  const mid = (await added.json()).id as string;
  await request.patch(`/api/fleet/machines/${mid}`, { data: { colour: "oklch(0.62 0.13 200)" } });
  const made: string[] = [];
  try {
    const placed = (await (await request.post("/api/fleet/sessions", { data: { machine: mid, model: STAND_IN, title: "Placed on its machine" } })).json()).session;
    made.push(placed.id);
    const local = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Kept on this machine", workspace: WS } })).json()).session;
    made.push(local.id);

    // The list: this machine's sessions, then a separator for rowbox, in its colour, over its sessions. No tag on the rows.
    await page.goto(`/s/${placed.id}`);
    const seps = page.getByTestId("session-list").getByTestId("machine-sep");
    await expect(seps).toHaveCount(2);
    await expect(seps.first()).toHaveAttribute("data-machine", "local");
    const sep = page.getByTestId("session-list").locator(`[data-testid="machine-sep"][data-machine="${mid}"]`);
    await expect(sep).toContainText("rowbox");
    await expect(sep).toHaveAttribute("data-reach", "ok");
    await expect(sep).toHaveAttribute("style", /oklch\(0\.62 0\.13 200\)/);
    // The placed session's row comes after its machine's separator, the local one before it.
    const order = await page.getByTestId("session-list").locator('[data-testid="machine-sep"], [data-testid="session-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-machine") ?? e.getAttribute("data-session")));
    expect(order.indexOf(local.id)).toBeLessThan(order.indexOf(mid));
    expect(order.indexOf(placed.id)).toBeGreaterThan(order.indexOf(mid));
    await expect(row(page, placed.id).getByTestId("where")).toHaveCount(0);
    // The header's machine chip says where the open session runs.
    await expect(page.getByTestId("machine-chip")).toHaveAttribute("data-machine", mid);
    await expect(page.getByTestId("machine-chip")).toContainText("rowbox");
    await expect(page).toHaveTitle(/Placed on its machine on rowbox/);
    await shoot(page, "session-rows-03-remote-row");

    // The palette: the machine's sessions are a group of their own.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("on its machine");
    await expect(page.getByTestId("palette").getByText("Sessions on rowbox")).toBeVisible();
    await shoot(page, "session-rows-04-palette");
    await page.keyboard.press("Escape");
    await page.goto(`/s/${local.id}`);
    await expect(page.getByTestId("machine-chip")).not.toHaveAttribute("data-machine", /./);

    // A session that lives on the other daemon is told here by that daemon's own state, from the first
    // paint: one that waits on a timer reads Waiting with the reason after a reload, when no change of
    // its state is there to bring it (the relay's snapshot and the fleet view carry the states).
    const theirs = (await (await request.post(`${PEER}/api/sessions`, { data: { model: STAND_IN, title: "Lives on the other daemon", workspace: ROOT } })).json()).session.id as string;
    try {
      await request.put(`${PEER}/api/sessions/${theirs}/permissions`, { data: { mode: "full-auto" } });
      await request.post(`${PEER}/api/sessions/${theirs}/messages`, { data: { text: script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }]) } });
      await expect.poll(async () => ((await (await request.get(`${PEER}/api/state`)).json()).states ?? {})[theirs]?.watch, { timeout: 30_000 }).toBe("wait");
      const remote = `${mid}--${theirs}`;
      await expect(row(page, remote)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500); // past the frame that told of the change: the reload below has only the snapshot
      await page.reload();
      await expect(row(page, remote)).toHaveAttribute("data-watch", "wait");
      await expect(row(page, remote).getByTestId("row-why")).toHaveText("Timer: check the deploy");
      await expect(row(page, remote).getByTestId("row-time")).toHaveText(/^in 1[45]m$/);
      await shoot(page, "session-rows-05-peer-state");
    } finally {
      await request.delete(`${PEER}/api/sessions/${theirs}`).catch(() => {});
    }

    // The machine stops answering: its separator says offline.
    await request.patch(`/api/fleet/machines/${mid}`, { data: { daemon_url: "http://127.0.0.1:9" } });
    await request.post(`/api/fleet/machines/${mid}/check`);
    await page.goto(`/s/${placed.id}`);
    await expect(sep).toHaveAttribute("data-reach", "offline", { timeout: 15_000 });
    await expect(sep).toContainText("offline");
    await expect(page.getByTestId("machine-chip")).toHaveAttribute("data-reach", "offline");
    await shoot(page, "session-rows-05-remote-offline");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    await request.delete(`/api/fleet/machines/${mid}`);
  }
});
