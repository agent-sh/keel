import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: a port range for each session whose sandbox is off ($KEEL_PORT, ten ports). The Preview panel says
// which ten are the session's, and a dev server that listens in another session's range is named with its holder.
test("the preview names the session's port range and who holds a port outside it", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `ports-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const make = async (title: string) => {
    const s = (await (await request.post("/api/sessions", { data: { workspace: ws, title, model: HAIKU } })).json()).session;
    await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    return s.id as string;
  };
  const serve = (id: string, port: string) => request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: {
    command: `bun -e "Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setInterval(() => {}, 1000)"`, run_in_background: true } }])}` } });
  const first = await make("Holder of a range"), second = await make("Another session");
  try {
    // The first session's server listens on its own $KEEL_PORT.
    await serve(first, "process.env.KEEL_PORT");
    const mine = async () => (await (await request.get(`/api/sessions/${first}/portal`)).json());
    await expect.poll(async () => (await mine()).ports.length, { timeout: 30_000 }).toBe(1);
    const { range, ports } = await mine();
    expect(range.to - range.from).toBe(9);
    expect(ports[0].port).toBe(range.from);
    expect(ports[0].holder).toMatchObject({ session_id: first, mine: true });
    await page.goto(`/s/${first}`);
    await openPanel(page, "preview");
    await expect(page.getByTestId("preview-range")).toHaveText(`Ports ${range.from} to ${range.to} for this session`);
    await expect(page.locator(`[data-testid="preview-port"][data-port="${range.from}"]`)).toBeVisible();
    await expect(page.getByTestId("preview-holder")).toHaveCount(0);
    await shoot(page, "session-ports-01-own");

    // The second session's server sits in the first one's range: its panel names the holder.
    await serve(second, String(range.from + 5));
    await expect.poll(async () => (await (await request.get(`/api/sessions/${second}/portal`)).json()).ports.length, { timeout: 30_000 }).toBe(1);
    const other = await (await request.get(`/api/sessions/${second}/portal`)).json();
    expect(other.range.from).not.toBe(range.from);
    await page.goto(`/s/${second}`);
    await openPanel(page, "preview");
    await expect(page.getByTestId("preview-holder")).toHaveText("in Holder of a range's range");
    await expect(page.getByTestId("preview-range")).toHaveText(`Ports ${other.range.from} to ${other.range.to} for this session`);
    await shoot(page, "session-ports-02-other");
  } finally {
    await request.delete(`/api/sessions/${first}`);
    await request.delete(`/api/sessions/${second}`);
  }
});
