import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const HOOK = join(import.meta.dirname, "fixtures/hook.sh");
const scripted = HAIKU.startsWith("scripted:");
const calls = (...commands: string[]) => `script:calls ${JSON.stringify(commands.map((command) => ({ name: "Bash", input: { command } })))}`;

// A repository of its own under the scratch home, with a hooks file the owner pins in Settings.
// `beforePin`: what the test looks at on the page the owner reads before pinning.
async function pinned(page: any, request: any, hooks: Record<string, unknown>, beforePin?: () => Promise<void>) {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `hooks-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(ws, ".keel"), { recursive: true });
  writeFileSync(join(ws, ".keel/hooks.json"), JSON.stringify({ hooks }, null, 1));
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto("/settings/hooks");
  const project = page.locator(`[data-testid="hook-source"][data-scope="project"]`).filter({ hasText: ws.split("/").pop()! });
  await expect(project).toHaveAttribute("data-active", "false");
  await project.click();
  await beforePin?.();
  await page.getByTestId("hook-pin").click();
  await expect(project).toHaveAttribute("data-active", "true");
  return { ws, id: session.id as string };
}

// Feature: a PreToolUse hook changes a call's input and allows it. The changed
// input is the one that is judged and runs. The allow answers only the card
// the owner would have got for a call inside the session's own scope: an edit
// moved to another file of the workspace runs without a card; a changed
// command that no sandbox confines still asks, with the changed command on the
// card; a high-risk one always asks. The transcript shows what ran and what
// the model asked for, and the model reads what was judged on the result.
test("a hook changes a call's input and allows it", async ({ page, request }) => {
  test.skip(!scripted, "needs the scripted model: the calls are given exactly");
  const { ws, id } = await pinned(page, request, { PreToolUse: [{ matcher: "Bash|Write", hooks: [{ type: "command", command: `${HOOK} rewrite` }] }] });
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${id}`);
  const asked = join(ws, "asked-by-model.txt");
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Write", input: { file_path: asked, content: "from the model" } }])}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  // The changed edit ran, with no card: the hook's file is there and the model's is not.
  expect(readFileSync(join(ws, "hook-made.txt"), "utf8")).toBe("from the hook");
  expect(existsSync(asked)).toBe(false);
  const call = page.getByTestId("tool-call").first();
  await expect(call).toHaveAttribute("data-state", "ok");
  await expect(call).toContainText("hook-made.txt");
  await expect(call.getByTestId("tool-rewritten")).toBeVisible();
  await expect(call.getByTestId("tool-asked")).toContainText("asked-by-model.txt");
  await expect(call.getByTestId("tool-hook-allowed")).toContainText("edits in this repository are fine");
  await shoot(page, "hook-events-01-rewritten");
  const events = async () => (await (await request.get(`/api/sessions/${id}`)).json()).events;
  const results = async () => JSON.stringify((await events()).filter((e: any) => e.kind === "tool_result"));
  expect(await results()).toContain("It ran with:");
  expect(await results()).toContain("hook-made.txt");
  // The history keeps what the model wrote.
  expect(JSON.stringify((await events()).filter((e: any) => e.kind === "assistant"))).toContain("asked-by-model.txt");

  // A command changed by the hook, with nothing to confine it: the allow does not answer for it. The card shows the changed command.
  const card = page.getByTestId("approval");
  await page.getByTestId("composer").fill(calls("echo asked-by-model-cmd"));
  await page.keyboard.press("Enter");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("touch hook-made-by-command.txt");
  await expect(card).toContainText("The model asked for: echo asked-by-model-cmd");
  expect(existsSync(join(ws, "hook-made-by-command.txt"))).toBe(false);
  await shoot(page, "hook-events-02-command-still-asks");
  await card.getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  expect(existsSync(join(ws, "hook-made-by-command.txt"))).toBe(true);

  // Changed into a high-risk command: it asks, and the refusal tells the model what was judged without saying it ran.
  await page.getByTestId("composer").fill(calls("echo asked-by-model-high"));
  await page.keyboard.press("Enter");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText("sudo rm -rf /var/lib/hook-e2e-thing");
  await expect(card).toContainText("The model asked for: echo asked-by-model-high");
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-send").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("tool-call").nth(2).getByTestId("tool-asked")).toHaveText("echo asked-by-model-high");
  expect(await results()).toContain("It did not run. The input that was judged:");
});

