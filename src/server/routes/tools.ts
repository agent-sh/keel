// Owner-facing routes of the tools: answer a question a tool is waiting on,
// see and stop background jobs (skills are in routes/surfaces.ts). Also joins the turn loop: a
// background job that ended reaches the model as a stored note on its next
// request, so the bytes stay the same on every later request.
import { join } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { answer, askedOf, decline, pendingQuestions, type Answers } from "../../tools/interact.ts";
import { conceal } from "../../core/conceal.ts";
import { ackNotices, adoptJobs, drainNotices, findJob, jobsChanged, jobsOf, jobView, running, stopJob } from "../../tools/jobs.ts";
import { renderForOwner } from "../../tools/skills.ts";
import { hookContext } from "../../integrations/hooks.ts";
import { promptExpansion } from "./hooks.ts";
import type { RouteModule } from "../app.ts";
import { pumpLines } from "../../core/proc.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const toolRoutes: RouteModule = (deps) => {
  // A page shows a session's background commands above its box: it is told when the list changed.
  jobsChanged.tell = (sessionId) => deps.bus.emit({ t: "feature", name: "jobs", session_id: sessionId, data: {} });
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
        const body = (await req.json().catch(() => ({}))) as { answers?: Answers; decline?: boolean; send_anyway?: boolean; question?: string };
        // (`question`: the id of the server's question this is for. One for another question is not taken.)
        const question = typeof body.question === "string" ? body.question : undefined;
        const stale = () => json({ error: "the question on that call is not the one this answers: read the one that is asked now", asked: askedOf(req.params.id, req.params.call)?.id }, 409);
        // A question a server asked can be declined; the model's own takes an answer.
        if (body.decline === true) {
          const d = decline(req.params.id, req.params.call, question);
          return d === "stale" ? stale() : d ? json({ ok: true }) : json({ error: "no question that can be declined is waiting for that call" }, 404);
        }
        if (!body.answers || typeof body.answers !== "object") return json({ error: "answers must be an object" }, 400);
        const sent = answer(req.params.id, req.params.call, body.answers, body.send_anyway === true, question);
        if (sent === "stale") return stale();
        if (sent === "unsent") return json({ error: "this form asks for what looks like a secret: decline it, or send the answer with send_anyway" }, 409);
        return sent ? json({ ok: true }) : json({ error: "no question is waiting for that call" }, 404);
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
        return json({ job: jobView(j), tail: conceal(tail, j.sessionId), truncated: size > 64 * 1024 });
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
        // The owner's UserPromptExpansion hooks see the command and what it expands to: they refuse it, or add to it.
        const hooked = await promptExpansion?.(s, { name: r.skill.name, args: String(b.args ?? ""), source: r.skill.scope, prompt: r.text });
        if (hooked?.block) return json({ error: `A hook refused this command: ${hooked.block}` }, 400);
        const more = hooked?.context.length ? `\n${hookContext("UserPromptExpansion", hooked.context)}` : "";
        const note = deps.store.append(s.id, "note", { text: `<skill name="${r.skill.name}">\n${r.text}\n</skill>${more}`, model: true, skill: r.skill.name });
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
