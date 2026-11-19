// Every spec imports `test` from here instead of @playwright/test: the same
// test, plus an automatic fixture that snapshots the daemon-wide settings a
// spec may change (the default permission mode, admin settings, alert routes,
// snooze, worktree and outside-agent settings) and puts back whatever a test
// left changed, passed or failed. One failing spec never changes the next
// one's daemon.
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

async function read(request: APIRequestContext) {
  const out: Record<string, Record<string, unknown> | null> = {};
  for (const s of SETTINGS) {
    const r = await request.get(s.path, { timeout: 5000 }).catch(() => null);
    out[s.path] = r?.ok() ? s.pick(await r.json()) : null;
  }
  const sn = await request.get("/api/snooze", { timeout: 5000 }).catch(() => null);
  out["/api/snooze"] = sn?.ok() ? { snooze: (await sn.json()).snooze } : null;
  return out;
}

export const test = base.extend<{ daemonSettings: void }>({
  daemonSettings: [
    async ({ request }, use) => {
      const before = await read(request);
      await use();
      const after = await read(request);
      for (const s of SETTINGS) {
        const b = before[s.path], a = after[s.path];
        if (!b || !a) continue;
        // Only the keys the test changed are written back.
        const changed = Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(a[k])));
        if (Object.keys(changed).length) await request.fetch(s.path, { method: s.write, data: changed }).catch((e) => console.warn(`could not restore ${s.path}: ${e}`));
      }
      const sb = before["/api/snooze"], sa = after["/api/snooze"];
      if (sb && sa && JSON.stringify(sb) !== JSON.stringify(sa)) {
        if (!sb.snooze) await request.delete("/api/snooze").catch((e) => console.warn(`could not end the snooze: ${e}`));
        else await request.put("/api/snooze", { data: { until_ms: (sb.snooze as any).until_ms } }).catch((e) => console.warn(`could not restore the snooze: ${e}`));
      }
    },
    { auto: true },
  ],
});
