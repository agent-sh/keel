// The model's automation tools run unasked (the gate reads them as reads), so
// what each refuses is the whole of its permission.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { setDeps } from "./core.ts";
import * as loops from "./loops.ts";
import * as waits from "./waits.ts";
import { automationTools } from "./tools.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-auto-")));
setDeps({ store, bus: new Bus(), errors: { capture() {} } } as any);
loops.migrate();
waits.migrate();
const s = store.createSession({ model: "m", workspace: "/", title: "t" });
const ctx = { sessionId: s.id, cwd: "/", signal: new AbortController().signal, spillDir: "/", seen: new Map() };
const tool = (name: string) => automationTools.find((t) => t.name === name)!;
const text = (o: { content: unknown }) => String(o.content);

test("an http wait follows web fetch's address rules", async () => {
  const r = await tool("WaitFor").run({ kind: "http", url: "http://127.0.0.1:3000/health" }, ctx);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("local or private address");
});

test("a wait on a background command's output file that no command of the session has is refused", async () => {
  const spill = mkdtempSync(join(tmpdir(), "keel-spill-"));
  const own = { ...ctx, spillDir: spill };
  const r = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1made-up.log"), contains: "done" }, own);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("does not wake this session");
  expect(text(r)).not.toContain("wakes this session by itself");
  mkdirSync(join(spill, "jobs"));
  writeFileSync(join(spill, "jobs", "b1real.log"), "");
  const real = await tool("WaitFor").run({ kind: "log", path: join(spill, "jobs", "b1real.log"), match: "^done" }, own);
  expect(real.is_error).toBeFalsy();
  // The exit file of a command that runs: written when it ends, so the wait is the wake for its end.
  const exit = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1real.log.exit") }, own);
  expect(exit.is_error).toBeFalsy();
  const noExit = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1made-up.log.exit") }, own);
  expect(noExit.is_error).toBe(true);
  const elsewhere = await tool("WaitFor").run({ kind: "file", path: join(spill, "later.log") }, own);
  expect(elsewhere.is_error).toBeFalsy();
  for (const w of waits.list(s.id)) waits.cancel(w.id, s.id);
});

test("CronDelete deletes the model's own scheduled tasks, not the owner's", async () => {
  const mine = loops.create({ session_id: s.id, schedule: "10m", prompt: "check", created_by: "model" }).loop;
  const owners = loops.create({ session_id: s.id, schedule: "10m", prompt: "report", created_by: "owner" }).loop;
  expect((await tool("CronDelete").run({ id: owners.id }, ctx)).is_error).toBe(true);
  expect(loops.get(owners.id)).toBeTruthy();
  expect((await tool("CronDelete").run({ id: mine.id }, ctx)).is_error).toBeFalsy();
});
