import { expect, test } from "./isolate.ts";
import type { APIRequestContext } from "./isolate.ts";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shoot } from "./shots.ts";

// Feature: the owner's ChatGPT app connectors as a server Keel brings (src/integrations/chatgpt-apps.ts). It is
// off until the owner turns it on; a session is offered an app only once its switch is on; a tool that reads the
// app runs with no card; a tool that changes or sends anything is the owner's card, whatever its connector calls
// it; and nothing of the server but its tools is reached. The server here is a stand-in on this machine
// (test/e2e/fixtures/chatgpt-apps.ts): a scratch daemon reads its address from the file KEEL_CHATGPT_APPS_STANDIN
// names (scripts/scratch-env.ts), so ChatGPT itself is never asked anything.
const NAME = "chatgpt-apps";
const MODEL = "scripted:stand-in";
const GMAIL = "connector_gmail_standin";
const rowOf = async (request: APIRequestContext) => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((s) => s.name === NAME);
const call = (tool: string, args: Record<string, unknown>) => ({ name: "mcp_call", input: { tool: `${NAME}__${tool}`, arguments: args } });
const states = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as any[]).map((a) => a.state).join(",") || "none";
const results = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data));

test("ChatGPT apps: off until turned on, an app by its switch, a read runs, a send its connector calls a read asks", async ({ page, request }) => {
  const first = await rowOf(request);
  test.skip(!first?.stand_in, "needs a scratch daemon with the apps stand-in (KEEL_CHATGPT_APPS_STANDIN, scripts/scratch-env.ts): a spec never asks ChatGPT itself");
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL), "requires the scripted provider");
  const fx = spawn("bun", [join(import.meta.dirname, "fixtures/chatgpt-apps.ts")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((res) => createInterface({ input: fx.stdout! }).once("line", res));
  expect(port, "the stand-in prints its port first").toMatch(/^\d+$/);
  const stats = async () => (await request.get(`http://127.0.0.1:${port}/stats`)).json();
  writeFileSync(first.stand_in, `http://127.0.0.1:${port}/ps/mcp\n`);
  const session = async (title: string) => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    return s as { id: string };
  };
  try {
    await request.post(`/api/mcp/servers/${NAME}/toggle`, { data: { enabled: false } });

    // Off: nothing was asked of the server, and its page says so.
    await page.goto("/");
    await page.getByTestId("composer").fill("/mcp");
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("mcp-panel");
    await panel.locator('[data-testid="mcp-entry"]').filter({ hasText: NAME }).first().click();
    const row = panel.locator(`[data-testid="mcp-server"][data-name="${NAME}"]`);
    await expect(row).toHaveAttribute("data-state", "disabled");
    await expect(row.getByTestId("mcp-apps")).toHaveCount(0);
    expect((await stats()).methods).toEqual([]);
    await shoot(page, "chatgpt-apps-01-off");

    // Turned on: the account's apps, each with what it reads and what asks. None is on for a session yet.
    await row.getByTestId("mcp-toggle").click();
    await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(row.getByTestId("mcp-tool-count")).toHaveText("10 tools");
    const apps = row.getByTestId("mcp-app");
    await expect(apps).toHaveCount(3);
    // (The send its connector calls read-only is counted with what asks; so is a read that reaches outside the app.)
    await expect(apps.getByTestId("mcp-app-counts")).toHaveText(["2 read · 4 ask you", "1 read · 1 ask you", "0 read · 1 read outside · 1 ask you"]);
    await expect(row.getByTestId("mcp-apps")).toHaveAttribute("data-on", "0");
    await expect(row.getByTestId("mcp-contents-toggle")).toHaveCount(0);
    await shoot(page, "chatgpt-apps-02-apps");

    // A session is offered no app: its tools are not there to call, and the server is asked nothing.
    const plain = await session("ChatGPT apps: none turned on");
    await request.post(`/api/sessions/${plain.id}/messages`, { data: { text: `script:calls ${JSON.stringify([call("gmail.search_emails", { query: "invoice" })])}` } });
    await expect.poll(async () => (await results(request, plain.id)).length, { timeout: 30_000 }).toBe(1);
    expect((await stats()).calls).toEqual([]);
    // Nor its resources, for anybody.
    expect((await request.get(`/api/mcp/servers/${NAME}/resources`)).status()).toBe(409);
    expect((await stats()).methods.filter((m: string) => m.startsWith("resources/"))).toEqual([]);

    // Gmail's switch: every session is offered Gmail from now on.
    await apps.filter({ hasText: "Gmail" }).getByTestId("mcp-app-toggle").click();
    await expect(apps.filter({ hasText: "Gmail" })).toHaveAttribute("data-on", "true");
    expect((await rowOf(request)).apps.on).toEqual([GMAIL]);
    await shoot(page, "chatgpt-apps-03-gmail-on");

    // A read runs with no card, signed in, with the tool's own routing.
    const s = await session("ChatGPT apps: a read, then a send");
    await page.goto(`/s/${s.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([call("gmail.search_emails", { query: "invoice" })])}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    expect(await states(request, s.id)).toBe("none");
    await expect(page.getByTestId("assistant-text").last()).toContainText("Invoice for November");
    let st = await stats();
    expect(st.calls).toEqual([{ tool: "gmail.search_emails", arguments: { query: "invoice" }, routed: true }]);
    expect(st.unsigned).toBe(0);

    // A send asks, though its connector calls it read-only: the owner's card, with no way to always allow it.
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([call("gmail.send_email", { to: "accounts@example.com", subject: "Re: Invoice", body: "Paid today." })])}`);
    await page.keyboard.press("Enter");
    const card = page.getByTestId("approval");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("through your ChatGPT account");
    await expect(card.getByTestId("allow-always")).toHaveCount(0);
    expect((await stats()).calls).toHaveLength(1);
    await shoot(page, "chatgpt-apps-04-send-asks");
    await card.getByTestId("deny").click();
    const send = card.getByTestId("deny-send");
    if (await send.count()) await send.click();
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    st = await stats();
    expect(st.calls).toHaveLength(1);
  } finally {
    const on = (await rowOf(request))?.apps?.on;
    if (on?.length) await request.put(`/api/mcp/servers/${NAME}/apps`, { data: { connectors: [] } });
    await request.post(`/api/mcp/servers/${NAME}/toggle`, { data: { enabled: false } });
    rmSync(first.stand_in, { force: true });
    fx.kill();
  }
});
