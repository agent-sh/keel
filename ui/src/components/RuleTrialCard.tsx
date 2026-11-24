import { useEffect, useMemo, useState, type ReactNode } from "react";
import { composing } from "../lib/keys.ts";
import { api, failed, reportError } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { Cell, Disclosure, Group, Item, List, More, Notice, Page, Row as KitRow, Table, type Col } from "./settings/kit.tsx";

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
      key={`${state}:${label}`} type="button" data-testid={testid} data-state={state} onClick={onClick}
      title={state === "gone" ? "Keep it" : state === "new" ? "Take it out of the change" : "Take it away in this change"}
      className={cn("max-w-full break-all rounded-md border px-2 py-0.5 text-left font-mono text-caption transition-colors",
        state === "gone" ? "border-danger/40 text-danger line-through" : state === "new" ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg")}
    >{state === "new" ? "+ " : ""}{label}</button>
  );
  const C: Record<string, Col> = {
    calls: { head: "Calls", end: true }, allow: { head: "Allowed", end: true, minor: true }, ask: { head: "Asked", end: true, minor: true },
    refuse: { head: "Refused", end: true }, succeeded: { head: "Had succeeded", end: true, minor: true },
  };
  const table = (first: string, rows: Row[], testid: string) => (
    <Table testid={testid} label={first} cols={[{ head: first, grow: true }, C.calls!, C.allow!, C.ask!, C.refuse!, C.succeeded!]}>
      {rows.map((r) => (
        <KitRow key={r.key} name={r.key} title={r.key} testid="trial-row" data-key={r.key}>
          <Cell col={C.calls!}>{r.n}</Cell>
          <Cell col={C.allow!} className={r.allow ? "text-fg" : "text-faint"}>{r.allow}</Cell>
          <Cell col={C.ask!} className={r.ask ? "text-warn" : "text-faint"}>{r.ask}</Cell>
          <Cell col={C.refuse!} className={r.refuse ? "text-danger" : "text-faint"}>{r.refuse}</Cell>
          <Cell col={C.succeeded!}>{r.succeeded} <span className="text-faint">({pct(r.share)})</span></Cell>
        </KitRow>
      ))}
    </Table>
  );
  const r = report?.r;
  const listed = r ? (all ? r.changed.calls : r.changed.calls.slice(0, LISTED)) : [];

  const grantItem = (key: string, state: "kept" | "gone" | "new", kind: string, pattern: string, scope: string, act: ReactNode) => (
    <Item
      key={key} testid="trial-grant" data-state={state} mono
      name={<span className={cn(state === "gone" && "text-danger line-through", state === "new" && "text-accent")}>{state === "new" ? "+ " : ""}{pattern}</span>}
      sub={<>{kind} <span className="text-faint">in</span> {scope}</>}
      actions={act}
    />
  );

  return (
    <Page testid="rule-trial" className="k-after-card">
      <Group
        title="Try a rule change" pad
        hint="Change your namespaces or standing grants here, then try the change on the tool calls of the last days. Nothing changes until you save, and Save is offered for the change the replay shows. No model is called."
      >
        <div className="flex flex-col gap-5">
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
              <List testid="trial-grants" dense>
                {grants.map((x) => {
                  const gone = removeG.includes(x.id);
                  return grantItem(x.id, gone ? "gone" : "kept", x.kind, x.pattern, x.scope,
                    <button type="button" className="k-btn" data-quiet={gone ? undefined : ""} onClick={() => toggle(removeG, setRemoveG, x.id)}>{gone ? "Keep" : "Revoke"}</button>);
                })}
                {addG.map((x, i) => grantItem(`new-${i}`, "new", x.kind, x.pattern, x.scope === "/" ? "every folder" : x.scope,
                  <button type="button" className="k-btn" data-quiet="" onClick={() => setAddG(addG.filter((_, j) => j !== i))}>Take out</button>))}
              </List>
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
              type="button" data-testid="trial-save" data-ink="" onClick={() => void save()} disabled={!fresh || empty || running}
              title={empty ? "Nothing to save" : fresh ? "Save this change" : "Try this change first: Save is for the change the replay shows"}
              className="k-btn k-btn-lg ml-auto"
            >Save the change</button>
          </div>
          {note && <p className="text-caption text-muted" data-testid="trial-note">{note}</p>}
          {r && !fresh && <p className="text-caption text-warn" data-testid="trial-stale">The change was edited after this replay. Try it again to save it.</p>}
        </div>
      </Group>

      {r && (
        <Group testid="trial-result" title="What the replay shows" bare hint={!report!.tried ? undefined : (
          <span data-testid="trial-summary">
            {r.changed.n === 0
              ? <>The change treats none of the {r.calls.toLocaleString()} calls otherwise.</>
              : <>The change treats <span className="font-medium">{r.changed.n.toLocaleString()}</span> of {r.calls.toLocaleString()} calls otherwise: <span className="text-fg">{r.changed.allow} allowed</span>, <span className="text-warn">{r.changed.ask} asked about</span>, <span className="text-danger">{r.changed.refuse} refused</span>. {r.changed.succeeded} of them had run and succeeded ({pct(r.changed.share)}).</>}
          </span>
        )} className={cn(!fresh && "opacity-60")}>
          {r.partial && (
            <Notice tone="warn" testid="trial-partial">
              The replay stopped at its {Math.round(r.partial.budgetMs / 1000)} s budget after {r.partial.sessions.toLocaleString()} of {r.partial.of.toLocaleString()} sessions, the newest first. The counts below are of those; try fewer days for all of them.
            </Notice>
          )}
          {report!.tried && r.changed.n > 0 && <Group>{table("Tool", r.changed.tools, "trial-tools")}</Group>}
          {report!.tried && r.changed.n > 0 && <Group>{table("Class", r.changed.classes, "trial-classes")}</Group>}
          {report!.tried && r.changed.n > 0 && (
            <Group>
              <List testid="trial-calls" dense>
                {listed.map((c) => (
                  <Item
                    key={c.id} testid="trial-call" data-call={c.id} mono name={c.tool}
                    sub={<>
                      <span className="text-muted">{WORD[c.from]}</span> <span className="text-faint">to</span> <span className={c.to === "refuse" ? "text-danger" : c.to === "ask" ? "text-warn" : "text-fg"}>{WORD[c.to]}</span>
                      {" "}<span>{c.cls}</span> <span className="text-faint">({c.ok ? "had succeeded" : "had not run or failed"})</span>
                    </>}
                    actions={<a href={c.link} className="k-btn" onClick={(e) => { e.preventDefault(); open(c); }} data-testid="trial-call-open">Open</a>}
                  />
                ))}
                {(r.changed.calls.length > LISTED && !all) || r.changed.more ? (
                  <More>
                    {r.changed.calls.length > LISTED && !all ? <button type="button" className="text-accent hover:underline" onClick={() => setAll(true)}>Show all {r.changed.calls.length}</button> : null}
                    {r.changed.more ? ` ${r.changed.more} more are counted above and not listed.` : null}
                  </More>
                ) : null}
              </List>
            </Group>
          )}
          <Group testid="trial-agreement" pad>
            <p className="text-ui">
              The current rules, replayed, agree with how <span className="font-medium tabular-nums">{r.agreement.agreed.toLocaleString()}</span> of {r.agreement.compared.toLocaleString()} calls were decided ({pct(r.agreement.share)}).
              {r.agreement.recorded.compared ? <> Of the calls stored with the rules' own record: {r.agreement.recorded.agreed.toLocaleString()} of {r.agreement.recorded.compared.toLocaleString()}.</> : null}
              <span className="text-faint"> Replayed in {(r.ms / 1000).toFixed(1)} s.</span>
            </p>
            {r.agreement.causes.length ? (
              <Disclosure summary="Why the others differ">
                {r.agreement.causes.map((c, i) => <p key={i}><span className="tabular-nums text-fg">{c.n.toLocaleString()}</span> {WORD[c.from]} then, {WORD[c.to]} now: {c.cause}</p>)}
              </Disclosure>
            ) : null}
            <Disclosure summary="What the replay does not run">
              {r.limits.map((l, i) => <p key={i}>{l}</p>)}
            </Disclosure>
          </Group>
        </Group>
      )}
    </Page>
  );
}
