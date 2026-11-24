// What the session's notices (a command's end, a restart note) ride on: a
// step of a turn, and nothing else. A server's sampling request, a summary or
// a side answer is not the session's conversation: a notice there would be
// sent to a model and a server the owner never saw it go to.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { addNotice, drainNotices } from "../../tools/jobs.ts";
import type { ProviderRequest } from "../../providers/types.ts";
import { toolRoutes } from "./tools.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "tools-routes-"));
const store = new Store(dir);
const before = allHooks().length;
toolRoutes({ store, bus: new Bus(), engine: { isRunning: () => false, isHeld: () => false }, errors: { capture: () => {} } } as any);
const hook = allHooks().slice(before).find((h) => h.beforeRequest)!;
afterAll(() => {
  allHooks().length = before;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a session's notices go with a step of its turn, never with a sampling, summary or side request", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  addNotice(s.id, "The command `deploy --token x` ended; its log is /logs/job-1.log.");
  const req = (purpose: ProviderRequest["purpose"]): ProviderRequest => ({ model: "m", system: "", messages: [{ role: "user", content: [{ type: "text", text: "What is the capital of France?" }] }], tools: [], signal: new AbortController().signal, purpose });
  for (const purpose of ["sampling", "summary", "side", "reader", "warm"] as const) {
    const r = await hook.beforeRequest!(s, req(purpose));
    expect({ purpose, sent: JSON.stringify(r.messages) }).toEqual({ purpose, sent: JSON.stringify(req(purpose).messages) });
  }
  // The turn's next step gets it.
  const turn = await hook.beforeRequest!(s, req("turn"));
  expect(JSON.stringify(turn.messages)).toContain("deploy --token x");
  expect(drainNotices(s.id)).toEqual([]);
});

test("a command's end a note already tells is not told again, found without a search over the session's events", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const sql: string[] = [];
  const query = store.db.query.bind(store.db);
  (store.db as any).query = (text: string) => (sql.push(text), query(text));
  try {
    const req = (): ProviderRequest => ({ model: "m", system: "", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [], signal: new AbortController().signal, purpose: "turn" });
    addNotice(s.id, "The command `a` ended.", { job: "job-7" });
    expect(JSON.stringify((await hook.beforeRequest!(s, req())).messages)).toContain("The command `a` ended.");
    // Told: the same end noted again (a restart came between storing it and marking it reported).
    addNotice(s.id, "The command `a` ended AGAIN.", { job: "job-7" });
    expect(JSON.stringify((await hook.beforeRequest!(s, req())).messages)).not.toContain("AGAIN");
    expect(sql.filter((q) => /\bFROM events\b/.test(q) && /LIKE/i.test(q))).toEqual([]);
  } finally {
    (store.db as any).query = query;
  }
});
