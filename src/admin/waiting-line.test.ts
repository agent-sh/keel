// A parked agent in the sessions report says what it waits on and until when,
// also when its timeline has no line of it (the audit's "Parked lane 2": waiting).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { overview, overviewText } from "./overview.ts";
import { waitingOf } from "./waiting-line.ts";

test("a waiting row with no timeline line is told from its state: on what, since when, due when", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "waiting-line-"));
  const store = new Store(dir);
  try {
    store.migrate(`ALTER TABLE sessions ADD COLUMN parent_id TEXT;
      CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, status TEXT, created INTEGER, ended INTEGER);`);
    const now = Date.now();
    const lead = store.createSession({ model: "fixture:m", workspace: dir, title: "Coordinator" }).id;
    const parked = store.createSession({ model: "fixture:m", workspace: dir, title: "Parked lane 2" }).id;
    const file = store.createSession({ model: "fixture:m", workspace: dir, title: "File lane" }).id;
    for (const [i, id] of [parked, file].entries()) {
      store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(lead, id);
      store.db.query("INSERT INTO agents (id, parent_id, session_id, status, created, ended) VALUES (?, ?, ?, 'waiting', ?, NULL)").run(`agent${i}`, lead, id, now - 300_000);
    }
    const states: Record<string, any> = {
      [lead]: { watch: "wait", agents: 0, why: "agent" },
      [parked]: { watch: "wait", agents: 0, why: "timer", since: now - 240_000, until: now + 35 * 60_000 },
      [file]: { watch: "wait", agents: 0, why: "wait", on: "file", since: now - 120_000, until: now + 8 * 60_000 },
    };
    const from = { store, counts: () => new Map<string, number>(), now: () => ({ state: "waiting" as const, lines: [] }), state: (x: { id: string }) => states[x.id] };
    const lines = overviewText(overview(from, { since: now - 3_600_000, of: lead })).split("\n");
    // It read "Parked lane 2": waiting; with nothing of what or when.
    expect(lines.find((l) => l.includes('"Parked lane 2"'))).toStartWith('  "Parked lane 2": waiting for a timer, for 4 min, due in 35 min');
    expect(lines.find((l) => l.includes('"File lane"'))).toStartWith('  "File lane": waiting for a file, for 2 min, due in 8 min');
    // A provider's wait has its own line elsewhere; a state that is not a wait adds nothing.
    expect(waitingOf({ watch: "wait", why: "resume", until: now }, now)).toEqual({});
    expect(waitingOf({ watch: "work", why: "tool" }, now)).toEqual({});
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
