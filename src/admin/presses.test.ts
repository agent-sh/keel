// What the daemon keeps of the owner's presses: only names, within the bounds.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BATCH_MAX, cleanBatch, clearPresses, PRESS_DAYS, PRESS_ROWS, PRESS_SCHEMA, pressReport, prunePresses, SEEN_ROWS, storePresses } from "./presses.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const db = () => { const d = new Database(":memory:"); d.exec(PRESS_SCHEMA); return d; };

test("a posted batch keeps names only: a word, a value or an id never gets in", () => {
  const b = cleanBatch({
    surface: "phone",
    presses: [
      { c: "show-sidebar", v: "session", s: "01a1fb6f-d40c-71f2", t: NOW - 1000 },
      { c: "Rename my secret project", v: "session", t: NOW },
      { c: "composer-text", v: "the owner typed this", t: NOW },
      { c: "row-0123456789", v: "new", t: NOW },
      { c: "ok", v: "new", s: "../etc passwd", t: NOW + 5 * DAY },
      { c: 5, v: "new" },
    ],
    seen: [{ c: "a", v: "new" }, { c: "has space", v: "new" }, null],
  }, NOW);
  expect(b.surface).toBe("phone");
  expect(b.presses).toEqual([
    { control: "show-sidebar", view: "session", session: "01a1fb6f-d40c-71f2", ts: NOW - 1000 },
    { control: "ok", view: "new", session: null, ts: NOW }, // a time from the future is the receipt's
  ]);
  expect(b.seen).toEqual([{ control: "a", view: "new" }]);
  expect(cleanBatch("nonsense", NOW)).toEqual({ surface: "page", presses: [], seen: [] });
  expect(cleanBatch({ presses: Array.from({ length: BATCH_MAX + 50 }, () => ({ c: "a", v: "new", t: NOW })) }, NOW).presses).toHaveLength(BATCH_MAX);
});

test("the tables are bounded by days and by rows, the oldest going first", () => {
  const d = db();
  d.transaction(() => {
    const put = d.prepare("INSERT INTO presses (ts, control, view, session_id, surface) VALUES (?, 'a', 'new', NULL, 'page')");
    for (let i = 0; i < PRESS_ROWS + 25; i++) put.run(NOW - 1000 + i);
    put.run(NOW - (PRESS_DAYS + 1) * DAY);
    const see = d.prepare("INSERT INTO press_seen (control, view, first_ts, last_ts) VALUES (?, 'new', ?, ?)");
    for (let i = 0; i < SEEN_ROWS + 10; i++) see.run(`c${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`, NOW - i, NOW - i);
    see.run("old", NOW - (PRESS_DAYS + 1) * DAY, NOW - (PRESS_DAYS + 1) * DAY);
  })();
  prunePresses(d, NOW);
  expect(d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM presses").get()!.n).toBe(PRESS_ROWS);
  // The newest rows are the ones kept.
  expect(d.query<{ t: number }, []>("SELECT MIN(ts) AS t FROM presses").get()!.t).toBe(NOW - 1000 + 25);
  expect(d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM press_seen").get()!.n).toBe(SEEN_ROWS);
  expect(d.query("SELECT 1 FROM press_seen WHERE control = 'old'").get()).toBeNull();
});

test("a stored batch prunes at most once a minute and a clear forgets everything", () => {
  const d = db();
  const batch = (n: number) => ({ surface: "page" as const, presses: Array.from({ length: n }, () => ({ control: "a", view: "new", session: null, ts: NOW })), seen: [] });
  storePresses(d, batch(2), NOW);
  d.run("INSERT INTO presses (ts, control, view, surface) VALUES (?, 'old', 'new', 'page')", [NOW - (PRESS_DAYS + 5) * DAY]);
  storePresses(d, batch(1), NOW + 1000); // inside the minute: no prune
  expect(d.query("SELECT 1 FROM presses WHERE control = 'old'").get()).not.toBeNull();
  storePresses(d, batch(1), NOW + 61_000);
  expect(d.query("SELECT 1 FROM presses WHERE control = 'old'").get()).toBeNull();
  clearPresses(d);
  expect(d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM presses").get()!.n).toBe(0);
  expect(d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM press_seen").get()!.n).toBe(0);
});

test("the report: most used first per view, and the controls drawn but not pressed in the range", () => {
  const d = db();
  const press = (control: string, view: string, n: number, at = NOW - DAY) =>
    storePresses(d, { surface: "page", presses: Array.from({ length: n }, () => ({ control, view, session: null, ts: at })), seen: [] }, NOW);
  press("fork", "session", 3);
  press("archive", "session", 7);
  press("new", "new", 2);
  press("stale", "session", 4, NOW - 40 * DAY); // pressed, but outside 30 days
  storePresses(d, { surface: "page", presses: [], seen: [{ control: "fork", view: "session" }, { control: "stale", view: "session" }, { control: "unused", view: "session" }, { control: "unused", view: "new" }] }, NOW);
  const r = pressReport(d, { now: NOW });
  expect(r.days).toBe(30);
  expect(r.presses).toBe(12);
  expect(r.views.map((v) => [v.view, v.presses])).toEqual([["session", 10], ["new", 2]]);
  expect(r.views[0]!.controls.map((c) => [c.control, c.presses])).toEqual([["archive", 7], ["fork", 3]]);
  expect(r.never.map((n) => n.control)).toEqual(["stale", "unused"].sort()); // seen in the range, never pressed in it
  expect(r.never.find((n) => n.control === "unused")!.views.split(",").sort()).toEqual(["new", "session"]);
  expect(pressReport(d, { now: NOW, days: 90 }).never.map((n) => n.control)).toEqual(["unused"]);
});

test("the report splits the presses by where the page ran", () => {
  const d = db();
  const one = (surface: "page" | "desktop" | "phone", n: number, at = NOW - DAY) =>
    storePresses(d, { surface, presses: Array.from({ length: n }, () => ({ control: "fork", view: "session", session: null, ts: at })), seen: [] }, NOW);
  one("page", 5);
  one("desktop", 3);
  one("phone", 1);
  one("desktop", 9, NOW - 40 * DAY); // outside the range
  expect(pressReport(d, { now: NOW }).surfaces).toEqual([{ surface: "page", presses: 5 }, { surface: "desktop", presses: 3 }, { surface: "phone", presses: 1 }]);
  expect(pressReport(d, { now: NOW, days: 90 }).surfaces.find((s) => s.surface === "desktop")!.presses).toBe(12);
});
