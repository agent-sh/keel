// A conversation another harness runs on an ssh machine, resumed in Keel:
// whether the original still works on something, the owner's choice (wait
// until it is idle, or resume now), and the wait while it runs. The list and
// the plain import are in imports.ts; the flow is src/fleet/resume.ts.
import type { MachineRow } from "../../fleet/db.ts";
import { LinkError } from "../../fleet/link.ts";
import { ResumeError, Resumes } from "../../fleet/resume.ts";
import { sharedImports } from "../../integrations/import/service.ts";
import type { Harness } from "../../integrations/import/types.ts";
import type { Deps, RouteModule } from "../app.ts";
import { fleet } from "./fleet.ts";
import { presence } from "./permissions.ts";

export let resumes: Resumes | undefined;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const HERE = ["claude", "codex"];

// The machine a request names, with its granted directory; or the answer.
export function grantedMachine(id: string): MachineRow | Response {
  if (!fleet) return bad("the fleet is not running", 409);
  if (id === "local") return bad("this machine's transcripts are in the import list");
  if (id.startsWith("ssh:")) return bad("enable that ssh host as a machine first");
  const m = fleet.row(id);
  if (!m) return bad("no such machine", 404);
  if (!m.workspace_root) return bad(`${m.name} has no granted directory: an imported session would have nowhere to run`);
  return m;
}

export const resumeRoutes: RouteModule = (deps: Deps) => {
  resumes = fleet ? new Resumes(deps, fleet, sharedImports(deps.store)) : undefined;
  const service = () => resumes!;
  // The machine, and the transcript named; only a machine reached over ssh has a helper that answers.
  const named = (req: any, q: { harness?: unknown; id?: unknown }): { m: MachineRow; harness: Harness; id: string } | Response => {
    const m = grantedMachine(req.params.id);
    if (m instanceof Response) return m;
    if (!fleet!.isSsh(m)) return bad(`${m.name} runs its own daemon: the state of its other harnesses is read only on machines reached over ssh`, 409);
    if (!HERE.includes(q.harness as string) || typeof q.id !== "string" || !q.id) return bad("give harness (claude or codex) and id");
    return { m, harness: q.harness as Harness, id: q.id };
  };
  const failed = (m: MachineRow, e: unknown) => {
    if (e instanceof ResumeError) return json({ error: e.message, ...e.more }, e.status);
    if (e instanceof LinkError) return bad(`${m.name} did not answer: ${e.message}`, 409);
    if ((e as any)?.status === 409) return bad((e as Error).message, 409);
    const rec = deps.errors.capture("server", e, { at: "resume from machine", machine: m.id });
    return json({ error: (e as Error).message, error_id: rec.id }, 500);
  };

  return {
    "/api/fleet/machines/:id/transcripts/activity": {
      GET: async (req: any) => {
        const u = new URL(req.url).searchParams;
        const t = named(req, { harness: u.get("harness"), id: u.get("id") });
        if (t instanceof Response) return t;
        try {
          return json({ ...(await service().activity(t.m, t.harness, t.id)), wait: service().waitOf(t.m.id, t.harness, t.id) });
        } catch (e) {
          return failed(t.m, e);
        }
      },
    },
    "/api/fleet/machines/:id/transcripts/resume": {
      POST: async (req: any) => {
        if (presence && !presence.allows(req, "takeover")) return json({ error: "this needs your passkey from a remote device", presence: { action: "takeover" } }, 428);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        const t = named(req, b);
        if (t instanceof Response) return t;
        if (b.when !== "now" && b.when !== "idle") return bad("when is now or idle");
        if (b.jobs !== undefined && b.jobs !== "keep" && b.jobs !== "end") return bad("jobs is keep or end");
        if (b.wait_ms !== undefined && !(typeof b.wait_ms === "number" && b.wait_ms > 0)) return bad("wait_ms must be a number above 0");
        try {
          const r = await service().resume(t.m, t.harness, t.id, { when: b.when, jobs: b.jobs ?? "keep", wait_ms: b.wait_ms, model: b.model, revision: b.revision });
          return json(r, r.action === "waiting" ? 202 : 200);
        } catch (e) {
          return failed(t.m, e);
        }
      },
      // The wait is given up; the original is left as it is.
      DELETE: async (req: any) => {
        const u = new URL(req.url).searchParams;
        const t = named(req, { harness: u.get("harness"), id: u.get("id") });
        if (t instanceof Response) return t;
        return json({ cancelled: service().cancel(t.m.id, t.harness, t.id) });
      },
    },
  };
};
