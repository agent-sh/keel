// A model its provider listed for the first time: one card with what the listing and the catalog say of
// it, an offer to try it, and, once the owner pressed, the trial and its result. Settings > Models shows
// the cards; the home shows one line that leads there (src/server/routes/model-trials.ts).
//
// A trial is an experiment (src/admin/experiments.ts): half of the new session trees try the model in
// the role the owner picks, the other half run as before. It starts on the press and ends on a press or
// by its own rule, and the card shows what it measured, per arm, with intervals.
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { every } from "../lib/clock.ts";
import { api, reportError } from "../lib/store.ts";
import { fmtMetric } from "../lib/metric.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, fmtTokens } from "../lib/utils.ts";
import { Seg } from "./Seg.tsx";

type Interval = { estimate: number; lo: number; hi: number; n: number; method: string };
type Role = "reader" | "small" | "builder";
type Trial = {
  id: string; role: Role; state: "draft" | "running" | "stopped"; started_ms?: number; stopped_ms?: number; stop_reason?: string;
  decision?: { verdict: string; text: string }; sessions: { arm: string; n: number }[]; per_arm: number | null; arms: string[];
  report?: {
    arms: { arm: string; clusters: number; units: number; metrics: Record<string, Interval> }[];
    effects: { metric: string; diff: Interval & { significant: boolean }; better: boolean | null }[];
  };
};
type Listed = {
  id: string; provider: string; model: string; name: string; context: number; output: number; efforts: string[];
  price?: { input: number; output: number }; billing: string; first_seen: number; trial?: Trial;
  refused?: Partial<Record<Role, string>>; unlisted?: boolean;
};
type Page = { roles: Role[]; metrics: Record<string, { label: string; unit: string }>; models: Listed[] };

export const ROLE_LABEL: Record<Role, string> = { reader: "Reader", small: "Small model", builder: "Builder" };
// What the model does in each role, for "Half of the new session trees would use it to ...".
const ROLE_DOES: Record<Role, string> = {
  reader: "read the long material handed to readers, ahead of the small models",
  small: "write titles and other small requests, ahead of the small models",
  builder: "run the agents they start, where no model is named",
};

// The new models, read now and then while the page is shown.
export function useNewModels(brief: boolean, ms: number) {
  const [page, setPage] = useState<Page | null>(null);
  const load = useCallback(() => api<Page>(`/api/models/new${brief ? "?brief" : ""}`).then(setPage).catch(reportError), [brief]);
  useEffect(() => { void load(); return every(ms, () => void load()); }, [load, ms]);
  return { page, load };
}

const price = (m: Listed) => (m.price ? `$${m.price.input} in, $${m.price.output} out per million tokens` : m.billing === "subscription" ? "on a plan" : "no price listed");

// The home's line: a new model is there, and where to look at it.
export function NewModelNews() {
  const { page } = useNewModels(true, 60_000);
  const n = page?.models.length ?? 0;
  if (!n) return null;
  const first = page!.models[0]!;
  return (
    <button type="button" data-testid="new-model-news" onClick={() => navigate({ name: "settings", section: "models" })}
      className="mt-2 flex max-w-full items-center gap-2 rounded-md px-2 py-1 text-left text-caption text-muted hover:bg-hover hover:text-fg">
      <Sparkles className="size-3.5 shrink-0 text-accent" />
      <span className="min-w-0 truncate">{n === 1 ? <><b className="font-medium text-fg">{first.name}</b> is new on {first.provider}</> : `${n} new models: ${first.name} and ${n - 1} more`}. Try it.</span>
    </button>
  );
}

// Settings > Models: a card for each new model.
export function NewModelCards() {
  const { page, load } = useNewModels(false, 5_000);
  if (!page?.models.length) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="new-models">
      {page.models.map((m) => <NewModelCard key={m.id} m={m} roles={page.roles} metrics={page.metrics} reload={() => void load()} />)}
    </div>
  );
}

