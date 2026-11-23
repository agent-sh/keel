// Plan mode's way out: the model presents a plan (ExitPlanMode for the Claude
// family, present_plan for the others) and waits on a card; the owner approves
// it, edited or not, and picks the mode the work goes on in, or sends it back
// with what to change. The plan last approved is kept with the session.
import { declareAsksOwner, registerShared } from "../../tools/registry.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import { isMode } from "../../safety/policy.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export type PlanCard = { id: string; session_id: string; plan: string; title?: string; created: number };
type Answer = { approved: true; mode: string; plan: string; note?: string } | { approved: false; feedback?: string };
// By session and id: a plan is known by its tool call's id, and a wire whose ids count the calls
// gives two sessions the same one.
const waiting = new Map<string, PlanCard & { resolve: (a: Answer) => void }>();
const keyOf = (sessionId: string, id: string) => `${sessionId}\u0000${id}`;
// How a plan stopped waiting: approved (in a mode), sent back to planning, or the turn ended under it.
export type PlanEnd = { card: PlanCard; how: "approved" | "denied" | "expired"; mode?: string; at: number };
// The plans that ended in the last day, newest last: a client that was away (a phone) is told how
// the plans it was shown ended. Kept in memory, as the waiting plans are.
const ended: PlanEnd[] = [];
const ENDED_FOR = 24 * 3600_000;
let emit: (c: PlanCard, state: "open" | "closed", end?: PlanEnd) => void = () => {};
export const plansEnded = (sinceMs: number): PlanEnd[] => ended.filter((e) => e.at >= sinceMs);
// The plans that wait for the owner now: a session with one needs them (src/automation/state.ts).
export const plansWaiting = (): PlanCard[] => Array.from(waiting.values(), ({ resolve: _r, ...c }) => c);
export const planWaits = (sessionId: string, id: string) => waiting.has(keyOf(sessionId, id));
// Set when the routes load: the daemon is stopping, and a plan whose wait ends now is parked with its
// turn, to be put back on its card at the next start (it did not end).
let parking = () => false;
// Known as calls that wait on the owner before their route module registers them (see declareAsksOwner).
declareAsksOwner("ExitPlanMode", "present_plan");

