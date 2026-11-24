// Settings > Usage > Trials: a setting that changes what an agent costs, tried on half of the new agent
// trees (src/admin/setting-trials.ts). One group a setting: what agents do now, the offer to try the other
// value, and once a trial is on, what each arm cost a turn and a tree, how many turns and calls failed and
// how long they took, with intervals. The owner keeps the other value or drops it; a trial ends by itself
// when its sample is settled or at its time. It is an experiment (src/admin/experiments.ts), so the numbers
// are the experiments' own.
import { useCallback, useEffect, useState } from "react";
import { every } from "../lib/clock.ts";
import { fmtMetric } from "../lib/metric.ts";
import { api, reportError } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { Cell, Empty, Group, Notice, Row, Status, Table, type Col } from "./settings/kit.tsx";
import { fmtMs, fmtUsd } from "./UsagePanel.tsx";

type Interval = { estimate: number; lo: number; hi: number; n: number; method: string };
type Last = {
  id: string; state: "draft" | "running" | "stopped"; started_ms?: number; stopped_ms?: number; stop_reason?: string;
  decision?: { verdict: string; text: string }; until_ms: number | null; per_arm: number | null; choice: { kept: boolean; ts: number } | null;
  arms: { name: string; trees: number }[];
  report?: {
    arms: { arm: string; clusters: number; metrics: Record<string, Interval> }[];
    effects: { metric: string; diff: Interval & { significant: boolean }; better: boolean | null }[];
  };
};
type Item = { id: string; label: string; ask: string; now: string; other: string | null; changed: boolean; last?: Last };
type Page_ = {
  rate: { per_day: number; trees: number; days: number };
  plan: { per_arm: number; expected_days: number; until_days: number; startable: boolean; why?: string };
  metrics: Record<string, { label: string; unit: string }>;
  busy: string | null; trials: Item[];
};

const CHANGE_COLS: Col[] = [{ head: "Per turn and per tree", grow: true }, { head: "As before", end: true }, { head: "With the trial", end: true }, { head: "Change", end: true }];

// A value in its unit; a time is said as a time, not as seconds.
const say = (unit: string, v: number, signed = false) => (unit === "ms" ? `${signed && v > 0 ? "+" : v < 0 ? "-" : ""}${fmtMs(Math.abs(v))}` : unit === "usd" && !signed ? fmtUsd(v) : fmtMetric(unit, v, signed));

export function SettingTrials() {
  const [page, setPage] = useState<Page_ | null>(null);
  const load = useCallback(() => api<Page_>("/api/trials").then(setPage).catch(reportError), []);
  useEffect(() => { void load(); return every(60_000, () => void load()); }, [load]);
  if (!page) return <div className="text-ui text-faint">Reading the trials.</div>;
  const on = page.trials.find((t) => t.last?.state === "running");
  return (
    <div className="flex flex-col gap-6" data-testid="setting-trials">
      <p className="text-ui text-muted">
        Half of the new agent trees run with the other value of a setting, the rest as before, and the cost of a tree says which stays. About {Math.round(page.rate.per_day)} new
        agent trees start a day (the last {page.rate.days} days), so a trial of {page.plan.per_arm} trees an arm takes about {page.plan.expected_days} days and ends by itself at {page.plan.until_days} days at the latest.
      </p>
      {page.busy && <Notice tone="warn" testid="trial-busy">{page.busy} is on trial for all new session trees: a trial of a setting starts when it ends.</Notice>}
      {!page.plan.startable && <Notice tone="warn" testid="trial-slow">{page.plan.why}</Notice>}
      {page.trials.map((t) => <Trial key={t.id} t={t} page={page} blocked={page.busy ?? (on && on.id !== t.id ? `${on.label} is on trial` : null)} reload={() => void load()} />)}
    </div>
  );
}

