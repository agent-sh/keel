// Owner-facing routes of the tools: answer a question a tool is waiting on,
// see and stop background jobs, list skills. Also joins the turn loop: a
// background job that ended reaches the model as a stored note on its next
// request, so the bytes stay the same on every later request.
import { registerHooks } from "../../engine/hooks.ts";
import { answer, pendingQuestions, type Answers } from "../../tools/interact.ts";
import { drainNotices, findJob, jobsOf, jobView, running, stopJob } from "../../tools/jobs.ts";
import { discoverSkills } from "../../tools/skills.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const toolRoutes: RouteModule = (deps) => {
  registerHooks({
    beforeRequest(s, req) {
      const n = drainNotices(s.id);
      if (!n.length) return req;
      const text = `<system-reminder>\n${n.join("\n")}\n</system-reminder>`;
      deps.bus.emit({ t: "event", event: deps.store.append(s.id, "note", { text, model: true }) });
      const messages = req.messages.slice();
      const last = messages[messages.length - 1];
      if (last?.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, { type: "text", text }] };
      else messages.push({ role: "user", content: [{ type: "text", text }] });
      return { ...req, messages };
    },
  });

  return {
    "/api/sessions/:id/questions": {
      GET: (req: any) => json({ pending: pendingQuestions(req.params.id) }),
    },
    "/api/sessions/:id/questions/:call": {
      POST: async (req: any) => {
        const body = (await req.json().catch(() => ({}))) as { answers?: Answers };
        if (!body.answers || typeof body.answers !== "object") return json({ error: "answers must be an object" }, 400);
        return answer(req.params.id, req.params.call, body.answers)
          ? json({ ok: true })
          : json({ error: "no question is waiting for that call" }, 404);
      },
    },
    "/api/sessions/:id/jobs": {
      GET: (req: any) => json({ jobs: jobsOf(req.params.id).map(jobView) }),
    },
    "/api/sessions/:id/jobs/:job/stop": {
      POST: async (req: any) => {
        const j = findJob(req.params.id, req.params.job);
        if (!j) return json({ error: "no such job" }, 404);
        if (running(j)) await stopJob(j, "was stopped by the owner");
        return json({ job: jobView(j) });
      },
    },
    "/api/sessions/:id/jobs/:job/log": {
      GET: async (req: any) => {
        const j = findJob(req.params.id, req.params.job);
        if (!j) return json({ error: "no such job" }, 404);
        const f = Bun.file(j.log);
        const size = f.size;
        const tail = await f.slice(Math.max(0, size - 64 * 1024)).text();
        return json({ job: jobView(j), tail, truncated: size > 64 * 1024 });
      },
    },
    "/api/skills": {
      GET: (req: any) => {
        const cwd = new URL(req.url).searchParams.get("cwd") || deps.workspace;
        return json({
          skills: discoverSkills(cwd).map((s) => ({
            name: s.name, description: s.description, root: s.dir, scope: s.scope,
            user_invocable: s.userInvocable, model_invocable: s.modelInvocable, argument_hint: s.argumentHint,
          })),
        });
      },
    },
  };
};
