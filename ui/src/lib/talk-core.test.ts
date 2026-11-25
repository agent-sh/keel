import { expect, test } from "bun:test";
import type { StoredEvent } from "../../../src/core/types.ts";
import { dictated, echoOf, loudAbove, OFF, pieces, replyOf, silenceEnded, spokenText, talkStep, VAD_START, vadStep, type Effect, type Talk, type TalkEvent } from "./talk-core.ts";

test("quiet ends a message only after words, and only after the whole silence", () => {
  const o = { words: "open the file", lastAt: 1000, silenceMs: 1500 };
  expect(silenceEnded({ ...o, now: 2499 })).toBe(false);
  expect(silenceEnded({ ...o, now: 2500 })).toBe(true);
  // Nothing said yet: quiet is not an end.
  expect(silenceEnded({ ...o, words: "  ", now: 99_000 })).toBe(false);
  expect(silenceEnded({ ...o, lastAt: null, now: 99_000 })).toBe(false);
});

test("a recording ends after speech that lasted, then quiet; a click or silence alone never ends it", () => {
  const run = (levels: [number, number][], silenceMs = 1000) => levels.reduce((v, [level, at]) => vadStep(v, level, at, silenceMs), VAD_START);
  const loud = 0.2;
  // Quiet from the start: no end, however long.
  expect(run([[0.001, 0], [0.001, 5000], [0.001, 20000]]).ended).toBe(false);
  // A click of 60 ms is not speech.
  expect(run([[loud, 0], [loud, 60], [0.001, 200], [0.001, 3000]]).ended).toBe(false);
  // A second of speech, then 999 ms of quiet is not yet the end; 1000 ms is.
  const speech: [number, number][] = [[loud, 0], [loud, 400], [loud, 800], [loud, 1000]];
  expect(run([...speech, [0.001, 1999]]).ended).toBe(false);
  expect(run([...speech, [0.001, 2000]]).ended).toBe(true);
  // A pause shorter than the silence inside a sentence does not end it.
  expect(run([...speech, [0.001, 1500], [loud, 1800], [loud, 2200], [0.001, 2900]]).ended).toBe(false);
});

test("the room's own noise is not speech: the floor follows it", () => {
  let v = VAD_START;
  for (let t = 0; t < 4000; t += 50) v = vadStep(v, 0.025, t, 1000);
  expect(v.floor).toBeGreaterThan(0.02);
  // A level that was loud against a quiet room is quiet against this one.
  expect(0.05 >= loudAbove(0.01)).toBe(true);
  expect(0.05 >= loudAbove(v.floor)).toBe(false);
});

test("dictated words go at the caret with the spaces they need", () => {
  expect(dictated({ before: "", after: "" }, "hello")).toEqual({ text: "hello", caret: 5 });
  expect(dictated({ before: "fix", after: "" }, " the test ")).toEqual({ text: "fix the test", caret: 12 });
  expect(dictated({ before: "fix ", after: "now" }, "the test")).toEqual({ text: "fix the test now", caret: 12 });
  expect(dictated({ before: "fix", after: ".\nthanks" }, "it")).toEqual({ text: "fix it.\nthanks", caret: 6 });
  // No words: the box is as it was, the caret where it stood.
  expect(dictated({ before: "a", after: "b" }, "  ")).toEqual({ text: "ab", caret: 1 });
});

test("a reply is read as speech: code left out, links as words, marks dropped", () => {
  const md = "## Done\n\nI changed **two** files:\n\n- `a.ts` has the [fix](https://x.example/p)\n- b.ts\n\n```ts\nconst x = 1;\n```\n\nSee https://example.com/a for more.";
  expect(spokenText(md)).toBe("Done. I changed two files: a.ts has the fix b.ts. (code omitted). See a link for more.");
  expect(spokenText("")).toBe("");
});

test("long text is cut at a sentence into pieces a speech route takes", () => {
  const text = "One sentence here. Another sentence follows. And a third one ends it.";
  expect(pieces(text, 100)).toEqual([text]);
  const cut = pieces(text, 40);
  expect(cut.every((p) => p.length <= 40)).toBe(true);
  expect(cut.join(" ")).toBe(text);
  expect(pieces("x".repeat(25), 10).join("")).toBe("x".repeat(25));
});

