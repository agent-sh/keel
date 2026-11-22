// After a daemon restart a session that has agents is told which of them the
// restart cut and what became of each: one line a restart, with its next
// request of any kind (the owner's prompt, a report, a wake, the next step of
// a turn that runs) once every one of them is decided. It starts no turn.
//
// Read from the start's record (src/admin/life.ts) and kept there: that a
// parent was told, and what of each agent. Cut agents are resumed a few at a
// time, so they are decided over seconds: the line waits for the last of
// them, and names them all. It does not wait longer than SETTLE_MS from the
// start: an agent whose resume waits on something (a card of the owner's, a
// provider that does not answer) is then named as not decided yet, and the
// parent hears of it by that agent's own report. An agent that has reported
// since the restart is not named: its report said what became of it. Nothing
// is said twice: a parent is marked told when the line is stored, so a daemon
// that goes down first tells it at its next start, from the record of the
// start before, unless the parent was given input since that start (other
// than a restart's own note): what it was told or did since is newer than
// the record.
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

// How long after a start the line waits for the last cut agent to be decided. Three turns are
// resumed at a time, a second apart (src/engine/turn.ts), so a dozen agents are decided within
// seconds; one that is not by now waits on something that may take minutes.
export const SETTLE_MS = 60_000;

// The cut agents of a parent that it is told of, each with what became of it. `skip`: agents another
// record tells of. Left out: a silent agent (a reviewer, a goal's check: not one its parent follows),
// and one that ended since the start: its report tells the parent.
// `ready`: every one of them is decided, or the start is SETTLE_MS old.
function owed(r: Restart, parent: string, skip?: Set<string>, now = Date.now()): { fates: Fate[]; ready: boolean } {
  const { store } = D();
  const agent = store.db.query<{ id: string; title: string; def: string | null; status: string; ended: number | null }, [string]>("SELECT id, title, def, status, ended FROM agents WHERE session_id = ?");
  const fates: Fate[] = [];
  let pending = 0;
  // Told already: a restart is one line to a parent.
  if (r.told?.[parent]) return { fates, ready: true };
  for (const t of r.turns) {
    if (t.parent_id !== parent || skip?.has(t.session_id)) continue;
    const a = agent.get(t.session_id);
    if (!a || (a.def && JSON.parse(a.def).silent)) continue;
    if (a.status !== "running" && a.status !== "waiting" && (a.ended ?? 0) >= r.up_ms) continue;
    const s = store.session(t.session_id);
    const fate = fateOf(t, !!s && t.state === "continued" && sessionState(s).watch === "need");
    if (!fate) pending++;
    fates.push({ session: t.session_id, id: a.id, title: a.title, fate: fate ?? "not decided yet: it reports when it goes on" });
  }
  return { fates, ready: !pending || now - r.up_ms >= SETTLE_MS };
}

// When the parent was last given input (a prompt, a report, a wake), other than a restart's own note
// to it: that note says its turn was cut, and nothing of its agents. Asked as a fact (the newest
// such row, found by the session's index): the session is not brought into memory for it.
function lastInput(parent: string): number | undefined {
  return D().store.db
    .query<{ ts: number }, [string]>("SELECT ts FROM events WHERE session_id = ? AND kind = 'user' AND COALESCE(json_extract(data, '$.origin'), '') != 'restart' ORDER BY seq DESC LIMIT 1")
    .get(parent)?.ts;
}

// Lines up the line for each parent that is owed one. `current`: the record as it stands when the
// line is sent (this start's record goes on changing; an earlier one is as it was saved).
function tell(r: Restart, current: () => Restart, earlier: boolean, skip?: Set<string>) {
  const key = `restart:${r.id}`;
  for (const parent of new Set(r.turns.map((t) => t.parent_id).filter((p): p is string => !!p))) {
    // Lined up already: it is written when it is sent, with what holds then.
    if (hasNotice(parent, key) || !owed(r, parent, skip).fates.length) continue;
    const line = () => {
      let sent: Fate[] = [];
      addNotice(parent, "", {
        key,
        fresh: () => {
          const now = owed(current(), parent, skip);
          // Not every agent is decided yet: the line waits for the parent's next request after this one.
          if (!now.ready) { line(); return undefined; }
          return cutAgentsLine((sent = now.fates), earlier);
        },
        stored: () => restarts()?.told(r.id, parent, Object.fromEntries(sent.map((f) => [f.session, f.fate]))),
      });
    };
    line();
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
    for (const parent of new Set(r.turns.map((t) => t.parent_id).filter((p): p is string => !!p))) {
      if (r.told?.[parent]) continue;
      // The parent was given input since that start: the record is older than what it knows. And a
      // parent all of whose cut agents this start cut again is told by this start's line. Either is
      // settled in the earlier record too: a later start does not bring it up again.
      const fates = owed(r, parent).fates;
      const since = lastInput(parent);
      if (!fates.length || (since !== undefined && since > r.up_ms) || fates.every((f) => again.has(f.session))) {
        const said = Object.fromEntries(fates.filter((f) => again.has(f.session)).map((f) => [f.session, f.fate]));
        r.told = { ...r.told, [parent]: said };
        restarts()?.told(r.id, parent, said);
      }
    }
    tell(r, () => r, true, again);
  }
}
