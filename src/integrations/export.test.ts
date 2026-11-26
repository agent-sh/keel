import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import type { Session, StoredEvent } from "../core/types.ts";
import { toClaudeRecords, toJsonl } from "./claude-format.ts";
import { activeContext, forClaude, handoffNotes, parseKeelJsonl, resumeLine, rowsOf, toCodexRollout, toKeelJsonl, toMarkdown } from "./export.ts";
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

test("a self-contained Keel file carries each file once, and is refused when its bytes are not what it says", () => {
  const bytes = new TextEncoder().encode("quarterly numbers\n");
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const file = (name: string) => ({ type: "attachment", id, name, media_type: "text/plain", size: bytes.byteLength });
  const evs = [ev("user", { text: "one", images: [file("budget.txt")] }), ev("user", { text: "two", images: [file("release.txt")] })];
  // Without the option the file is what it was: a manifest, no bytes.
  const plain = toKeelJsonl(s, evs);
  expect(plain.split("\n").filter(Boolean)).toHaveLength(3);
  expect(JSON.parse(plain.split("\n")[0]!).blobs).toBeUndefined();
  const p0 = parseKeelJsonl(plain);
  expect(p0.ok && p0.blobs.size).toBe(0);

  const whole = toKeelJsonl(s, evs, { blob: (x) => (x === id ? bytes : undefined) });
  const lines = whole.split("\n").filter(Boolean);
  expect(lines).toHaveLength(4); // two names, one blob
  expect(JSON.parse(lines[0]!)).toMatchObject({ events: 2, blobs: 1 });
  const p = parseKeelJsonl(whole);
  expect(p.ok && [...p.blobs.keys()]).toEqual([id]);
  expect(p.ok && Buffer.from(p.blobs.get(id)!).toString()).toBe("quarterly numbers\n");
  expect(p.ok && p.events.map((e) => e.data.images[0].name)).toEqual(["budget.txt", "release.txt"]);

  // One changed byte, a wrong size, a missing blob line, bytes no prompt names: nothing is accepted.
  const blob = JSON.parse(lines[3]!);
  const withBlob = (b: any) => [...lines.slice(0, 3), JSON.stringify(b)].join("\n") + "\n";
  const flipped = Buffer.from(bytes); flipped[0]! ^= 1;
  expect(parseKeelJsonl(withBlob({ ...blob, data: flipped.toString("base64") }))).toEqual({ ok: false, error: expect.stringContaining("do not match its digest") });
  expect(parseKeelJsonl(withBlob({ ...blob, size: blob.size + 1 }))).toEqual({ ok: false, error: expect.stringContaining("do not match its digest") });
  expect(parseKeelJsonl(lines.slice(0, 3).join("\n") + "\n")).toEqual({ ok: false, error: "incomplete export: expected 1 attached files, found 0" });
  const other = new TextEncoder().encode("not named");
  const stray = { blob: new Bun.CryptoHasher("sha256").update(other).digest("hex"), size: other.byteLength, data: Buffer.from(other).toString("base64") };
  expect(parseKeelJsonl([lines[0]!.replace('"blobs":1', '"blobs":2'), ...lines.slice(1), JSON.stringify(stray)].join("\n") + "\n")).toEqual({ ok: false, error: expect.stringContaining("none of its prompts names") });
});

