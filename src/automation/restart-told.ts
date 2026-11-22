// After a daemon restart a session that has agents is told which of them the
// restart cut and what became of each: one line, with its next request of any
// kind (the owner's prompt, a report, a wake, the next step of a turn that
// runs). It starts no turn.
//
// Read from the start's record (src/admin/life.ts) and kept there: which
// agent's fate each parent was told. The line is lined up as soon as the
// first cut agent of a parent is decided and is written when it is sent, from
// what is known then; an agent decided later, or one whose fate changed, gets
// a line of its own, and nothing is said twice. A parent is marked told when
// the line is stored, so a daemon that goes down first tells it at its next
// start, from the record of the start before.
import type { Restart, RestartTurn } from "../admin/life-rows.ts";
import { restarts } from "../admin/life.ts";
import { addNotice, hasNotice } from "../tools/jobs.ts";
import { clip, D } from "./core.ts";
import { sessionState } from "./state.ts";

// Words another party wrote (a title, a provider's error) as part of one line of the harness: no
// control characters, no brackets or quotes that could close the line's own or open a tag.
const plain = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/[<>\[\]"`]/g, "'").replace(/\s+/g, " ").trim();

// What became of a cut agent, in a few words; nothing while it is not decided.
// `asks`: whether it waits on the owner now (it may have been answered since the cut).
export function fateOf(t: RestartTurn, asks: boolean): string | undefined {
  if (t.state === "pending") return undefined;
  if (t.state === "continued") return asks ? "resumed, waits on the owner's answer" : "resumed";
  if (t.state === "held") return `not continued${t.why ? `: ${clip(plain(t.why).replace(/[.\s]+$/, ""), 140)}` : ""}`;
  if (t.state === "moved") return t.why ? plain(t.why) : "went on by other means";
  return "not continued";
}

export type Fate = { session: string; id: string; title: string; fate: string };
// "[harness] A daemon restart cut 3 of your agents mid-turn: "Builder" (id) resumed; ..."
// `earlier`: the restart is not the last one (its line was owed when the daemon went down again).
export function cutAgentsLine(fates: Fate[], earlier = false): string | undefined {
  if (!fates.length) return undefined;
  const said = fates.map((f) => `"${clip(plain(f.title), 48)}" (${f.id}) ${f.fate}`);
  const on = fates.some((f) => f.fate.startsWith("resumed"));
  return `[harness] ${earlier ? "An earlier daemon restart" : "A daemon restart"} cut ${said.length === 1 ? "1 of your agents" : `${said.length} of your agents`} mid-turn: ${said.join("; ")}.${on ? " A resumed agent reports as before: nothing to send it." : ""}`;
}

// The fates of a parent's cut agents that are decided and that it was not told (or was told otherwise).
// `skip`: agents another record tells of.
function owed(r: Restart, parent: string, skip?: Set<string>): Fate[] {
  const { store } = D();
  const agent = store.db.query<{ id: string; title: string; def: string | null }, [string]>("SELECT id, title, def FROM agents WHERE session_id = ?");
  const told = r.told?.[parent] ?? {};
  const out: Fate[] = [];
  for (const t of r.turns) {
    if (t.parent_id !== parent || skip?.has(t.session_id)) continue;
    const a = agent.get(t.session_id);
    // A silent agent (a reviewer, a goal's check) is not one its parent follows.
    if (!a || (a.def && JSON.parse(a.def).silent)) continue;
    const s = store.session(t.session_id);
    const fate = fateOf(t, !!s && t.state === "continued" && sessionState(s).watch === "need");
    if (fate && told[t.session_id] !== fate) out.push({ session: t.session_id, id: a.id, title: a.title, fate });
  }
  return out;
}

// Lines up the line for each parent that is owed one. `current`: the record as it stands when the
// line is sent (this start's record goes on changing; an earlier one is as it was saved).
function tell(r: Restart, current: () => Restart, earlier: boolean, skip?: Set<string>) {
  const key = `restart:${r.id}`;
  for (const parent of new Set(r.turns.map((t) => t.parent_id).filter((p): p is string => !!p))) {
    // Lined up already: it is written when it is sent, with whatever is decided by then.
    if (hasNotice(parent, key) || !owed(r, parent, skip).length) continue;
    let sent: Fate[] = [];
    addNotice(parent, "", {
      key,
      fresh: () => cutAgentsLine((sent = owed(current(), parent, skip)), earlier),
      stored: () => restarts()?.told(r.id, parent, Object.fromEntries(sent.map((f) => [f.session, f.fate]))),
    });
  }
}

// This start's record changed (a cut turn was found or decided), or is whole.
export function tellCutAgents(r: Restart) {
  tell(r, () => restarts()?.last() ?? r, false);
}

// At a start, once its own record is whole: what the starts before it still owed. An agent this
// start cut again is told by this start's line, not twice.
const EARLIER_STARTS = 3;
const EARLIER_MS = 86_400_000;
export function tellEarlier(now: Restart) {
  const again = new Set(now.turns.map((t) => t.session_id));
  for (const r of restarts()?.recent(EARLIER_STARTS) ?? []) {
    if (r.id === now.id || now.up_ms - r.up_ms > EARLIER_MS) continue;
    // What this start tells instead is settled in the earlier record too: a later start does not bring it up again.
    for (const parent of new Set(r.turns.map((t) => t.parent_id).filter((p): p is string => !!p))) {
      const over = owed(r, parent).filter((f) => again.has(f.session));
      if (over.length) {
        const fates = Object.fromEntries(over.map((f) => [f.session, f.fate]));
        r.told = { ...r.told, [parent]: { ...r.told?.[parent], ...fates } };
        restarts()?.told(r.id, parent, fates);
      }
    }
    tell(r, () => r, true, again);
  }
}
