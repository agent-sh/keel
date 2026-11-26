// Owner-facing routes of the tools: answer a question a tool is waiting on,
// see and stop background jobs (skills are in routes/surfaces.ts). Also joins the turn loop: a
// background job that ended reaches the model as a stored note on its next
// request, so the bytes stay the same on every later request.
import { join } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { answer, askedOf, decline, pendingQuestions, type Answers } from "../../tools/interact.ts";
import { conceal } from "../../core/conceal.ts";
import { ackNotices, adoptJobs, cutCommand, drainNotices, endedHow, jobEnded, findJob, hasNotice, jobsChanged, jobsOf, jobView, jobWhat, running, stopJob, type Job } from "../../tools/jobs.ts";
import { commandEndedQuietly } from "../../automation/alerts.ts";
import { renderForOwnerIn, skillRun } from "../../tools/skills.ts";
import { dropChoice } from "../../tools/skill-turn.ts";
import { hookContext } from "../../integrations/hooks.ts";
import { promptExpansion } from "./hooks.ts";
import type { RouteModule } from "../app.ts";
import { pumpLines } from "../../core/proc.ts";
import { newestTurn } from "../../admin/marks.ts";
import { heirOf } from "../../automation/agents.ts";
import { deliver, withdraw } from "../../automation/core.ts";
import { onJob as waitsOnJob } from "../../automation/waits.ts";
import { cutCommandLine, sayAt } from "../../admin/daemon-log.ts";
import { acpJobs } from "../../acp/jobs-hook.ts";
import { concealDeep } from "../../core/conceal.ts";
import type { BackgroundView } from "../../acp/v2.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

// What an ACP agent runs apart from its foreground work, in the shape of a session's command: nothing of it is a
// process of Keel's, so it has no log, and Stop asks the agent to end that one item (`external` says whose it is).
const agentJob = (v: BackgroundView, session: string) => concealDeep({
  id: v.id, num: 0, command: v.title, description: undefined, cwd: "", pty: false, log: "", started: v.since, background: true, bytes: 0,
  running: true, last: v.last, external: `agent ${v.kind}`, can_stop: v.can_stop,
}, session);