test("an event that names another one names its copy after a Keel file round trip, never the source's", () => {
  const u1 = ev("user", { text: "one" });
  const a1 = ev("assistant", { blocks: [{ type: "text", text: "two" }] });
  const clear = ev("compaction", { mode: "clear", undo_head: a1.id });
  const u2 = ev("user", { text: "three" });
  // A summary made on another branch: what it replaced is not in this file.
  const sum = ev("compaction", { mode: "summary", summary: "S", covered: u1.id, from_event: u2.id, replaced_head: "id-on-another-branch" });
  const evs = [u1, a1, clear, u2, sum];
  const p = parseKeelJsonl(toKeelJsonl(s, evs));
  if (!p.ok) throw new Error(p.error);
  expect(p.events[2]!.data).toEqual({ mode: "clear", undo_head: "e2" });
  expect(p.events[4]!.data).toEqual({ mode: "summary", summary: "S", covered: "e1", from_event: "e4" });
  let k = 0;
  const { rows } = rowsOf(p, () => `new${++k}`);
  expect(rows[2]!.data.undo_head).toBe("new2");
  expect(rows[4]!.data).toEqual({ mode: "summary", summary: "S", covered: "new1", from_event: "new4" });
  const text = JSON.stringify(rows);
  for (const e of evs) expect(text).not.toContain(`"${e.id}"`);
  expect(text).not.toMatch(/"e\d+"/);
  // A version 1 file names a covered event by its old id: kept, as before.
  const v1 = parseKeelJsonl(JSON.stringify({ keel_export: 1 }) + "\n" + JSON.stringify({ kind: "compaction", data: { mode: "summary", covered: "old-id" } }) + "\n");
  expect(v1.ok && rowsOf(v1).rows[0]!.data.covered).toBe("old-id");
});

test("a whole-tree Keel file keeps every branch and the head shown; a tree that does not hold together is refused", () => {
  const at = (id: string, parent: string | null, kind: string, data: any): StoredEvent => ({ id, session_id: s.id, seq: ++n, parent, kind: kind as any, data, ts: n });
  const root = at("r", null, "user", { text: "root" });
  const a = at("a", "r", "user", { text: "leaf a" });
  const clear = at("c", "a", "compaction", { mode: "clear", undo_head: "a" });
  const b = at("b", "r", "user", { text: "leaf b" });
  const all = [root, a, clear, b];
  const file = toKeelJsonl(s, all, { tree: { head: "c" } });
  // Its own version: a Keel that reads only branch files (versions 1 and 2) says it is not a Keel export.
  expect(JSON.parse(file.split("\n")[0]!)).toMatchObject({ keel_export: 3, scope: "tree", head: "e3", events: 4 });
  const p = parseKeelJsonl(file);
  if (!p.ok) throw new Error(p.error);
  let k = 0;
  const { rows, head } = rowsOf(p, () => `new${++k}`);
  expect(rows.map((r) => [r.id, r.parent])).toEqual([["new1", null], ["new2", "new1"], ["new3", "new2"], ["new4", "new1"]]);
  expect(head).toBe("new3");
  expect(rows[2]!.data.undo_head).toBe("new2");
  // The branch file is as it was: a chain with no parents, the last event the head.
  const branch = parseKeelJsonl(toKeelJsonl(s, [root, a, clear]));
  expect(branch.ok && [branch.header.keel_export, branch.header.scope]).toEqual([2, "current branch"]);
  expect(branch.ok && rowsOf(branch)).toMatchObject({ rows: [{}, {}, {}] });
  expect(branch.ok && "head" in rowsOf(branch)).toBe(false);
  expect(branch.ok && branch.events.every((e) => !("parent" in e))).toBe(true);

  const lines = file.split("\n").filter(Boolean);
  const edit = (i: number, f: (o: any) => any) => lines.map((l, j) => (j === i ? JSON.stringify(f(JSON.parse(l))) : l)).join("\n") + "\n";
  expect(parseKeelJsonl(edit(2, (o) => ({ ...o, parent: "e4" })))).toEqual({ ok: false, error: expect.stringContaining("does not hold before it") });
  expect(parseKeelJsonl(edit(0, (o) => ({ ...o, head: "e9" })))).toEqual({ ok: false, error: expect.stringContaining("which of its branches is shown") });
  expect(parseKeelJsonl(edit(4, (o) => ({ ...o, ref: "e1" })))).toEqual({ ok: false, error: expect.stringContaining("no ref of its own") });
});

