import { useEffect, useMemo, useState } from "react";
import { composing } from "../lib/keys.ts";
import { api, failed, reportError } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { Card } from "./Settings.tsx";
import { Select } from "./Select.tsx";

type Outcome = "allow" | "ask" | "refuse";
type Row = { key: string; n: number; allow: number; ask: number; refuse: number; succeeded: number; share: number | null };
type Changed = { id: string; session: string; event: string; tool: string; cls: string; from: Outcome; to: Outcome; ok: boolean; link: string };
type Cause = { cause: string; n: number; from: Outcome; to: Outcome };
type Report = {
  days: number; calls: number; ms: number;
  changed: { n: number; allow: number; ask: number; refuse: number; succeeded: number; share: number | null; tools: Row[]; classes: Row[]; calls: Changed[]; more: number };
  agreement: { compared: number; agreed: number; share: number | null; recorded: { compared: number; agreed: number }; before: Record<string, number>; causes: Cause[] };
  limits: string[];
  // Stopped at its time budget: the counts are of the newest `sessions` of `of`.
  partial?: { budgetMs: number; sessions: number; of: number };
};
type Grant = { id: string; kind: "shell" | "edit" | "tool"; pattern: string; scope: string; lifetime: string };
type GrantAdd = { kind: Grant["kind"]; pattern: string; scope: string };
type Change = { namespaces?: { add?: string[]; remove?: string[] }; grants?: { add?: GrantAdd[]; remove?: string[] } };

const WORD: Record<Outcome, string> = { allow: "allowed", ask: "asked about", refuse: "refused" };
const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
const LISTED = 12;

// The change as the server reads it: only what is set.
function changeOf(addNs: string[], removeNs: string[], addG: GrantAdd[], removeG: string[]): Change {
  const c: Change = {};
  if (addNs.length || removeNs.length) c.namespaces = { ...(addNs.length ? { add: addNs } : {}), ...(removeNs.length ? { remove: removeNs } : {}) };
  if (addG.length || removeG.length) c.grants = { ...(addG.length ? { add: addG } : {}), ...(removeG.length ? { remove: removeG } : {}) };
  return c;
}

