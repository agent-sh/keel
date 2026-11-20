import { expect, test } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the fleet. Two daemons on this machine stand in for two machines:
// this one (KEEL_URL) pairs with the other (KEEL_PEER_URL) from the Machines
// page, the other's session shows up in the session list and is driven through
// the link, and a session placed on the other machine runs its tools there.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

test("fleet: pair, the other machine's sessions, a tool on the peer", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // Start clean: no session placed on an old pairing, no old machine record.
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  const old = machines.filter((m: any) => m.daemon_url === PEER).map((m: any) => m.id);
  for (const s of (await (await request.get("/api/sessions")).json()).sessions) if (old.includes(s.machine)) await request.delete(`/api/sessions/${s.id}`);
  for (const id of old) await request.delete(`/api/fleet/machines/${id}`);
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  const prevRules = (await (await request.get("/api/fleet/placement")).json()).rules;
  await request.post("/api/fleet/placement", { data: { rules: [] } });
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });

  // The other machine has its own session and a file only it has.
  mkdirSync(ROOT, { recursive: true });
  const token = `peer-${Date.now().toString(36)}`;
  writeFileSync(`${ROOT}/note.txt`, `${token}\n`);
  const made = await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Started on the other machine", model: HAIKU } })).json();

  try {
    // Pair from the Machines page.
    await page.goto("/settings/machines");
    await expect(page.getByTestId("machines-panel")).toBeVisible();
    await page.getByTestId("machine-add-open").click();
    await page.getByTestId("machine-add-name").fill("devbox");
    await page.getByTestId("machine-add-url").fill(PEER);
    await page.getByTestId("machine-add-root").fill(ROOT);
    await page.getByTestId("machine-add-submit").click();
    const row = page.locator('[data-testid="machine-row"]').filter({ hasText: "devbox" });
    await expect(row.getByTestId("machine-link")).toContainText("linked", { timeout: 15_000 });
    await expect(row.getByTestId("machine-state")).toContainText(/ready|busy/);
    await expect(row).toContainText(ROOT);
    // A placement rule: sessions go to the other machine when Auto is picked.
    await page.getByLabel("Kind of work").selectOption("session");
    await page.getByTestId("placement-machine").selectOption({ label: "devbox" });
    await page.getByLabel("Note", { exact: true }).fill("work lives there");
    await page.getByTestId("placement-add").click();
    await expect(page.getByTestId("placement-rule")).toContainText("When a session, run it on devbox");
    await shoot(page, "fleet-01-machines");

    // One session list: the other daemon's session, under its machine.
    const remote = page.locator(`[data-testid="session-row"][data-session$="--${made.session.id}"]`);
    await expect(remote).toBeVisible({ timeout: 15_000 });
    // The list groups it under its machine.
    await expect(page.locator(`section:has([data-session$="--${made.session.id}"])`).getByTestId("group-machine")).toHaveText("devbox");
    await page.locator(`[data-testid="session-row"][data-session$="--${made.session.id}"]`).click();
    await expect(page.getByTestId("machine-chip")).toContainText("devbox");
    await expect(page.getByTestId("session-title")).toHaveText("Started on the other machine");
    // Its model is the other daemon's: the picker names it and offers that daemon's listing.
    await expect(page.getByTestId("model-picker")).not.toContainText(/Choose a model|No models/);
    await page.getByTestId("model-picker").click();
    await expect(page.getByTestId("peer-catalog")).toContainText("Models devbox lists");
    await expect(page.getByTestId("model-option").first()).toBeVisible();
    // Favorites and hiding are this daemon's choices: a peer's listing offers neither.
    await page.getByTestId("model-option").first().hover();
    await expect(page.getByTestId("pin-model")).toHaveCount(0);
    await expect(page.getByTestId("hide-model")).toHaveCount(0);
    await expect(page.getByTestId("peer-choices-note")).toContainText("devbox");
    // The default badge is that daemon's default, not this one's.
    const peerDefault = (await (await request.get(`${PEER}/api/models`)).json()).default;
    const localDefault = (await (await request.get("/api/models")).json()).default;
    const badged = page.getByTestId("model-option").filter({ has: page.getByTestId("model-default") });
    if (peerDefault) await expect(badged.first()).toHaveAttribute("data-model", peerDefault);
    if (localDefault !== peerDefault) await expect(page.locator(`[data-testid="model-option"][data-model="${localDefault}"]`).getByTestId("model-default")).toHaveCount(0);
    await shoot(page, "fleet-02a-peer-models");
    await page.keyboard.press("Escape");
    // Driven through the link: the turn runs on the other daemon, its frames come back over the relay.
    await page.getByTestId("composer").fill("Reply with the single word: pong");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("main")).toContainText(/pong/i);
    await shoot(page, "fleet-02-remote-session");

    // A new session placed by the rule on the other machine: its tools run there.
    await page.getByTestId("new-session").click();
    await page.getByTestId("machine-picker").click();
    await expect(page.locator('[data-testid="machine-option"]').filter({ hasText: "devbox" })).toBeVisible();
    await page.locator('[data-testid="machine-option"][data-machine="auto"]').click();
    await expect(page.getByTestId("machine-picker")).toContainText("Auto");
    // Before sending, the start box says where Auto puts it: the other
    // machine's directory, not a folder of this machine (no folder picker).
    await expect(page.getByTestId("auto-place")).toContainText(/places it on\s*devbox/);
    await expect(page.getByTestId("auto-place")).toContainText(ROOT);
    await expect(page.getByTestId("workspace-picker")).toHaveCount(0);
    await shoot(page, "fleet-03a-auto-place");
    // A request with a folder of this machine is not moved onto that one.
    const kept = await request.post("/api/fleet/sessions", { data: { machine: "auto", text: "", model: HAIKU, local_workspace: `${process.env.HOME}/.cache/keel-work/bun/e2e-ws` } });
    expect(kept.status()).toBe(409);
    expect((await kept.json()).error).toContain("not in");
    // A model this daemon cannot use is refused the same way wherever Auto goes, before any session.
    const before = (await (await request.get("/api/sessions")).json()).sessions.length;
    for (const machine of ["auto", "local-none"]) {
      const r = await request.post("/api/fleet/sessions", { data: { machine, text: "hi", model: "nosuch:model" } });
      expect(r.status()).toBe(409);
    }
    expect((await (await request.get("/api/sessions")).json()).sessions.length).toBe(before);
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("haiku 5.5");
    await page.getByRole("option").first().click();
    await page.getByTestId("composer").fill("Run this with the Bash tool, one call: cat note.txt && pwd. Then reply with the output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const tool = page.locator('[data-tool="Bash"]').first();
    await expect(tool.getByTestId("tool-machine")).toHaveText("devbox");
    await expect(page.locator("main")).toContainText("Placed on devbox by rule 1 (work lives there)");
    await expect(page.getByTestId("machine-chip")).toContainText("devbox");
    await tool.click();
    await expect(tool).toContainText(token);
    await expect(tool).toContainText(ROOT);
    await shoot(page, "fleet-03-tool-on-peer");
    // A checklist item of this session taken into a session of its own keeps
    // the machine its folder is on.
    const placedId = new URL(page.url()).pathname.split("/").pop()!;
    const placedMachine = (await (await request.get(`/api/sessions/${placedId}`)).json()).session.machine;
    expect(placedMachine).toBeTruthy();
    await request.post(`/api/sessions/${placedId}/tasks`, { data: { text: "Reply with the single word: ok" } });
    const task = (await (await request.get(`/api/sessions/${placedId}/tasks`)).json()).tasks[0];
    const started = await (await request.post(`/api/sessions/${placedId}/tasks/${task.id}/start`)).json();
    expect((await (await request.get(`/api/sessions/${started.session_id}`)).json()).session.machine).toBe(placedMachine);
    await request.post(`/api/sessions/${started.session_id}/interrupt`);
    await request.delete(`/api/sessions/${started.session_id}`);

    // One command on the other machine from a session that stays here.
    await page.getByTestId("new-session").click();
    await page.getByTestId("machine-picker").click();
    await page.locator('[data-testid="machine-option"][data-machine="local"]').click();
    await page.getByTestId("composer").fill("Call keel__run_on once with machine \"devbox\" and command \"cat note.txt\". Then reply with its output only.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const run = page.locator('[data-tool="keel__run_on"]').first();
    await expect(run.getByTestId("tool-machine")).toHaveText("devbox");
    await run.click();
    await expect(run).toContainText(`[ran on devbox]`);
    await expect(run).toContainText(token);
    await shoot(page, "fleet-04-run-on");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
    await request.post("/api/fleet/placement", { data: { rules: prevRules } });
    await request.delete(`${PEER}/api/sessions/${made.session.id}`);
  }
});

