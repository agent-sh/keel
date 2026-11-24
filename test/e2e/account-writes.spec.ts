import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const STAND_IN = "scripted:stand-in";
const calls = (list: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });

// Feature: writes with the owner's accounts beyond his namespaces. He names his namespaces in Settings > Safety; a push to
// another owner's repository asks him in Full auto too and names the namespace on the card, one to his own runs, and an
// agent is refused and told to report. (The remotes point at a port nothing listens on: no push ever leaves the machine.)
test("a push beyond the owner's namespaces is his to allow, in every mode", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "accounts-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", "x");
  git("remote", "add", "mine", "http://127.0.0.1:1/me/repo.git");
  git("remote", "add", "theirs", "http://127.0.0.1:1/them/lib.git");

  // The owner names his namespaces: typed, and learned from his config and confirmed.
  await page.goto("/settings/safety");
  const card = page.getByTestId("accounts-card");
  await expect(card.getByTestId("accounts-empty")).toBeVisible();
  const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: STAND_IN, title: "Account writes" } })).json();
  await card.getByTestId("accounts-look").click();
  await expect(card.getByTestId("accounts-found")).toContainText("127.0.0.1/them");
  await expect(card.getByTestId("accounts-found")).toContainText("127.0.0.1/me");
  await card.getByTestId("accounts-take-127.0.0.1/me").click();
  await expect(card.getByTestId("accounts-list")).toContainText("127.0.0.1/me");
  await expect(card.getByTestId("accounts-take-127.0.0.1/me")).toHaveCount(0);
  await card.getByTestId("accounts-input").fill("npm:@me");
  await card.getByTestId("accounts-add").click();
  await expect(card.getByTestId("accounts-list")).toContainText("npm:@me");
  await card.getByTestId("accounts-input").fill("not a namespace");
  await card.getByTestId("accounts-add").click();
  await expect(card.getByTestId("accounts-note")).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shoot(page, "account-writes-01-settings");

  const base = `/api/sessions/${session.id}`;
  const approvals = async () => (await (await request.get(`${base}/approvals?all`)).json()).approvals as { state: string; why?: string; summary: string }[];
  const turns = async () => { const r = await (await request.get(base)).json(); return r.running ? -1 : r.events.filter((e: any) => e.kind === "turn_end").length; };
  expect((await request.put(`${base}/permissions`, { data: { mode: "full-auto", sandbox: "off" } })).ok()).toBe(true);
  await page.goto(`/s/${session.id}`);

  // His own namespace: Full auto runs it as it ran before (it fails to connect; nothing asked).
  await request.post(`${base}/messages`, { data: { text: calls([bash("git push mine main")]) } });
  await expect.poll(turns, { timeout: 30_000 }).toBe(1);
  expect(await approvals()).toEqual([]);

  // Another owner's: Full auto does not run it unasked. The card names the namespace.
  await request.post(`${base}/messages`, { data: { text: calls([bash("git push theirs main")]) } });
  const ask = page.getByTestId("approval");
  await expect(ask).toHaveCount(1, { timeout: 30_000 });
  await expect(ask.getByTestId("approval-summary")).toContainText("git push theirs main");
  await expect(ask).toContainText("127.0.0.1/them/lib");
  await expect(ask).toContainText("not one of your namespaces");
  await expect(ask.getByTestId("allow-always")).toHaveCount(0);
  await shoot(page, "account-writes-02-card");
  await ask.getByTestId("deny").click();
  await ask.getByTestId("deny-send").click();
  await expect.poll(turns, { timeout: 30_000 }).toBe(2);
  expect((await approvals()).map((a) => a.state)).toEqual(["denied"]);

  // An agent is refused, with the way on: report what it wanted to do.
  await request.post(`${base}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: `Pusher\n${calls([bash("git push theirs main")])}`, isolation: "none" } }, { name: "wait_agent", input: {} }]) } });
  await expect.poll(turns, { timeout: 60_000 }).toBe(3);
  const agent = ((await (await request.get(`${base}/agents`)).json()).agents as { session_id: string }[])[0]!;
  const events = JSON.stringify((await (await request.get(`/api/sessions/${agent.session_id}`)).json()).events);
  expect(events).toContain("Report to your parent");
  expect(events).toContain("127.0.0.1/them/lib");
  expect(await approvals()).toHaveLength(1); // (the agent's refusal opened no card)
  await shoot(page, "account-writes-03-agent");
});