// Feature: a hook that runs into its time limit is the hook's, not the tool's.
// The call runs and passes; under it the transcript says the hook timed out,
// and the timeline's row says so in the same words (it read "Tool error").
test("a hook's time limit is said as the hook's, under the call and in the timeline", async ({ page, request }) => {
  test.skip(!scripted, "needs the scripted model: the calls are given exactly");
  const { id } = await pinned(page, request, { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "sleep 5", timeout: 1 }] }] });
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${id}`);
  await page.getByTestId("composer").fill(calls("echo hook-slow-ran"));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  const call = page.getByTestId("tool-call").first();
  await expect(call).toHaveAttribute("data-state", "ok");
  await expect(call.getByTestId("tool-hook-failed")).toHaveText(/timed out \(PreToolUse, 1 s\): sleep 5/);
  await shoot(page, "hook-events-04-timed-out");
  const story = await (await request.get(`/api/sessions/${id}/timeline?format=text`)).text();
  expect(story).toContain("Hook timed out (PreToolUse, 1 s): sleep 5");
  expect(story).not.toContain("Tool error");
});

// Every event Keel fires, named in one pinned hooks file.
const FIRED = [
  "SessionStart", "Stop", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "UserPromptExpansion", "PreToolUse", "StopFailure",
  "SubagentStop", "SessionEnd", "PermissionRequest", "PreCompact", "SubagentStart", "PostCompact", "Notification", "PermissionDenied",
  "PostToolBatch", "Interrupt", "PreModelRequest", "PostModelRequest",
];

// Feature: the hook events of the owner's other setups fire in Keel. A hooks
// file that names all of them loads with no problem, and one session's life
// (prompts, calls that run, fail, are refused or ask, a subagent, a slash
// command, a compaction, an error, a stop, its archiving) reaches the hook of
// each, with the fields its documentation names.
test("every hook event fires", async ({ page, request }) => {
  test.skip(!scripted, "needs the scripted model: the calls are given exactly");
  test.setTimeout(240_000);
  const { ws, id } = await pinned(page, request, Object.fromEntries(FIRED.map((e) => [e, [{ hooks: [{ type: "command", command: `${HOOK} log ${e}` }] }]])));
  const source = (await (await request.get(`/api/hooks?cwd=${encodeURIComponent(ws)}`)).json()).sources.find((s: any) => s.scope === "project");
  expect(source.problems).toEqual([]);
  expect(source.notes).toEqual([]);
  expect(Object.keys(source.events).sort()).toEqual([...FIRED].sort());
  await page.getByTestId("hook-source").filter({ hasText: ws.split("/").pop()! }).click();
  // The script its commands run sits outside .keel/: the page says the pin does not hold it.
  await expect(page.getByTestId("hook-unheld")).toContainText("fixtures/hook.sh");
  await shoot(page, "hook-events-03-every-event-pinned");

  mkdirSync(join(ws, ".claude/commands"), { recursive: true });
  writeFileSync(join(ws, ".claude/commands/greet.md"), "Say hello to $ARGUMENTS.\n");
  const given = (event: string): any[] => {
    const dir = join(ws, ".hook-seen");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.startsWith(`${event}.`)).flatMap((f) => { try { return [JSON.parse(readFileSync(join(dir, f), "utf8"))]; } catch { return []; } });
  };
  const fired = (event: string, n = 1) => expect.poll(() => given(event).length, { timeout: 30_000, message: `${event} fired` }).toBe(n);
  // The turn that answers a prompt has ended (a subagent's report may start a turn of its own in between).
  const ended = (text: string) => expect.poll(async () => {
    const events = (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
    const at = events.findLastIndex((e) => e.kind === "user" && String(e.data.text ?? "").startsWith(text.slice(0, 60)));
    return at >= 0 && events.slice(at).some((e) => e.kind === "turn_end");
  }, { timeout: 60_000, message: `the turn of "${text.slice(0, 40)}" ended` }).toBe(true);
  const say = async (text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await ended(text); };
  const mode = (m: string) => request.put(`/api/sessions/${id}/permissions`, { data: { mode: m, sandbox: "off" } });

  // A turn with a call that runs and one that fails.
  await mode("full-auto");
  await say(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo ok" } }, { name: "Read", input: { file_path: "/nonexistent/hook-e2e.txt" } }])}`);
  await fired("SessionStart");
  expect(given("SessionStart")[0]).toMatchObject({ session_id: id, cwd: ws, hook_event_name: "SessionStart", source: "startup", permission_mode: "bypassPermissions" });
  await fired("UserPromptSubmit");
  await fired("PreToolUse", 2);
  await fired("PostToolUse");
  expect(given("PostToolUse")[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "echo ok" } });
  await fired("PostToolUseFailure");
  expect(given("PostToolUseFailure")[0]).toMatchObject({ tool_name: "Read", is_interrupt: false });
  await fired("PostToolBatch", 2);
  await fired("Stop");
  expect(given("Stop")[0]).toMatchObject({ stop_hook_active: false });
  await fired("PreModelRequest", 3);
  await fired("PostModelRequest", 3);

  // A subagent that runs one turn and reports.
  await say(`script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: "A child task.\nscript:calls []", isolation: "none", background: false } }])}`);
  await fired("SubagentStart");
  await fired("SubagentStop");
  expect(given("SubagentStart")[0]).toMatchObject({ session_id: id, agent_type: "general-purpose" });
  expect(given("SubagentStop")[0].agent_id).toBe(given("SubagentStart")[0].agent_id);

  // A high-risk call in Auto: no judge model answers here, so it is refused without the owner.
  // (Full auto checks nothing: there it would run.)
  await mode("auto");
  await say(calls("sudo rm -rf /var/lib/hook-e2e-thing"));
  await fired("PermissionDenied");
  expect(given("PermissionDenied")[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "sudo rm -rf /var/lib/hook-e2e-thing" } });

  // A call that asks: the card's hooks run before it opens, and the owner is notified.
  await mode("ask");
  await page.goto(`/s/${id}`);
  const asking = calls("touch needs-a-card.txt");
  await request.post(`/api/sessions/${id}/messages`, { data: { text: asking } });
  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await fired("PermissionRequest");
  expect(given("PermissionRequest")[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "touch needs-a-card.txt" }, permission_mode: "default", keel_risk: "low" });
  await expect.poll(() => given("Notification").some((n) => n.notification_type === "permission_prompt"), { timeout: 30_000 }).toBe(true);
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-send").click();
  await ended(asking);

  // A slash command the owner runs.
  await mode("full-auto");
  expect((await request.post(`/api/sessions/${id}/skill`, { data: { name: "greet", args: "the crew" } })).status()).toBe(201);
  await ended("/greet the crew");
  await fired("UserPromptExpansion");
  expect(given("UserPromptExpansion")[0]).toMatchObject({ expansion_type: "slash_command", command_name: "greet", command_args: "the crew", prompt: expect.stringContaining("Say hello to the crew.") });

  // The owner compacts; the session starts again for the next prompt. (The turn's end is stored
  // before its hooks have run and the engine lets the session go: a compaction is refused until then.)
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).running, { timeout: 30_000 }).toBe(false);
  expect((await request.post(`/api/sessions/${id}/compact`, { data: { focus: "the greeting" } })).ok()).toBe(true);
  await fired("PreCompact");
  await fired("PostCompact");
  expect(given("PreCompact")[0]).toMatchObject({ trigger: "manual", custom_instructions: "the greeting" });
  expect(given("PostCompact")[0].compact_summary.length).toBeGreaterThan(0);
  await say("And after the summary?");
  await fired("SessionStart", 2);
  expect(given("SessionStart").map((x) => x.source).sort()).toEqual(["compact", "startup"]);

  // A turn that ends in an error, and one the owner stops.
  await say("refuse-this-prompt");
  await fired("StopFailure");
  expect(given("StopFailure")[0]).toMatchObject({ error: "unknown", error_details: expect.stringContaining("this prompt is refused") });
  const held = calls("sleep 60");
  const before = given("PreToolUse").length;
  await request.post(`/api/sessions/${id}/messages`, { data: { text: held } });
  await fired("PreToolUse", before + 1); // the command is under way
  await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
  await ended(held);
  await fired("Interrupt");

  // The session is archived: it ended, once.
  await request.patch(`/api/sessions/${id}`, { data: { archived: true } });
  await fired("SessionEnd");
  expect(given("SessionEnd")[0]).toMatchObject({ session_id: id, reason: "other" });
  // Once each for what happens once in this session's life.
  for (const e of ["SubagentStart", "SubagentStop", "PermissionDenied", "PermissionRequest", "UserPromptExpansion", "PreCompact", "PostCompact", "StopFailure", "Interrupt", "SessionEnd", "PostToolUseFailure"]) expect(given(e).length, e).toBe(1);
  for (const e of FIRED) expect(given(e).length, e).toBeGreaterThan(0);
});

