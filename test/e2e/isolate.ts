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
import { stopStrays } from "./own-daemon.ts";
import { isScratch } from "./scratch.ts";
import { FIXED_ENV, seeded } from "../../src/core/fixed-world.ts";

// A run of before and after pictures (src/pictures/run.ts) names its own instant: the daemon's ids and clock
// are fixed from it (src/core/fixed-world.ts), the spec's random numbers are seeded by it, and each page's
// clock starts at the daemon's own now and runs from there (the `page` fixture below), so two runs of one
// commit draw the same times.
const FIXED = Number(process.env[FIXED_ENV] ?? "") || 0;
if (FIXED) Math.random = seeded(FIXED >>> 5);

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
  for (const q of ["?agents=all", "?archived=1"]) {
    const r = await request.get(`/api/sessions${q}`, { timeout: 10_000 }).catch(() => null);
    if (r?.ok()) for (const s of ((await r.json()).sessions ?? []) as { id: string }[]) ids.add(s.id);
  }
  return ids;
}

// What else of the daemon outlives a test: the lists a spec adds to and a later
// spec reads (an MCP server, a project, a session folder, a paired machine, a
// placement rule, a loop). A machine a test paired is unpaired, and alerts it
// left unread are read: later specs see both. The rest is not removed, but a
// test that leaves one more than it found is named with what it left, in the
// run's summary: a spec that fails only after another one is found there.
const LISTS: { path: string; what: string; of: (b: any) => unknown[] }[] = [
  { path: "/api/mcp/servers", what: "MCP servers", of: (b) => b.servers ?? [] },
  { path: "/api/projects", what: "projects", of: (b) => b.projects ?? [] },
  { path: "/api/session-folders", what: "session folders", of: (b) => b.folders ?? [] },
  { path: "/api/fleet/machines", what: "machines", of: (b) => b.machines ?? [] },
  { path: "/api/fleet/placement", what: "placement rules", of: (b) => b.rules ?? [] },
  { path: "/api/loops", what: "loops", of: (b) => b.loops ?? [] },
];
const nameOf = (x: any) => String(typeof x === "string" ? x : x?.name ?? x?.title ?? x?.id ?? JSON.stringify(x)).slice(0, 60);
async function lists(request: APIRequestContext): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  await Promise.all(LISTS.map(async (l) => {
    const r = await request.get(l.path, { timeout: 10_000 }).catch(() => null);
    if (r?.ok()) out[l.what] = l.of(await r.json().catch(() => ({}))).map(nameOf);
  }));
  return out;
}
// The machines paired with the daemon (not the daemon's own, not the ssh hosts it only knows of).
const machines = async (request: APIRequestContext): Promise<string[]> => {
  const r = await request.get("/api/fleet/machines", { timeout: 10_000 }).catch(() => null);
  const all = r?.ok() ? (((await r.json().catch(() => ({}))).machines ?? []) as { id: string; daemon_url?: string | null }[]) : [];
  return all.filter((m) => m.id !== "local" && !m.id.startsWith("ssh:") && m.daemon_url).map((m) => m.id);
};
const unreadAlerts = async (request: APIRequestContext) => {
  const r = await request.get("/api/alerts?limit=1", { timeout: 10_000 }).catch(() => null);
  return r?.ok() ? Number((await r.json().catch(() => ({}))).unread?.total ?? 0) : 0;
};

// Asked once a worker: what the daemon says of itself.
let scratch: Promise<boolean> | undefined;
let warned = false;
const scratchDaemon = (request: APIRequestContext) => (scratch ??= (async () => {
  const get = async (path: string) => { const r = await request.get(path, { timeout: 10_000 }).catch(() => null); return r?.ok() ? await r.json() : {}; };
  const [daemon, boot, models] = await Promise.all([get("/api/daemon"), get("/api/bootstrap"), get("/api/models")]);
  return isScratch({ argv: daemon.argv, state_dir: daemon.state_dir, home: boot.home, providers: ((models.providers ?? []) as { id: string }[]).map((p) => p.id) });
})());

export const test = base.extend<{ daemonSettings: void; ownSessions: void; leftBehind: void }, { strays: void }>({
  // The last thing a worker does: whatever the spec's own daemons started and left running (a command a killed
  // daemon could not end, a daemon a failed spec did not stop) ends with the worker. A spec stops what it
  // started itself; this is for the one that failed before it did.
  strays: [
    async ({}, use) => {
      await use();
      const n = stopStrays();
      if (n) console.warn(`${n} process${n === 1 ? "" : "es"} of the spec daemons ${n === 1 ? "was" : "were"} left running and ${n === 1 ? "was" : "were"} stopped at the end of the run.`);
    },
    { scope: "worker", auto: true },
  ],
  page: async ({ page, request }, use) => {
    if (FIXED) {
      const r = await request.get("/api/daemon", { timeout: 10_000 }).catch(() => null);
      const d = r?.ok() ? await r.json() as { started_ms?: number; uptime_ms?: number } : {};
      await page.clock.install({ time: d.started_ms != null && d.uptime_ms != null ? d.started_ms + d.uptime_ms : FIXED });
    }
    await use(page);
  },
  // Set up first and looked at last, after the sessions went and the settings were put back.
  leftBehind: [
    async ({ request }, use, info) => {
      if (!(await scratchDaemon(request))) return use();
      const [before, unread, paired] = await Promise.all([lists(request), unreadAlerts(request), machines(request)]);
      await use();
      // A machine the test paired goes with it: every spec that needs one pairs it when it is not there, and a
      // paired machine changes what the next spec sees (a machine chip in every session's header, the folder a
      // moved session lands under). One that cannot be removed is named with the rest.
      for (const id of await machines(request)) if (!paired.includes(id)) await request.delete(`/api/fleet/machines/${id}`, { timeout: 15_000 }).catch(() => null);
      const after = await lists(request);
      const left = Object.entries(after).flatMap(([what, names]) => {
        const had = [...(before[what] ?? [])];
        const more = names.filter((n) => { const i = had.indexOf(n); if (i < 0) return true; had.splice(i, 1); return false; });
        return more.length ? [`${what}: ${more.join(", ")}`] : [];
      });
      if (left.length) info.annotations.push({ type: "left behind", description: left.join("; ") });
      if ((await unreadAlerts(request)) > unread) await request.post("/api/alerts/read", { data: {}, timeout: 10_000 }).catch(() => null);
    },
    { auto: true },
  ],
  ownSessions: [
    async ({ request, leftBehind: _first }, use) => {
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
    async ({ request, leftBehind: _first }, use) => {
      const before = await read(request);
      await use();
      await restore(request, before);
    },
    { auto: true },
  ],
});
