import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the list and the panes stay the owner's to arrange. A second pane
// is never forced: a kept layout with an empty pane opens as one pane, and
// opening a session opens it in the pane worked in. A second pane opens when
// asked for: the row's "open beside" button (or Ctrl click), or a session
// dropped on a pane's edge.
const MODEL = "scripted:stand-in";
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1700, height: 980 } });

test("panes on request, agents folded, the list filtered and arranged", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string, text = "Done.") => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const a = await mk(`Rotate the staging credentials ${tag}`);
  const b = await mk(`Draft the release notes ${tag}`);
  const c = await mk(`Profile the cold start ${tag}`);

  const bridge = page.getByTestId("bridge");
  const panes = bridge.locator(":scope > [data-slot]");
  const pane = (i: number) => bridge.locator(`:scope > [data-slot="${i}"]`);
  const entry = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);

  // His kept layout: two panes, the second left empty. It opens as one pane.
  await page.addInitScript((id) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [id, null], sizes: {}, active: 1 }));
  }, a);
  await page.goto(`/s/${a}`);
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", a);
  await expect(page.getByTestId("panes-1")).toHaveAttribute("aria-checked", "true");

  // Opening another session opens it in the same pane.
  await entry(b).click();
  await expect(panes).toHaveCount(1);
  await expect(pane(0)).toHaveAttribute("data-station", b);

  // Open beside: the row's button adds a pane to the right of the one worked in.
  await entry(a).hover();
  await entry(a).getByTestId("row-beside").click();
  await expect(panes).toHaveCount(2);
  await expect(pane(0)).toHaveAttribute("data-station", b);
  await expect(pane(1)).toHaveAttribute("data-station", a);
  await shoot(page, "arrange-01-open-beside");
  // Closing a session closes its pane.
  await pane(1).getByTestId("station-close").click();
  await expect(panes).toHaveCount(1);

  // A session dragged onto a pane's right edge opens beside it; onto its middle, in it.
  const data = await page.evaluateHandle((id) => { const dt = new DataTransfer(); dt.setData("application/x-keel-session", id); return dt; }, c);
  const box = (await pane(0).boundingBox())!;
  await pane(0).dispatchEvent("dragover", { dataTransfer: data, clientX: box.x + box.width * 0.5, clientY: box.y + 300 });
  await expect(pane(0)).toHaveAttribute("data-drop", "in");
  await pane(0).dispatchEvent("dragover", { dataTransfer: data, clientX: box.x + box.width - 20, clientY: box.y + 300 });
  await expect(pane(0)).toHaveAttribute("data-drop", "right");
  await shoot(page, "arrange-02-drop-beside");
  await pane(0).dispatchEvent("drop", { dataTransfer: data, clientX: box.x + box.width - 20, clientY: box.y + 300 });
  await expect(panes).toHaveCount(2);
  await expect(pane(1)).toHaveAttribute("data-station", c);
  await pane(1).getByTestId("station-close").click();
  await expect(panes).toHaveCount(1);
});
