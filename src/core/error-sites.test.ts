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

test("a kind that happened in three sessions lists each with its own count and latest time, and a session's own occurrence is the one opened from it", () => {
  const { store, errors, frames, capture, done } = fresh();
  try {
    const [a, b, c] = ["A", "B", "C"].map((title) => store.createSession({ model: "m", workspace: "/", title }));
    const turn = (id: string) => store.append(id, "turn_start", {}).id;
    const ta = turn(a!.id);
    errors.capture("provider", new Error("credit balance too low"), { session: a!.id }, { turn_event: ta, span_id: "span-a" });
    capture(a!.id, "credit balance too low");
    capture(b!.id, "credit balance too low");
    const last = capture(c!.id, "credit balance too low");
    // One kind, four times, last in C: what the row alone says.
    expect([last.count, last.session_id]).toEqual([4, c!.id]);
    const rec = errors.get(last.id)!;
    expect(rec.sites!.map((s) => `${s.title} ${s.count}`).sort()).toEqual(["A 2", "B 1", "C 1"]);
    expect(frames.at(-1)!.sites!.length).toBe(3);
    // The list of a session holds the kind although it last happened elsewhere.
    expect(errors.list(200, { session: a!.id }).map((e) => e.id)).toEqual([last.id]);
    expect(errors.list(200, { session: b!.id })[0]!.sites!.find((s) => s.session_id === b!.id)!.count).toBe(1);
    // Opened from A it is A's: its session, and no turn or span of C's.
    const first = errors.capture("provider", new Error("credit balance too low"), { session: a!.id }, { turn_event: ta, span_id: "span-a" });
    capture(c!.id, "credit balance too low");
    const mine = atSession(errors.get(first.id)!, a!.id);
    expect([mine.session_id, mine.turn_event, mine.span_id, mine.context]).toEqual([a!.id, ta, "span-a", undefined]);
    expect(atSession(errors.get(first.id)!, "no-such").session_id).toBe(c!.id);
    // Found by the end of its id, as a text row prints it.
    expect(errors.find(last.id.slice(-12))!.id).toBe(last.id);
    // A removed session takes its site with it: its count is said as held by no session.
    store.db.run("DELETE FROM sessions WHERE id = ?", [b!.id]);
    const lines = errorLines([errors.get(last.id)!], { now: 0 });
    expect(lines.some((l) => /1x  with no session recorded/.test(l))).toBe(true);
    expect(lines.filter((l) => /keel debug [0-9a-f]{12} --session [0-9a-f]{12}/.test(l)).length).toBe(2);
  } finally { done(); }
});

test("a failure a retry healed is recovered and read; one that was not healed keeps the kind open", () => {
  const { store, errors, frames, capture, done } = fresh();
  try {
    const s = store.createSession({ model: "m", workspace: "/", title: "Overloaded" });
    const other = store.createSession({ model: "m", workspace: "/", title: "Other" });
    const r1 = capture(s.id, "529 overloaded", { retry: 1 });
    const r2 = capture(s.id, "529 overloaded", { retry: 2 });
    expect(errorState(errors.get(r1.id)!)).toBe("open");
    errors.recovered([r1, r2], s.id);
    const healed = errors.get(r1.id)!;
    expect([errorState(healed), healed.sites![0]!.healed, !!healed.read_ts]).toEqual(["recovered", 2, true]);
    expect(errorState(frames.at(-1)!)).toBe("recovered");
    expect(errorLines([healed])[0]).toStartWith("0 open, 1 recovered (a retry passed).");
    // It happens again elsewhere and the retries run out: open and unread again.
    capture(other.id, "529 overloaded");
    const again = errors.get(r1.id)!;
    expect([errorState(again), again.read_ts]).toEqual(["open", undefined]);
    // Healed there too: recovered again.
    errors.recovered([again], other.id);
    expect(errorState(errors.get(r1.id)!)).toBe("recovered");
    // An occurrence outside any session is never healed.
    errors.capture("provider", new Error("529 overloaded"));
    expect(errorState(errors.get(r1.id)!)).toBe("open");
  } finally { done(); }
});

test("recovered only when every counted occurrence was healed in a session", () => {
  const site = (count: number, healed: number) => ({ session_id: "s", count, healed, first_ts: 1, ts: 2, ...(healed ? { healed_ts: 5 } : {}) });
  expect(recoveredAt(3, [site(3, 3)])).toBe(5);
  expect(recoveredAt(3, [site(3, 2)])).toBeUndefined();
  expect(recoveredAt(4, [site(3, 3)])).toBeUndefined();
  expect(recoveredAt(1, [])).toBeUndefined();
});

// A captured failure whose text or context holds a key-shaped string is stored without it.
test("a key in a captured error is not in its row", () => {
  const { store, errors, done } = fresh();
  try {
    const key = ["sk", "ant", "api03", "PLANTEDKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH"].join("-");
    const rec = errors.capture("tool", new Error(`the tool printed ${key}`), { tool: "Bash", stderr: `marker ${key}` });
    expect(rec.message).toBe("the tool printed <redacted>");
    expect(JSON.stringify(store.db.query("SELECT * FROM errors").all())).not.toContain("PLANTEDKEY");
  } finally { done(); }
});
