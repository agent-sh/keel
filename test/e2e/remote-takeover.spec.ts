import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { choose, shoot } from "./shots.ts";

// Feature: a conversation from another computer, resumed in Keel. The other
// computer is the stand-in ssh host of a scratch daemon (scripts/dev.sh: this
// machine with a scratch home, reached by test/e2e/fixtures/ssh-standin.sh),
// with no Keel daemon on it, only the helper Keel puts there. Its Claude Code
// transcripts are listed and imported over that link. Two stand-in harnesses
// (fixtures/harness-standin.ts) each run a child shell that writes nothing for
// a while, and a benchmark job in a process group of its own: each shows as
// active while its shell runs. One is waited for and resumed once it is idle;
// the other is copied while it works (the copy says so), then resumed now,
// with what was in flight listed, its job first. The copy then runs a turn
// whose shell runs on that machine.
const HOST = process.env.KEEL_SSH_STANDIN_HOST ?? "keel-standin";
const STAND_IN = "scripted:stand-in";
const tag = Date.now().toString(36);
const sid = (n: number) => `5e5e5e5e-${n}000-4000-8000-${tag.padStart(12, "0").slice(-12)}`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A finished Claude Code transcript in that machine's store, in its own format.
function transcript(home: string, cwd: string, id: string, title: string, fruit: string) {
  const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 3600_000;
  const base = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli" };
  const recs = [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(t).toISOString(), message: { role: "user", content: "Look at fruit.txt and name the fruit in it." } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date(t + 1000).toISOString(), message: { id: "msg_1", type: "message", role: "assistant", model: "claude-stand-in", content: [{ type: "text", text: `The fruit is ${fruit}.` }], stop_reason: "end_turn" } },
    { type: "ai-title", aiTitle: title, sessionId: id },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// A stand-in harness at work in `cwd`: its pid, for the checks and the cleanup.
function harness(home: string, cwd: string, id: string, title: string, hold: number, job: number): number {
  const p = spawn("bun", [resolve("test/e2e/fixtures/harness-standin.ts"), "--home", home, "--cwd", cwd, "--session", id, "--hold", String(hold), "--job", String(job), "--title", title], { detached: true, stdio: "ignore" });
  p.unref();
  return p.pid!;
}

async function openSheet(page: Page, machine: string) {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.getByRole("option", { name: /^Import sessions/ }).first().click();
  const sheet = page.getByTestId("import-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await choose(sheet.getByTestId("import-from"), { label: machine });
  await page.getByTestId("import-search").fill(tag);
  return sheet;
}
const notes = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "note").map((e) => e.data.text as string);

test("resume from an ssh machine: listed, imported, waited for or resumed now, and going on there", async ({ page, request }) => {
  test.setTimeout(300_000);
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  let machines = (await (await request.get("/api/fleet/machines")).json()).machines as any[];
  test.skip(!machines.some((m) => m.ssh_host === HOST), `the daemon's ssh configuration has no stand-in host ${HOST} (scripts/dev.sh adds it)`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  // The stand-in host, enabled: its home is the scratch home, the grant a folder in it.
  let m = machines.find((x) => x.ssh_host === HOST && x.enabled);
  const enabledHere = !m;
  if (!m) {
    const r = await (await request.post("/api/fleet/machines", { data: { ssh_host: HOST } })).json();
    m = r.machines.find((x: any) => x.id === r.id);
  }
  const home = m.facts.home as string;
  expect(home).toContain("keel-work");
  const root = join(home, "work");
  const proj = join(root, `proj-${tag}`);
  const outside = join(home, `elsewhere-${tag}`);
  for (const d of [proj, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(proj, "fruit.txt"), `quince-${tag}\n`);
  await request.patch(`/api/fleet/machines/${m.id}`, { data: { workspace_root: root } });
  transcript(home, proj, sid(1), `Name the fruit ${tag}`, `quince-${tag}`);
  transcript(home, outside, sid(2), `Elsewhere ${tag}`, "medlar");
  // One under a credentials folder: never offered.
  mkdirSync(join(root, ".ssh", tag), { recursive: true });
  transcript(home, join(root, ".ssh", tag), sid(3), `Hidden ${tag}`, "sloe");

  const made: string[] = [];
  let localCopy = "";
  const procs: number[] = [];
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  try {
    // A local import from an explicitly named fixture has the same source id.
    // It must not be offered as the copy from the SSH machine.
    const fixture = join(home, ".claude", "projects", proj.replace(/[^A-Za-z0-9]/g, "-"), `${sid(1)}.jsonl`);
    const local = await request.post("/api/import", { data: { path: fixture, harness: "claude", model: STAND_IN } });
    expect(local.status()).toBe(201);
    localCopy = (await local.json()).session.id;

    // ---- the list and a plain import, over the ssh link
    await page.goto("/");
    let sheet = await openSheet(page, m.name);
    const rows = sheet.getByTestId("import-row");
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(sheet.getByTestId("original-strip")).toHaveCount(0); // nothing runs them
    await sheet.locator(`[data-testid="import-row"][data-id="${sid(1)}"]`).click();
    await expect(sheet.getByTestId("import-counts")).toContainText(/1\s*prompts/);
    await expect(sheet.getByTestId("import-go")).toBeEnabled();
    await shoot(page, "resume-01-list");
    await sheet.getByTestId("import-go").click();
    await expect(page.getByTestId("machine-chip")).toContainText(m.name, { timeout: 15_000 });
    made.push(page.url().split("/s/")[1]!);
    expect(made[0]).not.toBe(localCopy);
    expect((await (await request.get(`/api/sessions/${made[0]}`)).json()).session.workspace).toBe(proj);
    // A transcript whose folder is outside the grant goes on in the granted directory, and says so.
    const far = await (await request.post(`/api/fleet/machines/${m.id}/transcripts/import`, { data: { harness: "claude", id: sid(2) } })).json();
    made.push(far.session.id);
    expect(far.session.workspace).toBe(root);
    expect((await notes(request, far.session.id)).join("\n")).toContain(`is not inside the directory granted on ${m.name}`);

    // A rollout goes through the same list, preview and import on the helper.
    const rollouts = join(home, ".codex", "sessions");
    mkdirSync(rollouts, { recursive: true });
    const rollout = join(rollouts, `rollout-${sid(6)}.jsonl`);
    const records = [
      { type: "session_meta", payload: { id: sid(6), cwd: proj, source: "cli" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Codex fruit ${tag}` }] } },
    ];
    writeFileSync(rollout, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const base = `/api/fleet/machines/${m.id}/transcripts`;
    const list = await (await request.get(`${base}?harness=codex&q=${tag}&refresh=1`)).json();
    expect(list.sessions.map((f: any) => f.id)).toEqual([sid(6)]);
    const preview = await (await request.get(`${base}/preview?harness=codex&id=${sid(6)}`)).json();
    expect(preview.tail[0].text).toBe(`Codex fruit ${tag}`);
    const copyThere = await (await request.post(`${base}/import`, { data: { harness: "codex", id: sid(6), model: STAND_IN } })).json();
    made.push(copyThere.session.id);
    expect(copyThere.session).toMatchObject({ machine: m.id, workspace: proj });

    // ---- two originals at work: a child shell that stays quiet, and a job of its own
    const waited = harness(home, proj, sid(4), `Waited for ${tag}`, 30, 600);
    const cut = harness(home, proj, sid(5), `Resumed now ${tag}`, 600, 600);
    procs.push(waited, cut);
    sheet = await openSheet(page, m.name);
    const row = (id: string) => sheet.locator("div").filter({ has: page.locator(`[data-testid="import-row"][data-id="${id}"]`) }).last();
    const strip = row(sid(4)).getByTestId("original-strip");
    await expect(strip).toHaveAttribute("data-state", "active", { timeout: 30_000 });
    await expect(strip.getByTestId("strip-state")).toContainText("Active · 1 job, 1 call");
    await expect(row(sid(5)).getByTestId("original-strip")).toHaveAttribute("data-state", "active");
    const seen = await (await request.get(`/api/fleet/machines/${m.id}/transcripts/activity?harness=claude&id=${sid(5)}`)).json();
    expect(seen.in_flight.map((i: any) => i.kind)).toEqual(["job", "tool"]); // the job first
    const stale = await request.post(`${base}/resume`, { data: { harness: "claude", id: sid(5), when: "now", revision: "older-view" } });
    expect(stale.status()).toBe(409);
    expect(alive(cut)).toBe(true);
    procs.push(...seen.in_flight.map((i: any) => i.pid));
    // The job of the one waited for is left running by the wait: ended with the test.
    const kept = await (await request.get(`/api/fleet/machines/${m.id}/transcripts/activity?harness=claude&id=${sid(4)}`)).json();
    procs.push(...kept.in_flight.map((i: any) => i.pid));
    await shoot(page, "resume-02-active-rows");

    // ---- wait until idle: the deadline is shown, and it resumes once the shell has ended
    await strip.getByTestId("strip-wait").click();
    const card = sheet.getByTestId("resume-card");
    await expect(card.getByTestId("resume-state")).toContainText("still working on this");
    await expect(card.getByTestId("in-flight-item")).toHaveCount(2);
    await expect(card.getByTestId("resume-until")).toContainText(/until \d\d:\d\d/);
    await expect(card.getByTestId("jobs-keep")).toBeChecked();
    await shoot(page, "resume-03-wait-form");
    await card.getByTestId("resume-wait-go").click();
    await expect(card.getByTestId("resume-deadline")).toContainText(/Gives up at \d\d:\d\d/);
    await expect(strip).toHaveAttribute("data-state", "waiting");
    await expect(strip).toContainText(/gives up at \d\d:\d\d/);
    expect(alive(waited)).toBe(true);
    await shoot(page, "resume-04-waiting");
    await page.waitForURL((u) => u.pathname.startsWith("/s/") && !u.pathname.includes(made[0]!), { timeout: 90_000 });
    const afterWait = page.url().split("/s/")[1]!.split(/[/?#]/)[0]!;
    made.push(afterWait);
    // It finished its turn first: the copy holds its last words, and it is gone.
    await expect(page.getByTestId("assistant-text").last()).toContainText("The slow check passed.");
    await expect.poll(() => alive(waited), { timeout: 10_000 }).toBe(false);
    const told = (await notes(request, afterWait)).join("\n");
    expect(told).toContain("once it was idle");
    expect(told).toContain("background job, left running there");
    expect(kept.in_flight.filter((i: any) => i.kind === "job").every((i: any) => alive(i.pid))).toBe(true);
    await shoot(page, "resume-05-resumed-after-wait");

    // ---- a plain copy of a conversation still at work says so, in its transcript and on its page
    const plain = await (await request.post(`/api/fleet/machines/${m.id}/transcripts/import`, { data: { harness: "claude", id: sid(5) } })).json();
    made.push(plain.session.id);
    expect((await notes(request, plain.session.id)).join("\n")).toContain("the original still runs there: it is working (1 background job, 1 call running)");
    await page.goto(`/s/${plain.session.id}`);
    await expect(page.getByTestId("resume-card")).toHaveAttribute("data-state", "active", { timeout: 15_000 });
    await shoot(page, "resume-05b-copy-still-runs");

    // ---- a wait that reaches its deadline gives up and leaves the original running
    const short = await request.post(`/api/fleet/machines/${m.id}/transcripts/resume`, { data: { harness: "claude", id: sid(5), when: "idle", wait_ms: 1500 } });
    expect(short.status()).toBe(202);
    await expect.poll(async () => (await (await request.get(`/api/fleet/machines/${m.id}/transcripts/activity?harness=claude&id=${sid(5)}`)).json()).wait?.state, { timeout: 20_000 }).toBe("expired");
    expect(alive(cut)).toBe(true);

    // ---- resume now: what is in flight is listed, the job first, and the owner says what becomes of it
    sheet = await openSheet(page, m.name);
    await sheet.locator(`[data-testid="import-row"][data-id="${sid(5)}"]`).click();
    await expect(card.getByTestId("resume-expired")).toContainText("The wait gave up");
    await card.getByTestId("resume-now").click();
    const items = card.getByTestId("in-flight-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute("data-kind", "job");
    await expect(items.nth(0)).toContainText("bench.sh");
    await expect(items.nth(1)).toHaveAttribute("data-kind", "tool");
    await expect(items.nth(1)).toContainText("Run the slow check");
    await card.getByTestId("jobs-end").click();
    await shoot(page, "resume-06-resume-now");
    await card.getByTestId("resume-now-go").click();
    // The copy made before is the one that goes on: no second copy.
    await expect(sheet).toBeHidden({ timeout: 60_000 });
    const copy = plain.session.id as string;
    await expect(page).toHaveURL(new RegExp(copy));
    await expect(page.getByTestId("machine-chip")).toContainText(m.name);
    // The original, its shell and its job are ended; the copy has the same list in a note.
    await expect.poll(() => [cut, ...seen.in_flight.map((i: any) => i.pid)].filter(alive), { timeout: 10_000 }).toEqual([]);
    const note = (await notes(request, copy)).find((t) => t.includes("was ended"))!;
    expect(note).toContain(`on ${m.name} was ended (SIGTERM)`);
    expect(note).toContain("background job, ended with it");
    expect(note).toContain("call, interrupted");
    expect(note).toContain("sleep 600; echo checked > slow-check.out");
    expect(note.indexOf("background job")).toBeLessThan(note.indexOf("call, interrupted"));

    // ---- the copy goes on: its shell runs on that machine, in the conversation's folder
    await request.patch(`/api/sessions/${copy}`, { data: { model: STAND_IN } });
    await request.put(`/api/sessions/${copy}/permissions`, { data: { mode: "full-auto" } });
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: "cat fruit.txt && pwd && head -n 1 bench.log" } }])}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end").last()).toBeVisible({ timeout: 60_000 });
    const tool = page.locator('[data-tool="Bash"]').last();
    await expect(tool.getByTestId("tool-machine")).toHaveText(m.name);
    await tool.click();
    await expect(tool).toContainText(`quince-${tag}`);
    await expect(tool).toContainText(proj);
    await expect(tool).toContainText("round 0"); // what the original's job wrote there
    await shoot(page, "resume-07-goes-on-there");

    // Listed again, the resumed conversation shows as imported, with nothing running it.
    const again = await (await request.get(`/api/fleet/machines/${m.id}/transcripts?q=${tag}`)).json();
    const resumed = again.sessions.find((s: any) => s.id === sid(5));
    expect(resumed.imported.session_id).toBe(copy);
    expect(resumed.original).toBeUndefined();
    expect(again.sessions.map((s: any) => s.id)).not.toContain(sid(3));
    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    for (const pid of procs) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
    if (localCopy) await request.delete(`/api/sessions/${localCopy}`);
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    if (enabledHere) await request.delete(`/api/fleet/machines/${m.id}`);
    for (const n of [1, 2, 3, 4, 5]) for (const d of [proj, outside, join(root, ".ssh", tag)]) rmSync(join(home, ".claude", "projects", d.replace(/[^A-Za-z0-9]/g, "-"), `${sid(n)}.jsonl`), { force: true });
    rmSync(proj, { recursive: true, force: true });
    rmSync(join(home, ".codex", "sessions", `rollout-${sid(6)}.jsonl`), { force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(root, ".ssh", tag), { recursive: true, force: true });
  }
});
