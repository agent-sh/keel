import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: several sessions on screen at once (the Bridge's stations). The
// station worked in has the keys: Alt+M opens only its model menu, a slash
// command acts on its session, and text put into one session's draft from
// outside lands in that station's message box and no other.
// Every station on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

test("keys and drafts per station", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `stations-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title } })).json()).session.id as string;
  const tag = Date.now();
  const a = await mk(`Station A ${tag}`);
  const b = await mk(`Station B ${tag}`);
  for (const id of [a, b]) await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  // Started and finished: the newest finished sessions get stations.
  for (const id of [a, b]) await request.post(`/api/sessions/${id}/messages`, { data: { text: "Reply with exactly the word ready." } });
  for (const id of [a, b]) await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 90_000 }).toBe(true);

  await page.setViewportSize({ width: 3840, height: 1080 }); // the owner's ultrawide: six stations
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
  const line = page.locator(`section[data-station="${copy.session.id}"]`).getByTestId("station-head").locator(".k-station-line");
  await expect(line).toHaveText("PASS all colored done");
  await request.delete(`/api/sessions/${copy.session.id}`);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
