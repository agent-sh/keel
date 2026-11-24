import { describe, expect, test } from "bun:test";
import type { Session, StoredEvent } from "../core/types.ts";
import { automationTools } from "../automation/tools.ts";
import { ASK_REFUSAL, answerOf, askRefusal } from "./ask.ts";

let seq = 0;
const ev = (kind: string, data: any): StoredEvent => ({ id: `e${++seq}`, session_id: "h", seq, parent: null, kind: kind as any, data, ts: seq * 1000 });
const ses = (id: string, title: string, settings: any = {}) => ({ id, title, settings } as unknown as Session);
const sessions = [ses("s1", "Fix the build"), ses("s2", "Deploy"), ses("h", "Helper", { helper: true })];
const send = { name: "keel__session_send", readOnly: false };
const read = { name: "helper__session_read", readOnly: true };

describe("a question from the phone's helper row", () => {
  test("its turn only reads, until the owner's own words come again; a wake after it changes nothing", () => {
    const typed = ev("user", { text: "tell Deploy to go on" });
    expect(askRefusal([typed], send)).toBeUndefined();
    const asked = [typed, ev("turn_end", { reason: "done" }), ev("user", { text: "what is going on?", ask: "phone" })];
    expect(askRefusal(asked, send)).toBe(ASK_REFUSAL);
    expect(askRefusal(asked, read)).toBeUndefined();
    expect(askRefusal([...asked, ev("user", { text: "<digest>", kind: "helper_digest" })], send)).toBe(ASK_REFUSAL);
    expect(askRefusal([...asked, ev("user", { text: "now send it", origin: "steer" })], send)).toBeUndefined();
  });

  test("a tool that acts in Keel is not a read, so it is refused too: agents, messages, loops, wakes, notifications", () => {
    const asked = [ev("user", { text: "what is going on?", ask: "phone" })];
    const byName = new Map(automationTools.map((t) => [t.name, t]));
    const acting = ["Agent", "spawn_agent", "SendMessage", "send_input", "close_agent", "CronCreate", "schedule_create", "CronDelete", "schedule_delete", "ScheduleWakeup", "schedule_wakeup", "WaitFor", "wait_for", "cancel_wait", "PushNotification", "notify", "Monitor", "monitor"];
    for (const name of acting) expect([name, askRefusal(asked, byName.get(name)!)]).toEqual([name, ASK_REFUSAL]);
    for (const name of ["CronList", "schedule_list", "wait_agent", "keel__agents_now"]) expect([name, askRefusal(asked, byName.get(name)!)]).toEqual([name, undefined]);
  });

  test("the answer: the reply's last words, the sessions read, named once; a restart's end is not the answer's", () => {
    const ask = ev("user", { text: "what waits for me?", ask: "phone" });
    const line = [
      ask,
      ev("assistant", { blocks: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "a", name: "helper__sessions", input: {} }] }),
      ev("turn_end", { reason: "restart" }),
      ev("assistant", { blocks: [{ type: "tool_use", id: "b", name: "helper__session_read", input: { session: "deploy" } }, { type: "tool_use", id: "c", name: "helper__session_read", input: { session: "s2" } }, { type: "tool_use", id: "d", name: "helper__session_read", input: { session: "nothing" } }] }),
    ];
    expect(answerOf(line, ask.id, sessions, true)).toMatchObject({ state: "working", text: "Looking.", looked: ["sessions"] });
    const done = [...line, ev("assistant", { blocks: [{ type: "text", text: "Deploy waits for your approval." }] }), ev("turn_end", { reason: "done" }), ev("assistant", { blocks: [{ type: "text", text: "a later turn" }] })];
    const a = answerOf(done, ask.id, sessions, false)!;
    expect([a.state, a.question, a.text, a.read.map((s) => s.title)]).toEqual(["done", "what waits for me?", "Deploy waits for your approval.", ["Deploy"]]);
    expect(answerOf([...line, ev("turn_end", { reason: "error" })], ask.id, sessions, false)!.state).toBe("failed");
    expect(answerOf(line, "missing", sessions, false)).toBeUndefined();
  });
});
