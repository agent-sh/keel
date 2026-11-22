// After a daemon restart a session that has agents is told which of them the
// restart cut and what became of each: one line, once, with its next input.
// It starts no turn: the agents that go on report as before, and one that was
// not continued ends with a report of its own, so an input follows either way.
// Read from the start's record (src/admin/life.ts): told as soon as every cut
// agent of the session is decided, so the line is there before the first of
// them reports again, and at the latest when the record is whole.
import type { Restart, RestartTurn } from "../admin/life-rows.ts";
import { clip, D, deliver } from "./core.ts";

// What became of a cut agent, in a few words.
function became(t: RestartTurn): string {
  if (t.state === "continued") return t.waiting ? "resumed, waits on the owner's answer" : "resumed";
  if (t.state === "held") return `not continued${t.why ? `: ${clip(t.why.replace(/\s+/g, " "), 140)}` : ""}`;
  if (t.state === "moved") return t.why ?? "went on by other means";
  return "not continued";
}

// "[harness] A daemon restart cut 3 of your agents mid-turn: "Builder" (id) resumed; ..."
// `named`: the agent of a cut turn's session (its id and title), or nothing for a session that is no agent to tell of.
export function cutAgentsLine(turns: RestartTurn[], named: (sessionId: string) => { id: string; title: string } | undefined): string | undefined {
  const said = turns.flatMap((t) => { const a = named(t.session_id); return a ? [`"${clip(a.title.replace(/\s+/g, " ").trim(), 48)}" (${a.id}) ${became(t)}`] : []; });
  if (!said.length) return undefined;
  const on = turns.some((t) => t.state === "continued");
  return `[harness] A daemon restart cut ${said.length === 1 ? "1 of your agents" : `${said.length} of your agents`} mid-turn: ${said.join("; ")}.${on ? " A resumed agent reports as before: nothing to send it." : ""}`;
}

// The parents told for a start's record, by the record's id: each once.
const told = new Map<string, Set<string>>();

// `whole`: the record is whole, so a turn nobody decided is told as it was left. Before that a
// session is told only once every cut agent of it is decided.
export function tellCutAgents(r: Restart, whole = false) {
  const { store } = D();
  const done = told.get(r.id) ?? told.set(r.id, new Set()).get(r.id)!;
  const byParent = new Map<string, RestartTurn[]>();
  for (const t of r.turns) if (t.parent_id) byParent.set(t.parent_id, [...(byParent.get(t.parent_id) ?? []), t]);
  const agent = store.db.query<{ id: string; title: string; def: string | null }, [string]>("SELECT id, title, def FROM agents WHERE session_id = ?");
  for (const [parent, turns] of byParent) {
    if (done.has(parent) || (!whole && turns.some((t) => t.state === "pending"))) continue;
    done.add(parent);
    const text = cutAgentsLine(turns, (sid) => {
      const a = agent.get(sid);
      // A silent agent (a reviewer, a goal's check) is not one its parent follows.
      return a && !(a.def && JSON.parse(a.def).silent) ? { id: a.id, title: a.title } : undefined;
    });
    if (text) deliver(parent, text, { kind: "harness", restart: r.id }, { ride: true });
  }
}
