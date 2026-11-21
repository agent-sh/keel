import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: observability built for fixing. A failed request becomes an error
// row that names the exact request (route, attempt, class), opens the turn's
// trace (a waterfall of requests and tools, the failing span's detail, "send
// again"), gives a debug bundle an agent can read, and "Fix this" starts a
// session that is handed the bundle. The daemon log is live in Settings, and
// the traces go out over OTLP/HTTP with the GenAI names. The scripted provider
// plays a refused billing (a 402) so the failure is the same every run.
const STAND_IN = "scripted:stand-in";

test("a failed request is traced, bundled, replayed and handed to a fix", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  // A stand-in OTLP collector.
  const got: any[] = [];
  const collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { if (req.url === "/v1/traces") got.push(JSON.parse(body)); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  const port = (collector.address() as AddressInfo).port;

  try {
    await page.goto("/settings/logs");
    await page.getByTestId("otlp-endpoint").fill(`http://127.0.0.1:${port}/v1/traces`);
    await page.getByTestId("otlp-save").click();
    await expect(page.getByTestId("otlp-state")).toContainText("0 sent");

    // Auth headers by reference: a name is saved, never a secret, and the daemon says what it found there.
    const hdr = page.getByTestId("otlp-headers");
    await expect(hdr.getByTestId("otlp-headers-state")).toContainText("No auth headers are sent.");
    await hdr.getByRole("radio", { name: "Keyring" }).click();
    await expect(hdr.getByTestId("otlp-headers-name")).toHaveAttribute("aria-label", "Keyring entry name");
    await hdr.getByRole("radio", { name: "Environment" }).click();
    await hdr.getByTestId("otlp-headers-name").fill("KEEL_E2E_UNSET_HEADERS");
    await hdr.getByTestId("otlp-headers-save").click();
    await expect(hdr.getByTestId("otlp-headers-state")).toContainText("$KEEL_E2E_UNSET_HEADERS is not set in the daemon's environment");
    expect((await (await request.get("/api/settings")).json()).settings.observe.otlp_headers).toEqual({ env: "KEEL_E2E_UNSET_HEADERS" });
    await shoot(page, "observe-00-auth-headers");
    await hdr.getByTestId("otlp-headers-clear").click();
    await expect(hdr.getByTestId("otlp-headers-state")).toContainText("No auth headers are sent.");

    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Observe check" } })).json();
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill("script:billing");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 20_000 });

    // The error row names the request it failed in.
    await page.getByTestId("errors-button").click();
    const panel = page.getByTestId("errors-panel");
    const row = panel.getByTestId("error-row").filter({ hasText: "credit balance is too low" }).first();
    await row.locator("summary").click();
    await expect(row.getByTestId("error-wire")).toContainText(`${STAND_IN}  ·  attempt 1  ·  HTTP 402`);
    await expect(row.getByTestId("error-wire")).toContainText("quota");
    await shoot(page, "observe-01-error-actions");

    // The bundle an agent reads: the failure, the turn's trace, the failing request, the log.
    const err = (await (await request.get("/api/errors?resolved=0")).json()).errors.find((e: any) => e.session_id === session.id);
    const md = await (await request.get(`/api/debug/bundle?error_id=${err.id}`)).text();
    for (const part of ["## Failure", "## Trace of the turn", "## The failing span", "Request shape: turn;", "## Transcript before the failure", "## Daemon log around it", "credit balance is too low", `[span ${err.span_id}]`]) expect(md).toContain(part);

    // The trace: the turn and its failed request, the request's detail, and sending it again.
    await row.getByTestId("error-trace").click();
    await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
    await openPanel(page, "traces");
    const view = page.getByTestId("trace-view");
    await expect(view.getByTestId("span-row")).toHaveCount(2);
    await expect(view.locator('[data-testid="span-row"][data-status="error"]')).toHaveCount(2);
    const detail = page.getByTestId("span-detail");
    await expect(detail).toContainText("chat stand-in");
    await expect(detail).toContainText("HTTP 402");
    await expect(detail).toContainText(err.span_id);
    await shoot(page, "observe-02-trace");
    await detail.getByTestId("span-replay").click();
    await expect(page.getByTestId("replay-result")).toContainText("Failed again: HTTP 402");
    await shoot(page, "observe-03-replayed");

    // OTLP: the turn and the request as GenAI spans, the failure as status 2.
    await expect.poll(() => got.flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans).map((s: any) => s.name), { timeout: 15_000 }).toEqual(expect.arrayContaining(["invoke_agent keel", "chat stand-in"]));
    const spans = got.flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans);
    const chat = spans.find((s: any) => s.name === "chat stand-in" && s.spanId === err.span_id);
    expect(chat.status.code).toBe(2);
    expect(chat.attributes).toEqual(expect.arrayContaining([{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }, { key: "error.type", value: { stringValue: "quota" } }, { key: "gen_ai.conversation.id", value: { stringValue: session.id } }]));
    // Shapes and numbers only: no prompt text leaves, and no failure text (it stays in the local span).
    expect(JSON.stringify(got)).not.toContain("script:billing");
    expect(chat.status).toEqual({ code: 2 });
    expect(JSON.stringify(got)).not.toContain("credit balance");
    expect((await (await request.get(`/api/debug/spans/${err.span_id}`)).json()).span.error).toContain("credit balance is too low");

    // A subagent's first turn sits under the spawn call in the parent's trace.
    const { session: lead } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Subagent trace" } })).json();
    await page.goto(`/s/${lead.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: "child work\nscript:calls []", isolation: "none" } }])}`);
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("turn-end").first()).toBeVisible({ timeout: 20_000 });
    const spawned = async () => {
      const first = (await (await request.get(`/api/debug/traces?session_id=${lead.id}`)).json()).traces.at(-1);
      const spans = first ? (await (await request.get(`/api/debug/traces/${first.trace_id}`)).json()).spans : [];
      return spans.filter((x: any) => x.session_id !== lead.id && x.status !== "running").length;
    };
    await expect.poll(spawned, { timeout: 15_000 }).toBe(2);
    await openPanel(page, "traces");
    await page.getByTestId("trace-row").last().click();
    const tree = page.getByTestId("trace-view");
    await expect(tree.locator('[data-testid="span-row"][data-kind="turn"][data-depth="2"]')).toContainText("Subagent turn", { timeout: 15_000 });
    await expect(tree.locator('[data-testid="span-row"][data-kind="request"][data-depth="3"]')).toHaveCount(1);
    await shoot(page, "observe-06-subagent-trace");

    // Fix this: a new session handed the bundle (on the stand-in here; the owner's default model otherwise).
    await page.route("**/api/debug/fix", (r) => r.continue({ postData: JSON.stringify({ ...JSON.parse(r.request().postData() ?? "{}"), model: STAND_IN }) }));
    await page.getByTestId("errors-button").click();
    const again = page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: "credit balance is too low" }).first();
    await again.locator("summary").click();
    await again.getByTestId("error-fix").click();
    await expect(page).not.toHaveURL(new RegExp(`/s/${session.id}`));
    const prompt = page.getByTestId("user-message").first();
    await expect(prompt).toContainText("The debug bundle is ");
    const path = (await prompt.innerText()).match(/The debug bundle is (\S+\.md)\./)![1]!;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("credit balance is too low");
    await shoot(page, "observe-04-fix-session");

    // The daemon log, live, filtered, and the export count.
    await page.goto("/settings/logs");
    await page.getByTestId("log-filter").fill("credit balance");
    await expect(page.getByTestId("log-lines")).toContainText("[provider] Scripted: your credit balance is too low");
    await expect(page.getByTestId("otlp-state")).toContainText(/[1-9]\d* sent/);
    await page.getByTestId("log-filter").fill("");
    await shoot(page, "observe-05-logs");
  } finally {
    collector.close();
  }
});

