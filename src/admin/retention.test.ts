// What the page cannot reach: the daily cleanup's clock. What is past the
// retention is counted, a working session is left alone, a removal never
// reaches past the settings whatever it is asked, and the cleanup waits a
// day after it first runs and after a setting changes.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Retention } from "./retention.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const DAY = 86_400_000;

test("what is past the retention is listed, then removed up to the listing and never past the settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-retention-"));
  try {
    const store = new Store(join(root, "s"));
    loadSettings(store.stateDir, () => {});
    store.db.run("CREATE TABLE telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER NOT NULL)");
    store.db.run("CREATE TABLE telemetry_tools (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER NOT NULL)");
    const now = Date.now();
    const file = (rel: string, days: number, bytes = 1000) => {
      const p = join(store.stateDir, "spill", rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "x".repeat(bytes));
      utimesSync(p, (now - days * DAY) / 1000, (now - days * DAY) / 1000);
      return p;
    };
    const old = [file("idle/out-old.txt", 40), file("idle/jobs/b1.log", 45, 3000), file("gone-session/web/page.md", 400)];
    const young = [file("idle/out-young.txt", 3), file("idle/jobs/b2.log", 29)];
    const working = file("working/out-old.txt", 60);
    for (let i = 0; i < 2500; i++) store.db.run("INSERT INTO telemetry_calls (session_id, ts) VALUES ('a', ?)", [now - 400 * DAY - i]);
    for (let i = 0; i < 10; i++) store.db.run("INSERT INTO telemetry_calls (session_id, ts) VALUES ('a', ?)", [now - 300 * DAY]);
    for (let i = 0; i < 7; i++) store.db.run("INSERT INTO telemetry_tools (session_id, ts) VALUES ('a', ?)", [now - 366 * DAY]);
    const captured: unknown[] = [];
    const ret = new Retention(store, { isRunning: (id: string) => id === "working" } as any, { capture: (_s: string, e: unknown) => (captured.push(e), {} as any) });

    // The defaults: 30 days of spilled output, a year of usage records.
    const due = await ret.due(now);
    expect(due.spill).toEqual({ before_ms: now - 30 * DAY, files: 3, bytes: 5000, sessions: 2, busy_sessions: 1 });
    expect(due.usage).toEqual({ before_ms: now - 365 * DAY, calls: 2500, tools: 7 });

    // The cleanup's first time is a day away: nothing goes before the page could list it.
    expect(due.next_ms).toBeGreaterThan(now + DAY - 5000);
    expect(await ret.tick(now + DAY - 60_000)).toBeUndefined();
    expect(old.every((p) => existsSync(p))).toBe(true);

    // Asked to remove everything up to now: only what the settings allow goes.
    const removed = await ret.remove({ spill_before_ms: now, usage_before_ms: now }, now);
    expect(removed).toEqual({ spill_files: 3, spill_bytes: 5000, usage_calls: 2500, usage_tools: 7 });
    expect([...old.map((p) => existsSync(p)), ...young.map((p) => existsSync(p)), existsSync(working)]).toEqual([false, false, false, true, true, true]);
    // A folder the removal emptied goes with it; one that still holds a file stays.
    expect([existsSync(join(store.stateDir, "spill", "gone-session")), existsSync(join(store.stateDir, "spill", "idle", "jobs"))]).toEqual([false, true]);
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_calls").get()!.n).toBe(10);
    expect(captured).toEqual([]);

    // Never: nothing is counted and nothing goes, whatever is asked.
    expect(patchSettings({ retention: { spill_days: 0, usage_days: 0 } }).ok).toBe(true);
    expect(await ret.due(now)).toMatchObject({ spill: { before_ms: null, files: 0 }, usage: { before_ms: null, calls: 0 } });
    expect(await ret.remove({ spill_before_ms: now, usage_before_ms: now }, now)).toEqual({ spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0 });
    expect(young.every((p) => existsSync(p))).toBe(true);

    // A changed setting waits a day, then the daily cleanup acts on it.
    expect(patchSettings({ retention: { spill_days: 2, usage_days: 200 } }).ok).toBe(true);
    const next = ret.next();
    expect(next).toBeGreaterThan(Date.now() + DAY - 5000);
    expect(await ret.tick(next - 1)).toBeUndefined();
    const at = next + 1;
    expect(await ret.tick(at)).toEqual({ spill_files: 2, spill_bytes: 2000, usage_calls: 10, usage_tools: 0 });
    expect(ret.next()).toBe(at + DAY);
    expect(existsSync(working)).toBe(true);
    expect(patchSettings({ retention: { spill_days: -1 } }).ok).toBe(false);
    // A removed key is the default again, not never.
    expect((patchSettings({ retention: { spill_days: null } }) as any).settings.retention.spill_days).toBe(30);
    ret.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
