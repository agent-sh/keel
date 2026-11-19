// Code mode: the run_code tool, and the calls each program made, kept so the
// owner's page shows them under the program (live, and after a reload). The
// model's context holds only the program and what it printed.
import { registerHooks } from "../../engine/hooks.ts";
import { registerShared } from "../../tools/registry.ts";
import { RUN_CODE, runCodeTool, type CodeCall } from "../../tools/codemode.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

// What the page keeps of one call's input and result: the model never reads
// these rows, the owner does, so a long read is cut for the page only.
const PAGE_CAP = 64 * 1024;
const clipText = (t: string) => (t.length > PAGE_CAP ? `${t.slice(0, PAGE_CAP)}\n[... ${t.length - PAGE_CAP} more characters]` : t);
function clipResult(r: CodeCall["result"]) {
  if (!r) return r;
  if (typeof r.content === "string") return { ...r, content: clipText(r.content) };
  return { ...r, content: r.content.map((b) => (b.type === "text" ? { ...b, text: clipText(b.text) } : b)) };
}
const clipInput = (input: any) => {
  const s = JSON.stringify(input ?? {});
  return s.length > PAGE_CAP ? { clipped: `${s.slice(0, PAGE_CAP)} [... ${s.length - PAGE_CAP} more characters]` } : input;
};

export const codeModeRoutes: RouteModule = (deps: Deps) => {
  const { store, bus } = deps;
  store.migrate(`
CREATE TABLE IF NOT EXISTS code_calls (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS code_calls_parent ON code_calls(session_id, parent, seq);`);
  const save = (sessionId: string, c: CodeCall) => {
    const row: CodeCall = { ...c, input: clipInput(c.input), result: clipResult(c.result) };
    try {
      store.db.query("INSERT INTO code_calls (id, session_id, parent, seq, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(c.id, sessionId, c.parent, c.seq, JSON.stringify(row));
    } catch (e) {
      deps.errors.capture("server", e, { at: "code_calls", session: sessionId });
    }
    bus.emit({ t: "feature", name: "code_call", session_id: sessionId, data: row });
  };
  registerShared(runCodeTool({ start: save, end: save }));

  registerHooks({
    beforeTool(s, call) {
      // The program would run on this daemon's machine, not where the session's files are.
      if (call.tool.name === RUN_CODE && s.machine) return { deny: "run_code runs on this daemon's machine, and this session's workspace is on another one: call the tools directly." };
    },
  });

  return {
    "/api/sessions/:id/code-calls": {
      GET: (req: any) => {
        const parent = new URL(req.url).searchParams.get("parent");
        const rows = parent
          ? store.db.query<{ data: string }, [string, string]>("SELECT data FROM code_calls WHERE session_id = ? AND parent = ? ORDER BY seq").all(req.params.id, parent)
          : store.db.query<{ data: string }, [string]>("SELECT data FROM code_calls WHERE session_id = ? ORDER BY parent, seq").all(req.params.id);
        return json({ calls: rows.map((r) => JSON.parse(r.data)) });
      },
    },
  };
};