// Settings > Safety > Try a rule change: an edit of the owner's own rules (his namespaces, his standing grants) is
// replayed over the stored calls of the last days before it is saved (src/safety/trial.ts). Save is offered for
// the edit the shown replay is of, and for no other.
export function RuleTrialCard() {
  const [names, setNames] = useState<string[] | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [addNs, setAddNs] = useState<string[]>([]);
  const [removeNs, setRemoveNs] = useState<string[]>([]);
  const [addG, setAddG] = useState<GrantAdd[]>([]);
  const [removeG, setRemoveG] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [g, setG] = useState<GrantAdd>({ kind: "shell", pattern: "", scope: "/" });
  const [days, setDays] = useState("7");
  const [report, setReport] = useState<{ key: string; r: Report; tried: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const [all, setAll] = useState(false);
  const load = () => Promise.all([
    api<{ settings: { accounts?: { namespaces?: string[] } } }>("/api/settings").then((r) => setNames(r.settings.accounts?.namespaces ?? [])),
    api<{ grants: Grant[] }>("/api/permissions/grants").then((r) => setGrants(r.grants.filter((x) => x.lifetime === "always"))),
  ]).catch(reportError);
  useEffect(() => { void load(); }, []);
  const change = useMemo(() => changeOf(addNs, removeNs, addG, removeG), [addNs, removeNs, addG, removeG]);
  const key = JSON.stringify([change, days]);
  const empty = !Object.keys(change).length;
  const fresh = report?.key === key;
  if (!names) return null;

  const toggle = (list: string[], set: (x: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addName = () => { const v = typed.trim(); if (v && !names.includes(v) && !addNs.includes(v)) setAddNs([...addNs, v]); setTyped(""); };
  const addGrant = () => { if (!g.pattern.trim() || !g.scope.trim().startsWith("/")) return; setAddG([...addG, { ...g, pattern: g.pattern.trim(), scope: g.scope.trim() }]); setG({ ...g, pattern: "" }); };
  const run = () => {
    setRunning(true); setNote("");
    api<Report>("/api/safety/trial", { method: "POST", body: JSON.stringify({ days: Number(days), ...(empty ? {} : { change }) }) })
      .then((r) => { setReport({ key, r, tried: !empty }); setAll(false); })
      .catch((e) => setNote(failed(e, { at: "RuleTrialCard" })))
      .finally(() => setRunning(false));
  };
  const save = () => api("/api/safety/trial/save", { method: "POST", body: JSON.stringify({ change }) })
    .then(() => { setAddNs([]); setRemoveNs([]); setAddG([]); setRemoveG([]); setReport(null); setNote("Saved."); return load(); })
    .catch((e) => setNote(failed(e, { at: "RuleTrialCard" })));
  const open = (c: Changed) => { setUI({ focusEvent: c.event }); navigate({ name: "session", id: c.session }); };

  const chip = (label: string, state: "kept" | "gone" | "new", onClick: () => void, testid: string) => (
    <button
      type="button" data-testid={testid} data-state={state} onClick={onClick}
      title={state === "gone" ? "Keep it" : state === "new" ? "Take it out of the change" : "Take it away in this change"}
      className={cn("max-w-full break-all rounded-md border px-2 py-0.5 text-left font-mono text-caption transition-colors",
        state === "gone" ? "border-danger/40 text-danger line-through" : state === "new" ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg")}
    >{state === "new" ? "+ " : ""}{label}</button>
  );
  const th = "px-2 py-1.5 font-normal", td = "px-2 py-1.5 tabular-nums text-right max-md:p-0 max-md:text-left";
  // (On a phone each count carries its own heading: the table's head row is not drawn.)
  const lab = (w: string) => <span className="block text-micro text-faint md:hidden" aria-hidden="true">{w}</span>;
  const table = (first: string, rows: Row[], testid: string) => (
    <table className="w-full table-fixed text-ui max-md:block" data-testid={testid}>
      <colgroup className="max-md:hidden"><col /><col className="w-20" /><col className="w-20" /><col className="w-20" /><col className="w-20" /><col className="w-32" /></colgroup>
      <thead className="max-md:hidden">
        <tr className="border-b border-line text-left text-caption text-faint">
          <th className={th}>{first}</th><th className={`${th} text-right`}>Calls</th><th className={`${th} text-right`}>Allowed</th>
          <th className={`${th} text-right`}>Asked</th><th className={`${th} text-right`}>Refused</th><th className={`${th} text-right`}>Had succeeded</th>
        </tr>
      </thead>
      <tbody className="max-md:block">
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-line/60 last:border-0 max-md:grid max-md:grid-cols-[1fr_1fr_1fr_1fr_1.6fr] max-md:gap-x-2 max-md:px-2 max-md:py-1.5" data-testid="trial-row" data-key={r.key}>
            <td className="truncate px-2 py-1.5 font-medium max-md:col-span-5 max-md:whitespace-normal max-md:break-words max-md:p-0 max-md:pb-1">{r.key}</td>
            <td className={td}>{lab("Calls")}{r.n}</td>
            <td className={cn(td, r.allow ? "text-fg" : "text-faint")}>{lab("Allowed")}{r.allow}</td>
            <td className={cn(td, r.ask ? "text-warn" : "text-faint")}>{lab("Asked")}{r.ask}</td>
            <td className={cn(td, r.refuse ? "text-danger" : "text-faint")}>{lab("Refused")}{r.refuse}</td>
            <td className={td}>{lab("Had succeeded")}{r.succeeded} <span className="text-faint">({pct(r.share)})</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const r = report?.r;
  const listed = r ? (all ? r.changed.calls : r.changed.calls.slice(0, LISTED)) : [];

  return (
    <div className="k-after-card flex flex-col gap-2" data-testid="rule-trial">
      <h3 className="px-1 text-ui font-medium text-muted">Try a rule change</h3>
      <Card>
        <div className="flex flex-col gap-5 py-4">
          <p className="text-ui text-muted">Change your namespaces or standing grants here, then try the change on the tool calls of the last days. Nothing changes until you save, and Save is offered for the change the replay shows. No model is called.</p>

          <section className="flex flex-col gap-2">
            <div className="text-base font-medium">Your namespaces</div>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="trial-namespaces">
              {names.map((n) => chip(n, removeNs.includes(n) ? "gone" : "kept", () => toggle(removeNs, setRemoveNs, n), "trial-namespace"))}
              {addNs.map((n) => chip(n, "new", () => setAddNs(addNs.filter((x) => x !== n)), "trial-namespace"))}
              {!names.length && !addNs.length && <span className="text-caption text-faint">None named yet.</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                data-testid="trial-namespace-input" value={typed} placeholder="github.com/you" spellCheck={false} className="k-field w-56 max-md:w-full"
                onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) addName(); }}
              />
              <button type="button" className="k-btn k-btn-lg" disabled={!typed.trim()} onClick={addName} data-testid="trial-namespace-add">Add to the change</button>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="text-base font-medium">Standing grants</div>
            {grants.length || addG.length ? (
              <ul className="flex flex-col gap-1" data-testid="trial-grants">
                {grants.map((x) => {
                  const gone = removeG.includes(x.id);
                  return (
                    <li key={x.id} className="flex items-center gap-3 text-ui max-md:flex-wrap max-md:gap-y-0" data-testid="trial-grant" data-state={gone ? "gone" : "kept"}>
                      <span className="w-12 shrink-0 text-caption text-faint">{x.kind}</span>
                      <span className={cn("min-w-0 flex-1 truncate font-mono max-md:basis-[calc(100%-4rem)] max-md:whitespace-normal max-md:break-all", gone && "text-danger line-through")}>{x.pattern}</span>
                      <span className="min-w-0 max-w-[40%] truncate text-caption text-faint max-md:max-w-none max-md:flex-1 max-md:whitespace-normal max-md:break-all">{x.scope}</span>
                      <button type="button" className={cn("text-caption", gone ? "text-fg" : "text-faint hover:text-danger")} onClick={() => toggle(removeG, setRemoveG, x.id)}>{gone ? "Keep" : "Revoke"}</button>
                    </li>
                  );
                })}
                {addG.map((x, i) => (
                  <li key={`new-${i}`} className="flex items-center gap-3 text-ui max-md:flex-wrap max-md:gap-y-0" data-testid="trial-grant" data-state="new">
                    <span className="w-12 shrink-0 text-caption text-accent">{x.kind}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-accent max-md:basis-[calc(100%-4rem)] max-md:whitespace-normal max-md:break-all">+ {x.pattern}</span>
                    <span className="min-w-0 max-w-[40%] truncate text-caption text-faint max-md:max-w-none max-md:flex-1 max-md:whitespace-normal max-md:break-all">{x.scope === "/" ? "every folder" : x.scope}</span>
                    <button type="button" className="text-caption text-faint hover:text-fg" onClick={() => setAddG(addG.filter((_, j) => j !== i))}>Take out</button>
                  </li>
                ))}
              </ul>
            ) : <span className="text-caption text-faint">No standing grants.</span>}
            <div className="flex flex-wrap items-center gap-2">
              <Select data-testid="trial-grant-kind" value={g.kind} onChange={(e) => setG({ ...g, kind: e.target.value as Grant["kind"] })} className="w-24">
                <option value="shell">shell</option><option value="edit">edit</option><option value="tool">tool</option>
              </Select>
              <input data-testid="trial-grant-pattern" value={g.pattern} placeholder={g.kind === "shell" ? "make test" : g.kind === "edit" ? "/path/to/folder" : "tool name"} spellCheck={false} className="k-field w-56 max-md:w-full font-mono"
                onChange={(e) => setG({ ...g, pattern: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) addGrant(); }} />
              <input data-testid="trial-grant-scope" value={g.scope} placeholder="/ for every folder" spellCheck={false} className="k-field w-48 max-md:w-full font-mono" onChange={(e) => setG({ ...g, scope: e.target.value })} />
              <button type="button" className="k-btn k-btn-lg" disabled={!g.pattern.trim() || !g.scope.trim().startsWith("/")} onClick={addGrant} data-testid="trial-grant-add">Add to the change</button>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <span className="text-ui text-muted">Replay the last</span>
            <Select data-testid="trial-days" value={days} onChange={(e) => setDays(e.target.value)} className="w-28">
              {["1", "3", "7"].map((d) => <option key={d} value={d}>{d === "1" ? "1 day" : `${d} days`}</option>)}
            </Select>
            <button type="button" className="k-btn k-btn-lg" onClick={run} disabled={running} data-testid="trial-run">{running ? "Replaying..." : empty ? "Replay the current rules" : "Try the change"}</button>
            <button
              type="button" data-testid="trial-save" onClick={() => void save()} disabled={!fresh || empty || running}
              title={empty ? "Nothing to save" : fresh ? "Save this change" : "Try this change first: Save is for the change the replay shows"}
              className="ml-auto h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >Save the change</button>
          </div>
          {note && <p className="text-caption text-muted" data-testid="trial-note">{note}</p>}
          {r && !fresh && <p className="text-caption text-warn" data-testid="trial-stale">The change was edited after this replay. Try it again to save it.</p>}

          {r && (
            <div className={cn("flex flex-col gap-4", !fresh && "opacity-60")} data-testid="trial-result">
              {r.partial && (
                <p className="text-caption text-warn" data-testid="trial-partial">
                  The replay stopped at its {Math.round(r.partial.budgetMs / 1000)} s budget after {r.partial.sessions.toLocaleString()} of {r.partial.of.toLocaleString()} sessions, the newest first. The counts below are of those; try fewer days for all of them.
                </p>
              )}
              {!report!.tried ? null : (
                <div className="flex flex-col gap-3">
                  <p className="text-base" data-testid="trial-summary">
                    {r.changed.n === 0
                      ? <>The change treats none of the {r.calls.toLocaleString()} calls otherwise.</>
                      : <>The change treats <span className="font-medium">{r.changed.n.toLocaleString()}</span> of {r.calls.toLocaleString()} calls otherwise: <span className="text-fg">{r.changed.allow} allowed</span>, <span className="text-warn">{r.changed.ask} asked about</span>, <span className="text-danger">{r.changed.refuse} refused</span>. {r.changed.succeeded} of them had run and succeeded ({pct(r.changed.share)}).</>}
                  </p>
                  {r.changed.n > 0 && table("Tool", r.changed.tools, "trial-tools")}
                  {r.changed.n > 0 && table("Class", r.changed.classes, "trial-classes")}
                  {r.changed.n > 0 && (
                    <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="trial-calls">
                      {listed.map((c) => (
                        <li key={c.id} className="flex items-center gap-3 px-3 py-1.5 text-ui max-md:flex-wrap max-md:gap-y-0.5" data-testid="trial-call" data-call={c.id}>
                          <span className="w-40 shrink-0 truncate font-mono text-caption max-md:w-auto max-md:whitespace-normal max-md:break-all">{c.tool}</span>
                          <span className="shrink-0 text-caption"><span className="text-muted">{WORD[c.from]}</span> <span className="text-faint">to</span> <span className={c.to === "refuse" ? "text-danger" : c.to === "ask" ? "text-warn" : "text-fg"}>{WORD[c.to]}</span></span>
                          <span className="min-w-0 flex-1 truncate text-caption text-faint max-md:basis-full max-md:whitespace-normal max-md:break-words">{c.cls}</span>
                          <span className={cn("shrink-0 text-caption", c.ok ? "text-muted" : "text-faint")}>{c.ok ? "had succeeded" : "had not run or failed"}</span>
                          <a href={c.link} className="shrink-0 text-caption text-accent hover:underline" onClick={(e) => { e.preventDefault(); open(c); }} data-testid="trial-call-open">Open</a>
                        </li>
                      ))}
                      {(r.changed.calls.length > LISTED && !all) || r.changed.more ? (
                        <li className="px-3 py-1.5 text-caption text-faint">
                          {r.changed.calls.length > LISTED && !all ? <button type="button" className="text-accent hover:underline" onClick={() => setAll(true)}>Show all {r.changed.calls.length}</button> : null}
                          {r.changed.more ? ` ${r.changed.more} more are counted above and not listed.` : null}
                        </li>
                      ) : null}
                    </ul>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-1.5 rounded-md bg-sunken px-3 py-2.5" data-testid="trial-agreement">
                <p className="text-ui">
                  The current rules, replayed, agree with how <span className="font-medium tabular-nums">{r.agreement.agreed.toLocaleString()}</span> of {r.agreement.compared.toLocaleString()} calls were decided ({pct(r.agreement.share)}).
                  {r.agreement.recorded.compared ? <> Of the calls stored with the rules' own record: {r.agreement.recorded.agreed.toLocaleString()} of {r.agreement.recorded.compared.toLocaleString()}.</> : null}
                  <span className="text-faint"> Replayed in {(r.ms / 1000).toFixed(1)} s.</span>
                </p>
                {r.agreement.causes.length ? (
                  <details className="text-caption text-muted">
                    <summary className="cursor-pointer select-none text-faint hover:text-fg">Why the others differ</summary>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {r.agreement.causes.map((c, i) => <li key={i}><span className="tabular-nums text-fg">{c.n.toLocaleString()}</span> {WORD[c.from]} then, {WORD[c.to]} now: {c.cause}</li>)}
                    </ul>
                  </details>
                ) : null}
                <details className="text-caption text-muted">
                  <summary className="cursor-pointer select-none text-faint hover:text-fg">What the replay does not run</summary>
                  <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4">{r.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
                </details>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
