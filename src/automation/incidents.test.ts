import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import * as activity from "./activity.ts";
import * as alerts from "./alerts.ts";
import { setDeps } from "./core.ts";
import * as incidents from "./incidents.ts";

// The incidents' frame to the pages, over a scratch store: one only when something of an incident
// changed, with the open ones and what cleared since the last frame. A held wait is synced at each
// of its tries; a page must not hear the same row each time.
// Another file's daemon start may have left its restart record on the process: this one has none.
const G = globalThis as { __keelRestarts?: unknown };
const restarts = G.__keelRestarts;
beforeAll(() => { delete G.__keelRestarts; });
afterAll(() => { incidents.unbind(); G.__keelRestarts = restarts; });

test("an incidents frame goes only when an incident changed, and carries what cleared since the last one", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-incidents-")));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const bus = new Bus();
  const outages: any[] = [];
  setDeps({ store, bus, errors: { capture: () => {}, onCapture: () => () => {} }, providers: { get: () => ({ label: "Provider" }), outages: { list: () => outages } } } as any);
  alerts.migrate();
  activity.migrate();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  incidents.bind();
  const frames: any[] = [];
  bus.on((f) => { if (f.t === "feature" && f.name === "incidents") frames.push(f.data); });
  const a = store.createSession({ title: "A", model: "p:m", workspace: "/" }).id;
  const b = store.createSession({ title: "B", model: "p:m", workspace: "/" }).id;

  const since = Date.now() - 1_000;
  outages.push({ provider: "p", since, confirmed: true, message: "ECONNREFUSED", sessions: [a, b] });
  incidents.syncHeld();
  incidents.frame();
  expect(frames).toHaveLength(1);
  expect(frames[0].open.map((i: any) => i.key)).toEqual(["provider:p"]);
  // The wait's next tries hold the same sessions: no row written again, no frame.
  incidents.syncHeld();
  incidents.syncHeld();
  incidents.frame();
  expect(frames).toHaveLength(1);
  // One went on: that is news.
  outages[0].sessions = [a];
  incidents.syncHeld();
  incidents.frame();
  expect(frames).toHaveLength(2);
  expect(frames[1].open[0].touched.find((t: any) => t.id === b).state).toBe("went_on");

  // It answers: the frame has it as cleared, and the frame after it no longer carries it.
  incidents.outageOver(outages.pop(), 60_000, true);
  incidents.frame();
  expect(frames).toHaveLength(3);
  expect([frames[2].open, frames[2].cleared.map((i: any) => i.cleared_how)]).toEqual([[], ["it answers again, after 1m"]]);
  outages.push({ provider: "q", since: Date.now(), confirmed: true, message: "ECONNREFUSED", sessions: [b] });
  incidents.syncHeld();
  incidents.frame();
  expect(frames).toHaveLength(4);
  expect([frames[3].open.map((i: any) => i.key), frames[3].cleared]).toEqual([["provider:q"], []]);
  // The list still has the cleared one, read from memory.
  expect(incidents.listed().cleared.map((i) => i.key)).toEqual(["provider:p"]);
});
