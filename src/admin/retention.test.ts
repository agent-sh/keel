// What the page cannot reach: the cleanup's clock, the running month, and
// the counts on the real usage schema, where a deleted record also changes
// the usage rollup through its triggers.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { ensureRollup } from "../server/routes/usage.ts";
import { readFile } from "../tools/files.ts";
import { removedNote } from "../tools/spill.ts";
import { PROPOSED, Retention } from "./retention.ts";
import { loadSettings, patchSettings, settings } from "./settings.ts";
import { Telemetry } from "./telemetry.ts";

const DAY = 86_400_000;
afterEach(() => setSystemTime());

test("nothing goes until a retention is set; then what a listing named, by its session's last use, and never the running month", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-retention-"));
  try {
    const store = new Store(join(root, "s"));
    loadSettings(store.stateDir, () => {});
    new Telemetry(store, new Bus());
    ensureRollup(store.db);
    expect(store.db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_rollup_%'").get()).toMatchObject({ n: 3 });
    // The 20th of a month at noon: the month began 19.5 days before.
    setSystemTime(new Date(2026, 5, 20, 12));
    const now = Date.now();
    const session = (title: string, usedDaysAgo: number, pinned = false) => {
      const s = store.createSession({ model: "p:m", workspace: root, title });
      store.db.run("UPDATE sessions SET updated = ?, settings = ? WHERE id = ?", [now - usedDaysAgo * DAY, JSON.stringify(pinned ? { pinned_ms: 1 } : {}), s.id]);
      return s.id;
    };
    const file = (id: string, rel: string, days: number, bytes = 1000) => {
      const p = join(store.stateDir, "spill", id, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "x".repeat(bytes));
      utimesSync(p, (now - days * DAY) / 1000, (now - days * DAY) / 1000);
      return p;
    };
    const idle = session("idle for forty days", 40), daily = session("used yesterday", 1), pinned = session("pinned", 90, true), working = session("working", 50), later = session("idle, listed later", 45);
    const gone = [file(idle, "1-bash-old.txt", 60), file(idle, "jobs/b1.log", 45, 3000), file(idle, "web/page.md", 41)];
    const stays = [
      file(idle, "jobs/b1.json", 45, 200),          // a command's record: the Terminal panel still lists it
      file(idle, "jobs/b2.log", 5),                  // written after its session's last turn
      file(daily, "1-bash-old.txt", 300),            // an old file of a session in use
      file(pinned, "1-bash-old.txt", 90),
      file(working, "1-bash-old.txt", 50),
      file("no-such-session", "1-bash-old.txt", 400), // a deleted session's folder: the Leftovers row removes it
    ];
    const laterFile = file(later, "1-bash-old.txt", 45);
    const call = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, outcome, cost, input, output) VALUES (?, ?, 'p:m', 'ok', 0.5, 10, 1)");
    for (let i = 0; i < 450; i++) call.run(idle, now - 400 * DAY - i);        // over a year old
    for (let i = 0; i < 30; i++) call.run(idle, now - 25 * DAY - i);           // last month
    for (let i = 0; i < 20; i++) call.run(daily, now - 12 * DAY - i);          // this month, twelve days ago
    for (let i = 0; i < 7; i++) store.db.run("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error) VALUES (?, ?, 'Bash', 5, 0)", [idle, now - 366 * DAY]);
    const rollup = () => store.db.query<{ n: number }, []>("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_rollup").get()!.n;
    expect(rollup()).toBe(500);
    const captured: unknown[] = [];
    const ret = new Retention(store, { isRunning: (id: string) => id === working } as any, { capture: (_s: string, e: unknown) => (captured.push(e), {} as any) });

    // Never by default: nothing is listed, nothing goes at any time, whatever is asked.
    expect(settings().retention).toEqual({ spill_days: 0, usage_days: 0 });
    expect(await ret.due(now)).toMatchObject({ spill: { before_ms: null, files: 0, session_ids: [] }, usage: { before_ms: null, calls: 0, tools: 0 } });
    expect(await ret.tick(now + 400 * DAY)).toBeUndefined();
    expect(await ret.remove({ spill_before_ms: now, usage_before_ms: now, sessions: [idle, later] }, now)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0 });
    expect([...gone, ...stays, laterFile].every((p) => existsSync(p))).toBe(true);
    // What the page proposes would list this, and still removes nothing.
    const would = await ret.due(now, PROPOSED);
    expect(would.spill).toMatchObject({ files: 4, bytes: 6000, sessions: 2, busy_sessions: 1, pinned_sessions: 1 });
    expect(would.usage).toMatchObject({ calls: 450, tools: 7 });

    // The owner accepts it. The listing: two idle sessions; the working and the pinned one are named as left alone.
    expect(patchSettings({ retention: PROPOSED }).ok).toBe(true);
    const due = await ret.due(now);
    expect(due.spill).toEqual({ before_ms: now - 30 * DAY, files: 4, bytes: 6000, sessions: 2, session_ids: expect.arrayContaining([idle, later]), busy_sessions: 1, pinned_sessions: 1 });
    expect(due.usage).toEqual({ before_ms: now - 365 * DAY, calls: 450, tools: 7 });
    // The cleanup's first time is a day after the setting changed.
    expect(due.next_ms).toBe(now + DAY);
    expect(await ret.tick(due.next_ms - 1)).toBeUndefined();

    // Remove now, for a listing that named only one of the sessions: the other keeps its file.
    const removed = await ret.remove({ spill_before_ms: now, usage_before_ms: now, sessions: [idle] }, now);
    // The counts are the rows and files that went, though each deleted call also changed the rollup.
    expect(removed).toEqual({ spill_files: 3, spill_bytes: 5000, usage_calls: 450, usage_tools: 7 });
    expect(rollup()).toBe(50);
    expect([...gone.map((p) => existsSync(p)), ...stays.map((p) => existsSync(p)), existsSync(laterFile)]).toEqual([false, false, false, true, true, true, true, true, true, true]);
    expect(captured).toEqual([]);

    // A removed file says what became of it: to the model that reads it again, and to the page.
    const read = await readFile(gone[0]!, { cwd: root, spillDir: join(store.stateDir, "spill", idle), seen: new Map() } as any);
    expect(read).toMatchObject({ error: true });
    expect(read.content).toContain("was removed by the storage retention on 2026-06-20: spilled output is kept 30 days after its session was last used (Settings, Storage). Run the command again to get its output.");
    expect(ret.removedOf(idle, [gone[0]!, gone[1]!, stays[1]!, join(store.stateDir, "spill", idle, "never-was.txt"), "/etc/passwd"])).toEqual([gone[0]!, gone[1]!]);
    expect(removedNote(join(store.stateDir, "spill", daily, "never-was.txt"), join(store.stateDir, "spill", daily))).toBeUndefined();
    expect(JSON.parse(readFileSync(join(store.stateDir, "spill", idle, ".retention.json"), "utf8"))).toMatchObject({ files: 3, bytes: 5000, kept_days: 30 });

    // A short retention never reaches into the running month: the monthly spend limit counts those records.
    expect(patchSettings({ retention: { usage_days: 7 } }).ok).toBe(true);
    const short = await ret.due(now);
    expect(short.usage).toEqual({ before_ms: new Date(2026, 5, 1).getTime(), calls: 30, tools: 0 });
    expect(await ret.remove({ usage_before_ms: now }, now)).toMatchObject({ usage_calls: 30 });
    expect(store.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM telemetry_calls WHERE ts >= ?").get(new Date(2026, 5, 1).getTime())!.n).toBe(20);
    expect(rollup()).toBe(20);

    // The daily cleanup, a day after that change: what is past the settings in every session it may touch.
    const next = ret.next();
    expect(await ret.tick(next - 1)).toBeUndefined();
    expect(await ret.tick(next)).toMatchObject({ spill_files: 1 });
    expect([existsSync(laterFile), stays.every((p) => existsSync(p))]).toEqual([false, true]);
    expect(ret.next()).toBe(next + DAY);
    expect(patchSettings({ retention: { spill_days: -1 } }).ok).toBe(false);
    ret.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
