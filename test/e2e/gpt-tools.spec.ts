import { expect, test, type APIRequestContext } from "./isolate.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, SCRIPTED, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;
// A 32x32 PNG, all one red.
const RED = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IyJCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJ3LED3QqzauAAAAAElFTkSuQmCC";
const STAND_IN = "scripted:gpt-stand-in";
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;

// The GPT model of the run: KEEL_TEST_GPT_MODEL, else the scripted GPT
// stand-in on a scripted run (it is offered Codex's tools and loads them as
// the Responses wire does), else the first GPT model the ChatGPT sign-in lists.
async function gptModel(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; family: string; provider: string }[];
  return process.env.KEEL_TEST_GPT_MODEL ?? (SCRIPTED ? models.find((m) => m.id === STAND_IN)?.id : models.find((m) => m.family === "gpt" && m.provider === "chatgpt")?.id);
}
const workspace = (name: string) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
const resultTexts = (e: any) => (e.data.results as any[]).map((r) => (typeof r.content === "string" ? r.content : (r.content ?? []).map((c: any) => c.text ?? "").join("\n")) as string);

// Feature: GPT's own tools on the Responses wire. The model finds an MCP tool
// with its client tool_search (the server's tools load as the namespace
// mcp__echo) and calls it there; view_image puts a local image in its context.
test("gpt tools: tool_search loads an MCP namespace, view_image", async ({ page, request }) => {
  const model = await gptModel(request);
  test.skip(!model, "no GPT model on a Responses route (run on the scripted provider, sign in to ChatGPT or set KEEL_TEST_GPT_MODEL)");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.delete("/api/mcp/servers/echo").catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: "echo", command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
  const ws = workspace("gpt");
  writeFileSync(join(ws, "swatch.png"), Buffer.from(RED, "base64"));
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model, title: "GPT tools" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const ends = async (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);
  const called = async () => (await events(request, session.id))
    .filter((e: any) => e.kind === "assistant").flatMap((e: any) => e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.name));
  try {
    // The tools the session is offered are Codex's, with tool_search in place of the search pair.
    const profile = await (await request.get(`/api/sessions/${session.id}/profile`)).json();
    expect(profile.tool_profile.family).toBe("gpt");
    expect(profile.eager_tools).toEqual(expect.arrayContaining(["exec_command", "write_stdin", "apply_patch", "request_user_input", "view_image", "tool_search"]));
    expect(profile.eager_tools).not.toContain("mcp_call");

    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(ask(
      "Use your tool_search tool to find the echo MCP server's echo tool, then call it once with the text: namespace-ok. Reply with what it returned.",
      calls([{ name: "tool_search", input: { query: "echo" } }, { name: "mcp__echo__echo", input: { text: "namespace-ok" } }]),
    ));
    await page.keyboard.press("Enter");
    await ends(1);
    const first = await called();
    expect(first).toContain("tool_search");
    expect(first).toContain("mcp__echo__echo");
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await expect(page.locator("body")).toContainText("echo: namespace-ok");
    await shoot(page, "gpt-01-tool-search");

    await page.getByTestId("composer").fill(ask("Call view_image once on swatch.png. Reply with one word: the image's color.", calls([{ name: "view_image", input: { path: "swatch.png" } }])));
    await page.keyboard.press("Enter");
    await ends(2);
    expect(await called()).toContain("view_image");
    const reply = (await events(request, session.id)).filter((e: any) => e.kind === "assistant").at(-1).data.blocks.map((b: any) => b.text ?? "").join(" ");
    expect(reply.toLowerCase()).toContain("red");
    await shoot(page, "gpt-02-view-image");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "client")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
    await request.delete("/api/mcp/servers/echo");
  }
});

// Feature: Codex's shell, edit and question tools as the UI shows them: a
// command in a PTY that waits for input and gets it from write_stdin, a file
// added with apply_patch, and request_user_input answered in the transcript.
// The exact calls are the test, so it runs on the scripted GPT stand-in.
test("gpt tools: exec_command and write_stdin, apply_patch, request_user_input", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted GPT stand-in: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = workspace("gpt-exec");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: STAND_IN, title: "GPT shell" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const ends = (n: number) => expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 60_000 });
  try {
    await page.goto(`/s/${session.id}`);
    // A command that waits for a line: the call yields with the process still running.
    await page.getByTestId("composer").fill(calls([{ name: "exec_command", input: { cmd: "read line; echo got-$line", shell: "bash", login: false, tty: true, yield_time_ms: 500 } }]));
    await page.keyboard.press("Enter");
    await ends(1);
    await expect(page.getByTestId("assistant-text").last()).toContainText("Process running with session ID");
    const num = (await (await request.get(`/api/sessions/${session.id}/jobs`)).json()).jobs.find((j: any) => j.command.startsWith("read line"))?.num;
    expect(num).toBeGreaterThan(0);

    await page.getByTestId("composer").fill(calls([
      { name: "write_stdin", input: { session_id: num, chars: "stdin-ok\n", yield_time_ms: 2000 } },
      { name: "apply_patch", input: { input: "*** Begin Patch\n*** Add File: notes.txt\n+alpha\n+beta\n*** End Patch\n" } },
    ]));
    await page.keyboard.press("Enter");
    await ends(2);
    const results = (await events(request, session.id)).filter((e) => e.kind === "tool_result").flatMap(resultTexts);
    expect(results.some((t) => t.includes("got-stdin-ok"))).toBe(true);
    expect(readFileSync(join(ws, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");
    await shoot(page, "gpt-03-exec-patch");

    await page.getByTestId("composer").fill(calls([{ name: "request_user_input", input: { questions: [{ id: "color", header: "Color", question: "Which color should I use?", options: [{ label: "Teal (Recommended)", description: "Calm" }, { label: "Amber", description: "Warm" }] }] } }]));
    await page.keyboard.press("Enter");
    const q = page.locator('[data-testid="question"][data-state="open"]');
    await expect(q).toBeVisible({ timeout: 30_000 });
    await q.getByTestId("question-option").filter({ hasText: "Amber" }).click();
    await shoot(page, "gpt-04-question");
    await q.getByTestId("question-submit").click();
    await ends(3);
    await expect(page.getByTestId("assistant-text").last()).toContainText('"color":{"answers":["Amber"]}');
    await shoot(page, "gpt-05-answered");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "client")).toEqual([]);
  } finally {
    await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${session.id}`);
  }
});
