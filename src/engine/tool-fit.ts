// The tools of a session's requests, fitted to the wire they go on
// (src/providers/wires/schema-fit.ts): what each request sends, what is left
// out and named, and the tools a provider refused, sent without their
// parameters for the rest of the session.
import type { Session } from "../core/types.ts";
import type { ModelInfo, Provider, Wire } from "../providers/types.ts";
import { BARE_SCHEMA, bareNote, fitTools, refusedTool, type FitTarget } from "../providers/wires/schema-fit.ts";
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

export class ToolFit {
  // Per session: the tools a provider refused the schema of (sent bare), and
  // the tools already named as left out (named once).
  private bare = new Map<string, Set<string>>();
  private named = new Map<string, Set<string>>();

  constructor(private capture: (e: unknown, context: Record<string, unknown>) => void) {}

  // The tools as the wire takes them; one that cannot be made to fit is left
  // out, and named in the session's failures the first time.
  fit(session: Session, wire: Wire | undefined, tools: Tool[]): Tool[] {
    const { tools: out, left } = fitTools(tools, targetOf(wire));
    if (left.length) this.tell(session, left);
    return out;
  }

  // The refused tools without their parameters, after every pin (a pin keeps
  // what the tool was declared with; this is what this session sends now).
  overlay(sessionId: string, tools: Tool[]): Tool[] {
    const bare = this.bare.get(sessionId);
    if (!bare?.size) return tools;
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
    let set = this.bare.get(session.id);
    if (set?.has(name)) return undefined;
    if (!set) this.bare.set(session.id, (set = new Set()));
    set.add(name);
    this.capture(err, { session: session.id, tool: name, fallback: "the tool is sent without its parameters for the rest of the session" });
    for (const h of allHooks()) try { h.toolSchemaRefused?.(session, name, message); } catch (e) { this.capture(e, { hook: "toolSchemaRefused", session: session.id }); }
    return name;
  }

  forget(sessionId: string) {
    this.bare.delete(sessionId);
    this.named.delete(sessionId);
  }

  private tell(session: Session, left: LeftTool[]) {
    let seen = this.named.get(session.id);
    if (!seen) this.named.set(session.id, (seen = new Set()));
    const fresh = left.filter((l) => !seen.has(`${l.name}\u0000${l.why}`));
    if (!fresh.length) return;
    for (const l of fresh) seen.add(`${l.name}\u0000${l.why}`);
    for (const h of allHooks()) try { h.toolsLeftOut?.(session, fresh); } catch (e) { this.capture(e, { hook: "toolsLeftOut", session: session.id }); }
  }
}
