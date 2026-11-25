// "Is anything stuck", on the rail: the running turns whose step has made no
// progress for too long (src/core/stuck.ts), agents' included, the longest
// first. The daemon marks such a session's state, so this reads the states
// the rows read and asks nothing more, and it is there only while something
// is stuck. Folded, it is a count that opens the list. An entry is one line, as a row is: the dot, the title, how
// long; what it has not done and whose agent it is are in its tooltip. It is in the colour of what needs the owner.
// An agent is not an entry of its own: the session it works for is, with how many of its agents are stuck, and the list
// shows the first few with the rest as a count that opens them (a long list took a quarter of the rail).
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { StuckMark } from "../../../src/core/watch.ts";
import { toggleList } from "../lib/rail.ts";
import { useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { useSessionStates } from "../lib/watch.ts";
import { Mark, span, useNow } from "./Mark.tsx";

type Item = StuckMark & { s: Session; parent?: Session; elapsed: number };

export function useStuck(): Item[] {
  const sessions = useStore((x) => x.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const states = useSessionStates(list);
  // The time each has gone without progress moves on while any is listed.
  const now = useNow(list.some((s) => states[s.id]?.stuck), 5000);
  return useMemo(
    () => list
      .flatMap((s) => { const hit = states[s.id]?.stuck; return hit ? [{ ...hit, s, parent: s.parent_id ? sessions[s.parent_id] : undefined, elapsed: now - hit.since }] : []; })
      .sort((a, b) => b.elapsed - a.elapsed),
    [list, states, sessions, now],
  );
}

// One entry of the list: a session that is stuck, or that has agents that are, with the longest of their times.
export type StuckGroup = { s: Session; own?: Item; agents: Item[]; elapsed: number };
export const SHOWN = 3;

// The entries: each stuck session once, its agents (at any depth) under the session at the root of its tree.
export function foldStuck(items: Item[], sessions: Record<string, Session>): StuckGroup[] {
  const root = (s: Session): Session => { for (let i = 0; s.parent_id && sessions[s.parent_id] && i < 16; i++) s = sessions[s.parent_id]!; return s; };
  const by = new Map<string, StuckGroup>();
  for (const i of items) {
    const r = root(i.s);
    const g = by.get(r.id) ?? { s: r, agents: [], elapsed: 0 };
    if (r.id === i.s.id) g.own = i; else g.agents.push(i);
    g.elapsed = Math.max(g.elapsed, i.elapsed);
    by.set(r.id, g);
  }
  return [...by.values()].sort((a, b) => b.elapsed - a.elapsed);
}

// What it has not done: a model gives no output, a command writes nothing; a step with no sign to read is long.
const SAID = (i: Item) => (i.what === "stream" ? "no output" : i.what === "model" ? "no answer yet" : i.what === "tool" ? `${i.text}, no output` : `Long step: ${i.text}`);

const TIP = (i: Item) => `${i.s.title || "New session"}${i.parent ? `, agent of ${i.parent.title || "a session"}` : ""}: ${SAID(i)}`;
const agentsWord = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;

export function StuckStrip({ open }: { open: boolean }) {
  const items = useStuck();
  const sessions = useStore((x) => x.sessions);
  const [all, setAll] = useState(false);
  const groups = useMemo(() => foldStuck(items, sessions), [items, sessions]);
  if (!groups.length) return null;
  const label = `${groups.length} without progress`;
  if (!open) {
    return (
      <button type="button" className="k-stuck-chip" data-testid="stuck" aria-label={`${label}. Show the list`} title={`${label}: ${groups.map((g) => g.s.title || "New session").join(", ")}`} onClick={() => toggleList(true)}>
        <TriangleAlert /><span className="tabular-nums">{groups.length}</span>
      </button>
    );
  }
  const shown = all ? groups : groups.slice(0, SHOWN);
  const more = groups.length - shown.length;
  return (
    <section className="k-stuck" data-testid="stuck" aria-label={label}>
      <h2 className="k-stuck-head"><TriangleAlert /><span>No progress</span><span className="tabular-nums">{groups.length}</span></h2>
      {shown.map((g) => (
        <button key={g.s.id} type="button" className="k-stuck-item" data-testid="stuck-item" data-session={g.s.id} data-what={(g.own ?? g.agents[0]!).what} data-agents={g.agents.length || undefined} title={[...(g.own ? [TIP(g.own)] : []), ...g.agents.map(TIP)].join("\n")} onClick={() => navigate({ name: "session", id: g.s.id })}>
          <Mark w="need" />
          <span className="k-stuck-title">{g.s.title || "New session"}</span>
          {g.agents.length > 0 && <span className="k-stuck-agents" data-testid="stuck-agents">{agentsWord(g.agents.length)}</span>}
          <span className="k-stuck-time tabular-nums">{span(g.elapsed)}</span>
        </button>
      ))}
      {(more > 0 || all) && groups.length > SHOWN && (
        <button type="button" className="k-stuck-more" data-testid="stuck-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `+${more} more`}</button>
      )}
    </section>
  );
}
