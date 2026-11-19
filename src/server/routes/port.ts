// Bring the owner's setup over from the other harnesses: GET is the plan
// (nothing is written), POST runs the picked items (one run at a time).
import type { RouteModule } from "../app.ts";
import { AREAS, apply, plan, type Area } from "../../integrations/port.ts";
import { sharedImports } from "../../integrations/import/service.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const portRoutes: RouteModule = (deps) => {
  const { store, providers, bus, errors } = deps;
  const imports = sharedImports(store);
  const mcp = () => (globalThis as any).__keelMcp;
  const portDeps = () => ({ store, imports, providers, workspace: deps.workspace, mcp: mcp(), emit: (s: any) => s && bus.emit({ t: "session", session: s }) });
  let running: Promise<unknown> | null = null;
  const limits = (u: URLSearchParams | Record<string, unknown>) => {
    const get = (k: string) => (u instanceof URLSearchParams ? u.get(k) : u[k]);
    const n = (k: string) => { const v = get(k); return v === null || v === undefined || v === "" ? undefined : Number(v); };
    const days = n("days"), max = n("max");
    if ((days !== undefined && !(days > 0)) || (max !== undefined && !(max >= 0))) return null;
    return { days, max };
  };
  return {
    "/api/port": {
      GET: async (req: Request) => {
        const l = limits(new URL(req.url).searchParams);
        if (!l) return json({ error: "days is a number above 0 and max one of 0 or more" }, 400);
        return json(await plan(portDeps(), l));
      },
      POST: async (req: Request) => {
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (b.ids !== undefined && (!Array.isArray(b.ids) || b.ids.some((x: unknown) => typeof x !== "string"))) return json({ error: "ids is a list of item ids" }, 400);
        if (b.areas !== undefined && (!Array.isArray(b.areas) || b.areas.some((a: unknown) => !AREAS.includes(a as Area)))) return json({ error: `areas are ${AREAS.join(", ")}` }, 400);
        const l = limits(b);
        if (!l) return json({ error: "days is a number above 0 and max one of 0 or more" }, 400);
        if (running) return json({ error: "a port is running; wait for it" }, 409);
        const run = apply(portDeps(), { ids: b.ids, areas: b.areas, ...l });
        running = run;
        try {
          const r = await run;
          for (const it of r.items) if (!it.ok && it.error) errors.capture("server", new Error(`port ${it.id}: ${it.error}`), { at: "port" });
          return json(r);
        } finally {
          running = null;
        }
      },
    },
  };
};
