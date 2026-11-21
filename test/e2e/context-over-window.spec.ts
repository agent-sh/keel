import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a history larger than the model's window. A session moved in from
// another harness carries no token counts and can be longer than its model
// reads in one request. Its first turn must not send that request: the history
// is compacted first, and since the summary request would not fit either, it
// is read as a text transcript (long tool outputs shortened, in parts oldest
// first). The strict stand-in model (src/providers/scripted.ts) counts the
// whole request at 2.5 bytes a token and refuses one over its window in a
// provider's own words, which end a turn that sends it.
const STRICT = "scripted:stand-in-strict";

test("an imported history over the window is compacted before its first request", async ({ page, request }) => {
  const info = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === STRICT);
  test.skip(!info, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  // 45 exchanges with a 4 KB tool output each: about 230 KB, over the window
  // of 80,000 tokens as the provider counts it, and under the share that
  // compacts when counted at 4 bytes a token.
  const lines: any[] = [];
  const add = (kind: string, data: any) => lines.push({ ref: `e${lines.length + 1}`, kind, data, ts: 1_700_000_000_000 + lines.length });
  for (let n = 1; n <= 45; n++) {
    add("user", { text: `Step ${n}: check the service on port ${7000 + n}.` });
    add("assistant", { blocks: [{ type: "tool_use", id: `call-${n}`, name: "Bash", input: { command: `curl -s localhost:${7000 + n}/health` } }], stop: "tool_use", imported: true });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: `call-${n}`, content: `BEGIN-${n} ${"status ok; ".repeat(360)} END-${n}` }] });
    add("assistant", { blocks: [{ type: "text", text: `Port ${7000 + n} answers. ${"All checks passed. ".repeat(40)}` }], stop: "end_turn", imported: true });
  }
  const file = [{ keel_export: 2, events: lines.length, scope: "current branch", title: "A long imported history", model: STRICT, workspace: "", created: 1_700_000_000_000 }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n";
  expect(Buffer.byteLength(file) / 2.5).toBeGreaterThan(info.context);
  expect(Buffer.byteLength(file) / 4).toBeLessThan(info.context * 0.85);
  const made = await (await request.post("/api/sessions/import", { data: file, headers: { "content-type": "application/x-ndjson" } })).json();
  const id = made.session.id;

  // The meter counts the history over the window before anything is sent.
  const ctx = await (await request.get(`/api/sessions/${id}/context`)).json();
  expect(ctx.context_used_tokens).toBeGreaterThan(ctx.context_window);
  await page.goto(`/s/${id}`);
  const composer = page.getByTestId("composer");
  await composer.fill("Which port did step 45 check?");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });

  // One compaction, written from the transcript in parts; the reply follows it and nothing failed.
  const events = (await (await request.get(`/api/sessions/${id}/events`)).json()).events as any[];
  const tail = events.slice(lines.length);
  const cp = tail.filter((e) => e.kind === "compaction");
  expect(cp).toHaveLength(1);
  expect(cp[0].data.parts).toBeGreaterThan(1);
  expect(cp[0].data.outputs_shortened).toBe(45);
  expect(cp[0].data.summary).toContain(`read part ${cp[0].data.parts} of ${cp[0].data.parts} of the transcript, after the summary of the parts before it`);
  // The prompt that opened the turn is not summarized: it follows the summary whole.
  expect(cp[0].data.owner_messages.at(-1)).toBe("Step 45: check the service on port 7045.");
  expect(cp[0].data.covered).toBe(events[lines.length - 1].id);
  expect(cp[0].data.owner_messages).toContain("Step 1: check the service on port 7001.");
  expect(tail.filter((e) => e.kind === "error")).toHaveLength(0);
  expect(tail.find((e) => e.kind === "turn_end").data.reason).toBe("end_turn");
  await expect(page.getByTestId("compacted")).toContainText(`read as a transcript in ${cp[0].data.parts} parts, 45 long tool outputs shortened`);
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Scripted reply, after a compaction.");
  await shoot(page, "context-over-window-01-compacted");

  // The next turn runs on the compacted context, measured by the provider.
  await composer.fill("And step 44?");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
  const after = (await (await request.get(`/api/sessions/${id}/events`)).json()).events as any[];
  expect(after.filter((e) => e.kind === "compaction")).toHaveLength(1);
  expect(after.at(-1).data.reason).toBe("end_turn");
});

