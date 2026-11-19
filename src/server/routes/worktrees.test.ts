// A worktree's folder is not parked away under a background command that
// still runs in it: the route names the command, and stops it only when asked.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { running, startJob, stopJob } from "../../tools/jobs.ts";
import { worktreeRoutes } from "./worktrees.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `wt-route-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => expect(Bun.spawnSync(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);

test("park refuses while a background command runs in the worktree, and stops it when told to", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
  const store = new Store(join(root, "state"));
  store.db.run("CREATE TABLE IF NOT EXISTS perm_settings (key TEXT PRIMARY KEY, value TEXT)"); // the gate's, where the retention setting lives
  const bus = new Bus();
  const providers = { defaultModel: async () => "m", resolve: async () => ({}) };
  const routes = worktreeRoutes({ store, bus, errors: new ErrorTracker(store, bus), providers, workspace: repo, engine: { isRunning: () => false, send() {} } } as any) as any;
  const call = (path: string, method: string, body: unknown, params: Record<string, string> = {}) =>
    routes[path][method](Object.assign(new Request(`http://x${path}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params }));
  const made = await (await call("/api/worktrees", "POST", { workspace: repo, title: "w" })).json();
  const s = made.session;
  const job = startJob({ sessionId: s.id, command: "sleep 30", cwd: s.workspace, logDir: join(root, "jobs"), background: true });
  try {
    const refused = await call("/api/sessions/:id/worktree/park", "POST", {}, { id: s.id });
    expect(refused.status).toBe(409);
    expect((await refused.json()).jobs.map((j: any) => j.command)).toEqual(["sleep 30"]);
    expect(existsSync(s.workspace)).toBe(true);
    const parked = await call("/api/sessions/:id/worktree/park", "POST", { stop_shells: true }, { id: s.id });
    expect(parked.status).toBe(200);
    expect(running(job)).toBe(false);
    expect(existsSync(s.workspace)).toBe(false);
  } finally {
    await stopJob(job);
  }
});
