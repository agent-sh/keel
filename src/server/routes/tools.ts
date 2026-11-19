// Owner-facing routes of the tools: answer a question a tool is waiting on,
// see and stop background jobs (skills are in routes/surfaces.ts). Also joins the turn loop: a
// background job that ended reaches the model as a stored note on its next
// request, so the bytes stay the same on every later request.
import { join } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { answer, pendingQuestions, type Answers } from "../../tools/interact.ts";
import { ackNotices, adoptJobs, drainNotices, findJob, jobsOf, jobView, running, stopJob } from "../../tools/jobs.ts";
import { renderForOwner } from "../../tools/skills.ts";
import type { RouteModule } from "../app.ts";
import { pumpLines } from "../../core/proc.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const toolRoutes: RouteModule = (deps) => {
  // Background commands a previous daemon started run on; take them back.
  try { adoptJobs(join(deps.store.stateDir, "spill")); } catch (e) { deps.errors.capture("tool", e, { at: "adopt jobs" }); }
  registerHooks({
    beforeRequest(s, req) {
      // A job's end already stored (a restart came between storing it and
      // marking it reported) is not said twice.
      const said = (job: string) => !!deps.store.db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'note' AND data LIKE ? LIMIT 1").get(s.id, `%"jobs":[%"${job}"%`);
      const drained = drainNotices(s.id);
      const n = drained.filter((x) => !x.job || !said(x.job));
      if (!n.length) { ackNotices(drained); return req; }
      const text = `<system-reminder>\n${n.map((x) => x.text).join("\n")}\n</system-reminder>`;
      const jobs = n.flatMap((x) => (x.job ? [x.job] : []));
      deps.bus.emit({ t: "event", event: deps.store.append(s.id, "note", { text, model: true, ...(jobs.length ? { jobs } : {}) }) });
      ackNotices(drained);
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
    // The owner runs a skill (/name args): its body reaches the model as a
    // stored note just before the message, the transcript shows the command.
    "/api/sessions/:id/skill": {
      POST: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const b = (await req.json().catch(() => ({}))) as { name?: string; args?: string };
        const r = renderForOwner(String(b.name ?? ""), String(b.args ?? ""), s.workspace, s.id);
        if ("error" in r) return json({ error: r.error }, 400);
        const note = deps.store.append(s.id, "note", { text: `<skill name="${r.skill.name}">\n${r.text}\n</skill>`, model: true, skill: r.skill.name });
        deps.bus.emit({ t: "event", event: note });
        const ev = deps.engine.send(s.id, `/${r.skill.name}${b.args?.trim() ? ` ${b.args.trim()}` : ""}`);
        return json({ event: ev }, 201);
      },
    },
    "/api/sessions/:id/grep": {
      GET: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const q = new URL(req.url).searchParams.get("q") ?? "";
        if (!q || q.length > 500) return json({ error: "q must be 1-500 characters" }, 400);
        const proc = Bun.spawn(["rg", "--json", "-F", "-i", "--max-filesize", "2M", "--max-columns", "300", "--", q, "."], { cwd: s.workspace, stdout: "pipe", stderr: "ignore", signal: req.signal });
        const matches: { path: string; line: number; text: string }[] = [];
        let truncated = false;
        await pumpLines(proc.stdout, (line) => {
          if (truncated || !line.includes('"type":"match"')) return;
          const m = JSON.parse(line).data;
          matches.push({ path: String(m.path.text).replace(/^\.\//, ""), line: m.line_number, text: String(m.lines.text ?? "").trimEnd().slice(0, 300) });
          if (matches.length >= 200) { truncated = true; proc.kill(); }
        }, "content search");
        return json({ matches, truncated });
      },
    },
  };
};
