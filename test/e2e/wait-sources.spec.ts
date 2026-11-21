import { expect, test } from "./isolate.ts";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

// Feature: waits on what lives outside the machine. A pull request's checks
// (gh with the owner's login, so the gate asks first) wake the session once
// they all finish, naming the failed ones; a WebSocket monitor delivers each
// message the server pushes and ends when the socket closes.
// Run the daemon with KEEL_GH_BIN=test/e2e/fixtures/gh-standin.sh: this test
// writes what the stand-in answers.
const GH = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state/gh");
const pr = (repo: string, n: number, v: unknown) => {
  mkdirSync(GH, { recursive: true });
  writeFileSync(join(GH, `${repo.replace("/", "_")}_${n}.json`), JSON.stringify(v));
};
const run = (name: string, status: string, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion });

test("pull request checks and a socket feed wake the session", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to set the waits with its tools from a plain prompt");
  const n = Date.now() % 1_000_000;
  const repo = "keel-e2e/fixture";
  // Is the daemon's gh the stand-in? A merged pull request fires at the first probe.
  pr(repo, n, { state: "MERGED", statusCheckRollup: [] });
  const probe = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "probe" } })).json()).session;
  const w = await (await request.post("/api/waits", { data: { session_id: probe.id, spec: { kind: "pr_checks", repo, pr_number: n } } })).json();
  await expect.poll(async () => ((await (await request.get("/api/waits")).json()).waits as any[]).find((x) => x.id === w.id)?.status !== "active" || !!((await (await request.get("/api/waits")).json()).waits as any[]).find((x) => x.id === w.id)?.last_error, { timeout: 15_000 }).toBe(true);
  const standin = ((await (await request.get("/api/waits")).json()).waits as any[]).find((x) => x.id === w.id)?.status === "fired";
  await request.delete(`/api/sessions/${probe.id}`);
  test.skip(!standin, "needs KEEL_GH_BIN=test/e2e/fixtures/gh-standin.sh on the daemon");

  pr(repo, n + 1, { state: "OPEN", statusCheckRollup: [run("lint", "COMPLETED", "SUCCESS"), run("integration", "IN_PROGRESS")] });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Wait sources" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
  await page.goto(`/s/${session.id}`);
  const say = async (text: string) => {
    await page.getByTestId("composer").fill(text);
    await page.keyboard.press("Enter");
  };

  // The checks wait runs gh with the owner's login: a card first.
  await say(`Use the WaitFor tool with kind pr_checks, repo ${repo} and pr_number ${n + 1}, then end your turn without other tools. When it fires, reply with only the names of the failed checks.`);
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("wait_pr_checks");
  await shoot(page, "wait-sources-01-card");
  await card.getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId("background-button").click();
  await expect(page.getByTestId("bg-wait")).toContainText(`Checks of ${repo}#${n + 1}`);
  await shoot(page, "wait-sources-02-parked");
  await page.keyboard.press("Escape");

  // The running check fails: the wait fires and names it.
  pr(repo, n + 1, { state: "OPEN", statusCheckRollup: [run("lint", "COMPLETED", "SUCCESS"), run("integration", "COMPLETED", "FAILURE")] });
  await expect(page.getByTestId("wake-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText("integration");

  // A socket feed: each message is an event; the close ends the monitor.
  const feed = spawn("bun", [join(import.meta.dirname, "fixtures/ws-feed.ts")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise<string>((res) => createInterface({ input: feed.stdout! }).once("line", res));
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await say(`Use the Monitor tool with ws url ws://127.0.0.1:${port}/ (no command) and the description "deploy feed". End your turn right after starting it. When an event with DONE arrives, reply with only that line.`);
    await expect(page.getByTestId("assistant-text").last()).toContainText("deploy 41 DONE", { timeout: 90_000 });
    await expect.poll(async () => ((await (await request.get("/api/waits")).json()).waits as any[]).find((x) => x.session_id === session.id && x.kind === "websocket")?.outcome ?? "", { timeout: 30_000 })
      .toContain("closed by the other side (code 1000, feed over)");
    await page.getByTestId("wake-notice").last().click();
    await shoot(page, "wait-sources-03-socket");
  } finally {
    feed.kill();
  }
  await request.delete(`/api/sessions/${session.id}`);
});
