import { expect, test } from "./isolate.ts";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

// Feature: everything that leaves is a row. A session's web fetch to a local
// address is refused before anything leaves, and its row names the host and the
// session; a session export to a page on this machine leaves nothing and is no
// row. Settings > Network
// shows what left today by host (a host first seen today is marked) and by
// session, says what it cannot see, and the turn's receipt lists its hosts.
test("network: what left, by host and session", async ({ page, request }) => {
  const host = `egress-${Date.now().toString(36)}.localhost`;
  const url = `https://${host}/page`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  try {
    const title = `Network check ${host.slice(7, 13)}`;
    const s = (await (await request.post("/api/sessions", {
      data: { model: HAIKU, title, text: ask(`Fetch ${url} with your web fetch tool, once, then reply with the word done.`, `script:calls ${JSON.stringify([{ name: "WebFetch", input: { url, prompt: "read it" } }])}`) },
    })).json()).session;
    // The product's own signal: the row is in the ledger.
    await expect.poll(async () => {
      const r = await (await request.get(`/api/egress?session_id=${s.id}`)).json();
      return r.recent.find((x: any) => x.host === host)?.outcome ?? null;
    }, { timeout: 120_000 }).toBe("refused");
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).session.phase, { timeout: 60_000 }).toBe("idle");
    // An export to this page stays on this machine: no row. (Rows are written in order: the next
    // turn's row in the ledger means an export row would be there too.)
    expect((await request.get(`/api/sessions/${s.id}/export?format=md`)).ok()).toBe(true);
    const later = `${host.replace(/^egress-/, "after-")}`;
    await request.post(`/api/sessions/${s.id}/messages`, {
      data: { text: ask(`Fetch https://${later}/page once, then reply done.`, `script:calls ${JSON.stringify([{ name: "WebFetch", input: { url: `https://${later}/page`, prompt: "read it" } }])}`) },
    });
    await expect.poll(async () => {
      const r = await (await request.get(`/api/egress?session_id=${s.id}`)).json();
      return r.recent.some((x: any) => x.host === later);
    }, { timeout: 120_000 }).toBe(true);
    const rows = (await (await request.get(`/api/egress?session_id=${s.id}`)).json()).recent;
    expect(rows.filter((x: any) => x.tool === "export")).toEqual([]);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).session.phase, { timeout: 60_000 }).toBe("idle");

    await page.goto("/settings/network");
    const panel = page.getByTestId("network-panel");
    const row = panel.locator(`[data-testid="network-host"][data-host="${host}"]`);
    await expect(row).toBeVisible();
    // Never seen before today.
    await expect(row.getByTestId("network-new")).toBeVisible();
    // Said by a dot in the news colour and plain words: no chip, so a first day's list is not a column of them.
    expect(await row.getByTestId("network-new").evaluate((el) => [el.textContent, getComputedStyle(el).backgroundColor, getComputedStyle(el, "::before").backgroundColor !== getComputedStyle(el).color])).toEqual(["new today", "rgba(0, 0, 0, 0)", true]);
    await expect(panel.getByTestId("network-by-session")).toContainText(title);
    await expect(panel.getByTestId("network-unseen")).toContainText(/cannot see|not here/);
    // The host's name is a button: the keyboard opens the row as the mouse does.
    const opener = row.getByRole("button", { name: host });
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByTestId("network-host-sessions")).toContainText(title);
    // Wide, the figures are in the row: the open area lists no column.
    await expect(panel.getByTestId("network-host-sessions").locator("dt").first()).toBeHidden();
    await shoot(page, "network-01-today");
    // Narrow, the table drops its minor columns and the open row lists them, with their heads.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByTestId("network-by-host").locator("th", { hasText: "Ports" })).toBeHidden();
    const dropped = panel.getByTestId("network-host-sessions").locator("dl > div");
    await expect(dropped.filter({ hasText: "Ports" })).toBeVisible();
    await expect(dropped.filter({ hasText: "Sessions" })).toContainText("1");
    await expect(dropped.filter({ hasText: "By" })).toContainText("WebFetch");
    await shoot(page, "network-01-narrow");
    await page.setViewportSize({ width: 1280, height: 720 });
    // The mouse closes it, too.
    await row.click();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByTestId("network-host-sessions")).toHaveCount(0);

    // The turn's receipt lists the host it went to.
    const tl = await (await request.get(`/api/sessions/${s.id}/timeline`)).json();
    // (The first turn: the one that fetched the first host. The timeline's order is not this test's.)
    const turn = tl.rows.filter((r: any) => r.kind === "turn").sort((a: any, b: any) => a.ts - b.ts)[0] ?? tl.rows[0];
    await page.goto(`/s/${s.id}`);
    await openPanel(page, "timeline");
    const line = page.locator(`[data-testid="timeline-row"][data-id="${turn.id}"]`);
    await line.locator("button[data-row]").click();
    const hosts = line.getByTestId("receipt-hosts");
    await expect(hosts).toContainText(host);
    await shoot(page, "network-02-receipt");
  } finally {
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  }
});
