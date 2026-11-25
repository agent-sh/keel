// A fork may take a worktree of its own, as a clone does: two forks of one task never write the same folder.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { turnRoutes } from "./turns.ts";

setDefaultTimeout(30_000);
const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `fork-wt-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("forks into worktrees write in folders of their own; a fork without the option keeps the folder", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "base\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  const store = new Store(join(root, "state"));
  const bus = new Bus();
  const routes = turnRoutes({ store, bus, errors: new ErrorTracker(store, bus), engine: { queued: () => [] } } as any) as any;
  const s = store.createSession({ workspace: repo, model: "m", title: "task" });
  const ev = store.append(s.id, "user", { text: "go" });
  const fork = async (body: object) => {
    const req = Object.assign(new Request(`http://x/api/sessions/${s.id}/fork`, { method: "POST", body: JSON.stringify({ event_id: ev.id, ...body }), headers: { "content-type": "application/json" } }), { params: { id: s.id } });
    const res = await routes["/api/sessions/:id/fork"].POST(req);
    expect(res.status).toBe(201);
    return (await res.json()).session as { id: string; workspace: string };
  };
  const plain = await fork({});
  expect(plain.workspace).toBe(repo);
  const one = await fork({ worktree: {} });
  const two = await fork({ worktree: { name: "second" } });
  for (const f of [one, two]) {
    expect(f.workspace).not.toBe(repo);
    expect(store.session(f.id)!.workspace).toBe(f.workspace);
    expect(existsSync(join(f.workspace, "a.txt"))).toBe(true);
  }
  expect(one.workspace).not.toBe(two.workspace);
  writeFileSync(join(one.workspace, "a.txt"), "one\n");
  writeFileSync(join(two.workspace, "b.txt"), "two\n");
  expect(existsSync(join(one.workspace, "b.txt"))).toBe(false);
  expect(existsSync(join(two.workspace, "a.txt")) && g(two.workspace, "diff", "--stat")).toBe("");
  expect(g(repo, "status", "--short")).toBe("");
  expect(g(repo, "branch", "--list", "keel/*").split("\n")).toHaveLength(2);
  store.db.close();
});