function Trial({ t, page, blocked, reload }: { t: Item; page: Page_; blocked: string | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const l = t.last;
  const post = (path: string, body: unknown = {}) => {
    setBusy(true);
    setRefused("");
    return api(path, { method: "POST", body: JSON.stringify(body) }).then(reload, (e) => (e?.status === 409 ? setRefused(String(e.message)) : reportError(e))).finally(() => setBusy(false));
  };
  const open = !!l && !l.choice;       // a trial whose setting the owner has not chosen yet
  const start = !l || !!l.choice;
  const trees = l ? l.arms.reduce((n, a) => n + a.trees, 0) : 0;
  const state = l?.state === "running" ? "On trial" : l?.choice ? (l.choice.kept ? "Kept" : "Dropped") : "Trial ended";
  return (
    <Group
      testid="setting-trial" data-trial={t.id} data-state={l ? (l.choice ? (l.choice.kept ? "kept" : "dropped") : l.state) : "none"}
      title={t.label} hint={t.ask}
      actions={start ? (
        <button type="button" className="k-btn" data-ink="" disabled={busy || !!blocked || t.other === null || !page.plan.startable} data-testid="trial-start" title={blocked ?? undefined}
          onClick={() => void post("/api/trials/start", { trial: t.id })}>Try it on half of new agent trees</button>
      ) : l && open ? (
        <>
          <button type="button" className="k-btn" data-ink="" disabled={busy} data-testid="trial-keep" title={`Agents ${l.arms[1]!.name} from now on`} onClick={() => void post(`/api/trials/${l.id}/keep`)}>Keep: {l.arms[1]!.name}</button>
          <button type="button" className="k-btn" data-quiet="" disabled={busy} data-testid="trial-drop" title={`Agents go on as before: ${l.arms[0]!.name}`} onClick={() => void post(`/api/trials/${l.id}/drop`)}>Drop it</button>
        </>
      ) : undefined}
    >
      <div className="flex flex-col gap-3 py-3">
        <p className="text-ui" data-testid="trial-now">
          An agent now <span className="font-medium">{t.now}</span>.
          {t.other !== null && !l && <span className="text-muted"> The trial: half of the new trees <span className="text-fg">{t.other}</span>.</span>}
          {t.changed && <button type="button" className="k-btn ml-3" data-quiet="" disabled={busy} data-testid="trial-reset" onClick={() => void post("/api/trials/reset", { trial: t.id })}>Put back what agents did before</button>}
        </p>
        {refused && <Notice tone="warn" testid="trial-refused">{refused}</Notice>}
        {l && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui" data-testid="trial-line">
              <Status tone={l.state === "running" ? "info" : l.choice?.kept ? "ok" : "quiet"} testid="trial-state">{state}</Status>
              <span className="text-muted">
                {trees} {trees === 1 ? "tree" : "trees"}{l.per_arm ? ` of ${l.per_arm * l.arms.length} wanted` : ""} · started {ago(l.started_ms ?? 0) === "now" ? "just now" : `${ago(l.started_ms ?? 0)} ago`}
                {l.state === "running" && l.until_ms ? ` · ends by itself at ${when(l.until_ms)} at the latest` : ""}
              </span>
            </div>
            {l.decision && l.state === "stopped" && (
              <p className="text-ui" data-testid="trial-decision">
                {/the owner$/.test(l.stop_reason ?? "")
                  ? <>You ended it before its sample was whole ({trees} of {(l.per_arm ?? 0) * l.arms.length} trees). The figures below are of the trees so far.</>
                  : l.decision.text}
                {l.stop_reason ? <span className="text-faint"> ({l.stop_reason})</span> : null}
              </p>
            )}
            <Saving l={l} rate={page.rate.per_day} metrics={page.metrics} />
            <Results l={l} metrics={page.metrics} />
          </>
        )}
        {!l && <Empty testid="trial-none">No trial of this yet. Nothing starts until you press.</Empty>}
      </div>
    </Group>
  );
}

// What the cheaper arm saves at the rate trees start at, when the trial is sure of the difference.
function Saving({ l, rate, metrics }: { l: Last; rate: number; metrics: Page_["metrics"] }) {
  const f = l.report?.effects.find((e) => e.metric === "tree_cost_usd");
  if (!f?.diff.significant || f.diff.method === "none") return null;
  const unit = metrics.tree_cost_usd?.unit ?? "usd";
  const less = f.diff.estimate < 0;
  const day = (v: number) => fmtUsd(Math.abs(v) * rate);
  return (
    <p className="text-ui" data-testid="trial-saving">
      A tree costs {say(unit, Math.abs(f.diff.estimate))} {less ? "less" : "more"} with the trial (95% interval {say(unit, f.diff.lo, true)} to {say(unit, f.diff.hi, true)}):
      about {day(f.diff.estimate)} a day {less ? "less" : "more"} at {Math.round(rate)} new trees a day.
    </p>
  );
}

function Results({ l, metrics }: { l: Last; metrics: Page_["metrics"] }) {
  const r = l.report;
  const [a, b] = [r?.arms.find((x) => x.arm === l.arms[0]!.name), r?.arms.find((x) => x.arm === l.arms[1]!.name)];
  const keys = Object.keys(metrics).filter((k) => a?.metrics[k] || b?.metrics[k]);
  if (!r || !keys.length) return <Empty testid="trial-empty">No turn has ended in either arm yet.</Empty>;
  const cell = (unit: string, i?: Interval) => (!i ? <span className="text-faint">none</span> : (
    <span className="tabular-nums">{say(unit, i.estimate)}{i.method !== "none" && <span className="block text-micro text-faint">{say(unit, i.lo)} to {say(unit, i.hi)}</span>}</span>
  ));
  const cols = CHANGE_COLS.map((c, i) => (i === 1 ? { ...c, head: <>{l.arms[0]!.name} <span className="text-micro text-faint">({a?.clusters ?? 0} trees)</span></> } : i === 2 ? { ...c, head: <>{l.arms[1]!.name} <span className="text-micro text-faint">({b?.clusters ?? 0} trees)</span></> } : c));
  return (
    <Table cols={cols} testid="trial-table" label="What each arm cost and how it went">
      {keys.map((k) => {
        const unit = metrics[k]!.unit, f = r.effects.find((e) => e.metric === k);
        return (
          <Row key={k} name={metrics[k]!.label} testid="trial-row" data-metric={k}>
            <Cell col={cols[1]!}>{cell(unit, a?.metrics[k])}</Cell>
            <Cell col={cols[2]!}>{cell(unit, b?.metrics[k])}</Cell>
            <Cell col={cols[3]!} className={cn(f?.better === true && "text-ok", f?.better === false && "text-danger", f?.better == null && "text-faint")}>
              {f ? <span className="tabular-nums">{say(unit, f.diff.estimate, true)}<span className="block text-micro text-faint">{f.diff.significant ? "beyond chance" : "within chance"}</span></span> : "none"}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}
