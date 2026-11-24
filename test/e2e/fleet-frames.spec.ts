import { expect, test } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Two daemons on this machine stand in for two machines: this one (KEEL_URL) shows the sessions of the
// other (KEEL_PEER_URL).
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

// Feature: what changes on another machine for one of its sessions reaches this machine's page for it. The far
// daemon names the sessions a change concerns (a secret forgotten, a repository's file trusted), because a
// frame that names none is not relayed. Here: the far session's secret card goes when the secret is forgotten
// there, and its Trust panel reads again when a file of its repository is trusted there.
test("a far session's secret card and Trust panel follow what changes on its machine", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const old = (await (await request.get("/api/fleet/machines")).json()).machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  const repo = `${ROOT}/frames-${Date.now().toString(36)}`;
  mkdirSync(`${repo}/.git`, { recursive: true });
  writeFileSync(`${repo}/AGENTS.md`, "# Rules\n\nAnswer briefly.\n");
  const mid = (await (await request.post("/api/fleet/machines", { data: { name: "far-desk", daemon_url: PEER, workspace_root: ROOT } })).json()).id as string;
  const { session: far } = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: repo, title: "Far frames", model: HAIKU } })).json();
  const token = `ghp_${Date.now().toString(36)}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5`.slice(0, 40);
  try {
    await page.goto(`/s/${mid}--${far.id}`);
    // (A card for a secret found is told by the frame of the moment it was found: the page is open first.)
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
    await request.post(`${PEER}/api/sessions/${far.id}/messages`, { data: { text: `Remember ${token} and reply ok.` } });
    const found = page.getByTestId("secret-found");
    await expect(found).toContainText("GitHub token", { timeout: 60_000 });
    await shoot(page, "fleet-frames-01-far-secret-found");
    // Forgotten there: the card goes here.
    const { secrets } = await (await request.get(`${PEER}/api/sessions/${far.id}/secrets`)).json();
    expect(secrets.length).toBe(1);
    expect((await request.delete(`${PEER}/api/secrets/${secrets[0].id}`)).ok()).toBe(true);
    await expect(found).toHaveCount(0, { timeout: 15_000 });

    // The Trust panel of the far session reads again when a file of its repository is trusted there.
    await openPanel(page, "trust");
    await expect(page.getByTestId("trust-panel")).toBeVisible();
    const t = await (await request.get(`${PEER}/api/trust?cwd=${encodeURIComponent(repo)}`)).json();
    const file = t.files.find((f: any) => f.path === `${repo}/AGENTS.md`);
    expect(file).toBeTruthy();
    const read = page.waitForRequest((r) => r.url().includes("/api/trust?cwd="), { timeout: 15_000 });
    expect((await request.post(`${PEER}/api/trust`, { data: { cwd: repo, files: [{ path: file.path, sha256: file.sha256 }] } })).ok()).toBe(true);
    await read;
    await shoot(page, "fleet-frames-02-far-trust-read");
  } finally {
    await request.delete(`${PEER}/api/sessions/${far.id}`);
    await request.delete(`/api/fleet/machines/${mid}`);
  }
});
