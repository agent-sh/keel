import { useEffect, useState } from "react";
import type { Lane } from "../../../../src/automation/lane-line.ts";
import { api, reportUnlessGone } from "../../lib/store.ts";
import { useAuto, type AgentRecord } from "../../lib/automation.ts";
import { useToldState } from "../../lib/watch.ts";
import { cn } from "../../lib/utils.ts";

// An agent's lane in five lines (src/automation/lane-line.ts): doing, waits for, went wrong, changed,
// next. Each from what Keel keeps, with no model request; a line in the agent's own words says so,
// and a fact that is missing is said to be missing. Read when a view shows it, and again when
// something it says changed: the agent's record, its session's state, its "now" line (told at
// most every 15 s). No timer of its own.
const kept = new Map<string, Lane>();

export function useLane(a: AgentRecord, on: boolean): Lane | undefined {
  const told = useToldState(a.session_id);
  const line = useAuto((s) => s.now[a.id]);
  const key = [a.status, a.ended ?? "", a.tasks, a.slot_wait ? 1 : 0, told?.watch ?? "", told?.why ?? "", told?.since ?? "", told?.text ?? "", line?.at ?? ""].join("|");
  const [lane, setLane] = useState(() => kept.get(a.id));
  useEffect(() => {
    if (!on) return;
    let live = true;
    api<Lane>(`/api/automation/agents/${a.id}/lane`)
      .then((l) => { kept.set(a.id, l); if (live) setLane(l); })
      .catch((e) => reportUnlessGone(e, { at: "agent lane" }));
    return () => { live = false; };
  }, [on, a.id, key]);
  return lane;
}

export function AgentLane({ a, className, testid = "agent-lane" }: { a: AgentRecord; className?: string; testid?: string }) {
  const lane = useLane(a, true);
  return (
    <dl className={cn("k-lane", className)} data-testid={testid} data-agent={a.id} data-ready={lane ? "" : undefined} aria-busy={!lane || undefined} aria-label={`What ${a.title} is doing, waits for, got wrong, changed and does next`}>
      {lane?.lines.map((l) => (
        <div key={l.key} className="k-lane-row" data-key={l.key} data-from={l.from} data-tone={l.tone} data-testid={`lane-${l.key}`}>
          <dt className="k-lane-label">{l.label}</dt>
          <dd className="k-lane-text" title={l.text}>{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}
