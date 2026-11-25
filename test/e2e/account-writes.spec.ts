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
  git("remote", "add", "third", "http://127.0.0.1:1/third/x.git");

  // The owner names his namespaces: typed, and learned from his config and confirmed.
  await page.goto("/settings/safety");
  const card = page.getByTestId("accounts-card");
  await expect(card.getByTestId("accounts-empty")).toBeVisible();
  const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: STAND_IN, title: "Account writes" } })).json();
  await card.getByTestId("accounts-look").click();
  await expect(card.getByTestId("accounts-found")).toContainText("127.0.0.1/them");
  await expect(card.getByTestId("accounts-found")).toContainText("127.0.0.1/me");
  await card.locator('[data-testid="accounts-take"][data-namespace="127.0.0.1/me"]').click();
  await expect(card.getByTestId("accounts-list")).toContainText("127.0.0.1/me");
  await expect(card.locator('[data-testid="accounts-take"][data-namespace="127.0.0.1/me"]')).toHaveCount(0);
  await card.getByTestId("accounts-input").fill("npm:@me");
  await card.getByTestId("accounts-add").click();
  await expect(card.getByTestId("accounts-list")).toContainText("npm:@me");
  await card.getByTestId("accounts-input").fill("not a namespace");
  await card.getByTestId("accounts-add").click();
  await expect(card.getByTestId("accounts-note")).toBeVisible();
  // GitHub is asked only at this press, and only when gh is signed in here: with no sign-in it says so and adds nothing.
  // (A daemon that runs with a real gh sign-in is not pressed: the spec never reads GitHub with the owner's account.)
  const signedIn = ((await (await request.get("/api/accounts/github")).json()).hosts as string[]).length > 0;
  if (!signedIn) {
    await card.getByTestId("accounts-github").click();
    await expect(card.getByTestId("accounts-note")).toContainText("not signed in");
  }
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

  // A first push to a place of his own that he has not named: the card offers Mine in one press. It allows this once and
  // names the owner in Your accounts, so the next push there asks nothing (an agent's too).
  await request.post(`${base}/messages`, { data: { text: calls([bash("git push third main")]) } });
  const mine = page.getByTestId("approval");
  await expect(mine).toHaveCount(1, { timeout: 30_000 });
  await expect(mine.getByTestId("allow-mine")).toContainText("This organization is mine");
  await expect(mine.getByTestId("allow-mine")).toContainText("127.0.0.1/third");
  await expect(mine.getByTestId("allow-mine")).toHaveAttribute("title", /Settings > Permissions > Your accounts/);
  await shoot(page, "account-writes-04-mine");
  await mine.getByTestId("allow-mine").click();
  await expect.poll(turns, { timeout: 30_000 }).toBe(3);
  expect(((await (await request.get("/api/settings")).json()).settings.accounts.namespaces as string[])).toContain("127.0.0.1/third");
  expect((await approvals()).map((a) => a.state)).toEqual(["denied", "allowed"]);
  await request.post(`${base}/messages`, { data: { text: calls([bash("git push third main")]) } });
  await expect.poll(turns, { timeout: 30_000 }).toBe(4);
  expect(await approvals()).toHaveLength(2);

  // An agent that names a place outside the repository's remotes is refused, with the way on: report what it wanted to do.
  await request.post(`${base}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: `Pusher\n${calls([bash("git push http://127.0.0.1:1/them/lib.git main")])}`, isolation: "none" } }, { name: "wait_agent", input: {} }]) } });
  await expect.poll(turns, { timeout: 60_000 }).toBe(5);
  const agent = ((await (await request.get(`${base}/agents`)).json()).agents as { session_id: string }[])[0]!;
  const events = JSON.stringify((await (await request.get(`/api/sessions/${agent.session_id}`)).json()).events);
  expect(events).toContain("Report to your parent");
  expect(events).toContain("127.0.0.1/them/lib");
  expect(events).toContain("Your accounts");
  expect(await approvals()).toHaveLength(2); // (the agent's refusal opened no card)
  await shoot(page, "account-writes-03-agent");

  // An agent's push to a remote of the repository it works in waits for the owner, as his own would: the card says it is the
  // agent's, and he can deny it.
  await request.post(`${base}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: `Pusher2\n${calls([bash("git push theirs main")])}`, isolation: "none" } }, { name: "wait_agent", input: {} }]) } });
  const agentCard = page.getByTestId("approval");
  await expect(agentCard).toHaveCount(1, { timeout: 60_000 });
  await expect(agentCard).toContainText("An agent's write");
  await expect(agentCard).toContainText("127.0.0.1/them/lib");
  await expect(agentCard.getByTestId("allow-mine")).toContainText("127.0.0.1/them");
  await shoot(page, "account-writes-05-agent-card");
  await agentCard.getByTestId("deny").click();
  await agentCard.getByTestId("deny-send").click();
  await expect.poll(turns, { timeout: 60_000 }).toBe(6);
  const second = ((await (await request.get(`${base}/agents`)).json()).agents as { session_id: string }[]).map((a) => a.session_id);
  const states = await Promise.all(second.map(async (id) => ((await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { state: string; why?: string }[])));
  expect(states.flat().filter((a) => a.state === "denied" && (a.why ?? "").includes("An agent's write"))).toHaveLength(1);
});
