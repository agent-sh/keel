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

  // A stand-in OTLP collector: traces, and the metrics and events beside them.
  const got: any[] = [];
  const metrics: any[] = [];
  const logs: any[] = [];
  const collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const to = req.url === "/v1/traces" ? got : req.url === "/v1/metrics" ? metrics : req.url === "/v1/logs" ? logs : null;
      to?.push(JSON.parse(body));
      res.writeHead(to ? 200 : 404, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  const port = (collector.address() as AddressInfo).port;

  try {
    await page.goto("/settings/logs");
    await page.getByTestId("otlp-endpoint").fill(`http://127.0.0.1:${port}/v1/traces`);
    await page.getByTestId("otlp-save").click();
    await expect(page.getByTestId("otlp-state")).toContainText("0 sent");
    // Metrics and events are off until the owner turns them on: a collector that takes only traces is not sent them.
    await expect(page.getByTestId("otlp-metrics")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("otlp-metrics").click();
    await page.getByTestId("otlp-events").click();
    await expect(page.getByTestId("otlp-metrics-where")).toContainText(`To http://127.0.0.1:${port}/v1/metrics.`);
    await expect(page.getByTestId("otlp-events-where")).toContainText(`To http://127.0.0.1:${port}/v1/logs.`);
    await page.getByTestId("otlp-events-where").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shoot(page, "observe-00-signals");

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
    // (Its marker: the middle of the row holds its acts.)
    await row.getByTestId("error-marker").click();
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

    // The same turn as metrics and events at the same collector, and as little of it: names, counts, classes.
    await request.post("/api/debug/export/flush");
    const series = metrics.flatMap((b) => b.resourceMetrics[0].scopeMetrics[0].metrics);
    const attrOf = (x: any, k: string) => x.attributes.find((a: any) => a.key === k)?.value?.stringValue;
    const failed = series.filter((m: any) => m.name === "keel.request.count").flatMap((m: any) => m.sum.dataPoints).find((p: any) => attrOf(p, "error.type") === "quota");
    expect([failed.asInt, attrOf(failed, "gen_ai.request.model"), attrOf(failed, "keel.status"), series.find((m: any) => m.name === "keel.request.count").sum.aggregationTemporality]).toEqual(["1", "stand-in", "error", 1]);
    expect(series.map((m: any) => m.name)).toEqual(expect.arrayContaining(["keel.turn.count", "keel.request.count", "keel.request.duration", "keel.turn.duration"]));
    const records = logs.flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
    expect(records.map((r: any) => r.eventName)).toEqual(expect.arrayContaining(["keel.user_prompt", "keel.api_error", "keel.turn"]));
    const apiError = records.find((r: any) => r.eventName === "keel.api_error" && r.spanId === err.span_id);
    expect([apiError.severityText, apiError.traceId, attrOf(apiError, "error.type"), attrOf(apiError, "gen_ai.conversation.id")]).toEqual(["ERROR", chat.traceId, "quota", session.id]);
    for (const out of [metrics, logs]) for (const word of ["script:billing", "credit balance"]) expect(JSON.stringify(out)).not.toContain(word);
    expect(JSON.stringify(metrics)).not.toContain(session.id);

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
    // Only for what an agent could fix: the account's credit is the owner's to mend, so the refused
    // billing has none, and a failure of the page's own code is handed over.
    const broken = `observe fix check ${Date.now().toString(36)}: TypeError: the plan is undefined`;
    await request.post("/api/errors", { data: { message: broken, context: { url: `/s/${session.id}` } } });
    await page.route("**/api/debug/fix", (r) => r.continue({ postData: JSON.stringify({ ...JSON.parse(r.request().postData() ?? "{}"), model: STAND_IN }) }));
    await page.getByTestId("errors-button").click();
    await expect(page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: "credit balance is too low" }).first().getByTestId("error-fix")).toHaveCount(0);
    const again = page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: broken }).first();
    await again.getByTestId("error-fix").click();
    await expect(page).not.toHaveURL(new RegExp(`/s/${session.id}`));
    const prompt = page.getByTestId("user-message").first();
    await expect(prompt).toContainText("The debug bundle is ");
    const path = (await prompt.innerText()).match(/The debug bundle is (\S+\.md)\./)![1]!;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(broken);
    await shoot(page, "observe-04-fix-session");

    // The daemon log, live, filtered, and the export count.
    await page.goto("/settings/logs");
    await page.getByTestId("log-filter").fill("credit balance");
    await expect(page.getByTestId("log-lines")).toContainText("[provider] Scripted: your credit balance is too low");
    await expect(page.getByTestId("otlp-state")).toContainText(/[1-9]\d* sent/);
    await page.getByTestId("log-filter").fill("");
    await shoot(page, "observe-05-logs");
  } finally {
    // The two signals go back to off: the collector they went to is closed here.
    await request.patch("/api/settings", { data: { observe: { otlp_metrics: null, otlp_events: null } } }).catch(() => {});
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
    // The replay is a trace of its own: it joins the list above with nothing reloaded by hand, and the turn's trace stays open.
    await expect(page.getByTestId("trace-row")).toHaveCount(2);
    await expect(page.getByTestId("trace-row").last()).toHaveAttribute("aria-current", "true");
    const traces = (await (await request.get(`/api/debug/traces?session_id=${session.id}`)).json()).traces;
    // The turn's own row is the oldest of the list.
    const row = page.getByTestId("trace-row").last();
    return { shown: await page.getByTestId("replay-result").innerText(), span: traces.find((t: any) => t.attrs.replay_of), turn: traces.find((t: any) => t.kind === "turn"), row: [await row.getAttribute("data-status"), await row.innerText()] };
  };

  const refused = await replayOf("refuse-late");
  expect(refused.shown).toContain("Declined (cyber) in ");
  expect(refused.shown).toContain("Scripted refusal for the test.");
  expect(refused.shown).not.toContain("Answered");
  expect(refused.span).toMatchObject({ status: "error", error_type: "refusal", error: "Scripted refusal for the test.", attrs: { result: { stop: "refusal" } } });
  // The turn the model declined is a failed turn in the list, in the refusal's words, not a green one.
  expect(refused.turn).toMatchObject({ status: "error", error_type: "refusal", error: "Scripted refusal for the test.", attrs: { reason: "refusal" } });
  expect(refused.row[0]).toBe("error");
  expect(refused.row[1]).toContain("Scripted refusal for the test.");
  await shoot(page, "observe-07-replay-declined");

  const answered = await replayOf("overloaded");
  expect(answered.shown).toContain("Answered in ");
  expect(answered.shown).toContain("Answered after the overload passed.");
  expect(answered.span).toMatchObject({ status: "ok", error: null, error_type: null, attrs: { result: { stop: "end_turn" } } });
  expect(answered.turn).toMatchObject({ status: "ok", error: null });
  expect(answered.row[0]).toBe("ok");
  await expect(page.getByTestId("trace-row").first()).toContainText("Replay on scripted:stand-in");
  await shoot(page, "observe-08-replay-answered");
});

