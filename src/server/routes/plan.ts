// Plan mode's way out: the model presents a plan (ExitPlanMode for the Claude
// family, present_plan for the others) and waits on a card; the owner approves
// it, edited or not, and picks the mode the work goes on in, or sends it back
// with what to change. The plan last approved is kept with the session.
import { registerShared } from "../../tools/registry.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import { isMode } from "../../safety/policy.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export type PlanCard = { id: string; session_id: string; plan: string; title?: string; created: number };
type Answer = { approved: true; mode: string; plan: string; note?: string } | { approved: false; feedback?: string };
const waiting = new Map<string, PlanCard & { resolve: (a: Answer) => void }>();
let emit: (c: PlanCard, state: "open" | "closed") => void = () => {};

async function present(input: any, ctx: ToolContext) {
  const plan = String(input?.plan ?? "").trim();
  if (!plan) return { content: "Give the plan as text.", is_error: true };
  const mode = gate?.perm(ctx.sessionId).mode;
  if (mode && mode !== "plan") return { content: `The session is not in plan mode (it is in ${mode}): go ahead with the work.` };
  const card: PlanCard = { id: ctx.callId ?? crypto.randomUUID(), session_id: ctx.sessionId, plan: plan.slice(0, 40_000), title: input?.title ? String(input.title).slice(0, 120) : undefined, created: Date.now() };
  const a = await new Promise<Answer>((resolve) => {
    const done = (x: Answer) => {
      if (!waiting.delete(card.id)) return;
      ctx.signal.removeEventListener("abort", onAbort);
      emit(card, "closed");
      resolve(x);
    };
    const onAbort = () => done({ approved: false, feedback: "the turn was stopped" });
    waiting.set(card.id, { ...card, resolve: done });
    emit(card, "open");
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  if (!a.approved) return { content: `The owner did not approve the plan${a.feedback ? `: ${a.feedback}` : "."} Stay in plan mode, change the plan, and present it again.` };
  const edited = a.plan !== card.plan;
  return {
    content: [
      `The owner approved the plan. The session is now in ${a.mode} mode: carry it out.`,
      edited ? `The owner edited it; this is the plan to follow:\n\n${a.plan}` : "",
      a.note ? `The owner's note: ${a.note}` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

const schema = {
  type: "object",
  properties: { plan: { type: "string", description: "The plan, in Markdown: what you will change and in what order" } },
  required: ["plan"],
};
const ExitPlanMode: Tool = {
  name: "ExitPlanMode",
  description: "In plan mode, present your plan to the owner for approval. Use it once the plan is ready; you cannot change anything until the owner approves.",
  input_schema: schema, readOnly: true, families: ["claude"], run: present,
};
const PresentPlan: Tool = {
  name: "present_plan",
  description: "In plan mode, present your plan to the owner for approval before you change anything. The owner approves it (maybe edited) or says what to change.",
  input_schema: { ...schema, properties: { ...schema.properties, title: { type: "string" } } }, readOnly: true, families: ["gpt", "gemini"], run: present,
};

export const planRoutes: RouteModule = (deps: Deps) => {
  const { store, bus } = deps;
  store.migrate("CREATE TABLE IF NOT EXISTS plans (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  emit = (c, state) => bus.emit({ t: "feature", name: "plan", session_id: c.session_id, data: { card: c, state } });
  registerShared(ExitPlanMode, PresentPlan);
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

  return {
    "/api/sessions/:id/plan": {
      GET: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const r = store.db.query<{ data: string }, [string]>("SELECT data FROM plans WHERE session_id = ?").get(req.params.id);
        const open = [...waiting.values()].filter((w) => w.session_id === req.params.id).map(({ resolve: _r, ...c }) => c);
        return json({ plan: r ? JSON.parse(r.data) : null, open });
      },
    },
    "/api/sessions/:id/plan/:pid": {
      POST: async (req: any) => {
        const w = waiting.get(req.params.pid);
        if (!w || w.session_id !== req.params.id) return bad("no plan is waiting with that id", 404);
        const b = await body(req);
        if (!b.approve) {
          w.resolve({ approved: false, feedback: typeof b.feedback === "string" && b.feedback.trim() ? b.feedback.trim().slice(0, 4000) : undefined });
          return json({ ok: true });
        }
        const mode = String(b.mode ?? "ask");
        if (!isMode(mode) || mode === "plan") return bad("pick the mode the work goes on in");
        // Leaving plan mode lets the session do more: from a remote device, the owner's passkey.
        if (presence && !presence.allows(req, `plan:${w.id}`)) return json({ error: "this needs your passkey from a remote device", presence: { action: `plan:${w.id}` } }, 428);
        const plan = typeof b.plan === "string" && b.plan.trim() ? b.plan.trim().slice(0, 40_000) : w.plan;
        gate?.setPerm(w.session_id, { mode });
        const rec = { session_id: w.session_id, plan, approval_id: w.id, mode, approved_ms: Date.now() };
        store.db.query("INSERT INTO plans (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data").run(w.session_id, JSON.stringify(rec));
        w.resolve({ approved: true, mode, plan, note: typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 2000) : undefined });
        return json({ ok: true, plan: rec });
      },
    },
  };
};
