import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import * as activity from "./activity.ts";
import { setDeps } from "./core.ts";
import { rulings } from "./rulings.ts";

// The rulings service over a scratch store, for what an e2e cannot time: the
// owner revoking a ruling while the small model reads, and one call answered
// twice (a restart cut it after the answer).
const scratch = (small: () => Promise<{ text: string; model: string } | undefined>) => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-rulings-")));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const bus = new Bus();
  const errors = { capture: (_s: string, e: unknown) => { throw e; } };
  setDeps({ store, bus, errors } as any);
  activity.migrate();
  const cwd = mkdtempSync(join(tmpdir(), "keel-rulings-ws-"));
  const session = (title: string, parent?: string) => {
    const s = store.createSession({ title, model: "m", workspace: cwd });
    if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
    return s.id;
  };
  const r = rulings({ store, bus, errors, engine: { small } } as any);
  const lead = session("Lead");
  const ctx = (sessionId: string, callId: string) => ({ sessionId, callId, cwd, signal: new AbortController().signal }) as any;
  const runner = (question: string) => [{ id: "0", question, options: [{ label: "bun test" }, { label: "vitest" }] }] as any;
  // The first agent's question, answered by the owner and kept for the tree.
  const first = session("Asker", lead);
  r.after(ctx(first, "c1"), runner("Which test runner?"), { "0": { picked: ["bun test"] } });
  const mark = r.keep(first, "c1", "tree");
  return { r, ctx, runner, session, lead, id: mark.rulings![0]!.id, uses: () => activity.list({}).items.filter((a) => a.kind === "ruling" && a.sub === "used").length };
};

test("a ruling revoked while the small model reads answers nothing: the owner gets the card", async () => {
  let reply!: (v: { text: string; model: string }) => void;
  const { r, ctx, runner, session, lead, id } = scratch(() => new Promise((res) => (reply = res)));
  const asking = r.before(ctx(session("Reader", lead), "c2"), runner("Which test runner do we use here?"));
  expect(asking).toBeInstanceOf(Promise);
  r.revoke(id);
  reply({ text: "0: 1", model: "small" });
  expect(await asking).toBeUndefined();
  expect(r.list()[0]!.uses).toBe(0);
});

test("one call answered from a ruling twice is one use and one timeline row", async () => {
  const { r, ctx, runner, session, lead, uses } = scratch(async () => undefined);
  const reader = session("Reader", lead);
  for (let i = 0; i < 2; i++) expect((await r.before(ctx(reader, "c2"), runner("Which test runner?")))?.answers).toEqual({ "0": { picked: ["bun test"] } });
  expect(r.list()[0]!.uses).toBe(1);
  expect(uses()).toBe(1);
});
