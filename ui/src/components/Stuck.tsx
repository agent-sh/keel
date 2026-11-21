// "Is anything stuck", on the rail: the running turns whose step has made no
// progress for too long (src/core/stuck.ts), agents' included, the longest
// first. It reads the same states the rows read, so nothing is asked of the
// daemon, and it is there only while something is stuck. Folded, it is a
// count that opens the list.
import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import type { Session } from "../../../src/core/types.ts";
import { stuckOf, type Stuck } from "../../../src/core/stuck.ts";
import { toggleList } from "../lib/rail.ts";
import { useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { useSessionStates } from "../lib/watch.ts";
import { span, useNow } from "./Mark.tsx";

type Item = Stuck & { s: Session; parent?: Session; elapsed: number };

export function useStuck(): Item[] {
  const sessions = useStore((x) => x.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const states = useSessionStates(list);
  // Checked again while anything works: a step crosses its limit with no frame to say so.
  const now = useNow(list.some((s) => states[s.id]?.watch === "work"), 5000);
  return useMemo(
    () => list
      .flatMap((s) => { const hit = stuckOf(states[s.id], now); return hit ? [{ ...hit, s, parent: s.parent_id ? sessions[s.parent_id] : undefined, elapsed: now - hit.since }] : []; })
      .sort((a, b) => b.elapsed - a.elapsed),
    [list, states, sessions, now],
  );
}

const SAID: Record<Stuck["what"], string> = { stream: "no output", model: "no answer yet", tool: "" };

export function StuckStrip({ open }: { open: boolean }) {
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
          <span className="k-stuck-what">{SAID[i.what] || i.text}</span>
          <span className="k-stuck-time tabular-nums">{span(i.elapsed)}</span>
        </button>
      ))}
    </section>
  );
}