const sessionOn = async (request: any, model: string) => {
  const r = await (await request.post("/api/sessions", { data: { model } })).json();
  return (r.session ?? r).id as string;
};
const eventsOf = async (request: any, id: string) => (await (await request.get(`/api/sessions/${id}/events`)).json()).events as any[];
const turnEnds = (request: any, id: string, n: number) =>
  expect.poll(async () => (await eventsOf(request, id)).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(n);
// What the strict stand-in counted of a session's requests: how many, the
// largest in tokens, and those over its window (which it refused).
async function counted(request: any, id: string): Promise<{ window: number; requests: number; largest: number; refused: number }> {
  const probe = await sessionOn(request, "scripted:stand-in");
  await request.post(`/api/sessions/${probe}/messages`, { data: { text: `script:counted ${id}` } });
  await turnEnds(request, probe, 1);
  const text: string = (await eventsOf(request, probe)).findLast((e) => e.kind === "assistant").data.blocks[0].text;
  await request.delete(`/api/sessions/${probe}`);
  return JSON.parse(text.replace(/^counted /, ""));
}

// Feature: the request as it is finally built is held to the window of the
// model it goes to. The strict stand-in counts every request it is sent, so
// each case shows that none reached it over its window.
test("a request over the destination model's window is never sent", async ({ page, request }) => {
  const info = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === STRICT);
  test.skip(!info, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");

  // A first input larger than the window however its bytes are counted (at
  // five bytes a token, the most a model is taken to have): there is nothing
  // to compact, so the turn ends saying so and the provider is never asked.
  const first = await sessionOn(request, STRICT);
  const long = "word ".repeat(90_000);
  expect(Buffer.byteLength(long) / 5).toBeGreaterThan(info.context);
  await request.post(`/api/sessions/${first}/messages`, { data: { text: long } });
  await turnEnds(request, first, 1);
  const failed = await eventsOf(request, first);
  expect(failed.find((e) => e.kind === "turn_end").data.reason).toBe("error");
  expect(failed.find((e) => e.kind === "error").data.message).toMatch(/larger than Scripted strict window's window \(about \d+ of 80000 tokens\), so it was not sent/);
  expect(failed.filter((e) => e.kind === "assistant")).toHaveLength(0);
  await page.goto(`/s/${first}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await shoot(page, "context-over-window-02-first-input-refused");
  // The next prompt takes the place of the one that could not be sent: the session answers it.
  await request.post(`/api/sessions/${first}/messages`, { data: { text: "A shorter one instead." } });
  await expect(page.getByTestId("assistant-text").last()).toHaveText("Scripted reply.", { timeout: 30_000 });
  const shown = (await (await request.get(`/api/sessions/${first}`)).json());
  const branch: any[] = [];
  for (let e = shown.events.find((x: any) => x.id === shown.session.head); e; e = shown.events.find((x: any) => x.id === e.parent)) branch.unshift(e);
  expect(branch.filter((e) => e.kind === "user").map((e) => e.data.text)).toEqual(["A shorter one instead."]);
  expect(shown.events.filter((e: any) => e.kind === "user")).toHaveLength(2);

  // A history another model measured in its own tokens (far fewer than the
  // strict one counts), then the session moves to the smaller window: the
  // context is counted for the model it goes to, compacted first, and the turn goes on.
  const lines: any[] = [];
  const add = (kind: string, data: any) => lines.push({ ref: `e${lines.length + 1}`, kind, data, ts: 1_700_000_000_000 + lines.length });
  for (let n = 1; n <= 45; n++) {
    add("user", { text: `Step ${n}: check the service on port ${7000 + n}.` });
    add("assistant", { blocks: [{ type: "tool_use", id: `call-${n}`, name: "Bash", input: { command: `curl -s localhost:${7000 + n}/health` } }], stop: "tool_use", model: "scripted:stand-in", usage: { input: 300, cache_read: 500 * n, cache_write: 0, output: 40 } });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: `call-${n}`, content: `BEGIN-${n} ${"status ok; ".repeat(360)} END-${n}` }] });
    add("assistant", { blocks: [{ type: "text", text: `Port ${7000 + n} answers. ${"All checks passed. ".repeat(40)}` }], stop: "end_turn", model: "scripted:stand-in", usage: { input: 1_200, cache_read: 500 * n, cache_write: 0, output: 200 } });
  }
  const file = [{ keel_export: 2, events: lines.length, scope: "current branch", title: "Moved to a smaller window", model: STRICT, workspace: "", created: 1_700_000_000_000 }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n";
  expect(Buffer.byteLength(file) / 2.5).toBeGreaterThan(info.context);
  const moved = (await (await request.post("/api/sessions/import", { data: file, headers: { "content-type": "application/x-ndjson" } })).json()).session.id;
  const kept = (await eventsOf(request, moved)).findLast((e) => e.kind === "assistant");
  expect(kept.data.usage.cache_read).toBe(22_500); // the other model's count came in with the history
  await request.post(`/api/sessions/${moved}/messages`, { data: { text: "Which port did step 45 check?" } });
  await turnEnds(request, moved, 1);
  const tail = (await eventsOf(request, moved)).slice(lines.length);
  expect(tail.filter((e) => e.kind === "compaction").map((e) => e.data.trigger)).toEqual(["threshold"]);
  expect(tail.filter((e) => e.kind === "error")).toHaveLength(0);
  expect(tail.find((e) => e.kind === "turn_end").data.reason).toBe("end_turn");

  // A side question whose own words overflow the window is refused with its
  // code and never sent; one that fits is answered.
  const side = await request.post(`/api/sessions/${moved}/side`, { data: { question: "why ".repeat(100_000) } });
  expect(side.status()).toBe(409);
  expect((await side.json()).code).toBe("context_over_window");
  const short = await request.post(`/api/sessions/${moved}/side`, { data: { question: "Which step was last?" } });
  expect(short.ok()).toBe(true);

  for (const id of [first, moved]) {
    const c = await counted(request, id);
    expect(c.refused, `requests over the window that reached the provider (${JSON.stringify(c)})`).toBe(0);
    expect(c.largest).toBeLessThanOrEqual(c.window);
  }
  expect((await counted(request, moved)).requests).toBeGreaterThan(2);
});

// An imported history of `steps` exchanges with a 4 KB tool output each, no token counts.
function longHistory(title: string, steps: number): { file: string; events: number } {
  const lines: any[] = [];
  const add = (kind: string, data: any) => lines.push({ ref: `e${lines.length + 1}`, kind, data, ts: 1_700_000_000_000 + lines.length });
  for (let n = 1; n <= steps; n++) {
    add("user", { text: `Step ${n}: check the service on port ${7000 + n}.` });
    add("assistant", { blocks: [{ type: "tool_use", id: `call-${n}`, name: "Bash", input: { command: `curl -s localhost:${7000 + n}/health` } }], stop: "tool_use", imported: true });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: `call-${n}`, content: `BEGIN-${n} ${"status ok; ".repeat(360)} END-${n}` }] });
    add("assistant", { blocks: [{ type: "text", text: `Port ${7000 + n} answers. ${"All checks passed. ".repeat(40)}` }], stop: "end_turn", imported: true });
  }
  const file = [{ keel_export: 2, events: lines.length, scope: "current branch", title, model: STRICT, workspace: "", created: 1_700_000_000_000 }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n";
  return { file, events: lines.length };
}

// Feature: what a summary request brings back is checked before it becomes
// the context. A summary cut at the output limit is asked for again and never
// kept as it is; a summary of a transcript's earlier parts that came back far
// longer than planned still goes with the next part inside one request.
test("a cut summary is never a checkpoint, and a long summary of earlier parts still fits the next request", async ({ request }) => {
  const info = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === STRICT);
  test.skip(!info, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const h = longHistory("Summaries that come back wrong", 60);
  const id = (await (await request.post("/api/sessions/import", { data: h.file, headers: { "content-type": "application/x-ndjson" } })).json()).session.id;
  const head = (await (await request.get(`/api/sessions/${id}`)).json()).session.head;

  // Every attempt is cut at the output limit: refused, nothing stored, the branch as it was.
  const cut = await request.post(`/api/sessions/${id}/compact`, { data: { focus: "script:summary-cut" } });
  expect(cut.status()).toBe(409);
  expect((await cut.json()).error).toMatch(/cut at Scripted strict window's output limit/);
  expect((await eventsOf(request, id)).filter((e) => e.kind === "compaction")).toHaveLength(0);
  expect((await (await request.get(`/api/sessions/${id}`)).json()).session.head).toBe(head);
  const afterCut = await counted(request, id);
  expect(afterCut.requests).toBe(3); // asked, and twice more, shorter

  // The first part's summary comes back at 60 KB: the parts after it are cut
  // again for the room it leaves, and no request goes over the window.
  const long = await request.post(`/api/sessions/${id}/compact`, { data: { focus: "script:summary-long" } });
  expect(long.ok()).toBe(true);
  const cp = (await long.json()).event;
  expect(cp.data.parts).toBeGreaterThan(1);
  expect(cp.data.summary).toContain(`read part ${cp.data.parts} of ${cp.data.parts} of the transcript, after the summary of the parts before it`);
  const c = await counted(request, id);
  expect(c.refused, `requests over the window that reached the provider (${JSON.stringify(c)})`).toBe(0);
  expect(c.requests - afterCut.requests).toBe(cp.data.parts);

  // Cut once, then written whole when asked again: that answer is the checkpoint.
  const again = await sessionOn(request, STRICT);
  await request.post(`/api/sessions/${again}/messages`, { data: { text: "A first exchange to summarize." } });
  await turnEnds(request, again, 1);
  const once = await request.post(`/api/sessions/${again}/compact`, { data: { focus: "script:summary-cut-once" } });
  expect(once.ok()).toBe(true);
  expect((await once.json()).event.data.summary).toContain("the scripted scenario ran");
});
