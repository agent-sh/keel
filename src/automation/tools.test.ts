// The model's automation tools run unasked (the gate reads them as reads), so
// what each refuses is the whole of its permission.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { setDeps } from "./core.ts";
import * as loops from "./loops.ts";
import { automationTools } from "./tools.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-auto-")));
setDeps({ store, bus: new Bus(), errors: { capture() {} } } as any);
loops.migrate();
const s = store.createSession({ model: "m", workspace: "/", title: "t" });
const ctx = { sessionId: s.id, cwd: "/", signal: new AbortController().signal, spillDir: "/", seen: new Map() };
const tool = (name: string) => automationTools.find((t) => t.name === name)!;
const text = (o: { content: unknown }) => String(o.content);

test("an http wait follows web fetch's address rules", async () => {
  const r = await tool("WaitFor").run({ kind: "http", url: "http://127.0.0.1:3000/health" }, ctx);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("local or private address");
});

test("CronDelete deletes the model's own scheduled tasks, not the owner's", async () => {
  const mine = loops.create({ session_id: s.id, schedule: "10m", prompt: "check", created_by: "model" }).loop;
  const owners = loops.create({ session_id: s.id, schedule: "10m", prompt: "report", created_by: "owner" }).loop;
  expect((await tool("CronDelete").run({ id: owners.id }, ctx)).is_error).toBe(true);
  expect(loops.get(owners.id)).toBeTruthy();
  expect((await tool("CronDelete").run({ id: mine.id }, ctx)).is_error).toBeFalsy();
});
