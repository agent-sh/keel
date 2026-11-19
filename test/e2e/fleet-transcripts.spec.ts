import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: transcripts on another machine. The import sheet lists the other
// machine's Claude Code and Codex sessions (its daemon reads them, never one
// under a credentials folder), previews one, and imports it: the copy goes on
// here with a model, and its tools run on that machine in the transcript's folder.
// Run the other daemon with KEEL_IMPORT_CLAUDE_DIR at a scratch store
// (KEEL_PEER_CLAUDE_DIR here names the same folder).
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;
const STORE = process.env.KEEL_PEER_CLAUDE_DIR ?? "";

// A small Claude Code transcript in that store, in its own format.
function claudeSession(root: string, cwd: string, id: string, fruit: string) {
  const dir = join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 60_000;
  const base = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli" };
  const recs = [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(t).toISOString(), message: { role: "user", content: "Look at fruit.txt and name the fruit in it." } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date(t + 1000).toISOString(), message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `The fruit is ${fruit}.` }], stop_reason: "end_turn" } },
    { type: "ai-title", aiTitle: `Name the ${fruit} fixture`, sessionId: id },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("fleet transcripts: another machine's sessions, imported to go on there", async ({ page, request }) => {
  const peerUp = await request.get(`${PEER}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  test.skip(!peerUp, `no peer daemon at ${PEER}: start a second daemon and set KEEL_PEER_URL and KEEL_PEER_ROOT`);
  test.skip(!STORE, "needs the other daemon's scratch Claude Code store (KEEL_PEER_CLAUDE_DIR)");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tag = Date.now().toString(36);
  const cwd = join(ROOT, `proj-${tag}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "fruit.txt"), `quince-${tag}\n`);
  claudeSession(STORE, cwd, `11111111-2222-4333-8444-${tag.padStart(12, "0").slice(-12)}`, `quince-${tag}`);
  // One under a credentials folder: never offered.
  const hidden = join(ROOT, ".ssh", `k-${tag}`);
  mkdirSync(hidden, { recursive: true });
  claudeSession(STORE, hidden, `11111111-2222-4333-8444-${(tag + "9").padStart(12, "0").slice(-12)}`, `quince-${tag}`);

  let { machines } = await (await request.get("/api/fleet/machines")).json();
  let peer = machines.find((m: any) => m.daemon_url === PEER);
  if (!peer) {
    const r = await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } })).json();
    peer = r.machines.find((m: any) => m.id === r.id);
  }
  expect((await request.get("/api/fleet/machines/local/transcripts")).status()).toBe(400);
  const listed = await (await request.get(`/api/fleet/machines/${peer.id}/transcripts?q=${tag}&refresh=1`)).json();
  expect(listed.machine).toBe(peer.name);
  expect(listed.sessions.map((s: any) => s.cwd)).toEqual([cwd]);

  let made = "";
  try {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await page.getByRole("option", { name: /^Import sessions/ }).first().click();
    const sheet = page.getByTestId("import-sheet");
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId("import-from").selectOption({ label: peer.name });
    await page.getByTestId("import-search").fill(tag);
    const rows = sheet.getByTestId("import-row");
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    await expect(rows.first()).toContainText(`Name the quince-${tag} fixture`);
    await rows.first().click();
    await expect(sheet.getByTestId("import-counts")).toContainText(/1\s*prompts/);
    await shoot(page, "fleet-transcripts-01-sheet");
    await sheet.getByTestId("import-go").click();

    // The copy goes on here; its tools run on that machine, in its folder there.
    await expect(page.getByTestId("machine-chip")).toContainText(peer.name, { timeout: 15_000 });
    made = page.url().split("/s/")[1]!;
    await page.request.put(`/api/sessions/${made}/permissions`, { data: { mode: "full-auto" } });
    await page.request.patch(`/api/sessions/${made}`, { data: { model: HAIKU } });
    await page.getByTestId("composer").fill("Run this with the Bash tool, one call: cat fruit.txt && pwd. Then reply with the output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end").last()).toBeVisible({ timeout: 120_000 });
    const tool = page.locator('[data-tool="Bash"]').last();
    await expect(tool.getByTestId("tool-machine")).toHaveText(peer.name);
    await tool.click();
    await expect(tool).toContainText(`quince-${tag}`);
    await expect(tool).toContainText(cwd);
    await shoot(page, "fleet-transcripts-02-continued");

    // Listed again, it shows as imported.
    const again = await (await request.get(`/api/fleet/machines/${peer.id}/transcripts?q=${tag}`)).json();
    expect(again.sessions[0].imported.session_id).toBe(made);
    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    if (made) await request.delete(`/api/sessions/${made}`);
  }
});
