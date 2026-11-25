// A session's folder move takes the agents that share its folder; an agent in a worktree of its own stays.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { Worktrees } from "../../worktree/manager.ts";
import { placesRoutes } from "./places.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `folder-agents-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("moving a session takes its folder agents along and leaves the worktree agent where it is", async () => {
  const old = join(root, "old"), next = join(root, "next"), wt = join(root, "wt");
  for (const d of [old, next, wt]) mkdirSync(d, { recursive: true });
  const store = new Store(join(root, "state"));
  const bus = new Bus();
  const routes = placesRoutes({ store, bus, errors: new ErrorTracker(store, bus), engine: { isRunning: () => false }, workspace: old } as any) as any;
  // (The column the agents' migration adds: an agent's session names its parent.)
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  const parent = store.createSession({ workspace: old, model: "m", title: "parent" });
  const kid = (title: string, workspace: string, under = parent.id) => {
    const c = store.createSession({ workspace, model: "m", title });
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(under, c.id);
    return c;
  };
  const a = kid("first", old);
  const b = kid("second", old);
  const w = kid("tree", wt);
  new Worktrees(store, join(root, "worktrees")).adopt(w.id, { repo_root: old, path: wt, branch: "keel/x", base: "main", base_commit: "0", state: "active", snapshot_ref: null, created: 1, updated: 1 } as any);
  const deep = kid("deep", old, a.id);

  const req = Object.assign(new Request("http://x", { method: "POST", body: JSON.stringify({ cwd: next }), headers: { "content-type": "application/json" } }), { params: { id: parent.id } });
  const res = await routes["/api/sessions/:id/folder"].POST(req);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(store.session(parent.id)!.workspace).toBe(next);
  for (const c of [a, b, deep]) expect(store.session(c.id)!.workspace).toBe(next);
  expect(store.session(w.id)!.workspace).toBe(wt);
  expect(body.agents.moved.map((x: any) => x.id).sort()).toEqual([a.id, b.id, deep.id].sort());
  expect(body.agents.stayed.map((x: any) => x.id)).toEqual([w.id]);
  const noteOf = (id: string) => store.events(id).find((e: any) => e.kind === "note")?.data as any;
  expect(noteOf(parent.id).text).toContain("first");
  expect(noteOf(parent.id).text).toContain("tree");
  expect(noteOf(a.id).model).toBe(true);
  expect(noteOf(a.id).text).toContain(next);
  expect(noteOf(w.id)).toBeUndefined();
  store.db.close();
});
