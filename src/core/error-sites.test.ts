// Where a kind of failure happened and whether a retry healed it: what the
// Errors list says about a repeated failure.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorLines, errorState } from "../admin/error-rows.ts";
import { Bus } from "./bus.ts";
import { atSession, recoveredAt } from "./error-sites.ts";
import { ErrorTracker } from "./errors.ts";
import { Store } from "./store.ts";
import type { ErrorRecord } from "./types.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "keel-sites-"));
  dirs.push(dir);
  const store = new Store(dir);
  const bus = new Bus();
  const frames: ErrorRecord[] = [];
  bus.on((f) => { if (f.t === "error") frames.push(f.error); });
  const said = console.error;
  console.error = () => {};
  const errors = new ErrorTracker(store, bus);
  const capture = (session: string, message: string, extra: object = {}) => errors.capture("provider", new Error(message), { session, ...extra });
  return { store, errors, frames, capture, done: () => { console.error = said; store.db.close(); } };
}

// (The per-session rows, a session's own bundle and Recovered after a retry are checked through
// the daemon in test/e2e/past-truth.spec.ts. Here: what a small workload cannot reach.)

// What a session's model is told about its failures is read from this list: it holds every kind
// that happened in the session, however many newer kinds the store holds.
test("a session's kinds are all listed in a store of thousands of newer kinds", () => {
  const { store, errors, done } = fresh();
  try {
    const mine = store.createSession({ model: "m", workspace: "/", title: "Mine" });
    const other = store.createSession({ model: "m", workspace: "/", title: "Other" });
    const add = store.db.query("INSERT INTO errors (id, ts, first_ts, count, source, message, fingerprint, session_id) VALUES (?, ?, ?, 1, 'tool', ?, ?, ?)");
    const site = store.db.query("INSERT INTO error_sites (error_id, session_id, count, first_ts, ts) VALUES (?, ?, 1, ?, ?)");
    store.db.transaction(() => {
      // 107 kinds in this session, older than everything else; then 5,200 kinds that last happened elsewhere.
      for (let i = 0; i < 107; i++) { add.run(`mine-${i}`, 1000 + i, 1000 + i, `mine ${i}`, `fm${i}`, i % 2 ? mine.id : other.id); site.run(`mine-${i}`, mine.id, 1000 + i, 1000 + i); }
      for (let i = 0; i < 5200; i++) { add.run(`else-${i}`, 10_000 + i, 10_000 + i, `else ${i}`, `fe${i}`, other.id); site.run(`else-${i}`, other.id, 10_000 + i, 10_000 + i); }
    })();
    const listed = errors.list(200, { session: mine.id });
    expect(listed).toHaveLength(107);
    expect(listed[0]!.id).toBe("mine-106");
    expect(listed.every((e) => e.sites!.some((x) => x.session_id === mine.id))).toBe(true);
    // Its limit and its filters still hold.
    expect(errors.list(10, { session: mine.id })).toHaveLength(10);
    store.readError("mine-3", true);
    expect(errors.list(200, { session: mine.id, read: false })).toHaveLength(106);
    expect(errors.list(200, { session: other.id }).length).toBe(200);
  } finally { done(); }
});

test("what is open of a kind is kept with the kind: resolved then healed elsewhere, and a deleted session", () => {
  const { store, errors, frames, capture, done } = fresh();
  try {
    const [a, b] = ["A", "B"].map((title) => store.createSession({ model: "m", workspace: "/", title }));
    // It failed for good in A; the owner resolved it. It happens in B and a retry heals it: recovered and read.
    const first = capture(a!.id, "529 overloaded");
    expect(errorState(errors.get(first.id)!)).toBe("open");
    expect(errorState(errors.resolve(first.id, true)!)).toBe("resolved");
    const again = capture(b!.id, "529 overloaded", { retry: 1, wait_ms: 500 });
    expect(errorState(errors.get(first.id)!)).toBe("open");
    errors.recovered([again], b!.id);
    // A later attempt whose retry is still to come leaves it recovered; healed, it is recovered still.
    const later = capture(b!.id, "529 overloaded", { retry: 1, wait_ms: 500 });
    expect([errorState(errors.get(first.id)!), !!errors.get(first.id)!.read_ts]).toEqual(["recovered", true]);
    errors.recovered([later], b!.id);
    const healed = errors.get(first.id)!;
    expect([errorState(healed), !!healed.read_ts, healed.count]).toEqual(["recovered", true, 3]);
    expect(errorState(frames.at(-1)!)).toBe("recovered");
    expect(errorLines([healed])[0]).toStartWith("0 open, 1 recovered (a retry passed).");
    // Its sessions are deleted: still recovered, with no session to name.
    store.db.run("DELETE FROM sessions WHERE id IN (?, ?)", [a!.id, b!.id]);
    const gone = errors.get(first.id)!;
    expect([errorState(gone), gone.sites]).toEqual(["recovered", undefined]);
    // Healed three times and then the retries run out: open and unread. Outside any session: never healed.
    const c = store.createSession({ model: "m", workspace: "/", title: "C" });
    const tries = [1, 2, 3].map((n) => capture(c.id, "stream dropped", { retry: n, wait_ms: 500 }));
    errors.recovered(tries, c.id);
    expect(errorState(errors.get(tries[0]!.id)!)).toBe("recovered");
    capture(c.id, "stream dropped");
    expect([errorState(errors.get(tries[0]!.id)!), errors.get(tries[0]!.id)!.read_ts]).toEqual(["open", undefined]);
    errors.capture("provider", new Error("529 overloaded"));
    expect(errorState(errors.get(first.id)!)).toBe("open");
    // The state from one row of the tally.
    expect([recoveredAt({ open: 0, healed_ts: 5 }), recoveredAt({ open: 1, healed_ts: 5 }), recoveredAt({ open: 1, pending: 1, healed_ts: 5 }), recoveredAt({ open: 0, healed_ts: null }), recoveredAt(undefined)]).toEqual([5, undefined, 5, undefined, undefined]);
  } finally { done(); }
});

// The count of unread failures is what the bug badge shows. A failure that is about to be tried
// again does not raise it; one whose retries ran out does, and so does one of a kind already open.
test("a failure that will be retried is not unread while its retry waits", () => {
  const { store, errors, capture, done } = fresh();
  try {
    const s = store.createSession({ model: "m", workspace: "/", title: "S" });
    const unread = () => store.errors(200, { resolved: false, read: false }).length;
    const one = capture(s.id, "429 rate limited", { retry: 1, wait_ms: 2000 });
    expect([unread(), !!one.read_ts, errorState(one)]).toEqual([0, true, "open"]);
    capture(s.id, "429 rate limited", { retry: 2, wait_ms: 4000 });
    expect(unread()).toBe(0);
    // The retries run out: this one is the owner's.
    capture(s.id, "429 rate limited");
    expect(unread()).toBe(1);
    // A later attempt of a kind that is open stays unread while it waits.
    capture(s.id, "429 rate limited", { retry: 1, wait_ms: 2000 });
    expect(unread()).toBe(1);
    // Opened from another session, a record says the kind's own last time beside that session's.
    const t = store.createSession({ model: "m", workspace: "/", title: "T" });
    const last = capture(t.id, "429 rate limited");
    const mine = atSession(errors.get(last.id)!, s.id);
    expect([mine.session_id, mine.kind_ts, mine.ts <= mine.kind_ts!]).toEqual([s.id, last.ts, true]);
  } finally { done(); }
});
