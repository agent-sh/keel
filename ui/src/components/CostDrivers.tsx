// Settings > Usage: why the range cost what it did. Each cause with what it
// cost and, beside it, what changes it: the steps by how large a prompt they
// sent, the cache rewrites by what broke the cache, the agents against the
// sessions above them, the steps a turn takes, and the dearest agent trees.
// From GET /api/usage/drivers (src/admin/cost-drivers.ts). The causes overlap:
// each is a share of the whole spend, not a part of a sum.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { rewriteFigure, type DriversRead } from "../../../src/admin/cost-drivers.ts";
import { openSession } from "../lib/automation.ts";
import { every } from "../lib/clock.ts";
import { api, reportError } from "../lib/store.ts";
import { fmtTokens } from "../lib/utils.ts";
import { CAUSE, fmtUsd, Panel, RANGES, type Range, Table } from "./UsagePanel.tsx";

type Drivers = Omit<DriversRead, "breaks"> & { breaks: (DriversRead["breaks"][number] extends infer B ? Omit<B, "models"> & { rewrite_usd: number | null; models: number } : never)[]; took_ms: number };

// What lowers each cause, in Keel's own terms.
const REWRITE_LEVER: Record<string, string> = {
  expired: "A session idle past the cache lifetime pays for its prompt again. Keel warms the cache while a session waits on a wait it set; long pauses mid-task with nothing set still lose it.",
  model_switch: "A model switch writes the whole prompt again for the new model. Switch in a new session, or right after a compaction.",
  compaction: "Each compaction writes its new, shorter context once; expected, and paid back by the steps after it.",
  branch_switch: "Showing another branch sends that branch's prompt, written again.",
  prefix_changed: "The tools or the system prompt changed under a running session (a server, a skill, an upgrade): change them between tasks.",
  provider_miss: "The provider did not find an unchanged prefix. Nothing here changes it.",
};
const band = (b: { from: number; to: number | null }) => (b.to === null ? `${fmtTokens(b.from)} and over` : b.from === 0 ? `Under ${fmtTokens(b.to)}` : `${fmtTokens(b.from)} to ${fmtTokens(b.to)}`);
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "none");

// One cause: what it is, what it cost, and the lever under it.
function Cause({ testid, fact, usd, lever }: { testid: string; fact: string; usd: string; lever: string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-0.5 border-b border-line/60 py-2.5 last:border-0" data-testid={testid}>
      <span className="text-ui text-fg">{fact}</span>
      <span className="text-right text-ui tabular-nums text-fg">{usd}</span>
      <span className="col-span-2 text-caption text-muted" data-testid="driver-lever">{lever}</span>
    </li>
  );
}

