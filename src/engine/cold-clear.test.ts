import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { clearedText, CLEAR_GAIN, KEEP_NEWEST, pickCleared } from "./cold-clear.ts";
import { toMessages } from "./turn.ts";

let seq = 0;
const ev = (kind: StoredEvent["kind"], data: any): StoredEvent => ({ id: `e${++seq}`, session_id: "s", seq, parent: null, kind, data, ts: seq });
const asks = (t: string) => t === "ask_user";
const big = (n: number, c = "x") => c.repeat(n);

// One step: the model thinks and calls a tool, the tool answers.
const step = (id: string, name: string, input: unknown, text: string, extra: Partial<{ err: boolean }> = {}): StoredEvent[] => [
  ev("assistant", { blocks: [{ type: "thinking", thinking: big(3000, "t"), signature: "s", bind: "b" }, { type: "tool_use", id, name, input }], model: "m", usage: {} }),
  ev("tool_result", { results: [{ type: "tool_result", tool_use_id: id, content: text, ...(extra.err ? { is_error: true } : {}) }] }),
];

function line(n = 14): StoredEvent[] {
  seq = 0;
  const out: StoredEvent[] = [ev("user", { text: "first task" })];
  for (let i = 0; i < n; i++) out.push(...step(`t${i}`, "Read", { file_path: `/repo/f${i}.ts` }, big(4000, String(i % 10))));
  out.push(ev("assistant", { blocks: [{ type: "text", text: "done" }], model: "m", usage: {} }));
  out.push(ev("user", { text: "second task, an hour later" }));
  return out;
}

const resultText = (m: ReturnType<typeof toMessages>, id: string) => {
  for (const x of m) for (const b of x.content as any[]) if (b.type === "tool_result" && b.tool_use_id === id) return typeof b.content === "string" ? b.content : b.content.map((c: any) => c.text).join("");
  return undefined;
};

test("a cold point clears old results but the newest ones, and earlier thinking", () => {
  const l = line();
  const pick = pickCleared(l, 0, { thinking: true, asks })!;
  expect(pick.ids).toEqual(["t0", "t1", "t2", "t3"]); // 14 results, the newest KEEP_NEWEST stay
  expect(14 - pick.ids.length).toBe(KEEP_NEWEST);
  expect(pick.thinking).toBe(l.findLast((e) => e.kind === "user")!.seq);
  expect(pick.files.map((f) => f.id)).toEqual(pick.ids); // none of them has a file yet
});

test("the projection after the note holds stubs and the same bytes on every later request; a warm one is untouched", () => {
  const l = line();
  const before = JSON.stringify(toMessages(l));
  const pick = pickCleared(l, 0, { thinking: true, asks })!;
  const note = ev("note", { kind: "cleared", text: clearedText(pick), ids: pick.ids, dir: "/spill/s", chars: pick.chars, thinking: pick.thinking });
  const cold = [...l, note];
  const m = toMessages(cold);
  expect(resultText(m, "t0")).toContain("the result of Read /repo/f0.ts, 4,000 characters");
  expect(resultText(m, "t0")).toContain("/spill/s/cleared/t0.txt");
  expect(resultText(m, "t4")!.length).toBe(4000);
  // Thinking before the last prompt goes to the wire marked stale (it takes out that oldest run); the newest turn keeps its own.
  const think = m.flatMap((x) => (x.role === "assistant" ? (x.content as any[]) : [])).filter((b) => b.type === "thinking");
  expect(think.length).toBe(14);
  expect(think.every((b) => b.bind === "stale")).toBe(true);
  // The same bytes again, and with later events added: the cleared part is a stable prefix from there on.
  const later = [...cold, ...step("t14", "Read", { file_path: "/repo/g.ts" }, big(4000, "z"))];
  const a = JSON.stringify(toMessages(cold)), b = JSON.stringify(toMessages(later));
  expect(a).toBe(JSON.stringify(m));
  expect(b.startsWith(a.slice(0, -2))).toBe(true);
  // Without the note (a warm session, or a branch from before it) the projection is the one every earlier request sent.
  expect(JSON.stringify(toMessages(l))).toBe(before);
  expect(before).toContain("0".repeat(100));
  expect(a.length).toBeLessThan(before.length - 4 * 3600);
});

