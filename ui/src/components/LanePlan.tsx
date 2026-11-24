// The Lane plan panel: a plan of lanes before its agents start (src/automation/lane-plans.ts). Each lane
// with the files it will touch; the pairs that meet in a file; the proposed order (waves, and lanes
// proposed as one); and one press to start the proposal, every lane, or the lanes picked. After the
// start each lane shows its agent and what its branch changed against its plan.
import { ArrowRight, Ban, Check, CircleDashed, FileWarning, GitMerge, ListChecks, Loader2, Merge, OctagonPause, Play, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { openSession } from "../lib/automation.ts";
import { dropPlan, makePlan, parseLanes, startPlan, usePlans, type LaneView, type PlanView } from "../lib/lane-plan.ts";
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { failed } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

const sha = (s: string) => s.slice(0, 9);
const n = (i: number) => i + 1;
const KIND = {
  file: { word: "same file", tone: "text-danger bg-danger-soft", hint: "Both lanes name this file: side by side they collide." },
  hub: { word: "hub file", tone: "text-warn bg-brass-soft", hint: "Both lanes name a file much of the repository's work touches: they collide there more than anywhere." },
  near: { word: "near", tone: "text-muted bg-sunken", hint: "One lane names a file the other only reaches as an importer: said, and ordered by nothing." },
} as const;
const ENDED = new Set(["completed", "incomplete", "failed", "stopped"]);

function LaneNo({ i, tone }: { i: number; tone?: "meet" | "plain" }) {
  return <span className={cn("grid size-5 shrink-0 place-items-center rounded-full font-mono text-micro font-semibold", tone === "meet" ? "bg-fg text-bg" : "bg-sunken text-fg")}>{n(i)}</span>;
}

// What a lane is now, as one short word and a tone.
function laneState(l: LaneView, plan: PlanView): { word: string; tone: string; state: string } {
  if (l.state === "waiting" && l.blocked && !l.blocked.ended) return { word: `blocked by ${n(l.blocked.lane)}`, tone: "text-danger", state: "blocked" };
  if (l.state === "waiting") return { word: `waits for ${l.waits_on.map(n).join(", ")} to land`, tone: "text-st-wait", state: "waiting" };
  if (l.state === "failed") return { word: "did not start", tone: "text-danger", state: "failed" };
  if (l.state === "planned") return { word: STATE_WORD.idle, tone: "text-faint", state: "planned" };
  const s = l.agent?.status ?? "started";
  const lead = l.merged_with.length && plan.lanes.find((x) => x.agent?.id === l.agent?.id && x.idx < l.idx);
  if (lead) return { word: `in lane ${n(lead.idx)}'s agent`, tone: "text-muted", state: "merged" };
  if (s === "running" || s === "waiting") return { word: STATE_WORD.work, tone: "text-st-work", state: "working" };
  if (s === "completed") return { word: l.agent?.landed ? `${STATE_WORD.done} · on ${plan.base}` : l.agent?.landed === false ? `${STATE_WORD.done} · not on ${plan.base} yet` : STATE_WORD.done, tone: "text-ok", state: "done" };
  return { word: s, tone: ENDED.has(s) ? "text-danger" : "text-muted", state: s };
}

function FileChip({ path, how, via, meet }: { path: string; how: string; via?: string; meet?: "file" | "hub" | "near" }) {
  return (
    <li
      className={cn("inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 font-mono text-micro", meet ? KIND[meet].tone : how === "importer" ? "text-faint" : "bg-sunken text-fg")}
      title={how === "importer" ? `imports ${via}` : how === "new" ? "a file the lane makes" : how === "declared" ? "declared by the plan" : "named by the brief"}
      data-testid="lane-file" data-how={how} data-meet={meet}
    >
      <span className="truncate">{path}</span>
      {how === "new" && <span className="font-sans text-faint">new</span>}
    </li>
  );
}

function LaneCard({ l, plan, meets, picked, pick, startNow, busy }: { l: LaneView; plan: PlanView; meets: Map<string, "file" | "hub" | "near">; picked: boolean; pick?: (on: boolean) => void; startNow?: () => void; busy: boolean }) {
  const st = laneState(l, plan);
  const strong = l.files.filter((f) => f.how !== "importer"), weak = l.files.filter((f) => f.how === "importer");
  const met = plan.meetings.some((m) => (m.a === l.idx || m.b === l.idx) && m.kind !== "near");
  return (
    <li className={cn("flex min-w-0 flex-col gap-2 rounded-lg border bg-raised p-2.5", picked ? "border-ring" : "border-line")} data-testid="lane-card" data-lane={l.idx} data-state={st.state}>
      <div className="flex min-w-0 items-center gap-2">
        {pick && <input type="checkbox" checked={picked} onChange={(e) => pick(e.target.checked)} className="size-3.5 shrink-0 accent-[var(--ring)]" aria-label={`Pick lane ${n(l.idx)}`} data-testid="lane-pick" />}
        <LaneNo i={l.idx} tone={met ? "meet" : "plain"} />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg" title={l.title}>{l.title}</span>
        <span className={cn("shrink-0 text-micro", st.tone)} data-testid="lane-state">{st.word}</span>
      </div>
      <p className="line-clamp-2 whitespace-pre-line text-caption text-muted" title={l.brief}>{l.brief}</p>
      {strong.length > 0 ? (
        <ul className="flex flex-wrap gap-1" data-testid="lane-files">
          {strong.map((f) => <FileChip key={f.path} path={f.path} how={f.how} meet={meets.get(f.path)} />)}
          {weak.slice(0, 4).map((f) => <FileChip key={f.path} path={f.path} how={f.how} via={f.via} meet={meets.get(f.path)} />)}
          {weak.length > 4 && <li className="px-1 py-0.5 text-micro text-faint">{weak.length - 4} more importers</li>}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-caption text-warn" data-testid="lane-no-files"><FileWarning className="size-3.5" aria-hidden="true" />No file known: declare its files, or it may meet any lane.</p>
      )}
      {l.unresolved.length > 0 && <p className="text-micro text-faint">Not found in the tree: <span className="font-mono">{l.unresolved.join(", ")}</span></p>}
      {(l.state === "failed" || l.blocked) && (
        <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 text-caption", l.blocked?.ended ? "bg-sunken text-muted" : "bg-danger-soft text-danger")} data-testid="lane-trouble">
          <Ban className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {l.state === "failed" ? <>Its agent did not start: {l.why}</> : <>Lane {n(l.blocked!.lane)} {l.blocked!.why}{l.blocked!.ended ? `: this lane starts once it lands` : ": this lane will not start by itself"}</>}
          </span>
          {startNow && <button type="button" className="k-btn h-6 shrink-0 px-2 text-micro" disabled={busy} onClick={startNow} data-testid="lane-start-now"><Play />Start now</button>}
        </div>
      )}
      {l.agent && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-caption">
          <button type="button" className="min-w-0 truncate text-accent-ink hover:underline" onClick={() => openSession(l.agent!.session_id)} data-testid="lane-agent">{l.agent.title}</button>
          <span className="font-mono text-micro text-faint">{l.agent.id}</span>
          {l.started && <span className="text-micro text-faint">started {ago(l.started)}</span>}
        </div>
      )}
      {l.changed && (
        <div className="flex flex-col gap-1 text-caption" data-testid="lane-changed">
          <p className="text-muted">
            Changed {l.changed.files.length} {l.changed.files.length === 1 ? "file" : "files"}: <span className="text-fg">{l.changed.hit.length} planned</span>
            {l.changed.unplanned.length > 0 && <> · <span className="text-fg">{l.changed.unplanned.length} not planned</span></>}
            {l.changed.missed.length > 0 && <> · {l.changed.missed.length} planned, not changed{l.agent && ENDED.has(l.agent.status) ? "" : " yet"}</>}
          </p>
          {l.changed.strays.map((s) => (
            <p key={s.file} className="flex min-w-0 items-center gap-1.5 rounded-md bg-danger-soft px-2 py-1 text-danger" data-testid="lane-stray">
              <FileWarning className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate"><span className="font-mono">{s.file}</span> is lane {s.lanes.map(n).join(", ")}'s</span>
              <span className="ml-auto shrink-0 text-micro">{l.told.includes(s.file) ? "told" : "not told yet"}</span>
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

// The proposal: waves left to right, each unit a chip of its lanes; a merged unit says why.
function Proposal({ plan }: { plan: PlanView }) {
  const units = plan.proposal.units;
  const waves = Array.from({ length: plan.proposal.waves }, (_, w) => units.map((u, k) => ({ u, k })).filter((x) => x.u.wave === w));
  const title = (i: number) => plan.lanes.find((l) => l.idx === i)?.title ?? "";
  return (
    <ol className="flex flex-wrap items-stretch gap-2" data-testid="plan-proposal">
      {waves.map((xs, w) => (
        <li key={w} className="flex min-w-0 max-w-full items-stretch gap-2" data-testid="plan-wave" data-wave={w}>
          {w > 0 && <ArrowRight className="size-4 shrink-0 self-center text-faint" aria-hidden="true" />}
          <div className="flex min-w-0 max-w-[32rem] flex-col gap-1.5 rounded-lg border border-line bg-raised p-2">
            <span className="k-label">{w === 0 ? "Start now" : `Then, wave ${w + 1}`}</span>
            {xs.map(({ u, k }) => (
              <div key={k} className="flex min-w-0 flex-col gap-0.5" data-testid="plan-unit" data-lanes={u.lanes.join(",")}>
                <span className="flex min-w-0 items-start gap-1.5 text-caption text-fg">
                  {u.lanes.length > 1 && <Merge className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden="true" />}
                  {u.lanes.map((i) => <LaneNo key={i} i={i} />)}
                  <span className="line-clamp-3 min-w-0 [overflow-wrap:anywhere]" title={u.lanes.map(title).join(" + ")} data-testid="plan-unit-title">{u.lanes.map(title).join(" + ")}</span>
                </span>
                {u.after.length > 0 && <span className="pl-0.5 text-micro text-muted">after {u.after.map((x) => units[x]!.lanes.map(n).join("+")).join(" and ")} {u.after.length === 1 && units[u.after[0]!]!.lanes.length === 1 ? "lands" : "land"}</span>}
                {u.why && <span className="pl-0.5 text-micro text-warn [overflow-wrap:anywhere]">as one lane: {u.why}</span>}
              </div>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Plan({ plan, session }: { plan: PlanView; session: Session }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const meets = useMemo(() => {
    const m = new Map<number, Map<string, "file" | "hub" | "near">>();
    const rank = { file: 0, hub: 1, near: 2 } as const;
    for (const x of plan.meetings) for (const i of [x.a, x.b]) {
      const at = m.get(i) ?? m.set(i, new Map()).get(i)!;
      for (const f of x.files) { const had = at.get(f); if (!had || rank[x.kind] < rank[had]) at.set(f, x.kind); }
    }
    return m;
  }, [plan.meetings]);
  const open = plan.lanes.filter((l) => l.state !== "started");
  const held = !!plan.held;
  const met = plan.meetings.filter((m) => m.kind !== "near").length;
  const fresh = plan.lanes.every((l) => l.state === "planned");
  const run = (how: "order" | "all" | number[], key: string) => {
    setBusy(key);
    setErr("");
    startPlan(session.id, plan.id, how).then((r) => { setPicked(new Set()); if (r.failed.length) setErr(r.failed.map((f) => `Lane ${n(f.idx)}: ${f.why}`).join(" · ")); }).catch((e) => setErr(failed(e, { at: "LanePlan" }))).finally(() => setBusy(""));
  };
  const drop = () => { setBusy("drop"); dropPlan(session.id, plan.id).catch((e) => setErr(failed(e, { at: "LanePlan" }))).finally(() => setBusy("")); };
  const ordered = plan.proposal.waves > 1 || plan.proposal.units.some((u) => u.lanes.length > 1);
  return (
    <section className="flex flex-col gap-3" data-testid="lane-plan" data-plan={plan.id}>
      <div className="flex flex-col gap-0.5 px-1">
        <p className="flex items-center gap-2 text-ui font-medium text-fg"><ListChecks className="size-4 text-muted" aria-hidden="true" />{plan.lanes.length} lanes</p>
        <p className="text-caption text-muted" data-testid="plan-summary">
          on <span className="font-mono">{plan.base}</span> at <span className="font-mono">{sha(plan.base_tip)}</span> · {met === 0 ? "no two lanes meet" : met === 1 ? "1 pair meets" : `${met} pairs meet`} · sent by {plan.by === "owner" ? "you" : "the session"} {ago(plan.created)}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="k-label px-1">Where lanes meet</h3>
        {plan.meetings.length === 0 ? (
          <p className="flex items-center gap-1.5 px-1 text-caption text-ok" data-testid="plan-no-meetings"><Check className="size-3.5" aria-hidden="true" />No two lanes name the same file.</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="plan-meetings">
            {plan.meetings.map((m) => (
              <li key={`${m.a}-${m.b}`} className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-raised px-2 py-1.5 text-caption" data-testid="plan-meeting" data-kind={m.kind} data-pair={`${m.a},${m.b}`} title={KIND[m.kind].hint}>
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-micro font-medium", KIND[m.kind].tone)}>{KIND[m.kind].word}</span>
                <LaneNo i={m.a} /><GitMerge className="size-3.5 shrink-0 text-faint" aria-hidden="true" /><LaneNo i={m.b} />
                <span className="min-w-0 truncate font-mono text-micro text-fg">{m.files.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="k-label px-1">Proposed order</h3>
        <Proposal plan={plan} />
      </div>

      {plan.held && open.length > 0 && (
        <p className="flex items-center gap-1.5 rounded-md bg-sunken px-2 py-1.5 text-caption text-muted" data-testid="plan-held">
          <OctagonPause className="size-3.5 shrink-0" aria-hidden="true" />Held: {plan.held}. Nothing of the plan starts until it is resumed; then the lanes that wait go on.
        </p>
      )}
      {open.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-1" data-testid="plan-actions">
          {fresh && (
            <button type="button" className="k-btn" data-ink="" disabled={!!busy || held} onClick={() => run("order", "order")} data-testid="plan-start-order">
              {busy === "order" ? <Loader2 className="animate-spin" /> : <Play />}{ordered ? "Start in proposed order" : "Start all"}
            </button>
          )}
          {fresh && ordered && <button type="button" className="k-btn" disabled={!!busy || held} onClick={() => run("all", "all")} data-testid="plan-start-all">Start all now</button>}
          <button type="button" className="k-btn" disabled={!!busy || held || !picked.size} onClick={() => run([...picked].sort((a, b) => a - b), "picked")} data-testid="plan-start-picked">
            {open.some((l) => l.state === "waiting") && !fresh ? "Start picked now" : "Start picked"}{picked.size ? ` (${picked.size})` : ""}
          </button>
          {fresh && <button type="button" className="k-btn ml-auto" data-quiet="" disabled={!!busy} onClick={drop} data-testid="plan-drop"><Trash2 />Discard</button>}
        </div>
      )}
      {err && <p className="px-1 text-caption text-danger" data-testid="plan-error">{err}</p>}

      <ul className="grid grid-cols-1 gap-2 @[44rem]:grid-cols-2 @[72rem]:grid-cols-3" data-testid="plan-lanes">
        {plan.lanes.map((l) => (
          <LaneCard key={l.idx} l={l} plan={plan} meets={meets.get(l.idx) ?? new Map()} picked={picked.has(l.idx)}
            pick={l.state === "started" ? undefined : (on) => setPicked((s) => { const x = new Set(s); if (on) x.add(l.idx); else x.delete(l.idx); return x; })}
            startNow={held ? undefined : () => run([l.idx], `lane-${l.idx}`)} busy={!!busy} />
        ))}
      </ul>
      {plan.hubs.length > 0 && <p className="px-1 text-micro text-faint" data-testid="plan-hubs">Hub files among them (much of the repository's work touches them): <span className="font-mono">{plan.hubs.join(", ")}</span></p>}
    </section>
  );
}

const EXAMPLE = "Faster search\nfiles: src/search.ts\nMake the search index incremental.\n---\nSearch filters\nAdd a filter by date to the search panel (ui/src/components/Search.tsx).";

function Composer({ session, close }: { session: Session; close?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const lanes = parseLanes(text);
  const send = () => {
    setBusy(true);
    setErr("");
    makePlan(session.id, lanes).then(() => { setText(""); close?.(); }).catch((e) => setErr(failed(e, { at: "LanePlan" }))).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-2.5" data-testid="plan-composer">
      <p className="text-caption text-muted">One lane a block, apart by a line <span className="font-mono text-fg">---</span>: its title, a line <span className="font-mono text-fg">files: a, b</span>, then its brief. Nothing starts until you press start.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} rows={8} className="k-field h-auto min-h-[10rem] resize-y py-2 font-mono text-caption" data-testid="plan-text" />
      <div className="flex items-center gap-2">
        <button type="button" className="k-btn" data-ink="" disabled={busy || lanes.length < 2} onClick={send} data-testid="plan-check">{busy ? <Loader2 className="animate-spin" /> : <ListChecks />}Check plan</button>
        <span className="text-micro text-faint">{lanes.length} {lanes.length === 1 ? "lane" : "lanes"}</span>
        {close && <button type="button" className="k-btn ml-auto" data-quiet="" onClick={close}><X />Cancel</button>}
      </div>
      {err && <p className="text-caption text-danger">{err}</p>}
    </div>
  );
}

export function LanePlan({ session }: { session: Session }) {
  const plans = usePlans(session.id);
  const [at, setAt] = useState<string | undefined>();
  const [writing, setWriting] = useState(false);
  if (!plans) return <p className="k-empty px-3 py-4">Loading…</p>;
  const plan = plans.find((p) => p.id === at) ?? plans[0];
  return (
    <div className="@container flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="lane-plans">
      {!plan && !writing && (
        <div className="k-empty px-1">
          <b>No plan of lanes yet</b>
          Before parallel agents start, a plan shows the files each lane will touch, the lanes that meet in a file, and an order that keeps them apart. A coordinator sends one with keel__lane_plan; you can write one here.
          <div className="k-empty-act"><button type="button" className="k-btn" onClick={() => setWriting(true)} data-testid="plan-new"><Plus />New plan</button></div>
        </div>
      )}
      {plans.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-1" data-testid="plan-tabs">
          {plans.map((p, k) => (
            <button key={p.id} type="button" onClick={() => setAt(p.id)} className={cn("h-6 rounded-md px-2 text-micro", p.id === plan?.id ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover")}>
              {k === 0 ? "Newest" : ago(p.created)} · {p.lanes.length} lanes
            </button>
          ))}
        </div>
      )}
      {plan && <Plan key={plan.id} plan={plan} session={session} />}
      {writing ? <Composer session={session} close={() => setWriting(false)} /> : plan && (
        <button type="button" className="k-btn self-start" data-quiet="" onClick={() => setWriting(true)} data-testid="plan-new"><Plus />New plan</button>
      )}
      {plan && <p className="flex items-center gap-1 px-1 text-micro text-faint"><CircleDashed className="size-3" aria-hidden="true" />A later lane starts by itself when the lanes it waits on have landed on {plan.base}.</p>}
    </div>
  );
}
