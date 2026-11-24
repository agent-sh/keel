// Settings > Usage > Review yield: which models' "done" holds, and which reviewers' refusals are worth
// their price. For each builder model and agent type: the lanes it reported done and how many of them were
// contradicted afterwards (a reviewer's refusal, a red check on the head it reported, a landing that had
// to fix it). For each reviewer model: its refusals a later fix confirmed, what its reviews cost, and the
// rounds of the lanes it reviewed. Every figure is a count of records the daemon keeps, never a model's
// opinion. From GET /api/usage/yield (src/admin/review-yield.ts).
import { useEffect, useRef, useState } from "react";
import type { YieldRead } from "../../../src/admin/review-yield.ts";
import { every } from "../lib/clock.ts";
import { api, reportError } from "../lib/store.ts";
import { fmtUsd, Panel, RANGES, type Range, Table } from "./UsagePanel.tsx";

// A model id as a person reads it: the provider's prefix and the listing's path left off.
const short = (model: string) => model.replace(/^[^:]*:/, "").replace(/^.*\//, "").replace(/^global\.[a-z]+\./, "");
const pct = (r: number | null) => (r === null ? "none" : `${Math.round(100 * r)}%`);
const Model = ({ model }: { model: string }) => <span className="block max-w-[16rem] truncate" title={model}>{short(model)}</span>;

export function ReviewYield({ range }: { range: Range }) {
  const [d, setD] = useState<YieldRead | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const load = () => api<YieldRead>(`/api/usage/yield?since_ms=${Date.now() - RANGES[range]}`).then((r) => { if (n === seq.current) setD(r); }).catch(reportError);
    load();
    return every(60_000, load);
  }, [range]);
  if (!d) return null;
  const none = !d.builders.length && !d.reviewers.length;
  return (
    <div className="flex flex-col gap-6" data-testid="review-yield">
      <Panel plain title="Builders" hint="lanes an agent reported finished, and how many were contradicted afterwards: a refusal, a red check on the head, a landing sent back" testid="yield-builders">
        {d.builders.length ? (
          <Table head={["Model", "Kind", "Lanes", "Contradicted", "Refused", "Red check", "Landing"]} wide={[1, 4, 5, 6]} align={["l", "l", "r", "r", "r", "r", "r"]}
            rows={d.builders.map((b) => [<Model model={b.model} />, b.type, b.done.toLocaleString(), `${pct(b.rate)} (${b.contradicted.toLocaleString()})`, b.refused.toLocaleString(), b.red.toLocaleString(), b.landing.toLocaleString()])} />
        ) : <p className="text-ui text-muted">No agent finished a lane with a branch in this range.</p>}
      </Panel>
      <Panel plain title="Reviewers" hint="a refusal counts as real when the branch moved on after it; the price is what their sessions cost" testid="yield-reviewers">
        {d.reviewers.length ? (
          <Table head={["Model", "Reviews", "Verdicts", "Refusals", "Real", "Spent", "Real per $", "Rounds a lane"]} wide={[1, 2, 7]} align={["l", "r", "r", "r", "r", "r", "r", "r"]}
            rows={d.reviewers.map((r) => [<Model model={r.model} />, r.reviewers.toLocaleString(), r.verdicts.toLocaleString(), r.refusals.toLocaleString(), r.confirmed.toLocaleString(),
              r.unpriced ? `${fmtUsd(r.usd)} and ${r.unpriced.toLocaleString()} unpriced` : fmtUsd(r.usd),
              r.confirmed_per_usd === null ? "none" : r.confirmed_per_usd.toFixed(2), r.rounds_per_lane === null ? "none" : r.rounds_per_lane.toFixed(1)])} />
        ) : <p className="text-ui text-muted">No review agent started in this range.</p>}
      </Panel>
      {none && <p className="text-caption text-faint">The records are read from agents, verdicts, the check ledger and the landing queue; none fall in this range.</p>}
    </div>
  );
}
