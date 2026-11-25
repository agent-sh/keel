// What the page cannot reach: the cleanup's clock, the running month, and
// the counts on the real usage schema, where a deleted record also changes
// the usage rollup through its triggers.
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { ensureRollup } from "../server/routes/usage.ts";
import { readFile } from "../tools/files.ts";
import { removedNote } from "../tools/spill.ts";
import { PROPOSED, Retention, retentionOf } from "./retention.ts";
import { EGRESS_SCHEMA } from "../safety/egress-report.ts";
import { loadSettings, patchSettings, settings } from "./settings.ts";
import { allHooks } from "../engine/hooks.ts";
import { Telemetry } from "./telemetry.ts";

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
// The settings are process-wide too: a test that loads a folder of its own and removes it leaves the files after
// this one a settings file no save can write. The scratch state folder is loaded again.
afterAll(() => { allHooks().length = hooksAtStart; loadSettings(process.env.KEEL_STATE_DIR!, () => {}); });

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
      file(idle, "cleared/t0.txt", 60),              // the text a stub in the context names (src/engine/cold-clear.ts)
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
    // (The outward ledger alone has a retention by default; this store has no ledger.)
    expect(settings().retention).toEqual({ spill_days: 0, usage_days: 0, egress_days: 30 });
    expect(await ret.due(now)).toMatchObject({ spill: { before_ms: null, files: 0, session_ids: [] }, usage: { before_ms: null, calls: 0, tools: 0 } });
    expect(await ret.tick(now + 400 * DAY)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0, egress_rows: 0 });
    expect(await ret.remove({ spill_before_ms: now, usage_before_ms: now, sessions: [idle, later] }, now)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0, egress_rows: 0 });
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
    expect(removed).toEqual({ spill_files: 3, spill_bytes: 5000, usage_calls: 450, usage_tools: 7, egress_rows: 0 });
    expect(rollup()).toBe(50);
    expect([...gone.map((p) => existsSync(p)), ...stays.map((p) => existsSync(p)), existsSync(laterFile)]).toEqual([false, false, false, true, true, true, true, true, true, true, true]);
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