test("what the model may need stays: errors, the owner's answers, results that were not text, a file a later call edited", () => {
  seq = 0;
  const l: StoredEvent[] = [ev("user", { text: "go" })];
  l.push(...step("err", "Bash", { command: "make" }, big(5000), { err: true }));
  l.push(...step("ask", "ask_user", { q: "which?" }, big(5000)));
  l.push(ev("assistant", { blocks: [{ type: "tool_use", id: "img", name: "Read", input: { file_path: "/a.png" } }], model: "m", usage: {} }));
  l.push(ev("tool_result", { results: [{ type: "tool_result", tool_use_id: "img", content: [{ type: "text", text: big(5000) }, { type: "image", media_type: "image/png", data: "AAAA" }] }] }));
  l.push(...step("read", "Read", { file_path: "/repo/edited.ts" }, big(5000)));
  l.push(...step("edit", "Edit", { file_path: "/repo/edited.ts", old: "a", new: "b" }, "ok"));
  l.push(...step("plain", "Read", { file_path: "/repo/plain.ts" }, big(13000)));
  l.push(...step("short", "Read", { file_path: "/repo/short.ts" }, big(900)));
  for (let i = 0; i < KEEP_NEWEST; i++) l.push(...step(`n${i}`, "Read", { file_path: `/n${i}` }, "tiny"));
  l.push(ev("user", { text: "later" }));
  const pick = pickCleared(l, 0, { thinking: false, asks });
  expect(pick?.ids).toEqual(["plain"]);
  expect(pick?.thinking).toBeUndefined();
});

test("nothing is cleared when the gain is small, and a result already cleared is not again", () => {
  seq = 0;
  const small: StoredEvent[] = [ev("user", { text: "go" }), ...step("a", "Read", { file_path: "/a.ts" }, big(2000))];
  for (let i = 0; i < KEEP_NEWEST; i++) small.push(...step(`n${i}`, "Read", { file_path: `/n${i}` }, "tiny"));
  expect(pickCleared(small, 0, { thinking: false, asks })).toBeUndefined();
  const l = line();
  const pick = pickCleared(l, 0, { thinking: true, asks })!;
  const cold = [...l, ev("note", { kind: "cleared", text: "x", ids: pick.ids, dir: "/d", chars: pick.chars, thinking: pick.thinking })];
  expect(pickCleared(cold, 0, { thinking: true, asks })).toBeUndefined();
  expect(CLEAR_GAIN).toBeGreaterThan(0);
});

test("a result that a cut already saved to a file names that file, and no second copy is written", () => {
  seq = 0;
  const cutText = `${big(2000)}\n\n[... 9000 chars cut; full output (120 lines) saved to /spill/s/1-Bash-ab.txt ...]\n\n${big(2000)}`;
  const l: StoredEvent[] = [ev("user", { text: "go" }), ...step("a", "Bash", { command: "cargo test" }, cutText)];
  for (let i = 0; i < KEEP_NEWEST; i++) l.push(...step(`n${i}`, "Read", { file_path: `/n${i}` }, "tiny"));
  l.push(ev("user", { text: "again" }));
  const pick = pickCleared(l, 0, { thinking: true, asks })!;
  expect(pick.ids).toEqual(["a"]);
  expect(pick.files).toEqual([]);
  const m = toMessages([...l, ev("note", { kind: "cleared", text: "x", ids: ["a"], dir: "/spill/s", chars: 1 })]);
  expect(resultText(m, "a")).toContain("/spill/s/1-Bash-ab.txt");
  expect(resultText(m, "a")).toContain("Bash cargo test");
});

test("a result after the last prompt stays, and a turn that holds thinking clears no result on the Anthropic wire", () => {
  seq = 0;
  const l: StoredEvent[] = [ev("user", { text: "go" })];
  for (let i = 0; i < 4; i++) l.push(...step(`old${i}`, "Read", { file_path: `/old${i}.ts` }, big(5000)));
  l.push(ev("assistant", { blocks: [{ type: "text", text: "done" }], model: "m", usage: {} }));
  l.push(ev("user", { text: "next" }));
  // The turn the prompt opened: twelve big results of its own, none of them cleared, whatever the keep count.
  for (let i = 0; i < 12; i++) l.push(...step(`new${i}`, "Read", { file_path: `/new${i}.ts` }, big(5000)));
  const pick = pickCleared(l, 0, { thinking: false, asks, keep: 0 })!;
  expect(pick.ids).toEqual(["old0", "old1", "old2", "old3"]);
  // On the Anthropic wire that turn's own thinking is bound to the prefix a stub would change: no result is cleared
  // (the earlier thinking alone may go: a thinking block's fingerprint leaves thinking out).
  const t = pickCleared(l, 0, { thinking: true, asks, keep: 0 })!;
  expect(t.ids).toEqual([]);
  expect(t.thinking).toBe(l.findLast((e) => e.kind === "user")!.seq);
  // At the start of a turn (its prompt is the last event) results and earlier thinking go together.
  const start = [...l.slice(0, 10), ev("user", { text: "again" })];
  const p = pickCleared(start, 0, { thinking: true, asks, keep: 0 })!;
  expect(p.ids.length).toBeGreaterThan(0);
  expect(p.thinking).toBe(start.at(-1)!.seq);
});
