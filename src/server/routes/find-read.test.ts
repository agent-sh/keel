// The page's Find over the part of a conversation it does not hold: only the
// session's own rows are read, and the part the page holds is left out before
// the cap counts what is found.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { fold, searchTerms } from "../search-query.ts";
import { findInSession } from "./find-read.ts";
import { initSearchIndex, keepIndexed } from "./search.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a find counts the session's rows outside the part the page holds, under the cap, and no other session's", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-find-"));
  dirs.push(dir);
  const store = new Store(dir);
  initSearchIndex(store.db);
  keepIndexed(store);
  const a = store.createSession({ model: "m", workspace: "/" });
  const b = store.createSession({ model: "m", workspace: "/" });
  // The two sessions' events interleave in the events table.
  const seqs: number[] = [];
  for (let i = 0; i < 40; i++) {
    seqs.push(store.append(a.id, "user", { text: `note ${i} quokkaroo here` }).seq);
    store.append(b.id, "user", { text: `other quokkaroo ${i}` });
  }
  store.side.flush();
  const ask = (held?: { from: number; to: number }, limit = 10) =>
    findInSession(store.db, { session: a.id, match: searchTerms("quokkaroo").join(" "), needle: fold("quokkaroo"), limit, ...(held ? { held } : {}) });

  const all = ask(undefined, 100);
  expect(all.rows.length).toBe(40);
  expect(all.more).toBe(false);
  expect(new Set(all.rows.map((r) => r.event_id)).size).toBe(40);
  expect(all.rows.map((r) => r.seq)).toEqual(seqs);

  // The page holds the first 30 prompts: the 10 after them are found, none held, and the cap is not reached.
  const after = ask({ from: seqs[0]!, to: seqs[29]! });
  expect(after.rows.map((r) => r.seq)).toEqual(seqs.slice(30));
  expect(after.more).toBe(false);
  // The page holds the end (an open end): what is before it.
  const before = ask({ from: seqs[35]!, to: Infinity }, 100);
  expect(before.rows.map((r) => r.seq)).toEqual(seqs.slice(0, 35));
  // More than the cap outside the held part says so.
  const capped = ask({ from: seqs[38]!, to: Infinity }, 5);
  expect(capped.rows.length).toBe(5);
  expect(capped.more).toBe(true);
  store.db.close();
});
