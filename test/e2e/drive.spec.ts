import { expect, test, type APIRequestContext } from "./isolate.ts";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HAIKU, shoot, openPanel } from "./shots.ts";

// Feature: sessions elsewhere. A stand-in agent view lists four stand-in
// sessions (Claude Code and Codex, live and ended, one waiting on a prompt).
// The owner reads them in the Elsewhere panel, sends a message, sees a send
// held while a prompt is open and answers the prompt. A model drives them
// through the deferred tools: an ordinary send goes through, a send into the
// open prompt is refused before any card, and a shell line asks the owner
// even in full auto.
const dir = join(tmpdir(), `keel-drive-e2e-${Date.now()}`);
const stateFile = join(dir, "state.json");
const now = Date.now() / 1000;
const transcript = join(dir, "claude.jsonl");

function seed() {
  mkdirSync(dir, { recursive: true });
  writeFileSync(transcript, [
    { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Add a health route to the API" } },
    { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/routes/health.ts" } }] } },
    { type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Added **GET /health**. It returns the build id." }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const row = (o: object) => ({ host: "", stale: false, source: "claude", detail: "", hold: "", hold_until: 0, job: "", thread: "", session: "", pane: "", model: "", cwd: "/work/api", t: now - 60, last: now - 60, ...o });
  writeFileSync(stateFile, JSON.stringify({
    agents: [
      row({ tool: "claude", name: "api-worker", session: "s-api", live: true, state: "idle", label: "idle", model: "claude-sonnet", transcript }),
      row({ tool: "codex", name: "migrate", thread: "t-mig", live: true, state: "working", label: "working", detail: "running the schema migration", cwd: "/work/db", source: "" }),
      row({ tool: "claude", name: "deploy-check", session: "s-dep", live: true, state: "needs_input", label: "waiting", detail: "Bash requests permission", cwd: "/work/deploy", t: now - 5, last: now - 5 }),
      row({ tool: "codex", name: "old-thread", thread: "t-old", live: false, state: "ended", label: "ended", cwd: "/work/old", t: now - 7200, last: now - 7200 }),
    ],
    prompts: { "s-dep": { id: "req1", kind: "permission", title: "Bash requests permission", body: "rm -rf build", native: true, choices: [{ value: "allow", label: "Allow once" }, { value: "deny", label: "Reject" }] } },
    screens: { "t-mig": ["› migrate the schema", "• Running bun run migrate", "  applied 3 of 5 migrations"] },
    queue: [],
    answers: [],
  }, null, 2));
  const wrapper = join(dir, "agent-view");
  writeFileSync(wrapper, `#!/bin/sh\nexec bun ${resolve("test/e2e/fixtures/agent-view.ts")} ${stateFile} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));

const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

test("sessions elsewhere: list, read, send, held while a prompt is open", async ({ page, request }) => {
  const before = (await (await request.get("/api/fleet/outside/settings")).json()).agent_view;
  const wrapper = seed();
  await request.put("/api/fleet/outside/settings", { data: { agent_view: wrapper } });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Driver" } })).json();
  try {
    // List, grouped by what each needs.
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "elsewhere");
    const panel = page.getByTestId("elsewhere-panel");
    await expect(panel.getByTestId("elsewhere-row")).toHaveCount(4);
    await expect(panel.getByTestId("elsewhere-group-waiting")).toContainText("deploy-check");
    await expect(panel.getByTestId("elsewhere-group-ended")).toContainText("old-thread");
    await shoot(page, "drive-01-list");

    // Read a transcript and send a message.
    await panel.locator('[data-id="claude:s-api"]').click();
    const detail = page.getByTestId("elsewhere-detail");
    await expect(detail.getByTestId("elsewhere-read")).toContainText("Added GET /health");
    await expect(detail.getByTestId("elsewhere-read")).toContainText("Edit src/routes/health.ts");
    await detail.getByTestId("elsewhere-input").fill("Also add a readiness route");
    await detail.getByTestId("elsewhere-send").click();
    await expect(detail.getByTestId("elsewhere-note")).toContainText("Delivered to api-worker");
    expect(state().queue).toEqual([{ id: "r1", key: "s-api", body: "Also add a readiness route" }]);
    await detail.getByTestId("elsewhere-input").fill("/compact");
    await expect(detail.getByTestId("elsewhere-warn")).toContainText("runs as a command");
    await shoot(page, "drive-02-read-send");
    await detail.getByTestId("elsewhere-input").fill("");

    // A session waiting on a prompt: the send is held, here and on the server.
    await detail.getByLabel("Back to the list").click();
    await panel.locator('[data-id="claude:s-dep"]').click();
    await expect(detail.getByTestId("elsewhere-prompt")).toContainText("rm -rf build");
    await expect(detail.getByTestId("elsewhere-held")).toBeVisible();
    await expect(detail.getByTestId("elsewhere-send")).toBeDisabled();
    const held = await request.post(`/api/fleet/outside/${encodeURIComponent("claude:s-dep")}`, { data: { action: "send", text: "go on" } });
    expect(held.status()).toBe(409);
    expect((await held.json()).error).toContain("waits on a prompt");
    expect(state().queue).toHaveLength(1);
    await shoot(page, "drive-03-held");

    // The owner answers it; the session is free again.
    await detail.getByTestId("elsewhere-choice").filter({ hasText: "Reject" }).click();
    await expect(detail.getByTestId("elsewhere-note")).toContainText("Answered deny");
    expect(state().answers).toEqual([{ key: "s-dep", id: "req1", choice: "deny" }]);
    await expect(detail.getByTestId("elsewhere-prompt")).toHaveCount(0);

    // A screen read for a session without a transcript.
    await detail.getByLabel("Back to the list").click();
    await panel.locator('[data-id="codex:t-mig"]').click();
    await expect(detail.getByTestId("elsewhere-screen")).toContainText("applied 3 of 5 migrations");

    // A model drives: an ordinary send goes through in full auto; a send into
    // an open prompt is refused before any card; a shell line asks the owner.
    const s2 = state();
    s2.prompts["s-dep"] = { id: "req2", kind: "permission", title: "Bash requests permission", body: "git push", native: true, choices: [{ value: "allow", label: "Allow once" }, { value: "deny", label: "Reject" }] };
    writeFileSync(stateFile, JSON.stringify(s2));
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    const say = (text: string) => request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    // Claude loads a deferred tool with ToolSearch, then calls it by name.
    const call = (to: string, text: string) => `Load keel__session_message with ToolSearch (query "select:keel__session_message"), then call it exactly once with {"to":"${to}","text":"${text}"}. Then reply with the tool's result word for word.`;
    await say(call("codex:t-mig", "status please"));
    await turnsDone(request, session.id, 1);
    expect(state().queue.at(-1)).toMatchObject({ key: "t-mig", body: "status please" });
    await say(call("claude:s-dep", "go on"));
    await turnsDone(request, session.id, 2);
    const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
    const results = events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
    expect(JSON.stringify(results.at(-1).content)).toContain("NOT_SENT");
    expect(state().queue).toHaveLength(2);
    expect((await (await request.get(`/api/sessions/${session.id}/approvals?all`)).json()).approvals).toHaveLength(0);

    await say(call("codex:t-mig", "!ls"));
    await expect(page.getByTestId("approval")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("approval")).toHaveAttribute("data-risk", "high");
    await expect(page.getByTestId("approval-summary")).toContainText("!ls");
    await shoot(page, "drive-04-owner-card");
    await page.getByTestId("deny").click();
    await page.getByTestId("deny-send").click();
    await turnsDone(request, session.id, 3);
    expect(state().queue).toHaveLength(2);
  } finally {
    await request.put("/api/fleet/outside/settings", { data: { agent_view: before ?? "" } });
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
    await request.delete(`/api/sessions/${session.id}`);
  }
});
