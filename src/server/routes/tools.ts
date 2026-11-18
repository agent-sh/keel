// Owner-facing routes of the tools: answer a question a tool is waiting on,
// see and stop background jobs, list skills. Also joins the turn loop: a
// background job that ended reaches the model as a stored note on its next
// request, so the bytes stay the same on every later request.
import { registerHooks } from "../../engine/hooks.ts";
import { answer, pendingQuestions, type Answers } from "../../tools/interact.ts";
import { drainNotices, findJob, jobsOf, jobView, running, stopJob } from "../../tools/jobs.ts";
import { discoverSkills, renderForOwner } from "../../tools/skills.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

// Text chunks to lines.
const lines = () => {
  let rest = "";
  return new TransformStream<string, string>({
    transform(chunk, c) { const parts = (rest + chunk).split("\n"); rest = parts.pop()!; for (const p of parts) c.enqueue(p); },
    flush(c) { if (rest) c.enqueue(rest); },
  });
};

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
        for await (const line of proc.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(lines())) {
          if (!line.includes('"type":"match"')) continue;
          const m = JSON.parse(line).data;
          matches.push({ path: String(m.path.text).replace(/^\.\//, ""), line: m.line_number, text: String(m.lines.text ?? "").trimEnd().slice(0, 300) });
          if (matches.length >= 200) { truncated = true; proc.kill(); break; }
        }
        return json({ matches, truncated });
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
