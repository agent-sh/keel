import type { Tool } from "../tools/types.ts";
import { fail, ok } from "../tools/types.ts";
import * as activity from "./activity.ts";
import { D, capture } from "./core.ts";

// Consult another model: the working model asks an advisor (a model the owner
// chose, usually stronger) for guidance at a decision point. The advisor reads
// the whole conversation as it stands, every tool call and result included, on
// its own model, runs no tool, and its answer comes back as the tool result:
// guidance to weigh, never an instruction. Claude Code's advisor is a server
// tool of the Anthropic API only; this one runs on any provider Keel has.
// Repeated consults on the same advisor read the conversation from its cache.

export function migrate() {
  D().store.migrate("CREATE TABLE IF NOT EXISTS advisor_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

const read = (key: string) => D().store.db.query<{ value: string }, [string]>("SELECT value FROM advisor_settings WHERE key = ?").get(key)?.value ?? null;
const write = (key: string, value: string | null) => {
  if (value) D().store.db.query("INSERT INTO advisor_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  else D().store.db.query("DELETE FROM advisor_settings WHERE key = ?").run(key);
};

// The session's own choice ("off" turns it off there), else the owner's default.
export function advisorFor(sessionId: string): string | null {
  const own = read(`session:${sessionId}`);
  if (own === "off") return null;
  return own ?? read("default");
}
export const defaultAdvisor = () => read("default");
export const sessionAdvisor = (sessionId: string) => read(`session:${sessionId}`);

async function checkModel(model: string | null) {
  if (model && model !== "off") await D().providers.resolve(model); // a model no provider lists is refused
}
export async function setDefault(model: string | null) {
  await checkModel(model);
  write("default", model);
}
export async function setForSession(sessionId: string, model: string | null) {
  await checkModel(model);
  write(`session:${sessionId}`, model);
}

const REQUEST = (q: string) =>
  "[harness] Advisor request. You are the advisor to the model working in the conversation above; its last call, to the advisor tool, is this request. " +
  "Read everything above, tool calls and results included. Give the guidance it needs now: the approach to take, what it missed, the likely cause of a repeating failure, or what to check before calling the task done. " +
  "Be concrete and short (under 400 words), point at files and lines, and say plainly when its current plan is right. You run no tools; nothing you write is run." +
  (q ? `\n\nIts question: ${q}` : "");

const money = (n?: number) => (n === undefined ? "" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);

export const advisorTool: Tool = {
  name: "advisor",
  families: ["claude", "gpt", "gemini", "other"],
  readOnly: true,
  description:
    "Consult your advisor: a second model the owner chose reads this whole conversation (every tool call and result) and gives guidance. " +
    "Call it at decision points: before committing to an approach on a large change, when an error keeps coming back, and before you call a long task done. Not for routine steps. " +
    "Its answer is guidance to weigh against your own evidence: when a file or a test contradicts it, say so instead of following it. It costs the advisor's tokens.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string", description: "What you want advice on; omit to ask for a general check of where you are" } },
  },
  run: async (input, ctx) => {
    const s = D().store.session(ctx.sessionId);
    if (!s) return fail("no such session");
    const model = advisorFor(s.parent_id ?? s.id); // an agent consults its parent's advisor
    if (!model) return fail("No advisor is set for this session: the owner chooses one (Settings > Agents, or /advisor). Go on with your own judgment.");
    const question = String(input.question ?? "").trim().slice(0, 4000);
    const t0 = Date.now();
    try {
      const res = await D().engine.ask(ctx.sessionId, [{ role: "user", content: [{ type: "text", text: REQUEST(question) }] }], ctx.signal, model, ctx.callId ? { id: ctx.callId, text: "(this advisor call: the request follows)" } : undefined);
      const text = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n\n").trim();
      const name = D().providers.current().find((m) => m.id === res.model_id)?.name ?? res.model_id;
      const cost = (res.usage as any).cost as number | undefined;
      activity.record("agent", "consult", ctx.sessionId, `Consulted the advisor ${name}${question ? `: ${question.slice(0, 120)}` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s${cost !== undefined ? `, ${money(cost)}` : ""})`, { model: res.model_id, usage: res.usage });
      if (res.stop === "refusal" || !text) return fail(`The advisor (${name}) declined to advise on this request.`);
      return ok(`Advisor ${name}${cost !== undefined ? ` (${money(cost)})` : ""}. Its guidance, to weigh against your own evidence:\n\n${text}`);
    } catch (e) {
      capture(e, { at: "advisor", session: ctx.sessionId });
      return fail(`The advisor is unavailable: ${(e as Error).message}. Go on with your own judgment.`);
    }
  },
};
