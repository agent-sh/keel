// Every spec imports `test` from here instead of @playwright/test: the same
// test, plus an automatic fixture that snapshots the daemon-wide settings a
// spec may change (the default permission mode, admin settings, alert routes,
// snooze, worktree and outside-agent settings) and puts back whatever a test
// left changed, passed or failed. One failing spec never changes the next
// one's daemon. A restoration the daemon refuses fails the test.
import { test as base, type APIRequestContext } from "@playwright/test";

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

export const test = base.extend<{ daemonSettings: void }>({
  daemonSettings: [
    async ({ request }, use) => {
      const before = await read(request);
      await use();
      await restore(request, before);
    },
    { auto: true },
  ],
});