// A trace opened while its turn runs follows the turn to its end: the same
// view, nothing clicked, shows the calls made since and how the turn ended.
// The scripted turn runs a command that holds it for a few seconds.
test("an open trace follows its turn to the end", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Live trace check" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 24 && echo held" } }])}`);
  await page.getByTestId("composer").press("Enter");
  // The first request has answered and the command is running.
  await expect.poll(async () => (await (await request.get(`/api/debug/traces?session_id=${session.id}`)).json()).traces[0]?.status, { timeout: 15_000 }).toBe("running");
  await openPanel(page, "traces");
  const view = page.getByTestId("trace-view");
  const turn = view.locator('[data-testid="span-row"][data-kind="turn"]');
  const detail = page.getByTestId("span-detail");
  await expect(turn).toHaveAttribute("data-status", "running");
  await expect(view.getByTestId("span-row")).toHaveCount(2);
  await expect(detail).toContainText("still running");
  await shoot(page, "observe-12-trace-running");

  // While the turn runs the view reads the trace again every two seconds:
  // one read at a time, none from a hidden tab, none once the trace is gone.
  const traceId = (await (await request.get(`/api/debug/traces?session_id=${session.id}`)).json()).traces[0].trace_id;
  const url = `**/api/debug/traces/${traceId}`;
  let asks = 0;
  page.on("request", (r) => { if (r.url().endsWith(`/api/debug/traces/${traceId}`)) asks++; });
  let release = () => {}, passed = () => {};
  const held = new Promise<void>((r) => (release = r)), through = new Promise<void>((r) => (passed = r));
  await page.route(url, async (r) => { await held; await r.continue(); passed(); });
  let from = asks;
  await expect.poll(() => asks, { timeout: 6000 }).toBe(from + 1);
  await page.waitForTimeout(3000); // a tick passes with that read still out
  expect(asks).toBe(from + 1);
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  release();
  await through;
  await page.unroute(url);
  await page.waitForTimeout(1000); // the read asked for meanwhile comes back
  from = asks;
  await page.waitForTimeout(3000);
  expect(asks).toBe(from);
  // Shown again: read at once.
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => asks, { timeout: 3000 }).toBeGreaterThan(from);
  await page.route(url, (r) => r.fulfill({ status: 404, json: { error: "no such trace" } }));
  await expect(page.getByTestId("trace-gone")).toBeVisible({ timeout: 6000 });
  from = asks;
  await page.waitForTimeout(3000);
  expect(asks).toBe(from);
  await page.unroute(url);

  // The command ends and the turn with it: the view is back with the call, the
  // second request and the turn's end, and the row in the list above too.
  await expect(view.getByTestId("span-row")).toHaveCount(4, { timeout: 45_000 });
  await expect(turn).toHaveAttribute("data-status", "ok", { timeout: 15_000 });
  await expect(view.locator('[data-testid="span-row"][data-kind="tool"]')).toContainText("Bash");
  await expect(detail).toContainText("invoke_agent");
  await expect(detail).toContainText("end_turn");
  await expect(detail).not.toContainText("still running");
  await expect(page.locator('[data-testid="trace-row"][aria-current="true"]')).toHaveAttribute("data-status", "ok");
  await shoot(page, "observe-13-trace-ended");
});

// An error opens the span it names, not the first failure of the trace and not
// the session's newest turn. The scripted overload fails twice and then
// answers: the row's last occurrence is attempt 2. Asked on the side, the same
// failure repeats in a request that belongs to no turn, with a trace of its own.
test("an error opens the exact span that failed", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const overloaded = async () => (await (await request.get("/api/errors?resolved=0")).json()).errors.find((e: any) => e.message.includes("529 overloaded"));
  const spansOf = async (trace: string) => (await (await request.get(`/api/debug/traces/${trace}`)).json()).spans as any[];
  const openRow = async () => {
    await page.getByTestId("errors-button").click();
    // A failure a retry healed is under Recovered; it is under Open when the kind also failed for good on this daemon.
    if ((await overloaded()).recovered_ts) await page.getByTestId("errors-panel").getByRole("tab", { name: /Recovered/ }).click();
    const row = page.getByTestId("errors-panel").getByTestId("error-row").filter({ hasText: "529 overloaded" }).first();
    await row.locator("summary").click();
    return row;
  };

  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Exact span check" } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("script:overloaded");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });

  // Two failed attempts in one trace; the row names the second.
  const err = await overloaded();
  expect(err.session_id).toBe(session.id);
  const turn = (await (await request.get(`/api/sessions/${session.id}/events`)).json()).events.find((e: any) => e.kind === "turn_start");
  expect(err.turn_event).toBe(turn.id);
  const attempts = (await spansOf(turn.id.replace(/-/g, ""))).filter((x) => x.kind === "request");
  expect(attempts.map((x) => [x.attrs.attempt, x.status])).toEqual([[1, "error"], [2, "error"], [3, "ok"]]);
  expect(err.span_id).toBe(attempts[1].span_id);

  let row = await openRow();
  await expect(row.getByTestId("error-wire")).toContainText("attempt 2");
  await expect(row.getByTestId("error-trace")).toHaveAttribute("title", "Opens the trace at the request or tool call that failed");
  await row.getByTestId("error-trace").click();
  await openPanel(page, "traces");
  const view = page.getByTestId("trace-view");
  const picked = view.locator('[data-testid="span-row"][aria-current="true"]');
  const detail = page.getByTestId("span-detail");
  // The turn, its three attempts, and the wait before each retry.
  await expect(view.getByTestId("span-row")).toHaveCount(6);
  await expect(view.locator('[data-testid="span-row"][data-kind="wait"]')).toHaveText([/Retry wait before attempt 2/, /Retry wait before attempt 3/]);
  await expect(detail).toContainText(attempts[1].span_id);
  await expect(detail).not.toContainText(attempts[0].span_id);
  await expect(detail).toBeInViewport();
  // One row is picked, the second attempt's (after the turn, the first attempt
  // and its retry wait), and it says which attempt it is. It stands off the
  // panel: no other row has its background, and the panel does not either.
  await expect(picked).toHaveCount(1);
  await expect(picked).toContainText("attempt 2");
  await expect(view.getByTestId("span-attempt")).toHaveText(["attempt 1", "attempt 2", "attempt 3"]);
  await page.mouse.move(0, 0);
  const grounds = await view.getByTestId("span-row").evaluateAll((rows) => rows.map((r) => getComputedStyle(r).backgroundColor));
  expect(grounds.findIndex((g) => g !== grounds[0])).toBe(3);
  expect(new Set(grounds).size).toBe(2);
  const [ground, under] = await picked.evaluate((r) => {
    const clear = (c: string) => c === "transparent" || /, 0\)$/.test(c) || / \/ 0\)$/.test(c);
    let up: Element | null = r.parentElement;
    while (up && clear(getComputedStyle(up).backgroundColor)) up = up.parentElement;
    return [getComputedStyle(r).backgroundColor, up ? getComputedStyle(up).backgroundColor : ""];
  });
  expect(ground).not.toBe(under);
  // And it carries the ink bar at its edge.
  expect(await picked.evaluate((r) => { const bar = getComputedStyle(r, "::before"); return [bar.content !== "none", bar.position, bar.backgroundColor !== "rgba(0, 0, 0, 0)"]; })).toEqual([true, "absolute", true]);
  await shoot(page, "observe-09-exact-attempt");

  // Another row is picked by hand; the error's Trace asked again picks its span again.
  await view.getByTestId("span-row").nth(1).click();
  await expect(detail).toContainText(attempts[0].span_id);
  // The bundle asked from a span is about that span: its id goes with the
  // request, and the bundle names it, not the span the error row last happened in.
  const [asked] = await Promise.all([page.waitForRequest((r) => r.url().includes("/api/debug/bundle?")), detail.getByTestId("span-bundle").click()]);
  expect(new URL(asked.url()).searchParams.get("span_id")).toBe(attempts[0].span_id);
  const bundled = await (await request.get(asked.url())).text();
  expect(bundled).toContain(`Asked from the span \`${attempts[0].span_id}\``);
  expect(bundled.slice(bundled.indexOf("## The failing span")).split("\n## ")[0]).toContain(`span \`${attempts[0].span_id}\``);
  // A span that is not kept, asked for alone, is no bundle at all.
  const unknown = await request.get("/api/debug/bundle?span_id=0000000000000000");
  expect([unknown.status(), (await unknown.json()).error]).toEqual([404, "no such span"]);
  row = await openRow();
  await row.getByTestId("error-trace").click();
  await expect(detail).toContainText(attempts[1].span_id);
  await expect(picked).toContainText("attempt 2");

  // The same failure in a side question, while the row is open: counted on the
  // same row, in no turn, and the row's wire line follows to the new span.
  row = await openRow();
  await expect(row.getByTestId("error-wire")).toBeVisible();
  expect((await request.post(`/api/sessions/${session.id}/side`, { data: { question: "What happened?" } })).status()).toBe(201);
  const aside = await overloaded();
  expect([aside.id, aside.count, aside.session_id, aside.turn_event]).toEqual([err.id, err.count + 2, session.id, undefined]);
  expect(attempts.map((x) => x.span_id)).not.toContain(aside.span_id);
  const { span } = await (await request.get(`/api/debug/spans/${aside.span_id}`)).json();
  expect([span.parent_id, span.attrs.attempt, span.attrs.turn_event]).toEqual([null, 2, undefined]);
  const md = await (await request.get(`/api/debug/bundle?error_id=${aside.id}`)).text();
  for (const part of ["In no turn: a request of its own", "## Trace of the request", `[span ${aside.span_id}]`]) expect(md).toContain(part);
  expect(md).not.toContain("## Trace of the turn");

  await expect(row.getByTestId("error-site-open")).not.toHaveAttribute("title", /at the turn/);
  await expect(row.getByTestId("error-wire")).toBeVisible();
  await row.getByTestId("error-trace").click();
  const current = page.locator('[data-testid="trace-row"][aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("529 overloaded");
  await expect(view.getByTestId("span-row")).toHaveCount(1);
  await expect(picked).toHaveCount(1);
  await expect(picked).toContainText("attempt 2");
  await expect(detail).toContainText(aside.span_id);
  await expect(detail).toContainText("Attempt");
  await shoot(page, "observe-10-standalone-span");

  // A trace that is no longer kept (spans are pruned after a while) says so,
  // and is not reported as a failure of the page.
  const client = async () => (await (await request.get("/api/errors")).json()).errors.filter((e: any) => e.source === "client").reduce((n: number, e: any) => n + (e.count ?? 1), 0);
  const before = await client();
  const turnTrace = turn.id.replace(/-/g, "");
  await page.route(`**/api/debug/traces/${turnTrace}`, (r) => r.fulfill({ status: 404, json: { error: "no such trace" } }));
  await page.getByTestId("trace-row").filter({ hasText: "Turn on stand-in" }).first().click();
  await expect(page.getByTestId("trace-gone")).toHaveText("This trace is no longer kept.");
  await expect(view).toHaveCount(0);
  await shoot(page, "observe-11-trace-gone");
  await page.unroute(`**/api/debug/traces/${turnTrace}`);
  expect(await client()).toBe(before);
});

