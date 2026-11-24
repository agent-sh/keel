// The owner's rules for a route that is out (src/engine/route-change.ts): when the provider an agent
// runs on has been out for N minutes, or its model has answered overloaded that long, the agents of a
// type go on on a model of another provider, and finish there. Never a session of the owner's.
import { ArrowRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Rule } from "../../../src/engine/route-change.ts";
import { actions, reportError, useModels, useStore } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { Seg } from "./Seg.tsx";
import { useSettings } from "./StoragePanel.tsx";

// The types every daemon has; a definition of the owner's is typed in.
const TYPES = ["general-purpose", "Explore"];
const minutesText = (m: number) => `${m} min`;

export function RouteChange() {
  const models = useModels();
  const [settings, patch] = useSettings();
  const report = useStore((s) => s.providers);
  const labels = useStore((s) => s.providerLabels);
  const [role, setRole] = useState("");
  const [from, setFrom] = useState("");
  const [minutes, setMinutes] = useState("10");
  const [to, setTo] = useState("");
  useEffect(() => { if (!report) actions.loadProviders().catch(reportError); }, [report]);
  if (!settings) return null;
  const rules: Rule[] = settings.route_change?.rules ?? [];
  const save = (next: Rule[]) => patch({ route_change: { rules: next } }).catch(reportError);
  const providers = (report?.providers ?? []).filter((p) => p.available).map((p) => ({ id: p.id, label: p.label }));
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const label = (id: string) => labels[id] ?? providers.find((p) => p.id === id)?.label ?? id;
  const n = Number(minutes);
  const toProvider = to.slice(0, Math.max(0, to.indexOf(":")));
  const problem = !to ? "Choose the model the agents resume on." : !(n > 0) ? "Minutes must be above 0." : from && from === toProvider ? "The model must be on another provider than the one it leaves." : "";
  const add = () => {
    if (problem) return;
    save([...rules, { role: role.trim(), minutes: n, to, ...(from ? { from } : {}) }]).then(() => { setRole(""); setFrom(""); setTo(""); });
  };
  return (
    <section className="k-card rounded-lg border border-line bg-raised px-5 py-4 shadow-1" data-testid="route-change">
      <h3 className="text-base font-medium">When a route is out</h3>
      <p className="mt-0.5 text-ui text-muted">
        An agent whose provider cannot be reached waits for it, and one whose model is overloaded keeps trying. Say how long, and the agents of a type resume on a model of another provider with their context, tell their parent once, and finish there. Your own sessions always wait.
      </p>
      {rules.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {rules.map((r, i) => (
            <div key={`${r.role}|${r.from ?? ""}|${i}`} className="flex min-h-9 items-start gap-2 rounded-md border border-line bg-sunken py-1 pl-2.5 pr-1 text-ui" data-testid="route-rule">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 py-1">
                <span className="font-medium">{r.role.trim() && r.role.trim() !== "*" ? r.role : "Any agent"}</span>
                <span className="text-muted">on {r.from ? label(r.from) : "any provider"} out for</span>
                <span className="tabular-nums">{minutesText(r.minutes)}</span>
                <span className="inline-flex min-w-0 items-start gap-1.5" title={r.to}>
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 break-words">{name(r.to)}<span className="text-muted"> on {label(r.to.slice(0, r.to.indexOf(":")))}</span></span>
                </span>
              </div>
              <button type="button" className="grid size-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg" aria-label={`Remove the rule for ${r.role.trim() || "any agent"}`} onClick={() => save(rules.filter((_, k) => k !== i))}>
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form className="mt-4 flex flex-col gap-3 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); add(); }} data-testid="route-rule-form">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex flex-col gap-1 text-caption text-muted">
            Agent type
            <input className="k-field w-44" list="route-change-types" placeholder="Any agent" value={role} onChange={(e) => setRole(e.target.value)} data-testid="route-rule-role" />
            <datalist id="route-change-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted">
            Out for (minutes)
            <input className="k-field w-24 tabular-nums" inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} data-testid="route-rule-minutes" />
          </label>
          <div className="flex flex-col gap-1 text-caption text-muted">
            Resume on
            <ModelMenu value={to} placeholder="Choose a model" onChange={(id) => id && setTo(id)} />
          </div>
        </div>
        <div className="flex flex-col gap-1 text-caption text-muted">
          Only when this provider is out
          <Seg wrap label="Provider" value={from} onChange={setFrom} options={[{ value: "", label: "Any provider" }, ...providers.map((p) => ({ value: p.id, label: p.label }))]} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="k-btn k-btn-lg" disabled={!!problem} data-testid="route-rule-add">Add the rule</button>
          <span className={cn("text-caption", problem ? "text-faint" : "text-muted")} data-testid="route-rule-hint">{problem || `${role.trim() || "Any agent"} on ${from ? label(from) : "any provider"}, out for ${minutesText(n)}: ${name(to)}.`}</span>
        </div>
      </form>
    </section>
  );
}
