import { expect, test } from "./isolate.ts";
import { peerProblem, standInDaemon } from "./peer.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: moving a session to another machine with its git state and back.
// Its uncommitted change travels, the model works on it over there, and coming
// back the folder it left gets the result; deleting the session removes the
// worktree it had over there.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;
const HOME_DIR = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/move-${Date.now().toString(36)}`;

test("fleet move: there with its git state, work there, back home", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  mkdirSync(ROOT, { recursive: true });
  let { machines } = await (await request.get("/api/fleet/machines")).json();
  if (!machines.some((m: any) => m.daemon_url === PEER)) await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } });
  mkdirSync(HOME_DIR, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", HOME_DIR, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(`${HOME_DIR}/a.txt`, "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  writeFileSync(`${HOME_DIR}/a.txt`, "one\ntwo\n"); // uncommitted: it must travel
  const s = (await (await request.post("/api/sessions", { data: { workspace: HOME_DIR, title: "Move me", model: HAIKU } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });

  try {
    await page.goto(`/s/${s.id}`);
    await page.getByTestId("machine-chip").click();
    await page.locator('[data-testid="move-to"]').filter({ hasText: "devbox" }).click();
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(page.getByTestId("move-progress")).toContainText("Last move");
    await shoot(page, "fleet-move-01-there");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("machine-chip")).toContainText("devbox");
    await expect(page.getByTestId("note").filter({ hasText: "Moved from" })).toBeVisible();

    await page.getByTestId("composer").fill("Run this with the Bash tool, one call: echo three >> a.txt && cat a.txt && pwd. Then reply with the output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const tool = page.locator('[data-tool="Bash"]').first();
    await tool.click();
    await expect(tool.getByTestId("tool-machine")).toHaveText("devbox");
    await expect(tool).toContainText("two");
    await expect(tool).toContainText("/.keel/worktrees/handoff-");
    expect(readFileSync(`${HOME_DIR}/a.txt`, "utf8")).toBe("one\ntwo\n"); // the folder it left is untouched

    await page.getByTestId("machine-chip").click();
    await page.locator('[data-testid="move-to"][data-machine="local"]').click();
    await expect(page.getByTestId("move-progress")).toContainText("devbox to", { timeout: 60_000 });
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done");
    await shoot(page, "fleet-move-02-back");
    await page.keyboard.press("Escape");
    expect(readFileSync(`${HOME_DIR}/a.txt`, "utf8")).toBe("one\ntwo\nthree\n");
    expect(git("status", "--short")).toContain("M a.txt");

    const away = (await (await request.get(`/api/sessions/${s.id}/handoff`)).json()).handoff.away;
    const wt = Object.values(away)[0] as string;
    expect(existsSync(wt)).toBe(true);
    await request.delete(`/api/sessions/${s.id}`);
    await expect.poll(() => existsSync(wt), { timeout: 20_000 }).toBe(false);

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${s.id}`);
    // The scratch repository here and the one the move made over there.
    rmSync(HOME_DIR, { recursive: true, force: true });
    rmSync(`${ROOT}/${basename(HOME_DIR)}`, { recursive: true, force: true });
  }
});

// A session whose tools run on another machine only comes back here: the
// daemon refuses a move from there to a third machine, so the picker offers
// "back here", lists the other machines with the reason, and offers them
// again once the session is home. Place only: nothing is carried, no model runs.
test("fleet move: from another machine a session only comes back here, and the picker says why", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const model = ((await (await request.get("/api/models")).json()).models as { provider: string; context: number; id: string }[])
    .filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;
  test.skip(!model, "the daemon runs without the scripted provider");
  mkdirSync(ROOT, { recursive: true });
  let { machines } = await (await request.get("/api/fleet/machines")).json();
  let first = machines.find((m: any) => m.daemon_url === PEER);
  if (!first) {
    const r = await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } })).json();
    first = r.machines.find((m: any) => m.id === r.id);
  }
  // A third machine that answers (a stand-in: nothing moves there), and one that does not.
  const tag = Date.now().toString(36);
  const box = standInDaemon("third");
  await box.open();
  const thirdName = `Third box ${tag}`;
  const third = (await (await request.post("/api/fleet/machines", { data: { name: thirdName, daemon_url: box.url(), workspace_root: "/srv/third" } })).json()).id as string;
  const stub = createServer((_, res) => res.writeHead(404).end("{}"));
  await new Promise<void>((resolve, reject) => stub.once("error", reject).listen(0, "127.0.0.1", resolve));
  const silent = (await (await request.post("/api/fleet/machines", { data: { name: `Silent box ${tag}`, daemon_url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, workspace_root: "/srv/silent" } })).json()).id as string;
  await expect.poll(async () => (await (await request.get(`/api/fleet/machines/${third}`)).json()).state).toBe("ready");
  const s = (await (await request.post("/api/sessions", { data: { title: "Move twice", model } })).json()).session;
  const to = (machine: string) => page.locator(`[data-testid="move-to"][data-machine="${machine}"]`);
  try {
    await page.goto(`/s/${s.id}`);
    await page.getByTestId("machine-chip").click();
    // At home the machines that answer are offered; the one that does not is marked and is no move.
    await expect(to(first.id)).toBeEnabled();
    await expect(to(third)).toBeEnabled();
    await expect(to(silent)).toBeDisabled();
    await expect(to(silent)).toContainText("offline");
    await expect(page.getByTestId("move-later")).toHaveCount(0);
    await page.getByRole("radio", { name: "place only" }).click();
    await to(first.id).click();
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(page.getByTestId("machine-chip")).toContainText(first.name);

    // There: only "back here" is a move; the third machine is listed with the reason.
    await expect(page.getByTestId("move-to")).toHaveCount(1);
    await expect(to("local")).toContainText("back here");
    await expect(to(third)).toHaveCount(0);
    const later = page.getByTestId("move-later");
    await expect(later.locator(`[data-testid="move-unavailable"][data-machine="${third}"]`)).toContainText(thirdName);
    await expect(later.locator(`[data-testid="move-unavailable"][data-machine="${silent}"]`)).toContainText("offline");
    await expect(later).toContainText("Move it back here first, then to one of these.");
    await shoot(page, "fleet-move-03-only-back");
    // What the picker no longer offers is what the daemon refuses.
    const refused = await request.post(`/api/sessions/${s.id}/handoff`, { data: { machine_id: third, carry: "none" } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("comes back here before it goes to a third");

    // Home again: both are offered as moves.
    await to("local").click();
    await expect(page.getByTestId("move-progress")).toContainText(`${first.name} to`, { timeout: 60_000 });
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done");
    await expect(to(first.id)).toBeEnabled();
    await expect(to(third)).toBeEnabled();
    await expect(to(silent)).toBeDisabled();
    await expect(page.getByTestId("move-later")).toHaveCount(0);
    await shoot(page, "fleet-move-04-home-again");
  } finally {
    await page.goto("about:blank");
    await request.delete(`/api/sessions/${s.id}`);
    for (const id of [third, silent]) await request.delete(`/api/fleet/machines/${id}`);
    stub.close();
    await box.close();
  }
});