function NewModelCard({ m, roles, metrics, reload }: { m: Listed; roles: Role[]; metrics: Page["metrics"]; reload: () => void }) {
  const no = m.refused ?? {};
  const [chosen, setRole] = useState<Role>(roles.find((r) => !no[r]) ?? roles[0] ?? "reader");
  const role = no[chosen] ? roles.find((r) => !no[r]) ?? chosen : chosen;
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const t = m.trial;
  const post = (path: string, body: unknown) => {
    setBusy(true);
    setRefused("");
    return api(path, { method: "POST", body: JSON.stringify(body) }).then(reload, (e) => (e?.status === 409 ? setRefused(String(e.message)) : reportError(e))).finally(() => setBusy(false));
  };
  const families = t ? t.sessions.reduce((n, s) => n + s.n, 0) : 0;
  return (
    <section data-testid="new-model" data-model={m.id} data-trial={t?.state ?? "none"} className="rounded-lg border border-line bg-raised p-4 shadow-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded-xs bg-accent-soft px-1.5 text-micro font-medium uppercase tracking-wide text-accent-ink">New</span>
        <h3 className="min-w-0 truncate text-base font-medium" data-testid="new-model-name">{m.name}</h3>
        <span className="text-caption text-faint">{m.provider} · {m.unlisted ? "no longer in its listing" : `listed ${ago(m.first_seen) === "now" ? "just now" : `${ago(m.first_seen)} ago`}`}</span>
      </div>
      <p className="mt-1 text-caption text-muted" data-testid="new-model-facts">
        {m.context ? `${fmtTokens(m.context)} context` : "context unknown"}
        {m.output ? `, ${fmtTokens(m.output)} output` : ""} · {price(m)} · {m.efforts.length ? `efforts ${m.efforts.join(", ")}` : "no efforts listed"}
      </p>

      {(!t || t.state !== "running") && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="new-model-offer">
          <span className="text-ui text-muted">{t ? "Try it again as" : "Try it as"}</span>
          <Seg label={`Role ${m.name} is tried in`} value={role} onChange={setRole} testid="new-model-role" title={ROLE_DOES[role]}
            options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r], title: no[r] ?? ROLE_DOES[r], testid: `new-model-role-${r}`, disabled: !!no[r] }))} />
          <button type="button" className="k-btn" data-ink disabled={busy || !!no[role]} data-testid="new-model-trial" onClick={() => void post("/api/models/new/trial", { model: m.id, role })}>Start a trial</button>
          <button type="button" className="k-btn" data-quiet disabled={busy} data-testid="new-model-dismiss" onClick={() => void post("/api/models/new/dismiss", { model: m.id })}>Dismiss</button>
        </div>
      )}
      {Object.values(no).map((why) => <p key={why} className="mt-2 text-caption text-faint" data-testid="new-model-role-off">{why}.</p>)}
      {!t && <p className="mt-2 text-caption text-faint">Half of the new session trees would use it to {ROLE_DOES[role]}. Nothing starts until you press.</p>}
      {refused && <p role="alert" className="mt-2 text-caption text-danger" data-testid="new-model-refused">{refused}</p>}

      {t && (
        <div className="mt-3 border-t border-line pt-3" data-testid="new-model-result">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
            <span data-testid="new-model-state" className={cn("rounded-sm px-1.5 py-0.5 text-micro font-medium uppercase tracking-wide", t.state === "running" ? "bg-accent-soft text-accent" : "bg-sunken text-faint")}>{t.state === "running" ? "On trial" : "Trial ended"}</span>
            <span className="text-muted">as {ROLE_LABEL[t.role].toLowerCase()} · {families} session {families === 1 ? "tree" : "trees"}{t.per_arm ? ` of ${t.per_arm * t.arms.length}` : ""} · {ago(t.started_ms ?? 0) === "now" ? "started now" : `started ${ago(t.started_ms ?? 0)} ago`}</span>
            {t.state === "running" && <button type="button" className="k-btn ml-auto" disabled={busy} data-testid="new-model-stop" onClick={() => void api(`/api/experiments/${t.id}/stop`, { method: "POST", body: "{}" }).then(reload).catch(reportError)}>Stop the trial</button>}
          </div>
          {t.state === "stopped" && t.decision && <p className="mt-1.5 text-ui" data-testid="new-model-decision">{t.decision.text}{t.stop_reason ? <span className="text-faint"> ({t.stop_reason})</span> : null}</p>}
          {t.report && <Results t={t} metrics={metrics} />}
        </div>
      )}
    </section>
  );
}

function Results({ t, metrics }: { t: Trial; metrics: Page["metrics"] }) {
  const [a, b] = t.report!.arms.length ? [t.report!.arms.find((x) => x.arm === t.arms[0]), t.report!.arms.find((x) => x.arm === t.arms[1])] : [];
  const rows = Object.keys(metrics).filter((k) => a?.metrics[k] || b?.metrics[k]);
  if (!rows.length) return <p className="mt-2 text-caption text-faint" data-testid="new-model-empty">No turn has ended in either arm yet.</p>;
  const cell = (unit: string, i?: Interval) => (!i ? <span className="text-faint">none</span> : <span className="tabular-nums">{fmtMetric(unit, i.estimate)}<span className="block text-micro text-faint">{i.method !== "none" ? `${fmtMetric(unit, i.lo)} to ${fmtMetric(unit, i.hi)}` : `${i.n} ${i.n === 1 ? "turn" : "turns"}`}</span></span>);
  return (
    <div className="mt-2 overflow-x-auto" data-testid="new-model-table">
      <table className="w-full min-w-[30rem] text-ui">
        <thead>
          <tr className="text-left text-caption text-faint">
            <th className="py-1 pr-3 font-normal">Per turn</th>
            <th className="px-3 py-1 font-normal">As before <span className="text-micro">({a?.clusters ?? 0} {a?.clusters === 1 ? "tree" : "trees"})</span></th>
            <th className="px-3 py-1 font-normal">With it <span className="text-micro">({b?.clusters ?? 0} {b?.clusters === 1 ? "tree" : "trees"})</span></th>
            <th className="py-1 pl-3 font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => {
            const unit = metrics[k]!.unit, f = t.report!.effects.find((e) => e.metric === k);
            return (
              <tr key={k} className="border-t border-line/60 align-top" data-testid={`new-model-row-${k}`}>
                <td className="py-1.5 pr-3 text-muted">{metrics[k]!.label}</td>
                <td className="px-3 py-1.5">{cell(unit, a?.metrics[k])}</td>
                <td className="px-3 py-1.5">{cell(unit, b?.metrics[k])}</td>
                <td className={cn("py-1.5 pl-3 tabular-nums", f?.better === true && "text-ok", f?.better === false && "text-danger", f?.better == null && "text-faint")}>
                  {f ? fmtMetric(unit, f.diff.estimate, true) : "none"}
                  <span className="block text-micro text-faint">{f ? (f.diff.significant ? "beyond chance" : "within chance") : ""}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
