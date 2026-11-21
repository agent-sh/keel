// The replay of a resume over a real store: only the events after the cursor,
// and where it ended. A cursor ahead of what is stored (the page outlived a
// restored backup) ends below it, which tells the page to read the session whole.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Live } from "./live.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "live-"));
const store = new Store(dir);
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a resume replays what came after the cursor and says where it ended", () => {
  const live = new Live(store, new Bus(), () => {});
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const empty = store.createSession({ workspace: dir, model: "p:m" });
  for (let i = 1; i <= 5; i++) store.append(s.id, "note", { text: `note ${i}` });
  const resume = (cursors: Record<string, number>) => {
    const sent: any[] = [];
    live.message({ send: (d: string) => void sent.push(JSON.parse(d)), subscribe() {}, unsubscribe() {} } as any, JSON.stringify({ op: "resume", cursors }));
    return { seqs: sent.filter((f) => f.t === "event").map((f) => f.event.seq), ends: sent.find((f) => f.t === "replayed").cursors };
  };
  expect(resume({ [s.id]: 3 })).toEqual({ seqs: [4, 5], ends: { [s.id]: 5 } });
  expect(resume({ [s.id]: 5 })).toEqual({ seqs: [], ends: { [s.id]: 5 } });
  expect(resume({ [s.id]: 0 })).toEqual({ seqs: [1, 2, 3, 4, 5], ends: { [s.id]: 5 } });
  // The page holds nine events of it, the daemon five: the replay ends at the fifth.
  expect(resume({ [s.id]: 9, [empty.id]: 2, gone: 4 })).toEqual({ seqs: [], ends: { [s.id]: 5, [empty.id]: 0 } });
});

// A replayed event carries no rev (it may be of any branch and moves no head
// in the page); the session's row follows the events with one, so the page
// knows where the head is: also when it shows an older branch than the newest.
test("a replay ends each session with its row, which carries a rev", () => {
  const bus = new Bus();
  const live = new Live(store, bus, () => {});
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const first = store.append(s.id, "note", { text: "one" });
  for (let i = 2; i <= 4; i++) store.append(s.id, "note", { text: `note ${i}` });
  // The session shows the first event again: its head is not its newest event.
  store.updateSession(s.id, { head: first.id });
  const sent: any[] = [];
  live.message({ send: (d: string) => void sent.push(JSON.parse(d)), subscribe() {}, unsubscribe() {} } as any, JSON.stringify({ op: "resume", cursors: { [s.id]: 2 } }));
  const events = sent.filter((f) => f.t === "event");
  expect(events.map((f) => f.event.seq)).toEqual([3, 4]);
  expect(events.every((f) => f.rev === undefined)).toBe(true);
  const row = sent.find((f) => f.t === "session");
  expect(row.session.head).toBe(first.id);
  expect(row.rev).toBe(bus.rev());
  expect(sent.indexOf(row)).toBeGreaterThan(sent.indexOf(events.at(-1)));
  expect(store.lastSeq(s.id)).toBe(4);
});