// Feature: a trace accounts for the whole turn. Besides its requests and tool
// calls it has the waits between them as spans of their own (the wait before
// a retry, an approval card open, a prompt in the queue, a compaction), and
// any other stretch no span covers is a row that says what it most likely was.
test("a trace shows a retry's wait, an approval wait and a queued prompt's wait as spans", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const open = async (title: string, mode: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    return session.id as string;
  };
  const traces = async (id: string) => (await (await request.get(`/api/debug/traces?session_id=${id}`)).json()).traces as any[];
  const spansOf = async (trace: string) => (await (await request.get(`/api/debug/traces/${trace}`)).json()).spans as any[];
  const took = (s: any) => s.end_ms - s.start_ms;

  // A rate limit: the request fails, the turn waits four seconds, the second try answers.
  // A prompt queued meanwhile waits for that turn to end.
  const limited = await open("Waits out a rate limit", "full-auto");
  await request.post(`/api/sessions/${limited}/messages`, { data: { text: "script:rate-limit" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${limited}?events=0`)).json()).status.kind, { timeout: 15_000 }).toBe("retry");
  await request.post(`/api/sessions/${limited}/messages`, { data: { text: "and then this", mode: "queue" } });
  await expect.poll(async () => (await traces(limited)).filter((t) => t.kind === "turn" && t.status === "ok").length, { timeout: 30_000 }).toBe(2);
  const [second, first] = await traces(limited);
  const one = await spansOf(first.trace_id);
  expect(one.map((s) => [s.kind, s.kind === "wait" ? s.name : s.status])).toEqual([["turn", "ok"], ["request", "error"], ["wait", "retry wait"], ["request", "ok"]]);
  const wait = one[2];
  expect(wait).toMatchObject({ status: "ok", parent_id: one[0].span_id, attrs: { attempt: 1, turn_event: one[0].attrs.turn_event } });
  expect(took(wait)).toBeGreaterThan(3_500);
  expect(took(wait)).toBeLessThan(6_000);
  // It fills the time between the two tries: what is left of the turn is small.
  expect(wait.start_ms - one[1].end_ms).toBeLessThan(250);
  expect(one[3].start_ms - wait.end_ms).toBeLessThan(250);
  const two = await spansOf(second.trace_id);
  const queued = two.find((s) => s.kind === "wait");
  expect(queued).toMatchObject({ name: "queue wait", status: "ok", parent_id: two.find((s) => s.kind === "turn").span_id });
  expect(took(queued)).toBeGreaterThan(2_500);
  expect(queued.end_ms).toBe(two.find((s) => s.kind === "turn").start_ms);

  // An approval: the card is open for a while, then allowed.
  const asked = await open("Waits for an approval", "ask");
  await request.post(`/api/sessions/${asked}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo allowed-after-a-wait >> waited.txt" } }])}` } });
  const card = async () => ((await (await request.get(`/api/sessions/${asked}/approvals`)).json()).approvals as any[])[0];
  await expect.poll(async () => (await card())?.state, { timeout: 15_000 }).toBe("pending");
  const cardId = (await card()).id;
  await page.waitForTimeout(1_500);
  await request.post(`/api/sessions/${asked}/approvals/${cardId}`, { data: { choice: "once" } });
  await expect.poll(async () => (await traces(asked))[0]?.status, { timeout: 20_000 }).toBe("ok");
  const three = await spansOf((await traces(asked))[0].trace_id);
  const approval = three.find((s) => s.name === "approval wait");
  expect(approval).toMatchObject({ kind: "wait", status: "ok", attrs: { tool: "Bash", approval_id: cardId, answer: "allowed", choice: "once" } });
  expect(took(approval)).toBeGreaterThan(1_400);
  const tool = three.find((s) => s.kind === "tool");
  expect(tool.start_ms).toBeGreaterThanOrEqual(approval.end_ms);
  // Nothing of the command or the answer's words is in it.
  expect(JSON.stringify(approval)).not.toContain("allowed-after-a-wait");

  // The page: the waits are rows of the waterfall, and the turn says where its time went.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${limited}`);
  await openPanel(page, "traces");
  await page.getByTestId("trace-row").last().click();
  const view = page.getByTestId("trace-view");
  const row = view.locator('[data-testid="span-row"][data-kind="wait"]');
  await expect(row).toHaveText(/Retry wait before attempt 2\s*4\.\d+ ?s/);
  await view.locator('[data-testid="span-row"][data-kind="turn"]').click();
  await expect(page.getByTestId("span-account")).toHaveText(/requests .*waits 4\.\d+ ?s/);
  await row.click();
  await expect(page.getByTestId("span-detail")).toContainText("the time before the next try (retry 1 of");
  await shoot(page, "observe-14-trace-retry-wait");
  await page.goto(`/s/${asked}`);
  await openPanel(page, "traces");
  await page.getByTestId("trace-row").first().click();
  const approvalRow = page.getByTestId("trace-view").locator('[data-testid="span-row"][data-kind="wait"]');
  await expect(approvalRow).toContainText("Approval wait for Bash");
  await approvalRow.click();
  await expect(page.getByTestId("span-detail")).toContainText("the owner's answer for Bash: allowed (once)");
  await shoot(page, "observe-15-trace-approval-wait");
});
