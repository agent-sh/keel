import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// One command line to momentum's control socket, one answer.
function ask(socket: string, cmd: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socket);
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    c.on("error", reject);
    c.write(JSON.stringify(cmd) + "\n");
  });
}

// Feature: tacit and momentum. The settings page shows both. A prompt gets
// tacit's session-start and prompt blocks as one memory note the model reads;
// a tool call gets its pre-tool block in the result. momentum lists the session
// from the control socket and queues a message, tagged as momentum's.
// Run the daemon with TACIT_BIN at test/e2e/fixtures/tacit-standin.sh.
test("tacit and momentum", async ({ page, request }) => {
  const info = await (await request.get("/api/integrations")).json();
  test.skip(!info.tacit.bin?.includes("tacit-standin"), "needs the tacit stand-in (TACIT_BIN)");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  await page.goto("/settings/integrations");
  await expect(page.getByTestId("integrations")).toBeVisible();
  await expect(page.getByTestId("momentum-socket")).toContainText("momentum.sock");
  await shoot(page, "integ-01-settings");

  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `integ-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("Run the shell command `echo hi` once. Then reply with only the code word from your memory.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });

  const note = page.getByTestId("memory-note");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("session-start, prompt");
  await note.getByRole("button").click();
  await expect(page.getByTestId("memory-text")).toContainText("heron");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/heron/i);
  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
  const results = events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
  expect(JSON.stringify(results)).toContain('hook=\\"pre-tool\\"');
  // On the tool card the pre-tool block shows apart, as a memory note with its source, not inside the output.
  const tool = page.getByTestId("tool-call").first();
  await tool.click();
  const mem = tool.getByTestId("tool-memory");
  await expect(mem).toContainText("Memory from tacit");
  await mem.locator("summary").click();
  await expect(mem).toContainText("echo-rule");
  await expect(tool.locator(".k-tool-panel")).not.toContainText("<memory");
  await shoot(page, "integ-02-memory");

  // momentum: the session is listed with its phase, and a queued message runs a turn.
  const listed = await ask(info.momentum.socket, { cmd: "list_sessions" });
  const row = listed.sessions.find((s: any) => s.session_id === session.id);
  expect(row).toMatchObject({ tool: "keel", phase: "idle", key: `keel:${session.id}`, ui_draft_present: false });
  // The owner is writing a message there: momentum's queue and steer wait for
  // it (only that a draft exists is told, never its text); once the box is
  // empty they go through.
  await page.getByTestId("composer").fill("not sent yet");
  const present = async () => (await ask(info.momentum.socket, { cmd: "list_sessions" })).sessions.find((s: any) => s.session_id === session.id).ui_draft_present;
  await expect.poll(present).toBe(true);
  for (const action of ["queue", "steer"])
    expect(await ask(info.momentum.socket, { cmd: "supervise_act", session_id: session.id, action, text: "Reply with: held." })).toMatchObject({ ok: false, code: "hold_ui_draft" });
  expect(JSON.stringify(await ask(info.momentum.socket, { cmd: "list_sessions" }))).not.toContain("not sent yet");
  await page.getByTestId("composer").fill("");
  await expect.poll(present).toBe(false);
  expect(await ask(info.momentum.socket, { cmd: "supervise_act", session_id: session.id, action: "queue", text: "   " })).toMatchObject({ ok: false, code: "empty_text" });
  expect(await ask(info.momentum.socket, { cmd: "supervise_act", session_id: session.id, action: "queue", text: "Reply with the single word: done." })).toMatchObject({ ok: true });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByText("[momentum] Reply with the single word: done.")).toBeVisible();
  // The second prompt asked tacit again, without a second session-start.
  await expect(note).toHaveCount(2);
  await expect(note.last()).not.toContainText("session-start");
  await shoot(page, "integ-03-momentum");

  // Memory use is fixed once the session has a message.
  expect((await request.patch(`/api/sessions/${session.id}/memory`, { data: { use_memory: false } })).status()).toBe(409);
  const momentum = await (await request.get("/api/momentum")).json();
  expect(typeof momentum.available).toBe("boolean");
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
