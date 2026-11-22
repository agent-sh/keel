// What a compaction keeps of the owner's own messages: newest first within the
// text budget, the message that crosses it as a marked excerpt with its files,
// and files newest first within the media budget, older ones named as gone.
// The context estimate counts what the next request carries: a declined reply
// adds nothing, a note for the model adds its text, an attached text file adds
// its size, and bytes are UTF-8 bytes.
import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { BYTES_PER_TOKEN, countPaced, contextBytes, bytesPerToken, capRatio, contextTokens, learnRatio, partPrompt, preparedHolds, replyBytes, transcriptParts, transcriptPartsPaced, TRANSCRIPT_PARTS_MAX, OWNER_MEDIA_BYTES, OWNER_WORDS_BYTES, keptMessages, checkpointData, settle, summarizable, summaryMessage, utf8Bytes } from "./compact.ts";

let seq = 0;
const ev = (kind: string, data: any) => ({ id: `e${++seq}`, session_id: "s", seq, ts: seq, kind, data }) as any;
const measured = [ev("user", { text: "hi" }), ev("assistant", { blocks: [{ type: "text", text: "ok" }], usage: { input: 100, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn" })];
const tail = (...e: any[]) => contextTokens([...measured, ...e]).estimated;

test("the estimated tail follows the next request", () => {
  expect(tail(ev("assistant", { blocks: [{ type: "text", text: "x".repeat(4000) }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "refusal" }))).toBe(0);
  expect(tail(ev("note", { text: "x".repeat(4000) }))).toBe(0);
  expect(tail(ev("note", { text: "x".repeat(4000), model: true }))).toBe(4000 / BYTES_PER_TOKEN);
  const file = { type: "attachment", id: "a".repeat(64), name: "log.txt", media_type: "text/plain", size: 96_000 };
  expect(tail(ev("user", { text: "", images: [file] }))).toBeGreaterThan(24_000);
  expect(utf8Bytes("מוכן")).toBe(8);
  expect(utf8Bytes("🌍")).toBe(4);
  expect(tail(ev("user", { text: "ש".repeat(1000) }))).toBe(2000 / BYTES_PER_TOKEN);
});

const file = (name: string, size: number) => ({ type: "attachment", id: "0".repeat(64), name, media_type: "application/pdf", size });

test("the message that crosses the text budget keeps a marked excerpt and its file", () => {
  for (const size of [OWNER_WORDS_BYTES - 1, OWNER_WORDS_BYTES, OWNER_WORDS_BYTES + 1]) {
    const paste = "x".repeat(size - 3) + "END";
    const line = [ev("user", { text: "a" }), ev("user", { text: paste, images: [file("ref.txt", 12)] })];
    const { owner_messages: words, owner_media, owner_messages_shortened } = keptMessages(line);
    const media = owner_media!;
    if (size < OWNER_WORDS_BYTES) expect(words).toEqual(["a", paste]);
    else if (size === OWNER_WORDS_BYTES) expect(words).toEqual([paste]);
    else {
      expect(words).toHaveLength(1);
      expect(words[0]).toMatch(/^x+\n\[\.\.\. \d+ bytes of this message were left out of the compacted context \.\.\.\]\nx*END$/);
      expect(Buffer.byteLength(words[0]!)).toBeLessThanOrEqual(OWNER_WORDS_BYTES);
    }
    expect(owner_messages_shortened).toBe(size > OWNER_WORDS_BYTES ? 1 : undefined);
    expect(media.at(-1)).toEqual([file("ref.txt", 12)] as any);
  }
});

test("files travel with their message through repeated compactions, the older one named when it no longer fits", () => {
  const half = OWNER_MEDIA_BYTES / 2;
  const run = (newer: number) => {
    const first = [ev("user", { text: "older caption", images: [file("a.pdf", half)] })];
    const c1 = ev("compaction", { mode: "summary", summary: "s1", ...keptMessages(first) });
    const second = [...first, c1, ev("user", { text: "newer caption", images: [file("b.pdf", newer)] })];
    const c2 = ev("compaction", { mode: "summary", summary: "s2", ...keptMessages(second) });
    const third = [...second, c2];
    const c3 = ev("compaction", { mode: "summary", summary: "s3", ...keptMessages(third) });
    return summaryMessage(c3.data).content.slice(1);
  };
  expect(run(half)).toEqual([file("a.pdf", half), { type: "text", text: "<message>\nolder caption\n</message>" }, file("b.pdf", half), { type: "text", text: "<message>\nnewer caption\n</message>" }] as any);
  const over = run(half + 1);
  expect(over[0]).toEqual({ type: "text", text: "[An attached file (a.pdf) the owner sent with this message is no longer in the context.]" });
  expect(over.slice(1)).toEqual([{ type: "text", text: "<message>\nolder caption\n</message>" }, file("b.pdf", half + 1), { type: "text", text: "<message>\nnewer caption\n</message>" }] as any);
});

// Only the owner's own words are kept as their: reports, wakes, loop runs,
// tasks, peers, momentum and hooks are kept under their own heading in what
// their words leave of the budget; the harness's own instructions are not kept.
test("delivered inputs never count as the owner's words", () => {
  const report = (k: number) => ev("user", { text: `<subagent_result agent_id="a${k}">${"r".repeat(15_000)}</subagent_result>`, kind: "subagent" });
  const line = [
    ev("user", { text: `the owner's ask ${"o".repeat(2_000)}` }),
    report(1), report(2), report(3), report(4),
    ev("user", { text: "loop run", kind: "loop" }), ev("user", { text: "from a peer", kind: "peer" }), ev("user", { text: "momentum item", origin: "momentum" }),
    ev("user", { text: "said aloud", origin: "voice" }), ev("user", { text: "steered", origin: "steer" }),
    ev("user", { text: "[harness] Continue.", origin: "harness" }), ev("user", { text: "[harness] schema", kind: "harness" }),
  ];
  const kept = keptMessages(line, 50_000);
  expect(kept.owner_messages).toEqual([line[0]!.data.text, "said aloud", "steered"]);
  expect(kept.other_messages!.slice(-3)).toEqual(["loop run", "from a peer", "momentum item"]);
  expect(kept.other_messages!.join("")).not.toContain("[harness]");
  expect(kept.other_messages_shortened).toBe(1);
  const text = (summaryMessage({ summary: "s", ...kept }).content[0] as any).text as string;
  expect(text.indexOf("<subagent_result")).toBeGreaterThan(text.indexOf("[Other messages delivered before the compaction"));
  expect(text.indexOf("[Other messages")).toBeGreaterThan(text.indexOf("said aloud"));
  // A later compaction keeps each side from the first one's record.
  const again = keptMessages([...line, ev("compaction", { mode: "summary", summary: "s", ...kept })], 50_000);
  expect(again.owner_messages).toEqual(kept.owner_messages);
  expect(again.other_messages).toEqual(kept.other_messages);
});

// A compaction at the start of a turn summarizes what came before the prompts
// that opened it, whoever sent them; once the turn has a reply, everything.
test("the prompts that open a turn stay out of its first compaction", () => {
  const old = [ev("user", { text: "old" }), ev("turn_start", {}), ev("assistant", { blocks: [], stop: "end_turn" }), ev("turn_end", {})];
  for (const meta of [{}, { origin: "voice" }, { origin: "momentum" }, { kind: "subagent" }]) {
    const opening = [ev("user", { text: "now", ...meta }), ev("user", { text: "and this", origin: "queued" }), ev("turn_start", {}), ev("note", { text: "memory", model: true })];
    expect(summarizable([...old, ...opening])).toEqual(old);
  }
  const mid = [...old, ev("user", { text: "now" }), ev("turn_start", {}), ev("assistant", { blocks: [], stop: "tool_use" })];
  expect(summarizable(mid)).toEqual(mid);
  expect(summarizable(old)).toEqual(old);
});

// A history no provider has counted (an imported one) is estimated whole at
// the model's bytes a token; a model's ratio follows what its provider reports.
test("an unmeasured history is counted at the model's own bytes a token", () => {
  const big = [ev("user", { text: "go" }), ev("assistant", { blocks: [{ type: "text", text: "x".repeat(100_000) }], stop: "end_turn", imported: true })];
  const t = contextTokens(big, "lab:dense");
  expect(t.measured).toBe(0);
  expect(t.used).toBeGreaterThan(100_000 / BYTES_PER_TOKEN);
  // Too small a request teaches nothing; each real one, the first too, moves the ratio a fifth of the way.
  expect(learnRatio("lab:dense", 3_000, 1_000)).toBeUndefined();
  expect(learnRatio("lab:dense", 400_000, 100_000)).toBeCloseTo(2.8);
  expect(learnRatio("lab:dense", 300_000, 100_000)).toBeCloseTo(2.84);
  expect(bytesPerToken("lab:dense")).toBeCloseTo(2.84);
  expect(bytesPerToken("lab:never-seen")).toBe(BYTES_PER_TOKEN);
  expect(contextTokens(big, "lab:dense").used).toBeLessThan(t.used);
  // A request refused as over the window proves a lower ratio; one that proves nothing new changes nothing.
  expect(capRatio("lab:dense", 400_000, 100_000)).toBeUndefined();
  expect(capRatio("lab:dense", 200_000, 100_000)).toBeCloseTo(1.8);
  expect(contextTokens(big, "lab:dense").used).toBeGreaterThan(t.used);
});

// The ratio counts what the provider tokenizes: a thought's signature and the
// block framing are not in a reply's bytes.
test("a reply counts its words, thinking and calls, not signatures", () => {
  const reply = [{ type: "thinking", thinking: "abcd", signature: "S".repeat(50_000) }, { type: "redacted_thinking", data: "R".repeat(9_000) }, { type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "Bash", input: { c: 1 } }] as any;
  expect(replyBytes(reply)).toBe(4 + 5 + 4 + 7);
});

// An idle summary stays whole when its own request stored a job notice after
// what it covers; an owner's prompt after it makes it partial.
test("a prepared summary holds through notes, not through new words", () => {
  const reply = ev("assistant", { blocks: [{ type: "text", text: "done" }], stop: "end_turn" });
  const line = [ev("user", { text: "go" }), reply, ev("turn_end", {}), ev("note", { kind: "job", text: "job 1 ended", model: true })];
  expect(preparedHolds(line, reply.id, true)).toBe(true);
  expect(preparedHolds([...line, ev("user", { text: "more" })], reply.id, true)).toBe(false);
  expect(preparedHolds([...line, ev("user", { text: "more" })], reply.id, false)).toBe(true);
  expect(preparedHolds(line, "gone", false)).toBe(false);
  const quote = "Read the report.";
  const retirement = { statements_done: [quote] };
  const above = (kind?: "standing" | "request") => [ev("compaction", { mode: "summary", statements: [{ by: "owner", text: quote, ...(kind ? { kind } : {}) }] }), ...line];
  expect(preparedHolds(above(), reply.id, true, retirement)).toBe(false);
  expect(preparedHolds(above("standing"), reply.id, false, retirement)).toBe(false);
  expect(preparedHolds(above("request"), reply.id, true, retirement)).toBe(true);
});

const turn = (n: number, out: string) => [
  { role: "user" as const, content: [{ type: "text" as const, text: `prompt ${n}` }] },
  { role: "assistant" as const, content: [{ type: "thinking", thinking: "hidden", signature: "s" } as any, { type: "tool_use" as const, id: `t${n}`, name: "Bash", input: { command: `run ${n}` } }] },
  { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: `t${n}`, content: out }] },
  { role: "assistant" as const, content: [{ type: "text" as const, text: `done ${n}` }] },
];

test("a history too long for one request: outputs shortened oldest first, then parts", () => {
  const msgs = [1, 2, 3, 4].flatMap((n) => turn(n, `START${n} ${"o".repeat(6_000)} END${n}`));
  // It fits: one part, nothing shortened, no reasoning in it.
  const whole = transcriptParts(msgs, 100_000);
  expect(whole.parts).toHaveLength(1);
  expect(whole.clipped).toBe(0);
  expect(whole.parts[0]).not.toContain("hidden");
  expect(whole.parts[0]).toContain("[assistant called Bash (t3)]");
  // A little over: only the oldest outputs lose their middle, and it is still one part.
  const some = transcriptParts(msgs, 16_000);
  expect(some.parts).toHaveLength(1);
  expect(some.clipped).toBe(3);
  expect(some.parts[0]).toMatch(/START1 o+\n\[\.\.\. \d+ bytes/);
  expect(some.parts[0]).toContain(`START4 ${"o".repeat(6_000)} END4`);
  // Far over: every output shortened and the transcript in parts, oldest first,
  // each within the budget, with every prompt and reply in exactly one of them.
  const long = [...Array(30).keys()].flatMap((n) => turn(n, "o".repeat(6_000)));
  const cut = transcriptParts(long, 20_000);
  expect(cut.clipped).toBe(30);
  expect(cut.parts.length).toBeGreaterThan(2);
  for (const p of cut.parts) expect(utf8Bytes(p)).toBeLessThanOrEqual(20_000);
  const joined = cut.parts.join("");
  for (let n = 0; n < 30; n++) expect(joined.split(`[user]\nprompt ${n}\n`)).toHaveLength(2);
  expect(joined.indexOf("prompt 3\n")).toBeLessThan(joined.indexOf("prompt 17\n"));
  // One message larger than a part goes on in the next parts, all of it read.
  const text = `HEAD ${"g".repeat(25_000)}ש MIDDLE ${"g".repeat(25_000)} TAIL`;
  const giant = transcriptParts([{ role: "user", content: [{ type: "text", text }] }, ...turn(1, "short")], 5_000);
  expect(giant.parts.length).toBeGreaterThan(10);
  for (const p of giant.parts) expect(utf8Bytes(p)).toBeLessThanOrEqual(5_000);
  expect(giant.parts.join("")).toStartWith(`[user]\n${text}\n[user]\nprompt 1`);
  // A later part's request carries the summary so far and says more follows.
  const mid = partPrompt("PART", 1, 3, "SO FAR", 30);
  expect(mid).toContain("<summary>\nSO FAR\n</summary>");
  expect(mid).toContain('<transcript part="2" of="3">');
  expect(mid).toContain("The next part follows");
  expect(partPrompt("PART", 2, 3, "SO FAR", 0, "the port")).toContain("Keep above all: the port");
});

// A summary's statements stand only in the words that were said: a quote is
// checked against the stored conversation and given back as its whole
// sentences, a retelling close to one sentence gets that sentence's words, one
// that says something nothing said is left out and counted, and the last
// summary's statements are carried until lifted; only scoped requests can be
// marked done.
test("statements are the conversation's own words, carried until lifted", () => {
  const said = [
    ev("user", { text: "Start on the export. Never run the migrations against staging; use the local copy. Also do not touch vendor/." }),
    ev("assistant", { blocks: [{ type: "text", text: "We settled on integer cents for every amount." }], stop: "end_turn" }),
    ev("user", { text: "Always run the linter before the tests." }),
  ];
  const first = settle(said, [
    "## Statements",
    '- owner: "Never run the migrations against staging"', // cut inside its sentence
    '- owner: "Do not touch vendor/."',
    '- owner: "Always run the linter before running the tests."', // retold, the same words nearly
    '- owner: "Prefer not to deploy on Fridays."', // nothing said it
    '- owner: "Keep above all: the export."', // the harness's request, not the conversation: skipped
    '- owner: "We settled on integer cents for every amount."', // the work said it
    "## Requests",
    '- owner: "Start on the export."',
    "## Lifted",
    "## Story",
    "1. Goal: the export.",
  ].join("\n"));
  expect(first.statements).toEqual([
    { by: "owner", text: "Never run the migrations against staging; use the local copy.", kind: "standing" },
    { by: "owner", text: "Also do not touch vendor/.", kind: "standing" },
    { by: "owner", text: "Always run the linter before the tests.", kind: "standing" },
    { by: "work", text: "We settled on integer cents for every amount.", kind: "standing" },
    { by: "owner", text: "Start on the export.", kind: "request" },
  ]);
  expect(first.statements_dropped).toEqual(["Prefer not to deploy on Fridays."]);
  expect(first.summary).toContain("## Story\n1. Goal: the export.");
  expect(first.summary).toContain("1 statement the summary did not quote word for word was left out");

  // Omission and a purported lift that uses only the assistant's words do not drop anything.
  const cp = ev("compaction", { mode: "summary", ...checkpointData(said, first.summary) });
  const later = [
    ...said, cp,
    ev("assistant", { blocks: [{ type: "text", text: "The vendor rule is over." }], stop: "end_turn" }),
    ev("user", { text: "The vendor rule is over: you may edit vendor/ now." }),
  ];
  const forgot = checkpointData(later.slice(0, -1), ['## Statements', '- owner: "Always run the linter before the tests."', "## Lifted", '- "Also do not touch vendor/." lifted by: "The vendor rule is over."', "## Story", "x"].join("\n"));
  expect(forgot.statements!.map((s) => s.text)).toEqual(first.statements!.map((s) => s.text));
  // Lifted by the owner's own words: gone, and said so.
  const lifted = checkpointData(later, ['## Statements', "## Lifted", '- "do not touch vendor/" lifted by: "The vendor rule is over: you may edit vendor/ now."', "## Story", "x"].join("\n"));
  expect(lifted.statements!.map((s) => s.text)).not.toContain("Also do not touch vendor/.");
  expect(lifted.statements!.length).toBe(4);
  expect(lifted.statements_lifted).toEqual([{ text: "Also do not touch vendor/.", by: "The vendor rule is over: you may edit vendor/ now." }]);
  // An exact lifted request must not select the longer standing rule containing it.
  const overlap = [
    { by: "owner", kind: "standing", text: "Rule for every export: Run the smoke tests." },
    { by: "owner", kind: "request", text: "Run the smoke tests." },
  ] as const;
  const liftRequest = settle([ev("user", { text: "Skip this one-off smoke test request." })], [
    "## Statements", "## Lifted", '- "Run the smoke tests." lifted by: "Skip this one-off smoke test request."', "## Story", "x",
  ].join("\n"), [...overlap]);
  expect(liftRequest.statements).toEqual([overlap[0]]);

  // Done can retire a scoped request, but not a standing rule, even if refiled as a request.
  const finish = [
    "## Statements", "## Requests", '- owner: "Always run the linter before the tests."',
    "## Done", '- "Always run the linter before the tests."', '- "Start on the export."', '- "Ship it."',
    "## Story", "x",
  ].join("\n");
  const finished = checkpointData(later, finish, 0);
  expect(finished.statements).toContainEqual({ by: "owner", text: "Always run the linter before the tests.", kind: "standing" });
  expect(finished.summary).toContain('- owner: "Always run the linter before the tests."');
  expect(finished.statements!.map((s) => s.text)).not.toContain("Start on the export.");
  expect(finished.statements_done).toEqual(["Start on the export."]);
  expect(finished.summary).toContain("1 earlier request the summary marked done was left out.");
  // A legacy checkpoint has no completion classification. A rewrite cannot grant one.
  const legacy = ev("compaction", {
    mode: "summary", statements: first.statements!.map(({ by, text }) => ({ by, text })),
  });
  const carried = checkpointData([...said, legacy], finish, 0);
  expect(carried.statements).toEqual(first.statements!.map((s) => ({ ...s, kind: "standing" })));
  expect(carried.statements_done).toBeUndefined();
  // A handoff note with no statements part keeps its text and the statements before it.
  const handoff = checkpointData(later, "Goal: go on with the export.");
  expect(handoff.statements!.length).toBe(5);
  expect(handoff.summary).toEndWith("## Story\nGoal: go on with the export.");
});

// Instruction files of subfolders, skills and MCP prompts the conversation
// loaded go through every compaction unchanged, the newest copy of each.
test("fixed context is carried unchanged through compactions", () => {
  const nested = (v: string) => `<nested-instructions path="/w/pkg/AGENTS.md">\nInstructions ${v}\n</nested-instructions>`;
  const line = [
    ev("user", { text: "go" }),
    ev("tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: `file text\n\n${nested("one")}` }] }),
    ev("tool_result", { results: [{ type: "tool_result", tool_use_id: "t2", content: "Base directory for this skill: /s/review\n\nReview steps." }] }),
    ev("tool_result", { results: [{ type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: `other\n${nested("two")}` }] }] }),
  ];
  const one = checkpointData(line, "story");
  expect(one.fixed).toEqual([
    { key: "skill:/s/review", text: "Base directory for this skill: /s/review\n\nReview steps." },
    { key: "nested:/w/pkg/AGENTS.md", text: nested("two") },
  ]);
  const cp = ev("compaction", { mode: "summary", ...one });
  const moved = (to: string) => ev("note", { kind: "folder", model: true, from: "/a", to, text: `[harness] The owner moved this session from /a to ${to}. Work in ${to} now.` });
  const two = checkpointData([...line, cp, moved("/b"), ev("note", { model: true, mcp_prompt: "p", text: '<mcp-prompt server="docs" name="style">\nWrite short.\n</mcp-prompt>' }), moved("/c")], "story 2");
  expect(two.fixed!.map((f) => f.key)).toEqual(["skill:/s/review", "nested:/w/pkg/AGENTS.md", "mcp-prompt:docs/style", "folder:place"]);
  expect(two.fixed!.at(-1)!.text).toContain("Work in /c now.");
  const text = (summaryMessage({ ...two, owner_messages: [] }).content[0] as any).text as string;
  expect(text).toContain(nested("two"));
  expect(text).toContain("Review steps.");
});

// The byte count is the encoder's: a lone surrogate is the replacement
// character (three bytes) and does not swallow the unit after it.
test("utf8Bytes counts what UTF-8 encoding writes, also for malformed UTF-16", () => {
  for (const s of ["plain text", "caf\u00e9 \u05e9\u05dc\u05d5\u05dd \u65e5\u672c", "ok \ud83d\ude00 done", "\ud83dA", "\ud83d\ud83d", "\ud83d\ud83d\ude00", "\ude00x", "end \ud83d", ""]) {
    expect([s, utf8Bytes(s)]).toEqual([s, Buffer.byteLength(s)]);
  }
});

// The count after a session moved to another model, and after a reply that
// measured nothing.
test("another model's reply is a floor, not the count; an interrupted reply with no usage is passed over", () => {
  const usage = (n: number) => ({ input: 10, cache_read: n, cache_write: 0, output: 0 });
  const reply = (model: string, n: number, text = "ok") => ev("assistant", { blocks: [{ type: "text", text }], model, stop: "end_turn", usage: usage(n) });
  // 100 KB of history that q:other measured at 62,000 tokens (its count holds its system prompt and tools).
  const line = [ev("user", { text: "x".repeat(50_000) }), reply("q:other", 62_000 - 10, "y".repeat(50_000)), ev("user", { text: "next" })];
  const bytes = Math.round(100_004 / BYTES_PER_TOKEN);
  // For the model that measured it: its own count plus what came since.
  expect(contextTokens(line, "q:other")).toMatchObject({ used: 62_000 + 2, measured: 62_000 });
  // For another model: never lower than that, though its own bytes count comes to less.
  expect(contextTokens(line, "lab:moved")).toMatchObject({ used: 62_000 + 2, measured: 62_000 });
  expect(bytes).toBeLessThan(62_000);
  // When the bytes come to more than the other model measured, the bytes stand.
  const low = [line[0]!, reply("q:other", 20_000, "y".repeat(50_000)), line[2]!];
  expect(contextTokens(low, "lab:moved")).toMatchObject({ used: bytes, measured: 0 });
  // With what every request carries before the conversation: added to a count that is bytes alone, not to a measured one.
  expect(contextTokens(low, "lab:moved", 21_000).used).toBe(bytes + 21_000);
  expect(contextTokens(line, "lab:moved", 21_000).used).toBe(Math.max(62_002, bytes + 21_000));
  expect(contextTokens(line, "q:other", 21_000).used).toBe(62_002);
  // Once the new model has replied, its own count is the count.
  const own = [...line, reply("lab:moved", 30_000), ev("user", { text: "more" })];
  expect(contextTokens(own, "lab:moved")).toMatchObject({ used: 30_010 + 2, measured: 30_010 });
  // A reply the owner interrupted is stored with no usage: the count before it stands, its words on top.
  const cut = [...own, ev("assistant", { blocks: [{ type: "text", text: "half" }], model: "lab:moved", stop: "interrupted", usage: { input: 0, cache_read: 0, cache_write: 0, output: 0 } }), ev("user", { text: "again" })];
  expect(contextTokens(cut, "lab:moved")).toMatchObject({ used: 30_010 + Math.round((4 + 4 + 5) / BYTES_PER_TOKEN), measured: 30_010 });
  expect(contextTokens(cut).measured).toBe(30_010);
  // A reply whose provider reports no usage (an outside agent's) is still the measured one: the count is what
  // came since, not the bytes of the whole history on every call.
  const silent = [...line, ev("assistant", { blocks: [{ type: "text", text: "z".repeat(40_000) }], model: "lab:moved", stop: "end_turn", usage: { input: 0, cache_read: 0, cache_write: 0, output: 0 } }), ev("user", { text: "more" })];
  expect(contextTokens(silent, "lab:moved")).toMatchObject({ used: 2, measured: 0, estimated: 2 });
});

// A history far too long for a handful of parts: the plan is held to the
// most parts, by shortening outputs and call inputs further and then leaving
// the oldest steps of the work out, each run named in its place. The owner's
// words are all in it, in order, and the newest work is whole.
test("a transcript is planned in at most the most parts, the oldest steps left out and named", async () => {
  const long = [...Array(600).keys()].flatMap((n) => turn(n, `OUT${n} ${"o".repeat(6_000)}`));
  const free = transcriptParts(long, 20_000);
  expect(free.parts.length).toBeGreaterThan(40);
  expect(free.left_out).toEqual({ steps: 0, bytes: 0 });

  const cut = transcriptParts(long, 20_000, TRANSCRIPT_PARTS_MAX);
  expect(cut.parts.length).toBeLessThanOrEqual(TRANSCRIPT_PARTS_MAX);
  for (const p of cut.parts) expect(utf8Bytes(p)).toBeLessThanOrEqual(20_000);
  const joined = cut.parts.join("");
  // Every prompt once, in order.
  for (let n = 0; n < 600; n++) expect(joined.split(`[user]\nprompt ${n}\n`)).toHaveLength(2);
  expect(joined.indexOf("prompt 3\n")).toBeLessThan(joined.indexOf("prompt 599\n"));
  // The oldest steps are gone and say so: one round a turn here (a call and its result), counted as rounds, not as pieces.
  expect(cut.left_out.steps).toBeGreaterThan(100);
  expect(cut.left_out.steps).toBeLessThan(600);
  expect(joined).not.toContain("[assistant called Bash (t0)]");
  expect(joined).toMatch(/^\[user\]\nprompt 0\n\[1 of the model's rounds from here are not in this transcript \(their calls, results and words\): \d+ bytes\. They stay stored and searchable\. Each line like this one stands for rounds left out where it is\.\]\n\[assistant\]\ndone 0\n\[user\]\nprompt 1\n\[1 more rounds not here: \d+ bytes\]\n\[assistant\]\ndone 1\n/);
  // The newest are there with their call and result, and the answer that ended every turn is, the oldest too.
  expect(joined).toContain("[assistant called Bash (t599)]");
  expect(joined).toContain("[result of t599]\nOUT599 ");
  for (let n = 0; n < 600; n++) expect(joined.split(`[assistant]\ndone ${n}\n`)).toHaveLength(2);
  const named = [...joined.matchAll(/\[(\d+) (?:of the model's rounds|more rounds not here)/g)].reduce((n, m) => n + Number(m[1]), 0);
  expect(named).toBe(cut.left_out.steps);
  // What the model wrote between two calls is part of the work: it goes with the round it is in.
  const chatty = [...Array(600).keys()].flatMap((n) => [
    { role: "user" as const, content: [{ type: "text" as const, text: `prompt ${n}` }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: `looking ${n}` }, { type: "tool_use" as const, id: `t${n}`, name: "Bash", input: { command: `run ${n}` } }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: `t${n}`, content: "o".repeat(6_000) }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${n}` }] },
  ]);
  const short = transcriptParts(chatty, 20_000, TRANSCRIPT_PARTS_MAX).parts.join("");
  expect([short.includes("[assistant]\nlooking 0\n"), short.includes("[assistant]\nanswer 0\n"), short.includes("[assistant]\nlooking 599\n")]).toEqual([false, true, true]);
  // The request says the earliest work is not in it.
  expect(partPrompt("PART", 0, 8, "", cut.clipped, undefined, cut.left_out.steps)).toContain(`${cut.left_out.steps} of the oldest steps of the work are left out`);

  // So many turns that their answers alone do not fit: the plan still holds, the oldest answers shortened, then left out.
  const many = [...Array(600).keys()].flatMap((n) => [
    { role: "user" as const, content: [{ type: "text" as const, text: `prompt ${n}` }] },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: `t${n}`, name: "Bash", input: { command: `run ${n}` } }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: `t${n}`, content: "o".repeat(3_000) }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${n} ${"a".repeat(900)} end ${n}` }] },
  ]);
  const held = transcriptParts(many, 20_000, TRANSCRIPT_PARTS_MAX);
  expect(held.parts.length).toBeLessThanOrEqual(TRANSCRIPT_PARTS_MAX);
  const heldText = held.parts.join("");
  for (let n = 0; n < 600; n++) expect(heldText.split(`[user]\nprompt ${n}\n`)).toHaveLength(2);
  expect([heldText.includes("answer 0 "), heldText.includes(`answer 599 ${"a".repeat(900)} end 599`)]).toEqual([false, true]);

  // Paced: the same plan, with the loop turning while it is made.
  const big = [...Array(900).keys()].flatMap((n) => turn(n, `OUT${n} ${"o".repeat(12_000)}`));
  let turns = 0;
  const tick = setInterval(() => turns++, 0);
  const paced = await transcriptPartsPaced(big, 20_000, TRANSCRIPT_PARTS_MAX);
  clearInterval(tick);
  expect(turns).toBeGreaterThan(3);
  expect(paced).toEqual(transcriptParts(big, 20_000, TRANSCRIPT_PARTS_MAX));

  // Words someone sent are never left out, however long: they take the parts they need.
  const said = [...Array(40).keys()].map((n) => ({ role: "user" as const, content: [{ type: "text" as const, text: `said ${n} ${"w".repeat(9_000)}` }] }));
  const kept = transcriptParts(said, 20_000, 4);
  expect(kept.left_out.steps).toBe(0);
  for (let n = 0; n < 40; n++) expect(kept.parts.join("")).toContain(`said ${n} w`);
});

// The messages a compaction keeps are read from where the last checkpoint's
// answer starts, not from the session's first event. The answer is the one a
// walk over the whole branch gives: over generated branches with summaries,
// summaries prepared ahead (covering up to an earlier event), and a summary
// lying in the verbatim tail of the next one.
test("the kept messages read from the last checkpoint are the ones a walk over the whole branch keeps", () => {
  type Entry = { text: string; media: any[] };
  // As it was: every event of the branch, from the first.
  const whole = (lineage: StoredEvent[], who: "owner" | "other"): Entry[] => {
    let all: Entry[] = [];
    const at: number[] = [];
    lineage.forEach((e, i) => {
      if (e.kind === "compaction") {
        const covered = e.data.covered ? lineage.findIndex((x) => x.id === e.data.covered) : -1;
        const tail = covered >= 0 ? all.filter((_, k) => at[k]! > covered) : [];
        const texts: string[] = e.data.mode !== "summary" ? [] : (who === "owner" ? e.data.owner_messages : e.data.other_messages) ?? [];
        const kept: Entry[] = texts.map((t, k) => ({ text: t, media: who === "owner" ? (e.data.owner_media?.[k] ?? []) : [] }));
        all = [...kept, ...tail];
        at.length = 0;
        at.push(...all.map(() => i));
      } else if (e.kind === "user" && (who === "owner" ? !e.data.kind && !e.data.origin : !!e.data.kind && e.data.kind !== "harness")) {
        all.push({ text: e.data.text, media: [] });
        at.push(i);
      }
    });
    return all;
  };
  let rnd = 3;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let n = 0, summaries = 0, ahead = 0, nested = 0;
  for (let session = 0; session < 80; session++) {
    const line: StoredEvent[] = [];
    const add = (kind: StoredEvent["kind"], data: any) => { line.push({ id: `k${session}-${++n}`, session_id: "s", seq: n, parent: line.at(-1)?.id ?? null, kind, data, ts: 0 }); };
    let last = -1; // the last checkpoint's index
    for (let turn = 0; turn < 6 + Math.floor(rand() * 30); turn++) {
      add("user", rand() < 0.6 ? { text: `owner ${n}` } : { text: `report ${n}`, kind: "subagent" });
      add("assistant", { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
      if (rand() < 0.25) {
        const kept = keptMessages(line, 1e9);
        // Prepared ahead: it covers up to an earlier event, now and then one before the checkpoint before it.
        const back = rand() < 0.5 ? Math.floor(rand() * (rand() < 0.3 ? 14 : 5)) : -1;
        const covered = back >= 0 ? line[Math.max(0, line.length - 1 - back)] : undefined;
        if (covered) { ahead++; if (line.indexOf(covered) < last) nested++; }
        last = line.length;
        add("compaction", { mode: rand() < 0.9 ? "summary" : "clear", summary: "so far", ...kept, ...(covered ? { covered: covered.id } : {}) });
        summaries++;
      }
      for (const who of ["owner", "other"] as const) {
        const want = whole(line, who).map((e) => e.text);
        const got = keptMessages(line, 1e9)[who === "owner" ? "owner_messages" : "other_messages"] ?? [];
        expect({ session, at: line.length, who, kept: got }).toEqual({ session, at: line.length, who, kept: want });
      }
    }
  }
  // The generated branches hold what is compared.
  expect(summaries).toBeGreaterThan(100);
  expect(ahead).toBeGreaterThan(30);
  expect(nested).toBeGreaterThan(3);
});

// A history brought in whole from a harness that had compacted it: each
// reply's count is of the context it had there, not of what lies before it
// here. Held to that count, the whole history was built into a request the
// provider then refused, twice, megabytes of it each time.
test("a measured count the bytes cannot be is not this context's: it is counted from its bytes", async () => {
  const reply = (text: string, input: number) => ev("assistant", { blocks: [{ type: "text", text }], usage: { input, output: 10, cache_read: 0, cache_write: 0 }, stop: "end_turn" });
  const long = Array.from({ length: 400 }, (_, i) => [ev("user", { text: `step ${i}` }), reply("x".repeat(10_000), 30_000)]).flat();
  // Four megabytes behind a reply that says 30,000 tokens: a million tokens at the default bytes a token.
  const t = contextTokens(long);
  expect(t.measured).toBe(0);
  expect(t.used).toBeGreaterThan(900_000);
  // With the request's own prefix on top, as for any context no reply measured.
  expect(contextTokens(long, undefined, 5_000).used).toBe(t.used + 5_000);
  // A count that is merely low for its bytes (escaped output, long runs of one character) stands: twenty bytes a token here.
  const dense = [ev("user", { text: "go" }), reply("x".repeat(590_000), 30_000)];
  expect(contextTokens(dense).measured).toBe(30_010);
  // The count of a long history is taken in slices, and kept: the same answer, and nothing left to count.
  const fresh = Array.from({ length: 300 }, (_, i) => [ev("user", { text: `step ${i}` }), ev("tool_result", { results: [{ type: "tool_result", tool_use_id: `c${i}`, content: "y".repeat(20_000) }] })]).flat();
  // (Turns of the loop are counted by a job that runs once in each, not by a clock: six megabytes, a turn a megabyte.)
  const turnsWhile = async (work: () => Promise<void>) => {
    let turns = 0, on = true;
    const turn = () => { turns++; if (on) setImmediate(turn); };
    setImmediate(turn);
    await work();
    on = false;
    return turns;
  };
  expect(await turnsWhile(() => countPaced(fresh))).toBeGreaterThanOrEqual(5);
  const before = contextBytes(fresh);
  expect(before).toBeGreaterThan(6_000_000);
  expect(await turnsWhile(() => countPaced(fresh))).toBe(0);
  expect(contextBytes(fresh)).toBe(before);
});

// An output's size in the transcript is taken from its parts, without putting the piece together:
// the same number as the piece's own bytes, also where the output ends in half a character.
test("a tool output is measured in the transcript as it is written there", () => {
  const out = (content: string) => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content }] },
  ] as any;
  for (const content of ["plain output\n", "מוכן 🌍", "cut in half \ud83d", ""]) {
    const text = `[result of c1]\n${content}\n`;
    // A budget of exactly the transcript's bytes holds it in one part; one byte less does not.
    const whole = transcriptParts(out(content), 1 << 20).parts.join("");
    expect(whole.endsWith(text)).toBe(true);
    expect(transcriptParts(out(content), utf8Bytes(whole)).parts).toHaveLength(1);
    expect(transcriptParts(out(content), utf8Bytes(whole) - 1).parts.length).toBeGreaterThan(1);
  }
});