// settings.json is the owner's file: a value written into it by hand is read
// at the next start, with no save to check it and no settings event. One
// that is not a whole number of days must remove nothing, and a valid one
// gets the same day's notice as one saved on the page.
test("a retention edited into settings.json by hand: a value that is not days removes nothing and is named once; a valid one waits its day", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-retention-"));
  try {
    setSystemTime(new Date(2026, 5, 20, 12));
    const now = Date.now();
    // A state folder as a daemon finds it at a start: the file as it was edited, old output, old records, and a cleanup time long past.
    const world = (name: string, retention: unknown) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ retention }));
      const store = new Store(dir);
      const errs: string[] = [];
      loadSettings(store.stateDir, (e) => errs.push((e as Error).message));
      new Telemetry(store, new Bus());
      ensureRollup(store.db);
      const session = (usedDaysAgo: number) => {
        const s = store.createSession({ model: "p:m", workspace: root, title: `idle ${usedDaysAgo} days` });
        store.db.run("UPDATE sessions SET updated = ? WHERE id = ?", [now - usedDaysAgo * DAY, s.id]);
        const p = join(dir, "spill", s.id, "1-bash.txt");
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, "x".repeat(1000));
        utimesSync(p, (now - usedDaysAgo * DAY) / 1000, (now - usedDaysAgo * DAY) / 1000);
        return { id: s.id, file: p };
      };
      const minute = store.createSession({ model: "p:m", workspace: root, title: "idle a minute" });
      const fresh = join(dir, "spill", minute.id, "1-bash.txt");
      mkdirSync(join(fresh, ".."), { recursive: true });
      writeFileSync(fresh, "new");
      utimesSync(fresh, (now - 60_000) / 1000, (now - 60_000) / 1000);
      store.db.run("UPDATE sessions SET updated = ? WHERE id = ?", [now - 60_000, minute.id]);
      const three = session(3), hundred = session(100);
      const call = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, outcome, cost, input, output) VALUES (?, ?, 'p:m', 'ok', 0.5, 10, 1)");
      const tool = store.db.query("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error) VALUES (?, ?, 'Bash', 5, 0)");
      store.db.transaction(() => { for (let i = 0; i < 500; i++) { call.run(three.id, now - Math.floor((i / 500) * 200 * DAY)); tool.run(three.id, now - Math.floor((i / 500) * 200 * DAY)); } })();
      // The clock of a daemon that was down past its cleanup time.
      store.db.run("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      store.db.run("INSERT INTO admin_meta (key, value) VALUES ('retention_next_ms', ?)", [String(now - DAY)]);
      const ret = new Retention(store, { isRunning: () => false } as any, { capture: (_s: string, e: unknown) => (errs.push((e as Error).message), {} as any) });
      const rows = () => [store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_calls").get()!.n, store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_tools").get()!.n];
      return { store, ret, errs, rows, files: [fresh, three.file, hundred.file], ids: [minute.id, three.id, hundred.id] };
    };

    // Not a whole number of days of at least 1: never. Nothing is listed, nothing goes at the start's cleanup, at
    // a later one, or when a removal is posted for everything; and the setting is named in Errors once.
    for (const [label, val, named] of [["minus-one", -1, "-1"], ["half", 0.5, "0.5"], ["true", true, "true"], ["string", "30", "\"30\""], ["list", [30], "[30]"]] as const) {
      const w = world(label, { spill_days: val, usage_days: val });
      expect(retentionOf()).toMatchObject({ spill_days: 0, usage_days: 0, invalid: [{ name: "retention.spill_days", value: val }, { name: "retention.usage_days", value: val }] });
      expect(await w.ret.tick(now)).toBeUndefined();
      // (The ledger's default still runs its cleanup; nothing of these goes.)
      expect(await w.ret.tick(now + 40 * DAY)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0, egress_rows: 0 });
      expect(await w.ret.due(now)).toMatchObject({ spill: { before_ms: null, files: 0, session_ids: [] }, usage: { before_ms: null, calls: 0, tools: 0 } });
      expect(await w.ret.remove({ spill_before_ms: now, usage_before_ms: now, sessions: w.ids }, now)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0, egress_rows: 0 });
      expect([w.files.map((f) => existsSync(f)), w.rows()]).toEqual([[true, true, true], [500, 500]]);
      expect(w.errs).toEqual([
        `settings.json: retention.spill_days is ${named}, which is not a whole number of days of at least 1 (0 is never). It is read as never: nothing is removed for it until it is set.`,
        `settings.json: retention.usage_days is ${named}, which is not a whole number of days of at least 1 (0 is never). It is read as never: nothing is removed for it until it is set.`,
      ]);
      w.ret.stop();
      w.store.db.close();
    }
    // Never, written three ways: nothing goes and nothing is reported.
    for (const [label, val] of [["null", null], ["zero", 0], ["absent", undefined]] as const) {
      const w = world(label, val === undefined ? {} : { spill_days: val, usage_days: val });
      expect(retentionOf().invalid).toEqual([]);
      expect(await w.ret.tick(now)).toBeUndefined();
      expect([w.files.map((f) => existsSync(f)), w.rows(), w.errs]).toEqual([[true, true, true], [500, 500], []]);
      w.ret.stop();
      w.store.db.close();
    }
    // One setting valid, one not: the valid one is acted on, the other is never.
    {
      const w = world("mixed", { spill_days: 30, usage_days: -1 });
      expect(retentionOf()).toMatchObject({ spill_days: 30, usage_days: 0, invalid: [{ name: "retention.usage_days", value: -1 }] });
      expect((await w.ret.due(now)).usage).toMatchObject({ before_ms: null, calls: 0 });
      w.ret.stop();
      w.store.db.close();
    }

    // A valid retention written into the file while the daemon was down, its cleanup time long past: the
    // start's cleanup removes nothing, the next one is a day out, and the page lists what it will remove.
    const w = world("valid", { spill_days: 30, usage_days: 90 });
    expect(w.ret.next()).toBe(now + DAY);
    expect(await w.ret.tick(now)).toBeUndefined();
    expect([w.files.map((f) => existsSync(f)), w.rows(), w.errs]).toEqual([[true, true, true], [500, 500], []]);
    const due = await w.ret.due(now);
    expect(due).toMatchObject({ next_ms: now + DAY, spill: { files: 1, sessions: 1, session_ids: [w.ids[2]!] }, usage: { before_ms: now - 90 * DAY } });
    expect(due.usage.calls).toBeGreaterThan(200);
    // A restart within that day does not start the day again, and does not act either.
    w.ret.stop();
    const again = new Retention(w.store, { isRunning: () => false } as any, { capture: () => ({}) as any });
    expect(again.next()).toBe(now + DAY);
    expect(await again.tick(now + DAY - 1)).toBeUndefined();
    // A day later: what the page lists then (the same file, and the records a day older), and nothing of a session used since.
    const then = await again.due(now + DAY);
    expect(then.usage.calls).toBeGreaterThanOrEqual(due.usage.calls);
    expect(await again.tick(now + DAY)).toEqual({ spill_files: 1, spill_bytes: 1000, usage_calls: then.usage.calls, usage_tools: then.usage.tools, egress_rows: 0 });
    expect(w.files.map((f) => existsSync(f))).toEqual([true, true, false]);
    // Edited again while it was down (shorter): a day's notice once more.
    again.stop();
    writeFileSync(join(w.store.stateDir, "settings.json"), JSON.stringify({ retention: { spill_days: 1, usage_days: 90 } }));
    loadSettings(w.store.stateDir, () => {});
    setSystemTime(new Date(now + 5 * DAY));
    const third = new Retention(w.store, { isRunning: () => false } as any, { capture: () => ({}) as any });
    expect(third.next()).toBe(now + 6 * DAY);
    expect(await third.tick()).toBeUndefined();
    expect(existsSync(w.files[1]!)).toBe(true);
    expect((await third.due()).spill).toMatchObject({ files: 2, sessions: 2 });
    third.stop();
    w.store.db.close();
  } finally {
    loadSettings(join(root, "none"), () => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("the outward ledger is kept 30 days by default, and its rows past that go in the daily cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-retention-egress-"));
  try {
    const store = new Store(join(root, "s"));
    loadSettings(store.stateDir, () => {});
    store.migrate(EGRESS_SCHEMA);
    setSystemTime(new Date(2026, 5, 20, 12));
    const now = Date.now();
    const row = store.db.query("INSERT INTO egress (ts, session_id, tool, host, port, bytes_out, outcome) VALUES (?, 's', 'model', 'api.example.com', 443, 100, 'sent')");
    for (let i = 0; i < 2500; i++) row.run(now - 40 * DAY - i);   // past 30 days: more than a step of the removal
    for (let i = 0; i < 10; i++) row.run(now - 10 * DAY - i);
    const n = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress").get()!.n;
    // A start after an upgrade: the notice it last gave named no ledger, so its day of notice starts now.
    store.db.run("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    store.db.run("INSERT INTO admin_meta (key, value) VALUES ('retention_noticed', ?), ('retention_next_ms', ?)", [JSON.stringify({ spill_days: 0, usage_days: 0 }), String(now - DAY)]);
    const ret = new Retention(store, { isRunning: () => false } as any, { capture: () => ({}) as any });
    expect(retentionOf()).toMatchObject({ egress_days: 30, invalid: [] });
    const due = await ret.due(now);
    expect(due.egress).toEqual({ before_ms: now - 30 * DAY, rows: 2500 });
    expect(due.next_ms).toBe(now + DAY);
    expect(await ret.tick(now)).toBeUndefined();
    expect(n()).toBe(2510);
    // A day later the cleanup removes them, and nothing younger.
    expect(await ret.tick(now + DAY)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0, egress_rows: 2500 });
    expect(n()).toBe(10);
    // Never (0) keeps every row; a removal posted for everything removes none.
    expect(patchSettings({ retention: { egress_days: 0 } }).ok).toBe(true);
    expect((await ret.due(now + DAY)).egress).toEqual({ before_ms: null, rows: 0 });
    expect(await ret.remove({ egress_before_ms: now + DAY }, now + DAY)).toMatchObject({ egress_rows: 0 });
    // A shorter one removes up to the instant asked, never past what it allows.
    expect(patchSettings({ retention: { egress_days: 5 } }).ok).toBe(true);
    expect(await ret.remove({ egress_before_ms: now + DAY }, now)).toMatchObject({ egress_rows: 10 });
    expect(n()).toBe(0);
    ret.stop();
    store.db.close();
  } finally {
    loadSettings(join(root, "none"), () => {});
    rmSync(root, { recursive: true, force: true });
  }
});
