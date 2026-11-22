// "Is anything stuck", on the rail: the running turns whose step has made no
// progress for too long (src/core/stuck.ts), agents' included, the longest
// first. The daemon marks such a session's state, so this reads the states
// the rows read and asks nothing more, and it is there only while something
// is stuck. Folded, it is a count that opens the list.
import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { StuckMark } from "../../../src/core/watch.ts";
import { toggleList } from "../lib/rail.ts";
import { useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { useSessionStates } from "../lib/watch.ts";
import { span, useNow } from "./Mark.tsx";
import { ReachLine } from "./Stale.tsx";

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

// What it has not done: a model gives no output, a command writes nothing; a step with no sign to read is long.
const SAID = (i: Item) => (i.what === "stream" ? "no output" : i.what === "model" ? "no answer yet" : i.what === "tool" ? `${i.text}, no output` : `Long step: ${i.text}`);

// What is wrong at a glance, above the list: the machines out of reach (Stale.tsx), then the turns without progress.
export function StuckStrip({ open }: { open: boolean }) {
  return <><ReachLine open={open} /><Stuck open={open} /></>;
}

function Stuck({ open }: { open: boolean }) {
  const items = useStuck();
  if (!items.length) return null;
  const label = `${items.length} without progress`;
  if (!open) {
    return (
      <button type="button" className="k-stuck-chip" data-testid="stuck" aria-label={`${label}. Show the list`} title={`${label}: ${items.map((i) => i.s.title || "New session").join(", ")}`} onClick={() => toggleList(true)}>
        <TriangleAlert /><span className="tabular-nums">{items.length}</span>
      </button>
    );
  }
  return (
    <section className="k-stuck" data-testid="stuck" aria-label={label}>
      <h2 className="k-stuck-head"><TriangleAlert /><span>No progress</span><span className="tabular-nums">{items.length}</span></h2>
      {items.map((i) => (
        <button key={i.s.id} type="button" className="k-stuck-item" data-testid="stuck-item" data-session={i.s.id} data-what={i.what} onClick={() => navigate({ name: "session", id: i.s.id })}>
          <span className="k-stuck-title">{i.s.title || "New session"}{i.parent && <span className="k-stuck-of"> · agent of {i.parent.title || "a session"}</span>}</span>
          <span className="k-stuck-what" title={SAID(i)}>{SAID(i)}</span>
          <span className="k-stuck-time tabular-nums">{span(i.elapsed)}</span>
        </button>
      ))}
    </section>
  );
}
