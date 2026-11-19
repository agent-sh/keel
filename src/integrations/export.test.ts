import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import type { Session, StoredEvent } from "../core/types.ts";
import { toClaudeRecords, toJsonl } from "./claude-format.ts";
import { activeContext, forClaude, handoffNotes, parseKeelJsonl, toCodexRollout, toKeelJsonl, toMarkdown } from "./export.ts";
import { readClaude } from "./import/claude.ts";
import { readCodex } from "./import/codex.ts";

const s: Session = { id: "0190-sess-abcdef12", title: "t", model: "p:next", workspace: "/w", created: 0, updated: 0, phase: "idle", archived: false, usage: {} as any, head: null, settings: {} } as any;
let n = 0;
const ev = (kind: string, data: any, ts = ++n): StoredEvent => ({ id: `id${++n}`, session_id: s.id, seq: n, parent: null, kind: kind as any, data, ts });
const tools = new Set(["tools"]);

test("Markdown: role boundaries hold whatever a result holds, and a result names its call", () => {
  const readme = "Intro\n```sh\nmake\n```\n# Appendix\n````\nfour\n````\n   ```";
  for (const out of ["", readme, "no newline at end"]) {
    const md = toMarkdown(s, [ev("assistant", { blocks: [{ type: "tool_use", id: "a", name: "read", input: { path: "A" } }], model: "p:first" }), ev("tool_result", { results: [{ tool_use_id: "a", content: out }] }), ev("user", { text: "Next prompt" })], tools);
    const toks = marked.lexer(md);
    expect(toks.filter((t) => t.type === "code" && t.lang === "text").map((t: any) => t.text)).toEqual([out]);
    expect(toks.filter((t) => t.type === "heading").map((t: any) => t.text)).toEqual(["t", "Keel · answered by p:first", "Owner"]);
  }
  // Which file was missing reads the same whichever result came first.
  const calls = ev("assistant", { blocks: [{ type: "tool_use", id: "a", name: "read", input: { path: "A" } }, { type: "tool_use", id: "b", name: "read", input: { path: "B" } }] });
  const one = toMarkdown(s, [calls, ev("tool_result", { results: [{ tool_use_id: "a", content: "present" }, { tool_use_id: "b", content: "missing" }] })], tools);
  const two = toMarkdown(s, [calls, ev("tool_result", { results: [{ tool_use_id: "b", content: "missing" }, { tool_use_id: "a", content: "present" }] })], tools);
  for (const md of [one, two]) expect(md).toMatch(/\*\*Result of call 2: read\*\*\n\n```text\nmissing/);
  expect(toMarkdown(s, [ev("tool_result", { results: [{ tool_use_id: "zz", content: "x" }] })], tools)).toContain("Result of a call not in this file");
});

test("Markdown: endings, attachments, who answered, a long result's tail", () => {
  const reply = (model: string) => ev("assistant", { blocks: [{ type: "text", text: "Checked A." }], model });
  const md = toMarkdown(s, [
    ev("user", { text: "", images: [{ type: "image", media_type: "image/png", data: "x" }, { type: "image", media_type: "image/png", data: "y" }] }),
    reply("p:first"), ev("turn_end", { reason: "interrupted" }),
    ev("user", { text: "go on" }), reply("p:first"), ev("turn_end", { reason: "end_turn" }),
    ev("user", { text: "status ok", kind: "subagent" }), reply("q:first"), ev("turn_end", { reason: "restart" }),
  ], new Set());
  expect(md).toContain("Selected for the next turn: p:next");
  expect(md).toContain("*2 images attached; not included in this file.*");
  expect(md.match(/answered by/g)?.length).toBe(2);
  expect(md).toContain("## Keel · answered by q:first");
  expect(md).toContain("## Report from a child agent");
  expect(md.match(/Stopped before completion by the owner/g)?.length).toBe(1);
  expect(md).toContain("Cut short by a daemon restart.");
  const long = toMarkdown(s, [ev("tool_result", { results: [{ tool_use_id: "a", content: "x".repeat(20_000) + "FINAL-CHECK-FAILED" }] })], tools);
  expect(long).toContain("FINAL-CHECK-FAILED");
  expect(long).toContain("characters left out here");
});

test("a Keel file cut short is caught; a whole one, even empty, reads", () => {
  const evs = [ev("user", { text: "one" }), ev("assistant", { blocks: [{ type: "text", text: "two" }] })];
  const file = toKeelJsonl(s, evs);
  const lines = file.split("\n");
  expect(parseKeelJsonl(file).ok).toBe(true);
  expect(parseKeelJsonl(toKeelJsonl(s, [])).ok).toBe(true);
  for (const cut of [lines[0] + "\n", lines.slice(0, 2).join("\n") + "\n"]) expect(parseKeelJsonl(cut)).toEqual({ ok: false, error: expect.stringContaining("incomplete export: expected 2 events") });
  expect(parseKeelJsonl(file.slice(0, file.length - 10))).toEqual({ ok: false, error: "incomplete export: the record on line 3 is cut or unreadable" });
  const v1 = parseKeelJsonl(JSON.stringify({ keel_export: 1 }) + "\n");
  expect(v1.ok && v1.notes[0]).toContain("cannot be checked");
  // A summary names its covered event by a ref of the file.
  const c = ev("compaction", { mode: "summary", summary: "S", covered: evs[0]!.id });
  const p = parseKeelJsonl(toKeelJsonl(s, [...evs, c]));
  expect(p.ok && p.events[2]!.data.covered).toBe("e1");
});

test("a resume handoff carries the active context only", () => {
  const before = ev("user", { text: "old rule" });
  const after = ev("user", { text: "new rule" });
  expect(activeContext([before, ev("compaction", { mode: "clear" }), after]).map((e) => e.data.text)).toEqual(["new rule"]);
  const sum = activeContext([before, ev("compaction", { mode: "summary", summary: "S" }), after]);
  expect(sum.map((e) => e.kind)).toEqual(["compaction", "user"]);
});

test("round trips through Claude Code's and Codex's files keep ids, outcomes, notes, images, times and models", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "", "keel-export-"));
  const png = { type: "image", media_type: "image/png", data: "iVBORw0KGgo" };
  const evs = [
    ev("user", { text: "look", images: [png] }, Date.UTC(2026, 0, 1, 9)),
    ev("note", { text: "Build ended", model: true }, Date.UTC(2026, 0, 1, 9, 1)),
    ev("assistant", { blocks: [{ type: "tool_use", id: "x".repeat(64) + "1", name: "check", input: {} }, { type: "tool_use", id: "x".repeat(64) + "2", name: "check", input: { n: 2 } }], model: "p:alpha", usage: { input: 73, output: 11, cache_read: 7, cache_write: 3 } }, Date.UTC(2026, 0, 1, 9, 2)),
    ev("tool_result", { results: [{ type: "tool_result", tool_use_id: "x".repeat(64) + "2", content: "See report", is_error: true }, { type: "tool_result", tool_use_id: "x".repeat(64) + "1", content: "See report" }] }, Date.UTC(2026, 0, 1, 9, 3)),
    ev("assistant", { blocks: [{ type: "text", text: "First check passed" }], model: "q:beta", stop: "interrupted" }, Date.UTC(2026, 0, 4, 9)),
    ev("turn_end", { reason: "interrupted" }, Date.UTC(2026, 0, 4, 9)),
  ];
  const claudeIn = toClaudeRecords(s, forClaude(evs), "c1");
  writeFileSync(join(dir, "c.jsonl"), toJsonl(claudeIn));
  writeFileSync(join(dir, "x.jsonl"), toCodexRollout(s, evs, "x1", Date.UTC(2026, 1, 1, 12)));
  const claudeUsage = claudeIn.find((r: any) => r.type === "assistant") as any;
  expect(claudeUsage.message.usage).toEqual({ input_tokens: 73, output_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 });
  expect((claudeIn[0] as any).message.content[0].source.media_type).toBe("image/png");
  const imageOnly = toCodexRollout(s, [ev("user", { text: "", images: [png] })], "x2", 0);
  expect(imageOnly).toContain('"input_image"');
  const codexTimes = (await Bun.file(join(dir, "x.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l).timestamp);
  expect(codexTimes.at(-1)).toBe("2026-01-04T09:00:00.000Z");
  for (const [file, read] of [["c.jsonl", readClaude], ["x.jsonl", readCodex]] as const) {
    const r = await read(join(dir, file));
    const kinds = r.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "user").length).toBe(1);
    expect(r.events.find((e) => e.kind === "note")?.data.text).toBe("Build ended");
    expect(r.events[0]!.data.images).toEqual([png]);
    const uses = r.events.filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks.filter((b: any) => b.type === "tool_use"));
    expect(new Set(uses.map((b: any) => b.id)).size).toBe(2);
    const results = r.events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
    const failedCall = results.find((x: any) => x.is_error)?.tool_use_id;
    expect(uses.find((b: any) => b.id === failedCall)?.input).toEqual({ n: 2 });
    expect(results.find((x: any) => !x.is_error)?.content).toBe("See report");
    const last = r.events.findLast((e) => e.kind === "assistant")!;
    expect(last.data.stop).toBe("interrupted");
    expect(r.events.filter((e) => e.kind === "assistant").map((e) => e.data.model)).toEqual(["alpha", "beta"]);
  }
});

test("a tool result's image goes to Codex and Claude Code byte for byte and comes back under its call", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "", "keel-export-"));
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcGgAAAFkAOHHE8n2AAAAAElFTkSuQmCC";
  const hash = (d: string) => new Bun.CryptoHasher("sha256").update(Buffer.from(d, "base64")).digest("hex");
  const evs = [
    ev("user", { text: "look at it" }),
    ev("assistant", { blocks: [{ type: "tool_use", id: "call_view", name: "view_image", input: { path: "a.png" } }, { type: "tool_use", id: "call_bad", name: "view_image", input: { path: "b.png" } }, { type: "tool_use", id: "call_find", name: "tool_search", input: { query: "x" } }], model: "p:alpha" }),
    ev("tool_result", { results: [
      { type: "tool_result", tool_use_id: "call_view", content: [{ type: "image", media_type: "image/png", data }, { type: "text", text: "a.png" }] },
      { type: "tool_result", tool_use_id: "call_bad", content: [{ type: "image", media_type: "image/png", data }, { type: "text", text: "half read" }], is_error: true },
      { type: "tool_result", tool_use_id: "call_find", content: [{ type: "tool_reference", tool_name: "mcp__echo__say" }] },
    ] }),
  ];
  writeFileSync(join(dir, "rollout-x.jsonl"), toCodexRollout(s, evs, "x", 0));
  const claude = toJsonl(toClaudeRecords(s, forClaude(evs), "c"));
  expect(claude).toContain(`"source":{"type":"base64","media_type":"image/png","data":"${data}"}`);
  writeFileSync(join(dir, "c.jsonl"), claude);
  for (const read of [readCodex(join(dir, "rollout-x.jsonl")), readClaude(join(dir, "c.jsonl"))]) {
    const results = (await read).events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
    // Codex keeps the id as is; Claude Code's export gives it the toolu_ prefix it needs.
    const byId = (id: string) => results.find((r: any) => r.tool_use_id === id || r.tool_use_id === `toolu_${id}`);
    for (const id of ["call_view", "call_bad"]) expect(hash(byId(id).content.find((c: any) => c.type === "image").data)).toBe(hash(data));
    expect(byId("call_bad").is_error).toBe(true);
    expect(byId("call_view").is_error).toBeUndefined();
  }
  expect(handoffNotes("codex", evs).join()).toContain("tool search result goes as text");
});