const ev = (seq: number, kind: StoredEvent["kind"], data: any): StoredEvent => ({ id: `e${seq}`, session_id: "s", seq, parent: null, kind, data, ts: seq });
test("the reply of a turn is its last words once it has ended", () => {
  const events = [
    ev(1, "user", { text: "before" }), ev(2, "assistant", { blocks: [{ type: "text", text: "old answer" }] }), ev(3, "turn_end", { reason: "end_turn" }),
    ev(4, "user", { text: "hi" }), ev(5, "turn_start", {}),
    ev(6, "assistant", { blocks: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t", name: "Read", input: {} }] }),
  ];
  expect(replyOf(events, 3)).toEqual({ done: false });
  const ended = [...events, ev(7, "assistant", { blocks: [{ type: "text", text: "It is fixed." }] }), ev(8, "turn_end", { reason: "end_turn" })];
  expect(replyOf(ended, 3)).toEqual({ done: true, text: "It is fixed.", reason: "end_turn" });
  // A turn that ended with tools only has nothing to read.
  expect(replyOf([ev(9, "assistant", { blocks: [{ type: "tool_use", id: "t", name: "x", input: {} }] }), ev(10, "turn_end", { reason: "error" })], 8)).toEqual({ done: true, text: "", reason: "error" });
  expect(replyOf(undefined, 0)).toEqual({ done: false });
});

// One conversation, event by event: what each step does and asks for.
function drive(steps: TalkEvent[], from: Talk = OFF) {
  const effects: Effect[][] = [];
  let talk = from;
  for (const s of steps) { const r = talkStep(talk, s); talk = r.talk; effects.push(r.effects); }
  return { talk, effects };
}

test("a spoken turn: listen, words, silence sends them, the reply is spoken, then listening again", () => {
  const r = drive([
    { t: "start", busy: false },
    { t: "words", final: "", interim: "open", at: 100 },
    { t: "words", final: "open the", interim: "file", at: 400 },
    { t: "tick", now: 1000, silenceMs: 1500 },
    { t: "tick", now: 1900, silenceMs: 1500 },
    { t: "reply", text: "Opened it." },
    { t: "spoken" },
  ]);
  expect(r.effects).toEqual([["listen"], [], [], [], ["unlisten", { send: "open the file" }], [{ speak: "Opened it." }], ["listen"]]);
  expect(r.talk.phase).toBe("listening");
  expect(r.talk.final).toBe("");
});

test("silence is counted from the last change of the words, not from the last event", () => {
  const r = drive([
    { t: "start", busy: false },
    { t: "words", final: "", interim: "wait", at: 100 },
    { t: "words", final: "", interim: "wait", at: 1400 },
  ]);
  expect(r.talk.lastAt).toBe(100);
  expect(talkStep(r.talk, { t: "tick", now: 1700, silenceMs: 1500 }).effects).toEqual(["unlisten", { send: "wait" }]);
});

test("ticks in other phases do nothing, and a reply nobody waits for is not spoken", () => {
  expect(talkStep(OFF, { t: "tick", now: 9e9, silenceMs: 1 }).effects).toEqual([]);
  expect(talkStep({ ...OFF, phase: "listening" }, { t: "reply", text: "x" }).effects).toEqual([]);
  expect(talkStep({ ...OFF, phase: "speaking" }, { t: "words", final: "a", interim: "", at: 1 }).talk.phase).toBe("speaking");
});

test("a reply with no words, or a message that could not go, returns to listening", () => {
  expect(drive([{ t: "reply", text: "  " }], { ...OFF, phase: "thinking" }).effects).toEqual([["listen"]]);
  expect(drive([{ t: "send-failed" }], { ...OFF, phase: "thinking" }).talk.phase).toBe("listening");
});

test("turned on while a turn works, it waits for that turn's reply before listening", () => {
  const r = drive([{ t: "start", busy: true }, { t: "reply", text: "Done." }]);
  expect(r.effects).toEqual([[], [{ speak: "Done." }]]);
});

test("stop ends it at once from any phase, silences the voice, and says nothing when already off", () => {
  for (const phase of ["listening", "thinking", "speaking"] as const) {
    const r = talkStep({ ...OFF, phase, final: "half a message" }, { t: "stop" });
    expect(r.talk).toEqual(OFF);
    expect(r.effects).toEqual(["unlisten", "hush"]);
  }
  expect(talkStep(OFF, { t: "stop" }).effects).toEqual([]);
});

test("a failure ends the mode and keeps its words; a recognizer that stopped by itself is started again", () => {
  const r = talkStep({ ...OFF, phase: "listening" }, { t: "failed", why: "no microphone" });
  expect(r.talk).toEqual({ ...OFF, error: "no microphone" });
  expect(r.effects).toEqual(["unlisten", "hush"]);
  expect(talkStep({ ...OFF, phase: "listening" }, { t: "recognizer-ended" }).effects).toEqual(["listen"]);
  expect(talkStep({ ...OFF, phase: "thinking" }, { t: "recognizer-ended" }).effects).toEqual([]);
});

test("a recording: when it ends the words are awaited, and what was said is sent, or nothing and it listens again", () => {
  const sent = drive([{ t: "start", busy: false }, { t: "captured" }, { t: "said", text: " run the tests " }, { t: "reply", text: "All pass." }]);
  expect(sent.effects).toEqual([["listen"], [], [{ send: "run the tests" }], [{ speak: "All pass." }]]);
  const quiet = drive([{ t: "start", busy: false }, { t: "captured" }, { t: "said", text: "" }]);
  expect(quiet.effects).toEqual([["listen"], [], ["listen"]]);
  expect(quiet.talk.phase).toBe("listening");
  expect(talkStep(OFF, { t: "said", text: "late words" }).effects).toEqual([]);
});

test("barge-in: the recognizer runs over the reply, speech that is not the reply's own stops the reading and starts the message", () => {
  const r = drive([
    { t: "start", busy: true },
    { t: "reply", text: "I opened the file and ran the tests.", barge: true },
    // the reply's own words heard back are not speech
    { t: "words", final: "", interim: "ran the tests", at: 10 },
    { t: "words", final: "", interim: "I opened the file", at: 20 },
    // the owner speaks over it
    { t: "words", final: "", interim: "wait no", at: 30 },
  ]);
  expect(r.effects).toEqual([[], ["listen", { speak: "I opened the file and ran the tests." }], [], [], ["hush"]]);
  expect(r.talk).toMatchObject({ phase: "listening", hearing: true, interim: "wait no", lastAt: 30, say: "" });
  // The silence that ends the message counts from the words of the owner's speech.
  expect(talkStep(r.talk, { t: "tick", now: 1600, silenceMs: 1500 }).effects).toEqual(["unlisten", { send: "wait no" }]);
});

test("barge-in: a recording hears speech by loudness and the reading stops with no words yet", () => {
  const r = drive([{ t: "start", busy: true }, { t: "reply", text: "Done.", barge: true }, { t: "voice" }]);
  expect(r.effects).toEqual([[], ["listen", { speak: "Done." }], ["hush"]]);
  expect(r.talk).toMatchObject({ phase: "listening", hearing: true, final: "", interim: "" });
  // Loud with no reading, or with barge-in off, is nothing.
  expect(talkStep({ ...OFF, phase: "listening", hearing: true }, { t: "voice" }).effects).toEqual([]);
  expect(talkStep({ ...OFF, phase: "speaking", say: "Done." }, { t: "voice" }).effects).toEqual([]);
});

test("barge-in off: the reading is not heard over, and the reply ends into listening as before", () => {
  const r = drive([{ t: "start", busy: true }, { t: "reply", text: "Done." }, { t: "words", final: "no", interim: "", at: 5 }, { t: "spoken" }]);
  expect(r.effects).toEqual([[], [{ speak: "Done." }], [], ["listen"]]);
});

test("barge-in: when the reply ends unbroken the recognizer that ran over it goes on listening, and one that stopped is started again", () => {
  const r = drive([{ t: "start", busy: true }, { t: "reply", text: "Done.", barge: true }, { t: "recognizer-ended" }, { t: "spoken" }]);
  expect(r.effects).toEqual([[], ["listen", { speak: "Done." }], ["listen"], []]);
  expect(r.talk).toMatchObject({ phase: "listening", hearing: true });
});

test("a reply's own words heard back are told from speech: the same words in a row inside what is read", () => {
  const said = "I opened the file, and then I ran the tests.";
  expect(echoOf("the file and then", said)).toBe(true);
  expect(echoOf("I ran the tests", said)).toBe(true);
  expect(echoOf("ran I the tests", said)).toBe(false);
  expect(echoOf("the file stop", said)).toBe(false);
  expect(echoOf("wait", said)).toBe(false);
  expect(echoOf("  ", said)).toBe(true);
});
