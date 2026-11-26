import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { personTyped } from "../../safety/imported.ts";
import { runRoutes } from "./run.ts";

// A prompt of `keel run` is a program's as often as a person's: what the route sends is never marked as the owner's
// typing in the memory transcript, and it carries no origin (whose words the gate counts it stays as it was).
test("a prompt POST /api/run sends is not marked as a person's typing, and carries no origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-route-"));
  const store = new Store(dir);
  try {
    const s = store.createSession({ workspace: dir, model: "p:m" });
    const sent: any[] = [];
    const engine = { send: (id: string, text: string, o: any) => { sent.push({ id, data: { text, ...o?.meta } }); return {}; } };
    const routes = runRoutes({ store, bus: { emit() {} }, engine, providers: { models: async () => [] }, workspace: dir } as any) as any;
    const r = await routes["/api/run"].POST(new Request("http://keel/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "go on", session_id: s.id }) }));
    expect(r.status).toBe(201);
    expect(sent.map((x) => [x.id, x.data.text, x.data.origin])).toEqual([[s.id, "go on", undefined]]);
    expect(personTyped({ own: false, until: 0 }, { kind: "user", seq: 1, ts: Date.now(), data: sent[0].data })).toBe(false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
