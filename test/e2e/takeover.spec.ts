import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: taking over a session another harness runs. A stand-in agent view
// runs three stand-in Claude Code sessions, each with its transcript. The
// owner takes over an idle one from the Elsewhere panel: it is ended where it
// ran and its last words land in the Keel copy. One at work is only copied:
// the copy says its original still runs, and Take over now finishes it once it
// is idle. A model asks to take one over: only the owner allows it, even in
// full auto, and an agent view that cannot end it gives the one step to take.
const dir = join(tmpdir(), `keel-takeover-e2e-${Date.now()}`);
const stateFile = join(dir, "state.json");
const now = Date.now() / 1000;

function transcript(sid: string, prompt: string, reply: string) {
  const path = join(dir, `${sid}.jsonl`);
  const at = new Date().toISOString();
  const rec = (uuid: string, parentUuid: string | null, type: string, content: unknown) =>
    ({ uuid, parentUuid, type, sessionId: sid, cwd: dir, timestamp: at, message: { role: type, content, ...(type === "assistant" ? { id: `m-${uuid}`, model: "claude-stand-in" } : {}) } });
  writeFileSync(path, [rec(`${sid}-1`, null, "user", prompt), rec(`${sid}-2`, `${sid}-1`, "assistant", [{ type: "text", text: reply }])].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const last = rec(`${sid}-3`, `${sid}-2`, "assistant", [{ type: "text", text: `Closing ${sid}: the work is saved.` }]);
  return { path, last };
}

function seed() {
  mkdirSync(dir, { recursive: true });
  const api = transcript("s-api", "Add a health route", "Added GET /health.");
  const dep = transcript("s-dep", "Check the deploy", "Watching the rollout.");
  const cron = transcript("s-cron", "Rotate the logs", "Rotated.");
  const row = (o: object) => ({ host: "", stale: false, source: "claude", detail: "", hold: "", hold_until: 0, job: "", thread: "", pane: "", model: "claude-stand-in", cwd: dir, t: now - 60, last: now - 60, tool: "claude", live: true, state: "idle", label: "idle", ...o });
  writeFileSync(stateFile, JSON.stringify({
    agents: [
      row({ name: "api-worker", session: "s-api", transcript: api.path }),
      row({ name: "deploy-check", session: "s-dep", transcript: dep.path, state: "working", label: "working", hold: "waiting on 2 subagents" }),
      row({ name: "log-rotor", session: "s-cron", transcript: cron.path, no_stop: true }),
    ],
    prompts: {}, screens: {}, queue: [], answers: [],
    last: { "s-api": [api.last], "s-dep": [dep.last], "s-cron": [cron.last] },
  }, null, 2));
  const wrapper = join(dir, "agent-view");
  writeFileSync(wrapper, `#!/bin/sh\nexec bun ${resolve("test/e2e/fixtures/agent-view.ts")} ${stateFile} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const edit = (f: (s: any) => void) => { const s = state(); f(s); writeFileSync(stateFile, JSON.stringify(s)); };

const confirm = async (page: Page) => {
  await expect(page.getByTestId("confirm")).toBeVisible();
  await page.getByTestId("confirm").getByRole("button", { name: "Take over" }).click();
};
const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

test("take over a running session: ended where it ran, or copied with the one step", async ({ page, request }) => {
  const before = (await (await request.get("/api/fleet/outside/settings")).json()).agent_view;
  const wrapper = seed();
  await request.put("/api/fleet/outside/settings", { data: { agent_view: wrapper } });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Driver" } })).json();
  const made: string[] = [session.id];
  try {
    // The owner takes over an idle session from the Elsewhere panel.
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "elsewhere");
    await page.getByTestId("elsewhere-panel").locator('[data-id="claude:s-api"]').click();
    await page.getByTestId("elsewhere-takeover").click();
    await expect(page.getByTestId("confirm")).toBeVisible();
    await shoot(page, "takeover-01-confirm");
    await confirm(page);
    await expect(page).not.toHaveURL(new RegExp(session.id));
    made.push(page.url().split("/s/")[1]!);
    await expect(page.getByTestId("assistant-text").last()).toContainText("Closing s-api: the work is saved.");
    expect(state().stopped).toEqual(["s-api"]);
    await expect(page.getByTestId("live-source")).toHaveCount(0);
    await shoot(page, "takeover-02-taken");

    // One at work is copied, not ended: the copy says its original still runs.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await page.keyboard.press("Enter");
    const running = page.getByTestId("import-running");
    await expect(running.getByTestId("import-running-row")).toHaveCount(2);
    await shoot(page, "takeover-03-running");
    await running.locator('[data-id="claude:s-dep"]').getByTestId("import-takeover").click();
    await confirm(page);
    await expect(page.getByTestId("live-source")).toContainText("The original still runs in Claude Code");
    const copy = page.url().split("/s/")[1]!;
    made.push(copy);
    const origin = await (await request.get(`/api/sessions/${copy}/origin`)).json();
    expect(origin.origin.live_source.id).toBe("claude:s-dep");
    const notes = (await (await request.get(`/api/sessions/${copy}`)).json()).events.filter((e: any) => e.kind === "note" && e.data.kind === "takeover");
    expect(notes.at(-1).data.text).toContain("waiting on 2 subagents");
    expect(state().stopped).toEqual(["s-api"]);
    await shoot(page, "takeover-04-still-runs");

    // Once it is idle, Take over now ends it and the copy gets its last words.
    edit((s) => Object.assign(s.agents[1], { state: "idle", label: "idle", hold: "" }));
    await page.getByTestId("take-over-now").click();
    await confirm(page);
    await expect(page.getByTestId("live-source")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("Closing s-dep: the work is saved.");
    expect(state().stopped).toEqual(["s-api", "s-dep"]);

    // An Antigravity conversation, found in its store by its id (only a scratch store is written).
    const first = await (await request.get("/api/import/sessions?limit=1")).json();
    const agyHome = first.harnesses.find((h: any) => h.harness === "agy")?.store as string | undefined;
    if (agyHome?.includes("keel-work")) {
      const id = `a7a7a7a7-0000-4000-8000-${String(Date.now()).slice(-12)}`;
      // The fixture writes SQLite, so it runs under Bun.
      execFileSync("bun", ["-e", `import { agySession } from ${JSON.stringify(resolve("test/e2e/fixtures/import-stores.ts"))}; agySession(${JSON.stringify(agyHome)}, ${JSON.stringify(dir)}, ${JSON.stringify(id)}, "Fanad");`]);
      edit((s) => s.agents.push({ host: "", stale: false, source: "", detail: "", hold: "", hold_until: 0, job: "", thread: "", pane: "", model: "", cwd: dir, t: now - 30, last: now - 30, tool: "agy", name: "lighthouse", session: id, live: true, state: "idle", label: "idle" }));
      await page.goto(`/s/${session.id}`);
      await openPanel(page, "elsewhere");
      await page.getByTestId("elsewhere-panel").locator(`[data-id="agy:${id}"]`).click();
      await page.getByTestId("elsewhere-takeover").click();
      await confirm(page);
      await expect(page).not.toHaveURL(new RegExp(session.id));
      made.push(page.url().split("/s/")[1]!);
      await expect(page.getByTestId("assistant-text").last()).toContainText("The lighthouse is Fanad.");
      expect(state().stopped).toEqual(["s-api", "s-dep", id]);
    }

    // A model asks: a card only the owner answers, even in full auto. This
    // agent view has no stop, so the copy comes back with the one step to take.
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await page.goto(`/s/${session.id}`);
    await request.post(`/api/sessions/${session.id}/messages`, {
      data: { text: 'Load keel__session_import with ToolSearch (query "select:keel__session_import"), then call it exactly once with {"id":"claude:s-cron","take_over":true}. Then reply with the tool\'s result word for word.' },
    });
    await expect(page.getByTestId("approval")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("approval")).toHaveAttribute("data-risk", "high");
    await expect(page.getByTestId("approval-summary")).toContainText('take over the claude session "log-rotor"');
    await shoot(page, "takeover-05-owner-card");
    await page.getByTestId("allow-once").click();
    await turnsDone(request, session.id, 1);
    const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
    const result = JSON.stringify(events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).at(-1).content);
    expect(result).toContain("Type /exit in its terminal");
    expect(state().stopped).not.toContain("s-cron");
    const cronCopy = /Keel copied \\"log-rotor\\" as session ([\w-]+)/.exec(result)?.[1];
    if (cronCopy) made.push(cronCopy);
  } finally {
    await request.put("/api/fleet/outside/settings", { data: { agent_view: before ?? "" } });
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
