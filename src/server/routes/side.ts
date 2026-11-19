// Side questions (/btw): a question answered by the session's model from the
// session as it stands (a running turn included, without the reply it is
// still writing), on the session's own request prefix, with no tool run.
// Nothing enters the conversation. A thread replays its newest exchanges with
// each question, so follow-ups see the earlier ones (Claude Code keeps 20).
import type { Message } from "../../core/types.ts";
import type { RouteModule } from "../app.ts";

export const SIDE_EXCHANGES_KEPT = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS side_exchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  usage TEXT NOT NULL,
  ran_tools INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS side_exchanges_session ON side_exchanges(session_id, id);
`;

type Exchange = { id: number; thread_id: string; question: string; answer: string; ts: number; model: string; usage: any; ran_tools: boolean };

const json = (data: unknown, status = 200) => Response.json(data, { status });

// Byte-stable per question, so a thread's earlier exchanges stay a cached prefix.
const asked = (q: string) =>
  `[harness] A side question from the owner. Answer it only from this conversation: you have no tools for this answer and nothing you write is run. Neither the question nor your answer enters the conversation.\n\n${q}`;

export const sideRoutes: RouteModule = ({ store, engine, errors }) => {
  store.migrate(SCHEMA);
  const rows = (sid: string): Exchange[] =>
    store.db.query<any, [string]>("SELECT * FROM side_exchanges WHERE session_id = ? ORDER BY id").all(sid)
      .map((r) => ({ ...r, usage: JSON.parse(r.usage), ran_tools: !!r.ran_tools }));
  const threads = (sid: string) => {
    const by = new Map<string, Exchange[]>();
    for (const x of rows(sid)) by.set(x.thread_id, [...(by.get(x.thread_id) ?? []), x]);
    return [...by.entries()].map(([id, exchanges]) => ({ id, created_ms: exchanges[0]!.ts, exchanges }));
  };

  // Clear forgets every exchange, also one still being answered: each clear
  // starts a new generation and stops the answers asked before it.
  const gen = new Map<string, number>();
  const pending = new Map<string, Set<AbortController>>();

  return {
    "/api/sessions/:id/side": {
      GET: (req: any) => (store.session(req.params.id) ? json({ threads: threads(req.params.id) }) : json({ error: "no such session" }, 404)),
      DELETE: (req: any) => {
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        gen.set(req.params.id, (gen.get(req.params.id) ?? 0) + 1);
        for (const c of pending.get(req.params.id) ?? []) c.abort();
        store.db.run("DELETE FROM side_exchanges WHERE session_id = ?", [req.params.id]);
        return json({ threads: [] });
      },
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const b = (await req.json().catch(() => ({}))) as any;
        const question = String(b.question ?? "").trim();
        if (!question) return json({ error: "the question is empty" }, 400);
        const known = b.thread_id && rows(s.id).some((x) => x.thread_id === b.thread_id);
        const thread = known ? String(b.thread_id) : crypto.randomUUID();
        const before = known ? rows(s.id).filter((x) => x.thread_id === thread).slice(-SIDE_EXCHANGES_KEPT) : [];
        const extra: Message[] = [];
        for (const x of before) {
          extra.push({ role: "user", content: [{ type: "text", text: asked(x.question) }] });
          extra.push({ role: "assistant", content: [{ type: "text", text: x.answer }] });
        }
        extra.push({ role: "user", content: [{ type: "text", text: asked(question) }] });
        const at = gen.get(s.id) ?? 0;
        const stop = new AbortController();
        const mine = pending.get(s.id) ?? pending.set(s.id, new Set()).get(s.id)!;
        mine.add(stop);
        const cleared = () => json({ error: "the side questions were cleared while this one was answered", cleared: true }, 409);
        let res;
        try {
          res = await engine.ask(s.id, extra, AbortSignal.any([req.signal, stop.signal]));
        } catch (e) {
          if ((gen.get(s.id) ?? 0) !== at) return cleared();
          const rec = errors.capture("provider", e, { session: s.id, at: "side question" });
          return json({ error: rec.message, error_id: rec.id }, 502);
        } finally {
          mine.delete(stop);
        }
        // An answer that lands after a clear is not kept (its thread was forgotten).
        if ((gen.get(s.id) ?? 0) !== at) return cleared();
        const ranTools = res.blocks.some((x) => x.type === "tool_use");
        let answer = res.blocks.filter((x) => x.type === "text").map((x: any) => x.text).join("\n\n").trim();
        if (ranTools) answer += `${answer ? "\n\n" : ""}_It asked to run a tool; side questions run none._`;
        if (res.stop === "refusal") answer ||= "The model declined this question.";
        const ts = Date.now();
        const id = store.db.query<{ id: number }, any[]>(
          "INSERT INTO side_exchanges (session_id, thread_id, question, answer, ts, model, usage, ran_tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        ).get(s.id, thread, question, answer, ts, res.model_id, JSON.stringify(res.usage), ranTools ? 1 : 0)!.id;
        // Keep the newest exchanges of the session; older ones are not replayed anyway.
        store.db.run("DELETE FROM side_exchanges WHERE session_id = ? AND id NOT IN (SELECT id FROM side_exchanges WHERE session_id = ? ORDER BY id DESC LIMIT 100)", [s.id, s.id]);
        return json({ thread_id: thread, exchange: { id, thread_id: thread, question, answer, ts, model: res.model_id, usage: res.usage, ran_tools: ranTools } }, 201);
      },
    },
  };
};