// Feature: a hook that is not a shell command. An http hook's handler is a URL:
// the event is posted to it as JSON, and a JSON answer is the hook's answer.
test("an http hook receives the event at a local sink", async ({ page, request }) => {
  test.skip(!scripted, "needs the scripted model: the calls are given exactly");
  const got: { path: string; type: string; body: any }[] = [];
  const sink = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text);
      got.push({ path: String(req.url), type: String(req.headers["content-type"]), body });
      if (req.url !== "/pre" || !String(body.tool_input?.command).includes("blocked-by-the-sink")) return void res.end();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the sink refused it" } }));
    });
  });
  await new Promise<void>((done) => sink.listen(0, "127.0.0.1", done));
  const at = `http://127.0.0.1:${(sink.address() as { port: number }).port}`;
  try {
    // Before the pin the page names each URL and what goes to it, as a line of its own, and shows the whole file.
    const { ws, id } = await pinned(page, request, {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "http", url: `${at}/pre` }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "http", url: `${at}/post` }] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "Is the work done?" }] }],
    }, async () => {
      const sends = page.getByTestId("hook-sends");
      await expect(sends).toHaveCount(2);
      await expect(sends.first()).toContainText(`Sends your prompts, tool inputs and tool results to ${at.replace("http://", "")}`);
      await expect(sends.first()).toContainText(`${at}/pre`);
      // A handler Keel does not run is a note on a file that loads, not a problem of it.
      await expect(page.getByTestId("hook-notes")).toContainText("prompt hooks are read and not run");
      await shoot(page, "hook-events-04-http-before-pin");
    });
    const source = (await (await request.get(`/api/hooks?cwd=${encodeURIComponent(ws)}`)).json()).sources.find((s: any) => s.scope === "project");
    expect(source.problems).toEqual([]);
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await page.goto(`/s/${id}`);
    await page.getByTestId("composer").fill(calls("echo to-the-sink", "echo blocked-by-the-sink"));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
    // The sink got both calls before they ran and the one that ran after it, as JSON with the event's fields.
    const pre = got.filter((g) => g.path === "/pre"), post = got.filter((g) => g.path === "/post");
    expect(pre.map((g) => g.body.tool_input.command)).toEqual(["echo to-the-sink", "echo blocked-by-the-sink"]);
    expect(pre[0]).toMatchObject({ type: "application/json", body: { session_id: id, cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "bypassPermissions" } });
    expect(post.length).toBe(1);
    expect(post[0]!.body).toMatchObject({ hook_event_name: "PostToolUse", tool_input: { command: "echo to-the-sink" }, tool_response: expect.stringContaining("to-the-sink") });
    // The sink's answer refused the second call.
    await expect(page.getByTestId("tool-call").nth(1)).toHaveAttribute("data-state", "error");
    const results = JSON.stringify((await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "tool_result"));
    expect(results).toContain("A hook blocked this call: the sink refused it");
    await page.getByTestId("tool-call").nth(1).click();
    await shoot(page, "hook-events-05-http-sink");
  } finally {
    sink.close();
  }
});