// A secret never crosses to the other machine: a call sent there names it,
// and that machine puts back one it holds under the same name, or refuses by
// name. The other daemon's state and answers never hold the value.
test("fleet: a secret goes to the other machine by name only", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const STAND_IN = "scripted:stand-in";
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: any) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const STATE = process.env.KEEL_PEER_STATE ?? `${dirname(ROOT)}/state`;
  test.skip(!existsSync(STATE), `the peer's state folder ${STATE} is not on this machine: set KEEL_PEER_STATE`);
  const known = (async () => (await (await request.get("/api/fleet/machines")).json()).machines.find((x: any) => x.daemon_url === PEER && x.workspace_root === ROOT));
  let m = await known();
  if (!m) {
    expect((await request.post("/api/fleet/machines", { data: { name: "secretbox", daemon_url: PEER, workspace_root: ROOT } })).status()).toBe(201);
    m = await known();
  }
  mkdirSync(ROOT, { recursive: true });
  const token = `ghp_${Date.now().toString(36)}Pe3rS3cr3tA1b2C3d4E5f6G7h8I9j0K1`.slice(0, 40);
  const sha = createHash("sha256").update(token).digest("hex");
  const NAME = `E2E_PEER_${Date.now().toString(36).toUpperCase()}`; // a daemon keeps a secret until it restarts
  const ref = "[value of $" + NAME + "]";
  const made: { base: string; id: string }[] = [];
  const done = (base: string, id: string, n: number) => expect.poll(async () => {
    const r = await (await request.get(`${base}/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(n);
  // A daemon learns the value from an owner's message, and the owner names it.
  const learn = async (base: string, id: string) => {
    await request.post(`${base}/api/sessions/${id}/messages`, { data: { text: `keep ${token} script:calls []` } });
    await done(base, id, 1);
    const { secrets } = await (await request.get(`${base}/api/sessions/${id}/secrets`)).json();
    expect((await request.patch(`${base}/api/secrets/${secrets[0].id}`, { data: { name: NAME } })).ok()).toBe(true);
  };
  try {
    const placed = await (await request.post("/api/fleet/sessions", { data: { machine: m.id, model: STAND_IN, title: "Secret by name" } })).json();
    const s = placed.session.id as string;
    made.push({ base: "", id: s });
    await request.put(`/api/sessions/${s}/permissions`, { data: { mode: "full-auto" } });
    await learn("", s);
    const calls = JSON.stringify([
      { name: "Bash", input: { command: `printf %s ${ref} | sha256sum` } },
      { name: "keel__run_on", input: { machine: m.name, command: `printf %s ${ref} | sha256sum` } },
    ]);
    const results = async () => (await (await request.get(`/api/sessions/${s}`)).json()).events.filter((e: any) => e.kind === "tool_result").map((e: any) => JSON.stringify(e.data));

    // The other machine does not hold it: nothing runs there, and the reason names it.
    await request.post(`/api/sessions/${s}/messages`, { data: { text: `script:calls ${calls}` } });
    await done("", s, 2);
    const refused = (await results()).slice(-2);
    expect(refused.length).toBe(2);
    for (const r of refused) expect(r).toContain("$" + NAME + " is not a secret on this machine");
    await page.goto(`/s/${s}`);
    await expect(page.locator('[data-tool="keel__run_on"]').first()).toBeVisible();
    await shoot(page, "fleet-05-secret-not-there");

    // Given there under the same name, both calls run with it.
    const far = (await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Holds the secret", model: STAND_IN } })).json()).session.id as string;
    made.push({ base: PEER, id: far });
    await learn(PEER, far);
    await request.post(`/api/sessions/${s}/messages`, { data: { text: `script:calls ${calls}` } });
    await done("", s, 3);
    for (const r of (await results()).slice(-2)) expect(r).toContain(sha);

    // The value is in no file of the other daemon's state and no answer it gives.
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n), st = statSync(p); return st.isDirectory() ? files(p) : st.isFile() ? [p] : []; });
    for (const f of files(STATE)) expect({ f, has: readFileSync(f).includes(token) }).toEqual({ f, has: false });
    for (const path of [`/api/sessions/${far}`, `/api/sessions/${s}/jobs`, "/api/errors", "/api/fleet/messages"]) {
      const body = await (await request.get(`${PEER}${path}`)).text();
      expect({ path, has: body.includes(token) }).toEqual({ path, has: false });
    }
    expect(JSON.stringify(await (await request.get(`/api/sessions/${s}`)).json())).not.toContain(token);
  } finally {
    for (const x of made) await request.delete(`${x.base}/api/sessions/${x.id}`);
  }
});
