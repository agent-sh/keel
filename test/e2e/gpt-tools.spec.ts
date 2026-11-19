import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;
// A 32x32 PNG, all one red.
const RED = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IyJCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJ3LED3QqzauAAAAAElFTkSuQmCC";

// Feature: GPT's own tools on the Responses wire. The model finds an MCP tool
// with its client tool_search (the server's tools load as the namespace
// mcp__echo) and calls it there; view_image puts a local image in its context.
// A GPT route on the Responses wire is needed: KEEL_TEST_GPT_MODEL, else the
// first GPT model the ChatGPT sign-in lists.
test("gpt tools: tool_search loads an MCP namespace, view_image", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; family: string; provider: string }[];
  const model = process.env.KEEL_TEST_GPT_MODEL ?? models.find((m) => m.family === "gpt" && m.provider === "chatgpt")?.id;
  test.skip(!model, "no GPT model on a Responses route (sign in to ChatGPT or set KEEL_TEST_GPT_MODEL)");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.delete("/api/mcp/servers/echo").catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: "echo", command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `gpt-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "swatch.png"), Buffer.from(RED, "base64"));
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model, title: "GPT tools" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const ends = async (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);
  const calls = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events
    .filter((e: any) => e.kind === "assistant").flatMap((e: any) => e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.name));
  try {
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill("Use your tool_search tool to find the echo MCP server's echo tool, then call it once with the text: namespace-ok. Reply with what it returned.");
    await page.keyboard.press("Enter");
    await ends(1);
    const first = await calls();
    expect(first).toContain("tool_search");
    expect(first).toContain("mcp__echo__echo");
    await expect(page.getByTestId("turn-end").last()).toBeVisible();
    await expect(page.locator("body")).toContainText("echo: namespace-ok");
    await shoot(page, "gpt-01-tool-search");

    await page.getByTestId("composer").fill("Call view_image once on swatch.png. Reply with one word: the image's color.");
    await page.keyboard.press("Enter");
    await ends(2);
    expect(await calls()).toContain("view_image");
    const reply = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "assistant").at(-1).data.blocks.map((b: any) => b.text ?? "").join(" ");
    expect(reply.toLowerCase()).toContain("red");
    await shoot(page, "gpt-02-view-image");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "client")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
    await request.delete("/api/mcp/servers/echo");
  }
});
