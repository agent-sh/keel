// Settings > Usage, overview: what memory costs the turns and whether they use
// it. One row per recall path (the memory store's blocks at a session's start,
// with a prompt and with a tool call; the helper's records), from the daemon's
// own measurement (/api/telemetry/memory). Counts, tokens and times only: no
// fact, name or prompt is kept there.
import { useEffect, useState, type ReactNode } from "react";
import { api, reportError } from "../lib/store.ts";
import { fmtTokens } from "../lib/utils.ts";
import { fmtMs, fmtPct, Panel, Table } from "./UsagePanel.tsx";

type Row = {
  asked: number; recalls: number; empty: number; repeat: number; skipped: number; late: number; timeouts: number; failures: number;
  facts: number; tokens: number; facts_checked: number; used: number; recalls_checked: number; recalls_used: number;
  repeats: number; cut: number; wait_ms: number; wait_max_ms: number;
};
// `store`: how the memory store answers right now (the kinds of call that are out, or often late).
type Kinds = { ask: boolean; tool: boolean };
type Report = { total: Row; paths: (Row & { path: string })[]; store?: { out: Kinds; degraded: Kinds } };

const PATH: Record<string, string> = {
  store_start: "Memory store, session start",
  store_prompt: "Memory store, with a prompt",
  store_tool: "Memory store, with a tool call",
  store_owed: "Memory store, carried to a later step",
  helper: "Helper records",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function MemoryUsage({ since }: { since: number }) {
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => {
    let live = true;
    // `since` is the overview report's own start: it moves with each of its polls, and this reads again.
    api<Report>(`/api/telemetry/memory?since_ms=${since}`).then((x) => live && setR(x)).catch(reportError);
    return () => { live = false; };
  }, [since]);
  if (!r) return null;

  const cells = (label: ReactNode, x: Row): ReactNode[] => {
    const why = [x.skipped && `${x.skipped} not asked`, x.empty && `${x.empty} with nothing to add`, x.repeat && `${x.repeat} already in the context`, x.late && `${x.late} not waited for`, x.timeouts && `${x.timeouts} timed out`, x.failures && `${x.failures} failed`].filter(Boolean).join(", ");
    return [
      label,
      <span title={why || undefined}>{x.recalls} <span className="text-faint">of {x.asked}</span></span>,
      <span title={plural(x.facts, "fact")}>{fmtTokens(x.tokens)}</span>,
      x.recalls_checked
        ? <span title={`${x.used} of ${plural(x.facts_checked, "fact")} named by the reply or a tool call of their turn`}>{x.recalls_used} <span className="text-faint">of {x.recalls_checked}, {fmtPct(x.facts_checked ? x.used / x.facts_checked : null)} of facts</span></span>
        : <span className="text-faint">none yet</span>,
      <span title={x.cut ? `${x.cut} more had no room in their block and followed with a later step` : undefined}>{x.repeats}{x.cut ? <span className="text-faint">, {x.cut} carried on</span> : null}</span>,
      <span title={`longest wait ${fmtMs(x.wait_max_ms)}`}>{fmtMs(x.wait_ms)}</span>,
    ];
  };
  const out = r.total.timeouts + r.total.failures;
  const kinds = (k?: Kinds) => [k?.ask && "prompts", k?.tool && "tool calls"].filter(Boolean).join(" and ");
  const slow = kinds(r.store?.degraded), down = kinds(r.store?.out);

  return (
    <Panel plain title="Memory" hint="what recall added to turns, and an estimate of whether they used it; counts only, no content" testid="usage-memory">
      {r.paths.length ? (
        <>
          <Table
            head={["Path", "Recalls", "Tokens added", "Named in reply (estimate)", "Not added again", "Time added"]}
            rows={[...r.paths.map((p) => cells(PATH[p.path] ?? p.path, p)), ...(r.paths.length > 1 ? [cells(<span className="font-medium">All memory</span>, r.total)] : [])]}
          />
          <p className="mt-3 border-t border-line pt-3 text-caption text-muted" data-testid="memory-notes">
            Named in reply is an estimate: a recall counts when the reply or a tool call of its turn spells the name of one of its facts, or three of its words in a row. It reads low: a fact can shape a reply without being named, and standing rules rarely are. A fact the context already holds is not added again; one its block has no room for follows with the next step.
            {out > 0 && <span className="text-danger" data-testid="memory-out"> The store did not answer {plural(out, "time")} ({r.total.timeouts} timed out, {r.total.failures} failed): those turns went on without it.</span>}
            {down && <span className="text-danger" data-testid="memory-down"> Right now it is not answering {down} in time.</span>}
            {slow && !down && <span className="text-warn" data-testid="memory-slow"> Right now it answers {slow} slowly: a quarter or more of its last 20 answers came later than a turn waits.</span>}
          </p>
        </>
      ) : <p className="k-empty">No memory was recalled in this range.</p>}
    </Panel>
  );
}