test("a resume handoff carries the active context only", () => {
  const before = ev("user", { text: "old rule" });
  const after = ev("user", { text: "new rule" });
  expect(activeContext([before, ev("compaction", { mode: "clear" }), after]).map((e) => e.data.text)).toEqual(["new rule"]);
  const sum = activeContext([before, ev("compaction", { mode: "summary", summary: "S" }), after]);
  expect(sum.map((e) => e.kind)).toEqual(["compaction", "user"]);
});

test("Codex resume adds display events without changing model history or Keel reimport", async () => {
  const summary = ev("compaction", { mode: "summary", summary: "Earlier context" });
  const prompt = ev("user", { text: "What changed?" });
  const steer = ev("user", { text: "Include the result", origin: "steer" });
  const delivered = [
    ev("user", { text: "Step budget", origin: "harness" }),
    ev("user", { text: "Restart context", origin: "restart" }),
    ev("user", { text: "Hook context", origin: "hook" }),
    ev("user", { text: "Automation steering", kind: "steer", origin: "steer" }),
    ev("user", { text: "Child report", kind: "subagent" }),
    ev("user", { text: "Peer context", kind: "peer" }),
    ev("user", { text: '<external_input source="peer_session">Legacy peer context</external_input>' }),
  ];
  const note = ev("note", { text: "Model only", model: true });
  const answer = ev("assistant", { blocks: [{ type: "text", text: "All good" }], model: "p:alpha" });
  const image = { type: "image", media_type: "image/png", data: "iVBORw0KGgo" };
  const next = ev("user", { text: "", images: [image] });
  const partial = ev("assistant", { blocks: [{ type: "text", text: "Checking" }] });
  const abort = ev("turn_end", { reason: "interrupted" });
  const continuation = ev("user", { text: "Continue interrupted work", origin: "harness" });
  const resumed = ev("assistant", { blocks: [{ type: "text", text: "Resumed" }], model: "p:beta" });
  const resumedEnd = ev("turn_end", { reason: "end_turn" });
  const start = ev("turn_start", {}, prompt.ts);
  const end = ev("turn_end", { reason: "end_turn" }, answer.ts);
  const evs = [
    summary, prompt, start, steer, ...delivered, note, answer, end, next, partial, abort, continuation, resumed, resumedEnd,
  ];
  const stamp = (e: StoredEvent) => new Date(e.ts).toISOString();
  const wire = (e: StoredEvent, type: string, payload: object) => ({ timestamp: stamp(e), type, payload });
  const message = (e: StoredEvent, role: string, content: object) => wire(e, "response_item", { type: "message", role, content: [content] });
  const modelHistory = [
    wire(summary, "session_meta", { id: "x", timestamp: stamp(summary), cwd: s.workspace, originator: "keel", cli_version: "0.0.0", source: "cli" }),
    wire(summary, "compacted", { message: "Earlier context" }),
    message(prompt, "user", { type: "input_text", text: "What changed?" }),
    message(steer, "user", { type: "input_text", text: "Include the result" }),
    ...delivered.map((e) => message(e, "user", { type: "input_text", text: e.data.text })),
    message(note, "user", { type: "input_text", text: "<keel_note>\nModel only\n</keel_note>" }),
    wire(answer, "turn_context", { cwd: s.workspace, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "alpha", summary: "auto" }),
    message(answer, "assistant", { type: "output_text", text: "All good" }),
    message(next, "user", { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo" }),
    message(partial, "assistant", { type: "output_text", text: "Checking" }),
    message(continuation, "user", { type: "input_text", text: "Continue interrupted work" }),
    wire(resumed, "turn_context", { cwd: s.workspace, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "beta", summary: "auto" }),
    message(resumed, "assistant", { type: "output_text", text: "Resumed" }),
  ];
  const before = toJsonl([...modelHistory.slice(0, -3), wire(abort, "event_msg", { type: "turn_aborted", reason: "interrupted" }), ...modelHistory.slice(-3)]);
  const after = toCodexRollout(s, evs, "x", 0);
  const rows = after.trimEnd().split("\n").map((json) => ({ json, row: JSON.parse(json) }));
  expect(rows.filter(({ row }) => row.type !== "event_msg").map(({ json }) => json + "\n").join("")).toBe(toJsonl(modelHistory));
  expect(rows.filter(({ row }) => row.type === "event_msg").map(({ row }) => row.payload)).toEqual([
    { type: "task_started", turn_id: summary.id },
    { type: "agent_message", message: "Summary of the earlier conversation (Keel)\n\nEarlier context" },
    { type: "task_complete", turn_id: summary.id },
    { type: "task_started", turn_id: prompt.id },
    { type: "user_message", message: "What changed?" },
    { type: "task_complete", turn_id: prompt.id },
    { type: "task_started", turn_id: steer.id },
    { type: "user_message", message: "Include the result" },
    { type: "agent_message", message: "All good" },
    { type: "task_complete", turn_id: steer.id },
    { type: "task_started", turn_id: next.id },
    { type: "user_message", message: "", images: ["data:image/png;base64,iVBORw0KGgo"] },
    { type: "agent_message", message: "Checking" },
    { type: "turn_aborted", turn_id: next.id, reason: "interrupted" },
    { type: "task_started", turn_id: continuation.id },
    { type: "agent_message", message: "Resumed" },
    { type: "task_complete", turn_id: continuation.id },
  ]);
  // Codex scans backward. Keep the hidden input and model setting between
  // the same turn markers without displaying the input as an owner prompt.
  const hiddenStart = rows.findIndex(({ row }) => row.payload.type === "task_started" && row.payload.turn_id === continuation.id);
  expect(rows.slice(hiddenStart + 1, hiddenStart + 3).map(({ row }) => row)).toEqual(modelHistory.slice(-3, -1));
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "", "keel-export-"));
  try {
    const oldPath = join(dir, "before.jsonl"), newPath = join(dir, "after.jsonl");
    writeFileSync(oldPath, before);
    writeFileSync(newPath, after);
    const old = await readCodex(oldPath), updated = await readCodex(newPath);
    expect(updated.events).toEqual(old.events);
    expect(updated.events.filter((e) => e.kind === "user").map((e) => e.data.text)).toEqual(["What changed?", "Include the result", ...delivered.map((e) => e.data.text), "", "Continue interrupted work"]);
    // Keel's own summary comes back as the checkpoint it was, not a note.
    expect(updated.events.filter((e) => e.kind === "compaction").map((e) => e.data.summary)).toEqual(["Earlier context"]);
    expect(updated.events.filter((e) => e.kind === "note").map((e) => e.data.text)).toEqual(["Model only"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a handoff to Claude Code writes the harness's inputs as turns no person typed, and the owner's prompts as they were", async () => {
  const evs = [
    ev("user", { text: "Fix the flaky test" }),
    ev("user", { text: "and the docs", origin: "steer" }),
    ev("user", { kind: "wake", text: "[harness] Your background command `make` exited with code 0." }),
    ev("user", { kind: "subagent", text: "Reports from agents you started follow." }),
    ev("user", { text: '<external_input source="peer_session" from="other">hi</external_input>' }),
    ev("user", { origin: "momentum", text: "[momentum] Your last turn ended early." }),
  ];
  const users = toClaudeRecords(s, forClaude(evs), "c9").filter((r: any) => r.type === "user") as any[];
  expect(users.map((r) => r.origin?.kind ?? null)).toEqual([null, null, "task-notification", "task-notification", "peer", "task-notification"]);
  expect(users.map((r) => r.promptSource ?? null)).toEqual([null, null, "system", "system", "system", "system"]);
  expect(users[4].turnOrigin).toBe("peer");
  // Keel reads the file back with the same words, none of them the owner's typing.
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "", "keel-export-"));
  try {
    writeFileSync(join(dir, "c9.jsonl"), toJsonl(users));
    const back = (await readClaude(join(dir, "c9.jsonl"))).events.filter((e) => e.kind === "user");
    expect(back.map((e) => e.data.text)).toEqual(evs.map((e) => e.data.text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("the resume line quotes a folder a shell would split or expand, and leaves a plain one as typed", () => {
  expect(resumeLine("/home/u/projects/keel-bun", "claude --resume x")).toBe("cd /home/u/projects/keel-bun && claude --resume x");
  expect(resumeLine("/w/it's a dir", "codex resume x")).toBe(`cd '/w/it'\\''s a dir' && codex resume x`);
  for (const dir of ["/w/a b", "/w/$HOME", "/w/a;b", "/w/`x`", "/w/a&b", "/w/~", "/w/*"]) expect(resumeLine(dir, "r")).toBe(`cd '${dir}' && r`);
});

test("a Keel file that would fail half way is refused whole, and one too large for an import is not written", () => {
  const bytes = new TextEncoder().encode("ledger\n");
  const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const file = { type: "attachment", id, name: "ledger.txt", media_type: "text/plain", size: bytes.byteLength };
  const whole = toKeelJsonl(s, [ev("user", { text: "one", images: [file] })], { blob: () => bytes });
  const lines = whole.split("\n").filter(Boolean);
  expect(parseKeelJsonl(whole).ok).toBe(true);
  // The event line changed in one way; the header and the blob line are as they were.
  const withEvent = (f: (o: any) => any) => [lines[0], JSON.stringify(f(JSON.parse(lines[1]!))), lines[2]].join("\n") + "\n";
  const refused = (text: string, words: string) => expect(parseKeelJsonl(text)).toEqual({ ok: false, error: expect.stringContaining(words) });
  for (const data of [undefined, null, "text", 7, []]) refused(withEvent((o) => ({ ...o, data })), "has no data");
  for (const images of ["x", { 0: file }, 3]) refused(withEvent((o) => ({ ...o, data: { ...o.data, images } })), "does not list what it carries");
  for (const name of [".", "..", "", "  ", 7, null, undefined, { a: 1 }]) refused(withEvent((o) => ({ ...o, data: { ...o.data, images: [{ ...file, name }] } })), "without a usable name or id");
  refused(withEvent((o) => ({ ...o, data: { ...o.data, images: [{ ...file, id: 5 }] } })), "without a usable name or id");
  refused(withEvent((o) => ({ ...o, data: { ...o.data, images: [{ ...file, charset: {} }] } })), "without a usable name or id");
  // A file line over what an upload may be is refused before its bytes are decoded.
  const blob = JSON.parse(lines[2]!);
  refused([lines[0], lines[1], JSON.stringify({ ...blob, size: 20 * 1024 * 1024 + 1 })].join("\n") + "\n", "larger than a file can be (20 MB)");
  refused([lines[0], lines[1], JSON.stringify({ ...blob, data: "A".repeat(28 * 1024 * 1024) })].join("\n") + "\n", "larger than a file can be (20 MB)");

  // Five files of 30 MiB do not fit a file an import takes: said with the total, and no stored file is read.
  const big = Array.from({ length: 5 }, (_, i) => ({ type: "attachment", id: `${i}`.repeat(64), name: `big-${i}.bin`, media_type: "application/octet-stream", size: 30 * 1024 * 1024 }));
  let read = 0;
  const make = (max: number) => toKeelJsonl(s, [ev("user", { text: "big", images: big })], { blob: () => (read++, bytes), size: () => 30 * 1024 * 1024, max });
  expect(() => make(128 * 1024 * 1024)).toThrow("with its attached files (150 MB in all) the Keel file would be about 200 MB, and another Keel takes at most 128 MB");
  expect(read).toBe(0);
  expect(make(256 * 1024 * 1024).split("\n").filter((l) => l.startsWith('{"blob"'))).toHaveLength(5);
  // The same bound holds without files: a conversation too long for an import is said so.
  expect(() => toKeelJsonl(s, [ev("user", { text: "x".repeat(5000) })], { max: 6000 })).toThrow("the Keel file would be about");
});