export const toolRoutes: RouteModule = (deps) => {
  // A page shows a session's background commands above its box: it is told when the list changed.
  jobsChanged.tell = (sessionId) => deps.bus.emit({ t: "feature", name: "jobs", session_id: sessionId, data: {} });
  acpJobs.changed = jobsChanged.tell;
  // A command a cut call was waiting on has ended: that is what its session's turn waited for, so
  // it starts one (an agent's too: it is not done while such a command runs, src/automation/agents.ts).
  // After the step that found the end: at a start the commands are taken back before the turns
  // the last daemon left are closed, and an input must not start a turn ahead of that. A session
  // whose cut turn is about to be continued gets it after that turn.
  // It starts no turn where nobody waits for one: a command someone stopped (the owner, an archive,
  // a delete: that is no result the turn waited for) and a session the owner stopped are told with
  // the session's next request, whatever starts it, as a background command's end is.
  jobEnded.tell = (job, text, { sent, note, riding }) => {
    setTimeout(async () => {
      try {
        // A stop or a live job from a reload can finish between recovery slices.
        if (deps.boot?.jobs) await deps.boot.jobs;
        // Its session is gone or archived: nobody to tell, and nothing left to owe.
        const s = deps.store.session(job.sessionId);
        if (!s || s.archived) return riding ? note() : sent();
        // A context an agent lost (a successor took its task up) is never started again: it ran on beside its
        // successor, at the price of its whole context a step. The successor holds the task and its worktree, and
        // hears of the command with its next input.
        const heir = heirOf(job.sessionId);
        if (heir) {
          deliver(heir, `[harness] A command an earlier context of your task started has ended: ${text.replace(/^\[harness\] /, "")}`, { kind: "harness", job: job.id }, { ride: true });
          return riding ? note() : sent();
        }
        // An agent that has ended (it reported, or it was a goal's check or a review that answered at its
        // turn's end) is not started again for a command it left running: nobody reads that turn.
        const agent = deps.store.db.query<{ status: string }, [string]>("SELECT status FROM agents WHERE session_id = ?").get(job.sessionId);
        if (agent && agent.status !== "running" && agent.status !== "waiting") return riding ? note() : sent();
        if (riding) return commandEnded(job, text, riding, agent?.status === "waiting", { sent, note });
        // (An agent parked on the command is the one that still gets its turn after a stop: nothing else ends its wait.)
        // A released command its call's limit killed ends as that call would have: its turn goes on (not a stop).
        const limitKill = !!(job.released && job.killAt && job.stopReason?.startsWith("was killed at its "));
        if ((job.stopReason && !limitKill && agent?.status !== "waiting") || deps.engine.isHeld(job.sessionId)) return (note(), quiet(job));
        // Its branch ends in a turn a restart cut: the engine is about to continue that turn (or holds it for the owner).
        const end = deps.store.db.query<{ kind: string; reason: string | null }, [string]>("SELECT kind, data ->> '$.reason' AS reason FROM events WHERE id = (SELECT head FROM sessions WHERE id = ?)").get(job.sessionId);
        const cut = end?.kind === "turn_end" && end.reason === "restart";
        if (!deliver(job.sessionId, text, { kind: "harness", job: job.id }, { ...(cut ? { hold: true } : {}), onSent: () => sent() })) sent();
      } catch (e) { deps.errors.capture("tool", e, { at: "a command's end", session: job.sessionId }); }
    }, 0);
  };
  // A background command the model started has ended (not one a cut call waited on: above). Its note
  // is lined up for the session's next request already, so a turn at work reads it at its next step;
  // an idle session is started with it, once: the input is stored under the end's key, in the write
  // that stores the prompt. It starts no turn where nobody waits for it: a command someone stopped
  // (unless an agent is parked on it: nothing else ends that wait), a session the owner stopped, and
  // a session with a wait of its own on the command (that wait's wake says more: what the file
  // gained, and the note rides it). Ends that land a moment apart go as one input.
  const commandEnded = (job: Job, text: string, key: string, parked: boolean, { sent, note }: { sent: () => void; note: () => void }) => {
    // (Its note is gone already when a request of a turn at work took it, or the result of a cut call told it.)
    // (A wait of its own on the command wakes the session: that turn's end is the finish.)
    if (waitsOnJob(job.sessionId, job)) return note();
    if (!hasNotice(job.sessionId, key) || (job.stopReason && !parked) || deps.engine.isHeld(job.sessionId)) return (note(), quiet(job));
    // Told before a restart, and its record did not say so yet.
    if (deps.engine.hasInput(job.sessionId, key)) return sent();
    const meta = { kind: "harness", job: job.id };
    deliver(job.sessionId, text, meta, {
      coalesceMs: 300,
      // Read with a request of a turn at work meanwhile (src/tools/jobs.ts calls jobEnded.read): nothing left to tell.
      refresh: () => hasNotice(job.sessionId, key) ? {
        text, meta,
        onSent: () => {
          deps.store.db.query("INSERT OR IGNORE INTO input_keys (session_id, key, ts) VALUES (?, ?, ?)").run(job.sessionId, key, Date.now());
          sent();
        },
      } : undefined,
    });
  };
  // A command whose end starts no turn: a turn that ended while it ran said so, and its finish is raised now.
  const quiet = (job: Job) => commandEndedQuietly(job.sessionId, `The command ${jobWhat(job)} ${endedHow(job)}.`);
  // Its note went with a request of the session: the input lined up for it is not sent.
  jobEnded.read = (job) => void withdraw(job.sessionId, (m) => m.kind === "harness" && m.job === job.id);
  // Background commands a previous daemon started run on; take them back.
  const spill = join(deps.store.stateDir, "spill");
  const refused = (file: string, why: string) => void deps.errors.capture("tool", new Error(`A record of a background command was not taken over at this start: ${why}. Nothing was signalled for it. The record: ${file}`), { at: "adopt jobs" }, { group: "a job's record was not taken over" });
  const problem = (e: unknown) => void deps.errors.capture("tool", e, { at: "adopt jobs" });
  if (deps.boot) {
    deps.boot.jobs = adoptJobs(spill, refused, { afterListen: true }).then(() => {}, problem);
  } else {
    try { adoptJobs(spill, refused); } catch (e) { problem(e); }
  }
  // The commands whose end a note of the session already tells (what a restart between storing the note and marking
  // it reported must not tell twice). Notes stored before this table are not in it.
  deps.store.migrate("CREATE TABLE IF NOT EXISTS told_jobs (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, job TEXT NOT NULL, PRIMARY KEY (session_id, job)) WITHOUT ROWID");
  const toldCut = new Set<string>();
  registerHooks({
    // A call a restart cut while it ran a command: its result says what became
    // of the command (the engine stores the text as the call's result, an
    // error like every cut call's, under the name the hook has for such a text).
    // The command is the cut turn's own: one started since that turn began (a server that repeats call ids across turns).
    callOutcome: (sessionId, callId) => {
      const text = cutCommand(sessionId, callId, { since: newestTurn(deps.store, sessionId)?.ts });
      // Said once a call: the engine asks again when it writes the call's result.
      if (text && !toldCut.has(`${sessionId}\u0000${callId}`)) {
        toldCut.add(`${sessionId}\u0000${callId}`);
        if (toldCut.size > 500) toldCut.delete(toldCut.values().next().value!);
        sayAt({ session: sessionId }, cutCommandLine(text, deps.store.session(sessionId)?.title));
      }
      return text ? { denied: text } : undefined;
    },
    beforeRequest(s, req) {
      // Only a step of a turn carries the session's notices: a summary, a side
      // answer, a reader's read or a server's sampling request is not the
      // session's conversation, and what it would carry is left for the next step.
      if ((req.purpose ?? "turn") !== "turn") return req;
      // A job's end already stored (a restart came between storing it and
      // marking it reported) is not said twice.
      // (Asked of a table kept for it: a search of the session's events for the job's id reads them all, on the loop.)
      const said = (job: string) => !!deps.store.db.query("SELECT 1 FROM told_jobs WHERE session_id = ? AND job = ?").get(s.id, job);
      const drained = drainNotices(s.id);
      const stored = (list: typeof drained) => { for (const x of list) try { x.stored?.(); } catch (e) { deps.errors.capture("server", e, { at: "a note was stored", session: s.id }); } };
      const before = drained.filter((x) => x.job && said(x.job));
      // A note written when it is sent says what holds now; one that no longer holds is dropped.
      const n = drained.filter((x) => !before.includes(x)).flatMap((x) => { if (!x.fresh) return [x]; const now = x.fresh(); return now ? [{ ...x, text: now }] : []; });
      // (One said already is in the history too: what waits for it to be read is told so.)
      stored(before);
      if (!n.length) { ackNotices(drained); return req; }
      const text = `<system-reminder>\n${n.map((x) => x.text).join("\n")}\n</system-reminder>`;
      const jobs = n.flatMap((x) => (x.job ? [x.job] : []));
      deps.bus.emit({ t: "event", event: deps.store.append(s.id, "note", { text, model: true, ...(jobs.length ? { jobs } : {}) }) });
      for (const job of jobs) deps.store.db.query("INSERT OR IGNORE INTO told_jobs (session_id, job) VALUES (?, ?)").run(s.id, job);
      ackNotices(drained);
      stored(n);
      const messages = req.messages.slice();
      const last = messages[messages.length - 1];
      if (last?.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, { type: "text", text }] };
      else messages.push({ role: "user", content: [{ type: "text", text }] });
      return { ...req, messages };
    },
  });

  return {
    "/api/sessions/:id/questions": {
      // `calls`: the call that asks each one (its tool and input), for a view that answers an agent's question
      // without holding the agent's transcript.
      GET: (req: any) => {
        const pending = pendingQuestions(req.params.id);
        const calls = pending.flatMap((call_id) => {
          const e = deps.store.db.query<{ data: string }, [string, string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'assistant' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(req.params.id, JSON.stringify(call_id));
          try {
            const use = e && (JSON.parse(e.data).blocks ?? []).find((b: any) => b.type === "tool_use" && b.id === call_id);
            return use ? [{ call_id, name: String(use.name), input: use.input }] : [];
          } catch { return []; }
        });
        return json({ pending, calls });
      },
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
      GET: (req: any) => json({ jobs: [...jobsOf(req.params.id).map(jobView), ...acpJobs.list(req.params.id).map((v) => agentJob(v, req.params.id))] }),
    },
    "/api/sessions/:id/jobs/:job/stop": {
      POST: async (req: any) => {
        // An item of an ACP agent's background list: the agent is asked to end that one.
        if (/^(terminal|tool_call|subagent|work):/.test(req.params.job)) {
          const why = acpJobs.stop(req.params.id, req.params.job);
          return why ? json({ error: why }, 409) : json({ ok: true });
        }
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
        // (Its allowed-tools are granted once the hooks below let it through.)
        const r = await renderForOwnerIn(String(b.name ?? ""), String(b.args ?? ""), s, { count: false });
        if ("error" in r) return json({ error: r.error }, 400);
        // The owner's UserPromptExpansion hooks see the command and what it expands to: they refuse it, or add to it.
        const hooked = await promptExpansion?.(s, { name: r.skill.name, args: String(b.args ?? ""), source: r.skill.scope, prompt: r.text });
        if (hooked?.block) return json({ error: `A hook refused this command: ${hooked.block}` }, 400);
        const more = hooked?.context.length ? `\n${hookContext("UserPromptExpansion", hooked.context)}` : "";
        // context: fork: the skill runs as an agent of this session, its text the agent's task; its report comes back here.
        if (r.skill.fork && skillRun.fork) {
          const cmd = `/${r.skill.name}${b.args?.trim() ? ` ${b.args.trim()}` : ""}`;
          const note = deps.store.append(s.id, "note", { kind: "skill_fork", text: `${cmd} runs as an agent of its own (the skill's context: fork).`, skill: r.skill.name });
          deps.bus.emit({ t: "event", event: note });
          const out = await skillRun.fork({ sessionId: s.id, cwd: s.workspace, signal: AbortSignal.timeout(60_000), seen: new Map(), spillDir: "" } as any, { ...r.skill, fork: { ...r.skill.fork, background: true } }, `${r.text}${more}`);
          if (out.is_error) return json({ error: String(out.content) }, 400);
          return json({ event: note, agent: String(out.content) }, 201);
        }
        // Its allowed-tools hold for the turn the command reaches: the one it
        // starts, or the one running now that it is steered into. A command
        // that waits in a queue no turn takes yet grants nothing.
        const cmd = `/${r.skill.name}${b.args?.trim() ? ` ${b.args.trim()}` : ""}`;
        const running = deps.engine.isRunning(s.id);
        const granted = await renderForOwnerIn(r.skill.name, String(b.args ?? ""), s, { grant: running ? "now" : "next", cmd });
        if ("error" in granted) return json({ error: granted.error }, 400);
        const note = deps.store.append(s.id, "note", { text: `<skill name="${r.skill.name}">\n${granted.text}\n</skill>${more}`, model: true, skill: r.skill.name });
        deps.bus.emit({ t: "event", event: note });
        const ev = deps.engine.send(s.id, cmd);
        if (!running && !deps.engine.isRunning(s.id)) { skillRun.drop?.(s.id); dropChoice(s.id); }
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