// Sending a failed request again: what came back is said as it ended. The
// scripted provider is overloaded on the first attempt, so the request is
// kept, and what a later send of it gets depends on the scenario.
test("a replay the model declines shows as declined, an answered one as answered", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const replayOf = async (script: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Replay ${script}` } })).json();
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:${script}`);
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await openPanel(page, "traces");
    // The first failed request is picked: the overloaded attempt, which kept its request.
    const detail = page.getByTestId("span-detail");
    await expect(detail).toContainText("529 overloaded");
    await detail.getByTestId("span-replay").click();
    await expect(page.getByTestId("replay-result")).toBeVisible({ timeout: 15_000 });
    const traces = (await (await request.get(`/api/debug/traces?session_id=${session.id}`)).json()).traces;
    return { shown: await page.getByTestId("replay-result").innerText(), span: traces.find((t: any) => t.attrs.replay_of) };
  };

  const refused = await replayOf("refuse-late");
  expect(refused.shown).toContain("Declined (cyber) in ");
  expect(refused.shown).toContain("Scripted refusal for the test.");
  expect(refused.shown).not.toContain("Answered");
  expect(refused.span).toMatchObject({ status: "error", error_type: "refusal", error: "Scripted refusal for the test.", attrs: { result: { stop: "refusal" } } });
  await shoot(page, "observe-07-replay-declined");

  const answered = await replayOf("overloaded");
  expect(answered.shown).toContain("Answered in ");
  expect(answered.shown).toContain("Answered after the overload passed.");
  expect(answered.span).toMatchObject({ status: "ok", error: null, error_type: null, attrs: { result: { stop: "end_turn" } } });
  await shoot(page, "observe-08-replay-answered");
});
