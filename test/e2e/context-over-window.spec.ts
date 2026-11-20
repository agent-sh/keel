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
  expect(cp[0].data.owner_messages.at(-1)).toBe("Which port did step 45 check?");
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
