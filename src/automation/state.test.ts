import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import * as agents from "./agents.ts";
import { setDeps } from "./core.ts";
import { sessionState, TALLY } from "./state.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

test("a session's state counts its own agents by a seek on the parent, never by a pass over every agent stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const store = new Store(join(dir, "state"));
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, isHeld: () => false }, providers: { current: () => [] } } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  agents.migrate();
  const lead = store.createSession({ model: "m:x", workspace: dir, title: "Lead" });
  const other = store.createSession({ model: "m:x", workspace: dir, title: "Other" });
  const alone = store.createSession({ model: "m:x", workspace: dir, title: "Alone" });
  // Twelve agents of one session (four failed, one waiting), and twenty thousand of another.
  const add = store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created) VALUES (?, ?, ?, 'a', 'general-purpose', 'm:x', 1, ?, 1)");
  store.db.transaction(() => {
    ["failed", "failed", "failed", "failed", "waiting", ...Array(7).fill("completed")].forEach((st, i) => add.run(`lead-${i}`, lead.id, `sl-${i}`, st));
    for (let i = 0; i < 20_000; i++) add.run(`other-${i}`, other.id, `so-${i}`, i % 5 ? "completed" : "failed");
  })();
  expect(sessionState(store.session(lead.id)!)).toMatchObject({ agents: 1, agents_total: 12, agents_failed: 4, agents_waiting: 1 });
  expect(sessionState(store.session(other.id)!)).toMatchObject({ agents_total: 20_000, agents_failed: 4_000 });
  // A session with no agent has no counts.
  const none = sessionState(store.session(alone.id)!);
  expect(none.agents_total).toBeUndefined();
  expect(none.agents_failed).toBeUndefined();
  // The read is a search of one parent's rows on the parent's index: its cost does not grow with the table.
  // (It grouped the whole table for every state: 41 ms at a hundred thousand agents.)
  const plan = store.db.query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${TALLY}`).all(lead.id).map((r) => r.detail).join("; ");
  expect(plan).toContain("SEARCH agents USING INDEX agents_parent (parent_id=?)");
  expect(plan).not.toContain("SCAN");
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) store.db.query(TALLY).get(lead.id);
  expect((performance.now() - t0) / 200).toBeLessThan(1);
  store.db.close();
});