async function present(input: any, ctx: ToolContext) {
  const plan = String(input?.plan ?? "").trim();
  if (!plan) return { content: "Give the plan as text.", is_error: true };
  const mode = gate?.perm(ctx.sessionId).mode;
  if (mode && mode !== "plan") return { content: `The session is not in plan mode (it is in ${mode}): go ahead with the work.` };
  const card: PlanCard = { id: ctx.callId ?? crypto.randomUUID(), session_id: ctx.sessionId, plan: plan.slice(0, 40_000), title: input?.title ? String(input.title).slice(0, 120) : undefined, created: Date.now() };
  const a = await new Promise<Answer>((resolve) => {
    const done = (x: Answer, stopped = false) => {
      if (!waiting.delete(keyOf(card.session_id, card.id))) return;
      ctx.signal.removeEventListener("abort", onAbort);
      // Parked with its turn by a daemon that stops: it did not end, and no client is told it did.
      if (stopped && parking()) { emit(card, "closed"); resolve(x); return; }
      const end: PlanEnd = { card, how: stopped ? "expired" : x.approved ? "approved" : "denied", ...(x.approved ? { mode: x.mode } : {}), at: Date.now() };
      while (ended.length && (ended[0]!.at < end.at - ENDED_FOR)) ended.shift();
      ended.push(end);
      emit(card, "closed", end);
      resolve(x);
    };
    const onAbort = () => done({ approved: false, feedback: "the turn was stopped" }, true);
    waiting.set(keyOf(card.session_id, card.id), { ...card, resolve: done });
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
  input_schema: schema, readOnly: true, asksOwner: true, families: ["claude"], run: present,
};
const PresentPlan: Tool = {
  name: "present_plan",
  description: "In plan mode, present your plan to the owner for approval before you change anything. The owner approves it (maybe edited) or says what to change.",
  input_schema: { ...schema, properties: { ...schema.properties, title: { type: "string" } } }, readOnly: true, asksOwner: true, families: ["gpt", "gemini", "other"], run: present,
};

// The owner's decision on a waiting plan, from whichever client was proven to be the owner (the
// page with its passkey, the phone with its approval key): approve, edited or not, in a mode the
// work goes on in, or send it back with what to change. Set when the routes load.
export type PlanDecision = { approve?: unknown; mode?: unknown; plan?: unknown; note?: unknown; feedback?: unknown };
// `proven`: asked once an approval is valid, before it is applied; an answer it gives refuses it.
type Said = { status: number; body: any };
export let decidePlan: (sessionId: string, id: string, b: PlanDecision, proven?: () => Said | null) => Said = () => ({ status: 503, body: { error: "plans are not loaded" } });

export const planRoutes: RouteModule = (deps: Deps) => {
  const { store, bus } = deps;
  parking = () => !!deps.engine?.isDraining?.();
  decidePlan = (sessionId, id, b, proven) => {
    const w = waiting.get(keyOf(sessionId, id));
    if (!w) return { status: 404, body: { error: "no plan is waiting with that id" } };
    // The decision is said one way. A body that says it another way (or not
    // at all) decides nothing: the plan keeps waiting.
    if (typeof b.approve !== "boolean") return { status: 400, body: { error: 'say the decision as "approve": true (with "mode") or false (with "feedback")' } };
    if (!b.approve) {
      w.resolve({ approved: false, feedback: typeof b.feedback === "string" && b.feedback.trim() ? b.feedback.trim().slice(0, 4000) : undefined });
      return { status: 200, body: { ok: true } };
    }
    // An edit the owner emptied approves nothing (an omitted one keeps the shown plan).
    if (b.plan !== undefined && (typeof b.plan !== "string" || !b.plan.trim())) return { status: 400, body: { error: "the edited plan is empty: write the plan to approve, or keep planning" } };
    const mode = String(b.mode ?? "ask");
    if (!isMode(mode) || mode === "plan") return { status: 400, body: { error: "pick the mode the work goes on in" } };
    const refused = proven?.();
    if (refused) return refused;
    const plan = typeof b.plan === "string" ? b.plan.trim().slice(0, 40_000) : w.plan;
    // (An approval changes the session's mode: not something owed to a store that takes no writes.)
    if (store.refusing) return { status: 503, body: { error: "the daemon's store takes no writes right now, and a plan's approval changes the session's mode, which cannot be kept: approve it when the store takes writes again, or reject it now" } };
    gate?.setPerm(w.session_id, { mode });
    const rec = { session_id: w.session_id, plan, approval_id: w.id, mode, approved_ms: Date.now() };
    store.db.query("INSERT INTO plans (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data").run(w.session_id, JSON.stringify(rec));
    w.resolve({ approved: true, mode, plan, note: typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 2000) : undefined });
    return { status: 200, body: { ok: true, plan: rec } };
  };
  store.migrate("CREATE TABLE IF NOT EXISTS plans (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  emit = (c, state, end) => bus.emit({ t: "feature", name: "plan", session_id: c.session_id, data: { card: c, state, ...(end ? { end } : {}) } });
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
        const w = waiting.get(keyOf(req.params.id, req.params.pid));
        if (!w || w.session_id !== req.params.id) return bad("no plan is waiting with that id", 404);
        const b = await body(req);
        // Leaving plan mode lets the session do more: from a remote device, the owner's passkey.
        const r = decidePlan(w.session_id, w.id, b, () => presence && !presence.allows(req, `plan:${w.id}`)
          ? { status: 428, body: { error: "this needs your passkey from a remote device", presence: { action: `plan:${w.id}` } } } : null);
        return json(r.body, r.status);
      },
    },
  };
};
