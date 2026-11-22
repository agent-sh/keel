// Every spec imports `test` from here instead of @playwright/test: the same
// test, plus an automatic fixture that snapshots the daemon-wide settings a
// spec may change (the default permission mode, admin settings, alert routes,
// snooze, worktree and outside-agent settings) and puts back whatever a test
// left changed, passed or failed. One failing spec never changes the next
// one's daemon. A restoration the daemon refuses fails the test.
//
// The sessions a test made go with it too, whatever it left of them (a turn
// still running, a failed one, one that waits on an approval). They are the
// daemon's state like the settings: the session list folds a folder's rows
// at rest behind "N more" once enough others stand before them, so a later
// spec's own row was not in the page; and a turn left running was counted by
// a spec that counts what runs. Specs run one at a time, so a session that
// was not there when a test began is that test's: on a scratch daemon. On
// any other (a KEEL_URL that names a daemon somebody works on) a session
// made meanwhile may be theirs, so nothing is removed there (scratch.ts).
// A removal the daemon refuses fails the test, as a refused restoration does.
import { test as base, type APIRequestContext } from "@playwright/test";
import { isScratch } from "./scratch.ts";

export * from "@playwright/test";

type Setting = { path: string; write: "PUT" | "PATCH"; pick: (b: any) => Record<string, unknown> };
const SETTINGS: Setting[] = [
  {
    path: "/api/permissions/settings",
    write: "PUT",
    pick: (b) => ({ default_mode: b.default_mode, default_sandbox: b.default_sandbox, reviewer_model: b.reviewer_model, reviewer_policy: b.reviewer_policy }),
  },
  { path: "/api/settings", write: "PATCH", pick: (b) => b.settings },
  { path: "/api/alerts/settings", write: "PUT", pick: (b) => b.settings },
  { path: "/api/worktrees/settings", write: "PUT", pick: (b) => b },
  { path: "/api/fleet/outside/settings", write: "PUT", pick: (b) => b },
];

type Api = Pick<APIRequestContext, "get" | "fetch" | "put" | "delete">;
type Snapshot = Record<string, Record<string, unknown> | null>;

export async function read(request: Api): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const s of SETTINGS) {
    const r = await request.get(s.path, { timeout: 5000 }).catch(() => null);
    out[s.path] = r?.ok() ? s.pick(await r.json()) : null;
  }
  const sn = await request.get("/api/snooze", { timeout: 5000 }).catch(() => null);
  out["/api/snooze"] = sn?.ok() ? { snooze: (await sn.json()).snooze } : null;
  return out;
}

// Puts back what differs from `before`. A write the daemon refuses or that
// does not get through fails the test that left the change, naming the
// endpoint and the answer: the next spec would run on changed settings.
export async function restore(request: Api, before: Snapshot): Promise<void> {
  const after = await read(request);
  const failed: string[] = [];
  const write = async (method: string, path: string, data?: unknown) => {
    try {
      const r = await request.fetch(path, { method, ...(data === undefined ? {} : { data }) });
      if (!r.ok()) failed.push(`${method} ${path} answered ${r.status()}`);
    } catch (e) {
      failed.push(`${method} ${path} did not get through: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  for (const s of SETTINGS) {
    const b = before[s.path], a = after[s.path];
    if (!b || !a) continue;
    // Only the keys the test changed are written back.
    const changed = Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(a[k])));
    if (Object.keys(changed).length) await write(s.write, s.path, changed);
  }
  const sb = before["/api/snooze"], sa = after["/api/snooze"];
  if (sb && sa && JSON.stringify(sb) !== JSON.stringify(sa)) {
    if (!sb.snooze) await write("DELETE", "/api/snooze");
    else await write("PUT", "/api/snooze", { until_ms: (sb.snooze as any).until_ms });
  }
  if (failed.length) throw new Error(`The daemon's settings were not put back after this test: ${failed.join("; ")}`);
}

async function sessionIds(request: APIRequestContext) {
  const ids = new Set<string>();
  for (const q of ["", "?archived=1"]) {
    const r = await request.get(`/api/sessions${q}`, { timeout: 10_000 }).catch(() => null);
    if (r?.ok()) for (const s of ((await r.json()).sessions ?? []) as { id: string }[]) ids.add(s.id);
  }
  return ids;
}

// Asked once a worker: what the daemon says of itself.
let scratch: Promise<boolean> | undefined;
let warned = false;
const scratchDaemon = (request: APIRequestContext) => (scratch ??= (async () => {
  const get = async (path: string) => { const r = await request.get(path, { timeout: 10_000 }).catch(() => null); return r?.ok() ? await r.json() : {}; };
  const [daemon, boot, models] = await Promise.all([get("/api/daemon"), get("/api/bootstrap"), get("/api/models")]);
  return isScratch({ argv: daemon.argv, state_dir: daemon.state_dir, home: boot.home, providers: ((models.providers ?? []) as { id: string }[]).map((p) => p.id) });
})());

export const test = base.extend<{ daemonSettings: void; ownSessions: void }>({
  ownSessions: [
    async ({ request }, use) => {
      if (!(await scratchDaemon(request))) {
        if (!warned) console.warn("The daemon at KEEL_URL is not a scratch one (no scripted provider, not a dev daemon with a state folder of its own): the sessions the tests make are left there.");
        warned = true;
        return use();
      }
      const before = await sessionIds(request);
      await use();
      const failed: string[] = [];
      for (const id of await sessionIds(request)) {
        if (before.has(id)) continue;
        // (A session's agents go with it; one that went meanwhile answers 404.)
        try {
          const r = await request.delete(`/api/sessions/${id}?stop_shells=1`, { timeout: 30_000 });
          if (!r.ok() && r.status() !== 404) failed.push(`DELETE /api/sessions/${id} answered ${r.status()}: ${(await r.text()).slice(0, 200)}`);
        } catch (e) {
          failed.push(`DELETE /api/sessions/${id} did not get through: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      if (failed.length) throw new Error(`The sessions this test made were not removed: ${failed.join("; ")}`);
    },
    { auto: true },
  ],
  daemonSettings: [
    async ({ request }, use) => {
      const before = await read(request);
      await use();
      await restore(request, before);
    },
    { auto: true },
  ],
});
