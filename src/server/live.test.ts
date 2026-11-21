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
