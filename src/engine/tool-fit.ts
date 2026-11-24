// The tools of a session's requests, fitted to the wire they go on
// (src/providers/wires/schema-fit.ts): what each request sends, what is left
// out and named, and the tools a provider refused, sent without their
// parameters for the rest of the session. Both are kept with the session, so a
// restart neither tells a left-out tool again nor sends a refused one's schema.
import type { Store } from "../core/store.ts";
import { SessionMap } from "../core/session-map.ts";
import type { Session } from "../core/types.ts";
import type { ModelInfo, Provider, Wire } from "../providers/types.ts";
import { BARE_SCHEMA, bareNote, fitTools, refusedTool, type FitTarget } from "../providers/wires/schema-fit.ts";
import { forgetFit, markFit } from "../tools/defer.ts";
import type { Tool } from "../tools/types.ts";
import { allHooks } from "./hooks.ts";

export type LeftTool = { name: string; why: string };

// The wire a model's requests go on (a stand-in's own, else its provider's);
// a provider that names none gets every wire's rules.
export const wireOf = (provider: Pick<Provider, "wire" | "wireOf">, info: Pick<ModelInfo, "model">): Wire | undefined => provider.wireOf?.(info.model) ?? provider.wire;
export const targetOf = (wire: Wire | undefined): FitTarget => wire ?? "portable";

// How many tools one request is sent again without (a refusal that names one
// tool after another past this is the request's own failure).
export const SCHEMA_RESENDS = 3;

// `kind`: "bare", a tool whose schema the provider refused (`why` empty), or
// "told", a tool left out and named in the session's failures for `why`.
const SCHEMA = `CREATE TABLE IF NOT EXISTS session_tool_fit (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, why TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, name, why))`;

type Kept = { bare: Set<string>; told: Set<string> };
const toldKey = (l: LeftTool) => `${l.name}\u0000${l.why}`;

export class ToolFit {
  // Each session's rows as read once from the table (a few names at most).
  private kept = new SessionMap<Kept>(1024);

  constructor(private store: Store, private capture: (e: unknown, context: Record<string, unknown>) => void) {
    store.migrate(SCHEMA);
  }

  private of(sessionId: string): Kept {
    let k = this.kept.get(sessionId);
    if (k) return k;
    k = { bare: new Set(), told: new Set() };
    const rows = this.store.db.query<{ kind: string; name: string; why: string }, [string]>("SELECT kind, name, why FROM session_tool_fit WHERE session_id = ?").all(sessionId);
    for (const r of rows) (r.kind === "bare" ? k.bare.add(r.name) : k.told.add(toldKey(r)));
    this.kept.set(sessionId, k);
    return k;
  }

  private keep(sessionId: string, kind: "bare" | "told", name: string, why: string) {
    try {
      this.store.db.query("INSERT OR IGNORE INTO session_tool_fit (session_id, kind, name, why) VALUES (?, ?, ?, ?)").run(sessionId, kind, name, why);
    } catch (e) {
      this.capture(e, { at: "session_tool_fit", session: sessionId, tool: name });
    }
  }

  // The tools as the wire takes them; one that cannot be made to fit is left
  // out, and named in the session's failures the first time. The session's
  // tool search is told which (src/tools/defer.ts markFit).
  fit(session: Session, wire: Wire | undefined, tools: Tool[]): Tool[] {
    const { tools: out, left } = fitTools(tools, targetOf(wire));
    markFit(session.id, out.map((t) => t.name), left);
    if (left.length) this.tell(session, left);
    return out;
  }

  // The refused tools without their parameters, after every pin (a pin keeps
  // what the tool was declared with; this is what this session sends now).
  overlay(sessionId: string, tools: Tool[]): Tool[] {
    const bare = this.of(sessionId).bare;
    if (!bare.size) return tools;
    return tools.map((t) => (bare.has(t.name) && t.input_schema !== BARE_SCHEMA && !t.freeform ? { ...t, description: bareNote(t.description), input_schema: BARE_SCHEMA } : t));
  }

  // A provider's refusal of one tool's schema: the tool it names, now sent
  // bare for this session, or undefined when the refusal names none (or one
  // already bare: the request's failure is then its own).
  refused(session: Session, err: unknown, tools: Pick<Tool, "name" | "defer" | "namespace">[], wire: Wire | undefined): string | undefined {
    const status = (err as { status?: number })?.status;
    if (status !== undefined && status !== 400 && status !== 422) return undefined;
    const message = String((err as Error)?.message ?? err);
    const name = refusedTool(message, tools, wire);
    if (!name) return undefined;
    const bare = this.of(session.id).bare;
    if (bare.has(name)) return undefined;
    bare.add(name);
    this.keep(session.id, "bare", name, "");
    this.capture(err, { session: session.id, tool: name, fallback: "the tool is sent without its parameters for the rest of the session" });
    for (const h of allHooks()) try { h.toolSchemaRefused?.(session, name, message); } catch (e) { this.capture(e, { hook: "toolSchemaRefused", session: session.id }); }
    return name;
  }

  forget(sessionId: string) {
    this.kept.delete(sessionId);
    forgetFit(sessionId);
  }

  private tell(session: Session, left: LeftTool[]) {
    const told = this.of(session.id).told;
    const fresh = left.filter((l) => !told.has(toldKey(l)));
    if (!fresh.length) return;
    for (const l of fresh) {
      told.add(toldKey(l));
      this.keep(session.id, "told", l.name, l.why);
    }
    for (const h of allHooks()) try { h.toolsLeftOut?.(session, fresh); } catch (e) { this.capture(e, { hook: "toolsLeftOut", session: session.id }); }
  }
}
