import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, WORKBENCH } from "./shots.ts";

// Feature: several sessions on screen at once (the Bridge's panes). The
// pane worked in has the keys: Alt+M opens only its model menu, a slash
// command acts on its session, and text put into one session's draft from
// outside lands in that station's message box and no other.
// Every station on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: WORKBENCH });

test("keys and drafts per station", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `stations-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title } })).json()).session.id as string;
  const tag = Date.now();
  const a = await mk(`Station A ${tag}`);
  const b = await mk(`Station B ${tag}`);
  for (const id of [a, b]) await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  // Started and finished.
  for (const id of [a, b]) await request.post(`/api/sessions/${id}/messages`, { data: { text: "Reply with exactly the word ready." } });
  for (const id of [a, b]) await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 90_000 }).toBe(true);

  await page.setViewportSize({ width: 3840, height: 1080 }); // an ultrawide
  // Two panes, A and B in them (the layout is the owner's: nothing fills a pane by itself).
  await page.addInitScript((ids) => localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: ids, sizes: {}, active: 0 })), [a, b]);
  await page.goto(`/s/${a}`);
  const station = (title: RegExp) => page.locator("section.k-station").filter({ has: page.getByRole("heading", { name: title }) });
  const sa = station(new RegExp(`^Station A ${tag}`));
  const sb = station(new RegExp(`^Station B ${tag}`));
  await expect(sa).toBeVisible();
  await expect(sb).toBeVisible();

  // Work in B: it takes the keys.
  await sb.getByTestId("composer").click();
  await expect(page).toHaveURL(new RegExp(`/s/${b}`));
  await page.keyboard.press("Alt+m");
  await expect(page.getByPlaceholder("Search models")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search models")).toHaveCount(0);

  // A slash command acts on the station it was typed in.
  await sb.getByTestId("composer").fill("/permissions full-auto");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${b}/permissions`)).json()).perm.mode).toBe("full-auto");
  expect((await (await request.get(`/api/sessions/${a}/permissions`)).json()).perm.mode).toBe("ask");

  // A draft for A shows up in A's box only.
  await request.post(`/api/sessions/${a}/draft`, { data: { text: "From outside, for A.", origin: "capture" } });
  await expect(sa.getByTestId("composer")).toHaveValue("From outside, for A.");
  await expect(sb.getByTestId("composer")).toHaveValue("");
  await shoot(page, "stations-01-draft-in-a");

  // A reply that quotes colored terminal output: the station line has the words, not the escapes.
  const file = (await (await request.get(`/api/sessions/${a}/export?format=jsonl`)).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const reply = file.findLast((r: any) => r.kind === "assistant" && r.data?.blocks?.some((b: any) => b.type === "text"));
  reply.data.blocks = [{ type: "text", text: "\x1b[1;32mPASS\x1b[0m all colored \x1b]0;title\x07done" }];
  const copy = await (await request.post("/api/sessions/import", { data: file.map((r) => JSON.stringify(r)).join("\n") + "\n", headers: { "content-type": "application/x-ndjson" } })).json();
  await page.goto(`/s/${copy.session.id}`);
  // (The pane worked in carries no line of its own; the card beside its row shows the same line.)
  await expect(page.locator(`section[data-station="${copy.session.id}"]`)).toBeVisible();
  await page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${copy.session.id}"]`).hover();
  await expect(page.getByTestId("rail-card").locator(".k-rail-card-line")).toHaveText("PASS all colored done");
  await request.delete(`/api/sessions/${copy.session.id}`);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Feature: more panes than the window holds. At five and six panes on 1920x1040 the session
// list stays a titled narrow list (it does not fold to marks), with what needs the owner and
// what failed marked on its rows, and the panes that fit stand whole beside it. At the row's
// right edge the panes' map has a mark for each pane in order: one out of view says so, and a
// press on it brings that pane into view; the one scrolled away then says it is out of view.
test("five and six panes: a titled list, and a map that brings in a pane off the window", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
  const ids: string[] = [];
  const titles = ["Retry the importer", "Bound the delay", "Fix the flaky test", "Write the notes", "Check the cache", "Port the parser"];
  try {
    for (const [i, title] of titles.entries()) {
      const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json();
      ids.push(session.id);
      const asks = i === 1 || i === 4;
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: asks ? "ask" : "full-auto", sandbox: "off" } });
      await request.post(`/api/sessions/${session.id}/messages`, { data: { text: asks ? `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `mkdir -p out${i}` } }])}` : i === 2 ? "script:billing" : "script:render" } });
    }
    const pending = async (id: string) => ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals ?? []).length;
    await expect.poll(() => pending(ids[1]!), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => pending(ids[4]!), { timeout: 30_000 }).toBe(1);
    await page.setViewportSize({ width: 1920, height: 1040 });
    for (const n of [5, 6]) {
      await page.addInitScript(([panes]) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.workbench", "true"); localStorage.setItem("keel.panes", panes!); }, [JSON.stringify({ count: n, slots: ids.slice(0, n), sizes: {}, active: 0 })]);
      await page.goto(`/s/${ids[0]}`);
      await expect(page.locator("section.k-station[data-station]")).toHaveCount(n);
      // The list of titles, not the column of marks: each session's name reads on its row.
      const rail = page.getByTestId("sidebar");
      await expect(rail).toHaveAttribute("data-open");
      await expect(rail).not.toHaveAttribute("data-over");
      const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`).first();
      for (const [i, id] of ids.entries()) {
        await expect(row(id)).toBeVisible();
        const title = row(id).locator(".k-row-title");
        // The whole name, or a dozen letters of it (6em), show beside its mark.
        const shows = await title.evaluate((el, name) => el.textContent === name && (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth >= 6 * parseFloat(getComputedStyle(el).fontSize)), titles[i]!);
        expect(shows, `${titles[i]} reads on its row`).toBe(true);
      }
      // The list's own controls are not cut: at this width they are their icons.
      expect(await rail.evaluate((el) => [...el.querySelectorAll<HTMLElement>(".k-rail-acts .k-act, .k-rail-acts .k-act *")].filter((n) => n.getClientRects().length && n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent))).toEqual([]);
      await expect(row(ids[1]!)).toHaveAttribute("data-watch", "need");
      await expect(row(ids[4]!)).toHaveAttribute("data-watch", "need");
      await expect(row(ids[2]!)).toHaveAttribute("data-watch", "fail");
      // The panes that fit stand whole between the list and the map.
      const map = page.getByTestId("pane-map");
      await expect(map).toBeVisible();
      const marks = map.getByTestId("pane-map-mark");
      await expect(marks).toHaveCount(n);
      const left = (await rail.boundingBox())!, edge = (await map.boundingBox())!;
      const pane = (i: number) => page.locator(`section.k-station[data-slot="${i}"]`);
      for (let i = 0; i < 4; i++) { const b = (await pane(i).boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(left.x + left.width - 1); expect(b.x + b.width).toBeLessThanOrEqual(edge.x + 1); }
      for (let i = 0; i < 4; i++) await expect(marks.nth(i)).not.toHaveAttribute("data-off", /./);
      for (let i = 4; i < n; i++) await expect(marks.nth(i)).toHaveAttribute("data-off", "right");
      await expect(marks.nth(4)).toHaveAttribute("data-watch", "need");
      await shoot(page, `stations-0${n - 3}-${n}-panes`);
      // A press on the last pane's mark brings it into view, and the first goes out of it to the left.
      await marks.nth(n - 1).click();
      await expect.poll(async () => { const b = (await pane(n - 1).boundingBox())!; return b.x + b.width <= edge.x + 1 && b.x >= left.x + left.width - 1; }).toBe(true);
      await expect(marks.nth(n - 1)).not.toHaveAttribute("data-off", /./);
      await expect(marks.nth(0)).toHaveAttribute("data-off", "left");
      await marks.nth(0).click();
      await expect(marks.nth(0)).not.toHaveAttribute("data-off", /./);
    }
    await shoot(page, "stations-04-six-panes-back");
  } finally { for (const id of ids) await request.delete(`/api/sessions/${id}`); }
});