export function CostDrivers({ range }: { range: Range }) {
  const [d, setD] = useState<Drivers | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const load = () => api<Drivers>(`/api/usage/drivers?since_ms=${Date.now() - RANGES[range]}`).then((r) => { if (n === seq.current) setD(r); }).catch(reportError);
    load();
    return every(30_000, load);
  }, [range]);
  if (!d) return null;
  const spent = d.total.cost;
  if (!d.total.calls) return null;
  const causes: { key: string; usd: number; node: ReactNode }[] = [];
  // The steps over the largest bands, where the spend per step is highest.
  const steps = d.bands.reduce((n, b) => n + b.calls, 0);
  const big = d.bands.filter((b) => b.from >= 200_000);
  const bigUsd = big.reduce((n, b) => n + b.cost, 0), bigSteps = big.reduce((n, b) => n + b.calls, 0);
  if (bigSteps) {
    const small = d.bands.filter((b) => b.from < 200_000), smallSteps = small.reduce((n, b) => n + b.calls, 0), smallUsd = small.reduce((n, b) => n + b.cost, 0);
    causes.push({ key: "big", usd: bigUsd, node: (
      <Cause key="big" testid="driver-big" usd={fmtUsd(bigUsd)}
        fact={`${pct(bigUsd, spent)} of the spend went on ${bigSteps.toLocaleString()} steps that sent 200K tokens or more (${pct(bigSteps, steps)} of the steps), at ${fmtUsd(bigUsd / bigSteps)} a step${smallSteps ? ` against ${fmtUsd(smallUsd / smallSteps)} under 200K` : ""}.`}
        lever="Every step sends the whole prompt. A new context, or a compaction before the prompt grows this large, makes each step after it cheaper; long reading goes to agents or readers, whose prompts stay small." />
    ) });
  }
  // Rewrites, by cause, in dollars.
  for (const b of d.breaks) {
    const usd = b.rewrite_usd ?? b.cost;
    causes.push({ key: `break-${b.cause}`, usd, node: (
      <Cause key={b.cause} testid="driver-rewrite" usd={rewriteFigure(b, fmtUsd).figure}
        fact={`${b.calls.toLocaleString()} ${b.calls === 1 ? "request" : "requests"} wrote the prompt again because ${CAUSE[b.cause] ?? b.cause}${rewriteFigure(b, fmtUsd).note}.`}
        lever={REWRITE_LEVER[b.cause] ?? "What differed is in the cache breaks of Speed and tools."} />
    ) });
  }
  if (d.agents.sessions) {
    causes.push({ key: "agents", usd: d.agents.cost, node: (
      <Cause key="agents" testid="driver-agents" usd={fmtUsd(d.agents.cost)}
        fact={`Agents spent ${pct(d.agents.cost, spent)}: ${d.agents.sessions.toLocaleString()} ${d.agents.sessions === 1 ? "agent" : "agents"}, against ${fmtUsd(d.roots.cost)} in the ${d.roots.sessions.toLocaleString()} ${d.roots.sessions === 1 ? "session" : "sessions"} above them.`}
        lever="An agent pays for its own prompt each step. A narrow task, and a smaller model for agents that only read, keep each one cheap." />
    ) });
  }
  if (d.turns.turns) {
    const per = d.turns.steps / d.turns.turns;
    causes.push({ key: "turns", usd: d.turns.cost, node: (
      <Cause key="turns" testid="driver-turns" usd={fmtUsd(d.turns.cost / d.turns.turns)}
        fact={`${d.turns.turns.toLocaleString()} ${d.turns.turns === 1 ? "turn" : "turns"} took ${d.turns.steps.toLocaleString()} ${d.turns.steps === 1 ? "step" : "steps"}, ${per.toFixed(per < 10 ? 1 : 0)} a turn; a turn cost ${fmtUsd(d.turns.cost / d.turns.turns)} on average.`}
        lever="Each step reads the whole prompt again. A task said whole up front takes fewer steps than one found out step by step." />
    ) });
  }
  causes.sort((a, b) => b.usd - a.usd);
  const missing = d.total.unpriced + d.total.incomplete;
  return (
    <Panel plain title="Why it cost this" hint={`each cause as a share of all ${fmtUsd(spent)}${missing ? `, ${missing.toLocaleString()} requests with no known cost left out` : ""}; the causes overlap`} testid="usage-drivers-card">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ul className="flex flex-col" data-testid="drivers">{causes.map((c) => c.node)}</ul>
        <div className="flex min-w-0 flex-col gap-6">
          <div data-testid="drivers-bands">
            <div className="mb-1 text-caption text-faint">Turn steps by the prompt they sent</div>
            <Table head={["Prompt", "Steps", "Spend", "Share", "A step"]} wide={[1, 4]}
              rows={d.bands.map((b) => [band(b), b.calls.toLocaleString(), fmtUsd(b.cost), pct(b.cost, spent), fmtUsd(b.calls ? b.cost / b.calls : 0)])} />
          </div>
          {d.trees.length > 0 && (
            <div data-testid="drivers-trees">
              <div className="mb-1 text-caption text-faint">The dearest sessions, with their agents</div>
              <Table head={["Session", "Spend", "Agents", "Share"]} wide={[2]}
                onRow={(i) => openSession(d.trees[i]!.root)}
                rows={d.trees.map((t) => [<span className="block max-w-[11rem] truncate max-sm:max-w-[10rem]" title={t.title ?? t.root}>{t.title ?? "a removed session"}</span>, fmtUsd(t.cost), t.agents ? `${fmtUsd(t.agents_cost)} in ${t.agents}` : "none", pct(t.cost, spent)])} />
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
