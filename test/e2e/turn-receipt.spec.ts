import type { StoredEvent } from "../../src/core/types.ts";
import { expect, test } from "./isolate.ts";

test("a queued turn has a content-free receipt linked to its exact events and spans", async ({ request }) => {
  const { models } = await (await request.get("/api/models")).json();
  const model = (models as { id: string; context: number }[]).filter((m) => m.id.startsWith("scripted:")).sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  if (!model) return;

  const { session } = await (await request.post("/api/sessions", { data: { model: model.id, title: "Receipt title marker" } })).json();
  const base = `/api/sessions/${session.id}`;
  const events = async (): Promise<StoredEvent[]> => (await (await request.get(`${base}/events`)).json()).events;
  const send = async (text: string, mode?: "queue" | "steer") => (await (await request.post(`${base}/messages`, { data: { text, mode } })).json());
  const receipt = (id: string) => request.get(`/api/debug/turns/${id}/receipt`);
  const traces = async () => (await (await request.get(`/api/debug/traces?session_id=${session.id}`)).json()).traces;

  try {
    expect((await request.put(`${base}/permissions`, { data: { mode: "full-auto" } })).ok()).toBe(true);
    const first = (await send("script:slow receipt-owner-marker")).event;
    const queued = (await send(`script:batch ${JSON.stringify([
      { name: "Bash", input: { command: "printf receipt-tool-payload; exit 1" } },
      { name: "receipt-unknown-tool", input: { "receipt-input-key": "receipt-input-value" } },
    ])}`, "queue")).queued;
    expect(queued.id).toBeTruthy();
    const steer = (await send("receipt-steer-marker", "steer")).queued;
    await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length).toBe(2);
    const stored = await events();
    const input = stored.find((e) => e.kind === "user" && e.data.queue_id === queued.id)!;
    const start = stored.find((e) => e.kind === "turn_start" && e.parent === input.id)!;
    const end = stored.findLast((e) => e.kind === "turn_end")!;
    const root = (await traces()).find((s: any) => s.attrs.turn_event === start.id);
    const { spans } = await (await request.get(`/api/debug/traces/${root.trace_id}`)).json();
    const response = await receipt(start.id);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      session_id: session.id, turn_event: start.id, trace_id: root.trace_id, span_id: root.span_id,
      inputs: [{ event_id: input.id, origin: "queued", queue_id: queued.id }],
      end: { event_id: end.id, reason: "end_turn" },
    });
    expect(body.inputs).toHaveLength(1);
    expect(body.requests.map((s: any) => s.span_id)).toEqual(spans.filter((s: any) => s.kind === "request").map((s: any) => s.span_id));
    expect(body.requests.map((s: any) => [s.purpose, s.status])).toEqual([["turn", "ok"], ["turn", "ok"]]);
    const tool = spans.find((s: any) => s.kind === "tool");
    expect(tool.error).toContain("receipt-tool-payload");
    const results = stored.filter((e) => e.kind === "tool_result");
    const ran = results.find((e) => e.data.results.some((r: any) => r.tool_use_id === tool.attrs.call_id))!;
    const notRun = results.find((e) => e.id !== ran.id)!;
    expect(body.tools).toEqual(expect.arrayContaining([
      { result_event_id: ran.id, span_id: tool.span_id, status: "error" },
      { result_event_id: notRun.id, span_id: null, status: "error" },
    ]));
    expect(body.tools).toHaveLength(2);
    for (const marker of ["Receipt title marker", "receipt-owner-marker", "receipt-tool-payload", "receipt-unknown-tool", "receipt-input-key", "receipt-input-value", "script:batch"]) {
      expect(JSON.stringify(body)).not.toContain(marker);
    }
    expect((await receipt(first.id)).status()).toBe(404);
    const firstTurn = stored.find((e) => e.kind === "turn_start")!;
    const steerInput = stored.find((e) => e.kind === "user" && e.data.queue_id === steer.id)!;
    const steering = await (await receipt(firstTurn.id)).json();
    expect(steering.inputs).toEqual([
      { event_id: first.id, origin: "owner", queue_id: null },
      { event_id: steerInput.id, origin: "steer", queue_id: steer.id },
    ]);
    expect(JSON.stringify(steering)).not.toMatch(/receipt-(owner|steer)-marker/);

    // The old receipt still names the original end when another branch is shown.
    expect((await request.post(`${base}/head`, { data: { head_event_id: first.id, leaf: false } })).ok()).toBe(true);
    await send("script:billing");
    await expect.poll(async () => (await events()).filter((e) => e.kind === "error").length).toBe(1);
    const failed = (await events()).findLast((e) => e.kind === "turn_start")!;
    const err = (await events()).findLast((e) => e.kind === "error")!;
    const failure = await (await receipt(failed.id)).json();
    expect(failure.end.reason).toBe("error");
    expect(failure.requests[0]).toMatchObject({ purpose: "turn", status: "error", error_id: err.data.error_id });
    expect(JSON.stringify(failure)).not.toContain("credit balance");
    expect(await (await receipt(start.id)).json()).toEqual(body);
  } finally {
    await request.delete(base);
  }
});
