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
    // (A row of one line says no number of agents: the session says it.)
    await expect(r.getByTestId("row-state")).toHaveText("Working");
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
    await expect(sep).toContainText("Offline");
    await expect(page.getByTestId("machine-chip")).toHaveAttribute("data-reach", "offline");
    // Its rows read as offline too: stepped back, the clock's place saying so instead of counting.
    await expect(row(page, placed.id)).toHaveAttribute("data-offline", "true");
    // The row's word is Offline, with when it last told; the pane's head says the same and its clock stands.
    await expect(row(page, placed.id).getByTestId("row-time")).toHaveText("Offline");
    await expect(row(page, placed.id).getByTestId("row-why")).toHaveText(/^as of \d\d:\d\d$/);
    await expect(page.getByTestId("station-word")).toHaveText("Offline");
    await expect(page.getByTestId("station-why")).toHaveText(/^as of \d\d:\d\d$/);
    await expect(page.getByTestId("station-clock")).toHaveCount(0);
    expect(await row(page, placed.id).locator(".k-row-title").evaluate((el) => getComputedStyle(el).color)).toBe(await sep.locator(".k-machine-sep-count").evaluate((el) => getComputedStyle(el).color));
    // And the line above the list counts them, on screen wherever the machine's separator is: a press goes to the first.
    // (By the machine's name, since it is one machine.)
    await expect(page.getByTestId("sum-offline")).toHaveText(/^1\s*rowbox\s+offline$/i);
    await expect(page.getByTestId("sum-offline")).toBeInViewport({ ratio: 1 });
    await page.getByTestId("sum-offline").click();
    await expect(row(page, placed.id)).toBeFocused();
    await shoot(page, "session-rows-05-remote-offline");
    // The card beside the row says the same: what the session last told, with no clock that runs.
    await row(page, placed.id).hover();
    const card = page.getByTestId("rail-card");
    await expect(card.getByTestId("rail-card-why")).toHaveAttribute("data-why", "offline");
    await expect(card.getByTestId("rail-card-why")).toHaveText(/^It last told: /);
    await expect(card.locator("[data-live]")).toHaveCount(0);
    // And the card of its mark in the folded list: Offline, as of when, not the state it last told with a clock.
    await page.evaluate(() => localStorage.setItem("keel.list", "false"));
    await page.reload();
    await page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${placed.id}"]`).hover();
    await expect(card.getByTestId("rail-card-word")).toHaveText("Offline");
    await expect(card.getByTestId("rail-card-time")).toHaveText(/^as of \d\d:\d\d$/);
    await expect(card.locator("[data-live]")).toHaveCount(0);
    await shoot(page, "session-rows-05-remote-offline-card");
    await page.evaluate(() => localStorage.setItem("keel.list", "true"));
    await page.goto(`/s/${placed.id}`);

    // All five counts at once (one needs the owner, one failed, one works, one is unread, one is on the
    // machine that does not answer): the line fits its bar at every text size and at the narrowest the
    // list goes. Words give way before figures, and no figure is cut.
    const mk = async (title: string, text: string, mode = "full-auto") => {
      const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
      made.push(session.id);
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
      return session.id as string;
    };
    const state = async (id: string) => ((await (await request.get("/api/state")).json()).states ?? {})[id]?.watch as string | undefined;
    const asks = await mk("Asks before it deletes", script([{ name: "Bash", input: { command: "rm -rf dist" } }]), "ask");
    const bad = await mk("Fails on the bill", "script:billing");
    const busy = await mk("Runs for a while", script([{ name: "Bash", input: { command: "tail -f /dev/null" } }]));
    await mk("Finished unseen", "script:say Done.");
    await expect.poll(() => state(asks), { timeout: 30_000 }).toBe("need");
    await expect.poll(() => state(bad), { timeout: 30_000 }).toBe("fail");
    await expect.poll(() => state(busy), { timeout: 30_000 }).toBe("work");
    try {
      for (const [scale, width] of [[1, null], [0.9, null], [1.5, null], [1, 232], [1.5, 348]] as const) {
        const at = `text size ${scale}${width ? ", the narrowest list" : ""}`;
        await page.evaluate(([s, w]) => { localStorage.setItem("keel.textScale", JSON.stringify(s)); if (w) localStorage.setItem("keel.listW", JSON.stringify(w)); else localStorage.removeItem("keel.listW"); }, [scale, width] as const);
        await page.reload();
        for (const kind of ["need", "fail", "work", "unread", "offline"]) await expect(page.getByTestId(`sum-${kind}`), `the ${kind} count at ${at}`).toBeVisible();
        // Settled: the faces are in and the line has been measured with them.
        await page.evaluate(() => document.fonts.ready);
        const line = await page.getByTestId("list-summary").evaluate((el) => {
          const box = el.getBoundingClientRect();
          const chips = [...el.querySelectorAll<HTMLElement>(".k-sum-chip")];
          const cut = chips.filter((c) => { const b = c.getBoundingClientRect(), n = c.querySelector(".k-sum-n")!.getBoundingClientRect(); return n.width < 1 || b.right > box.right + 0.5 || b.left < box.left - 0.5; });
          return { over: el.scrollWidth - el.clientWidth, cut: cut.map((c) => c.dataset.kind), words: chips.filter((c) => !c.hasAttribute("data-bare")).map((c) => c.dataset.kind) };
        });
        expect(line.cut, `counts cut at ${at}`).toEqual([]);
        expect(line.over, `the line's content beyond its bar at ${at}`).toBeLessThanOrEqual(0);
        // What calls the owner keeps its word longest.
        if (line.words.length) expect(line.words, at).toContain("need");
        if (scale === 1 && !width) await shoot(page, "session-rows-06-five-counts");
      }
    } finally {
      await page.evaluate(() => { localStorage.removeItem("keel.textScale"); localStorage.removeItem("keel.listW"); });
      await request.post(`/api/sessions/${busy}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    }
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    await request.delete(`/api/fleet/machines/${mid}`);
  }
});

// Feature: with many sessions, what needs the owner is named without scrolling: a row out of the list's
// view is named at the list's foot, a press away; and in a list too narrow for words beside the title
// (four panes) a row that needs the owner keeps its reason on a line of its own.
test("what needs you is named in a long list, and keeps its reason in a narrow one", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const made: string[] = [];
  const session = async (title: string, folder: string, mode = "full-auto") => {
    mkdirSync(`${WS}/${folder}`, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: `${WS}/${folder}` } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
    made.push(session.id);
    return session.id as string;
  };
  try {
    const asker = await session("Rotate the long-list certificates", `named-${tag}-ask`, "ask");
    await request.post(`/api/sessions/${asker}/messages`, { data: { text: script([{ name: "Bash", input: { command: `touch named-${tag}.txt` } }]) } });
    // A long list: eight more folders of six sessions at rest.
    for (let f = 0; f < 8; f++) for (let i = 0; i < 6; i++) await session(`Filler ${f}.${i}`, `named-${tag}-${f}`);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${asker}/approvals`)).json()).approvals?.length ?? 0, { timeout: 20_000 }).toBe(1);
    const others = made.filter((id) => id !== asker);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/s/${others[0]}`);
    const r = row(page, asker);
    await expect(r).toHaveAttribute("data-watch", "need");
    // Its row out of the list's view, whichever end it is at: named at the foot.
    const list = page.getByTestId("session-list");
    await list.evaluate((l, id) => { const x = l.querySelector<HTMLElement>(`[data-session="${id}"]`)!; const top = x.getBoundingClientRect().top - l.getBoundingClientRect().top + l.scrollTop; l.scrollTop = top > l.clientHeight ? 0 : l.scrollHeight; }, asker);
    await expect(r).not.toBeInViewport();
    const strip = page.getByTestId("need-strip");
    const named = strip.locator(`[data-session="${asker}"]`);
    await expect(named).toBeInViewport();
    await expect(named).toHaveText("Rotate the long-list certificates");
    // The list's rows did not move for it: what shrank is the room under them.
    await shoot(page, "session-rows-need-strip");
    // The same at the desk's own size.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await list.evaluate((l, id) => { const x = l.querySelector<HTMLElement>(`[data-session="${id}"]`)!; const top = x.getBoundingClientRect().top - l.getBoundingClientRect().top + l.scrollTop; l.scrollTop = top > l.clientHeight ? 0 : l.scrollHeight; }, asker);
    await expect(r).not.toBeInViewport();
    await expect(named).toBeInViewport();
    await shoot(page, "session-rows-need-strip-1920");
    await named.click();
    await expect(page.getByTestId("approval").first()).toBeVisible();
    // Four panes: the list is narrow, and the asking row says what it asks on a line of its own.
    await page.setViewportSize({ width: 1920, height: 1040 });
    // Set from a page of this origin that runs none of the app: an open page writes its own panes back over them.
    await page.goto("/api/daemon");
    await page.evaluate((slots) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.panes", JSON.stringify({ count: 4, slots, sizes: {}, active: 0 })); }, others.slice(0, 4));
    await page.goto(`/s/${others[0]}`);
    await expect(page.locator("section.k-station:not([inert] *)")).toHaveCount(4);
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-narrow", "true");
    await r.scrollIntoViewIfNeeded();
    await expect(r).toHaveAttribute("data-reason", "true");
    await expect(r.getByTestId("row-why")).toBeVisible();
    await expect(r.getByTestId("row-why")).toContainText(`named-${tag}.txt`);
    expect((await r.getByTestId("row-why").boundingBox())!.width).toBeGreaterThan(40);
    await shoot(page, "session-rows-narrow-reason");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

// Feature: on a phone at a large text size the drawer's parts never lie over one another: the find
// takes a tap, the list keeps room for rows of its own (the acts fold to their icons when it must),
// and what is out of its view is named on one row. With the keyboard up the drawer is the find, the
// rows and those names.
test("on a phone at a large text size, the find, the list and the names at its foot each keep their place", async ({ browser, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const turns = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length;
  try {
    for (let i = 0; i < 14; i++) {
      const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Large text ${String(i).padStart(2, "0")}${i % 3 === 0 ? " fails" : ""}`, workspace: WS } })).json();
      made.push(session.id);
      if (i % 3 === 0) await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:billing" } });
    }
    for (const id of made.filter((_, i) => i % 3 === 0)) await expect.poll(() => turns(id), { timeout: 30_000 }).toBe(1);
    for (const [scale, height, keyboard] of [[1.5, 600, 0], [1.2, 600, 300]] as const) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height }, hasTouch: true, isMobile: true });
      await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
      const page = await ctx.newPage();
      try {
        await page.goto(`/s/${made[1]}`);
        await page.getByRole("button", { name: "All sessions" }).first().tap();
        const find = page.getByTestId("list-filter");
        const strip = page.getByTestId("need-strip");
        await expect(strip).toBeVisible();
        if (keyboard) {
          await find.tap();
          await page.setViewportSize({ width: 390, height: height - keyboard });
          await expect(find).toBeInViewport({ ratio: 1 });
        }
        // The find is where a tap lands, not under the strip or the rail's foot.
        await expect.poll(() => find.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
        // The list keeps room for rows of its own: two rows or more fit between the find and the list's foot.
        const room = await page.evaluate(() => {
          const find = document.querySelector('[data-testid="list-find"]')!.getBoundingClientRect();
          const foot = document.querySelector('[data-testid="list-foot"]')!.getBoundingClientRect();
          const row = document.querySelector('[data-testid="session-list"] [data-testid="session-row"]')!.getBoundingClientRect();
          return (Math.min(foot.top, innerHeight) - find.bottom) / row.height;
        });
        expect(room).toBeGreaterThanOrEqual(2);
        // What is out of view is named on one row, the rest counted, and the row is on the screen.
        await expect(strip).toBeInViewport({ ratio: 1 });
        const tops = await strip.locator(".k-need-name[data-session], [data-testid='need-strip-more']").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        expect(tops.length).toBeGreaterThan(0);
        expect(new Set(tops).size).toBe(1);
        await shoot(page, `session-rows-large-text-${scale}-${height - keyboard}`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
