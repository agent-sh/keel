// The tree review: the branches a session's agents left, read as one diff by area (src/board/tree-review.ts).
// Each hunk names its agent, branch, review verdict and checks (the work board's facts); hunks of two
// branches that change the same lines show side by side under what git's merge of the two says. Per area
// the owner lands it through the landing queue in the order proposed from the overlaps, sends it back to
// its agents with a note, or drops it.
import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeft, ArrowRight, Check, CornerUpLeft, GitMerge, Loader2, RefreshCw, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { useTreeMark } from "../lib/board.ts";
import { usePhoneWidth } from "../lib/list-hold.ts";
import { failed, onFeature, reportUnlessGone, scope } from "../lib/store.ts";
import { decide, laneOf, readArea, readTree, wouldConflict, type AreaDetail, type AreaHunk, type Decision, type TreeArea, type TreeBranch, type TreeOverlap, type TreeView } from "../lib/tree-review.ts";
import { ago, cn } from "../lib/utils.ts";
import { PicturesArea } from "./Pictures.tsx";
import { confirmAction } from "./Confirm.tsx";

const short = (b: string) => b.replace(/^keel\//, "");
const sha = (s: string | null | undefined) => (s ? s.slice(0, 9) : "?");
const where = (k: string) => (k === "." ? "top level" : k);
// Names in a line: past this many, the first ones and how many more (the whole list on hover).
const NAMES = 5;
// Lane dots of one area's row: past this many, a count, so the row's counts stay on one line.
const DOTS = 6;

type Lanes = Map<string, number>;
const Dot = ({ i, className }: { i: number; className?: string }) => (
  <span aria-hidden="true" className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: laneOf(i) }} />
);

const VERDICT: Record<string, { word: string; cls: string }> = {
  approved: { word: "approved", cls: "text-ok" },
  refused: { word: "refused", cls: "text-danger" },
  disputed: { word: "disputed", cls: "text-danger" },
  stale: { word: "review stale", cls: "text-warn" },
  words: { word: "words only", cls: "text-warn" },
  unclear: { word: "unclear", cls: "text-warn" },
  pending: { word: "in review", cls: "text-st-work" },
};
const verdictOf = (b: TreeBranch) => (b.verdict ? VERDICT[b.verdict] ?? { word: b.verdict, cls: "text-muted" } : { word: "no review", cls: "text-faint" });

function checksOf(b: TreeBranch): { word: string; cls: string } {
  const c = b.checks;
  if (!c || c.state === "none") return { word: "no checks named", cls: "text-faint" };
  if (c.state === "unknown") return { word: "checks unknown", cls: "text-faint" };
  if (c.failed.length) return { word: `check failed: ${c.failed.join(", ")}`, cls: "text-danger" };
  if (c.notRun.length && !c.passed.length) return { word: `not run: ${c.notRun.join(", ")}`, cls: "text-muted" };
  return { word: `passed: ${c.passed.join(", ")}${c.notRun.length ? `; not run: ${c.notRun.join(", ")}` : ""}`, cls: c.notRun.length ? "text-muted" : "text-ok" };
}

// Who a hunk is: the branch's mark and name, its agent, its verdict and its checks.
function Who({ b, lanes }: { b: TreeBranch; lanes: Lanes }) {
  const v = verdictOf(b), c = checksOf(b);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption" data-testid="tree-who" data-branch={b.branch} data-verdict={b.verdict ?? "none"}>
      <Dot i={lanes.get(b.branch) ?? 0} />
      <span className="font-mono text-fg">{short(b.branch)}</span>
      <span className="min-w-0 max-w-[16rem] truncate text-muted max-md:max-w-full max-md:whitespace-normal" title={`${b.title} (agent ${b.agent})`}>{b.title}</span>
      <span className={cn("text-micro font-medium", v.cls)} data-testid="tree-verdict">{v.word}</span>
      <span className={cn("text-micro", c.cls)} data-testid="tree-checks">{c.word}</span>
      {b.working && <span className="text-micro text-st-work">working</span>}
    </div>
  );
}

// One hunk's lines with their numbers on both sides.
function Hunk({ h }: { h: AreaHunk }) {
  let o = h.old, n = h.new;
  const rows = h.lines.filter((l) => !l.startsWith("\\")).map((l) => {
    const k = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
    const row = { k, text: l.slice(1), old: k === "add" ? undefined : o, new: k === "del" ? undefined : n };
    if (k !== "add") o++;
    if (k !== "del") n++;
    return row;
  });
  const digits = Math.max(2, String(Math.max(o, n)).length);
  return (
    <div className="overflow-x-auto">
      <table className="k-diff-body w-full border-collapse font-mono text-micro leading-5" style={{ "--k-diff-digits": digits } as CSSProperties}>
        <tbody>
          <tr className="k-diff-line" data-kind="hunk"><td colSpan={3} className="px-2 py-0.5">{h.head}</td></tr>
          {rows.map((r, i) => (
            <tr key={i} className="k-diff-line" data-kind={r.k}>
              <td className="k-diff-no select-none text-faint">{r.old ?? ""}</td>
              <td className="k-diff-no select-none text-faint">{r.new ?? ""}</td>
              <td className="whitespace-pre pr-3 text-fg"><span className="select-none text-faint">{r.k === "add" ? "+" : r.k === "del" ? "-" : " "}</span>{r.text}</td>
            </tr>
          ))}
          {h.more > 0 && <tr><td colSpan={3} className="px-2 py-0.5 font-sans text-faint">{h.more} more lines of this hunk are not shown</td></tr>}
          {!h.lines.length && <tr><td colSpan={3} className="px-2 py-0.5 font-sans text-faint">Past what the review keeps of this branch: its lines are counted, not shown.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function File({ f, view, lanes }: { f: AreaDetail["files"][number]; view: TreeView; lanes: Lanes }) {
  const byBranch = new Map(view.branches.map((b) => [b.branch, b]));
  const ovs = new Map(view.overlaps.map((o) => [o.id, o]));
  const counts = view.areas.flatMap((a) => a.files).find((x) => x.path === f.path)?.branches ?? [];
  // Blocks in the base's order: an overlap's hunks side by side, every other hunk alone.
  const blocks: ({ kind: "one"; h: AreaHunk } | { kind: "overlap"; ov: TreeOverlap; hs: AreaHunk[] })[] = [];
  const seen = new Set<string>();
  for (const h of f.hunks) {
    // (An area's hunks read before the view moved may name an overlap the view no longer has: alone, then.)
    const ov = h.overlap ? ovs.get(h.overlap) : undefined;
    if (!ov) { blocks.push({ kind: "one", h }); continue; }
    if (seen.has(ov.id)) continue;
    seen.add(ov.id);
    blocks.push({ kind: "overlap", ov, hs: f.hunks.filter((x) => x.overlap === ov.id) });
  }
  return (
    <section className="k-diff-file" data-testid="tree-file" data-path={f.path}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sunken px-3 py-1.5">
        <span className="min-w-[12rem] flex-1 truncate font-mono text-caption text-fg max-md:whitespace-normal max-md:break-all" title={f.path}>{f.path}</span>
        {counts.slice(0, DOTS).map((c) => (
          <span key={c.branch} className="inline-flex items-center gap-1 font-mono text-micro text-muted" data-testid="tree-file-count">
            <Dot i={lanes.get(c.branch) ?? 0} className="size-2" />
            {c.status === "A" ? "added " : c.status === "D" ? "deleted " : c.status === "B" ? "binary " : ""}
            <span className="text-ok">+{c.added}</span><span className="text-danger">-{c.removed}</span>
          </span>
        ))}
        {counts.length > DOTS && (
          <span className="font-mono text-micro text-muted" data-testid="tree-file-more" title={counts.slice(DOTS).map((c) => `${short(c.branch)} +${c.added} -${c.removed}`).join("\n")}>
            and {counts.length - DOTS} more <span className="text-ok">+{counts.slice(DOTS).reduce((n, c) => n + c.added, 0)}</span> <span className="text-danger">-{counts.slice(DOTS).reduce((n, c) => n + c.removed, 0)}</span>
          </span>
        )}
      </header>
      <div className="flex flex-col divide-y divide-line">
        {blocks.map((bl, i) => bl.kind === "one" ? (
          <div key={i} className="flex flex-col" data-testid="tree-hunk" data-branch={bl.h.branch}>
            <div className="px-3 py-1">{byBranch.get(bl.h.branch) && <Who b={byBranch.get(bl.h.branch)!} lanes={lanes} />}</div>
            <Hunk h={bl.h} />
          </div>
        ) : (
          <div key={i} className="flex flex-col" data-testid="tree-overlap" data-conflict={bl.ov.conflict === null ? "unknown" : String(bl.ov.conflict)}>
            <p className={cn("flex items-start gap-2 px-3 py-1.5 text-caption", bl.ov.conflict ? "bg-danger-soft text-danger" : "bg-sunken text-muted")} data-testid="tree-overlap-note">
              {bl.ov.conflict ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <GitMerge className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
              <span>{bl.ov.note}</span>
            </p>
            {/* Each side keeps a readable width: past what the pane holds, the sides scroll sideways. */}
            {new Set(bl.hs.map((h) => h.branch)).size > 2 && <p className="px-3 pt-1 text-micro text-faint">{new Set(bl.hs.map((h) => h.branch)).size} branches change these lines: their sides scroll sideways.</p>}
            <div className="overflow-x-auto" data-testid="tree-overlap-sides">
            <div className="grid divide-x divide-line" style={{ gridTemplateColumns: `repeat(${new Set(bl.hs.map((h) => h.branch)).size}, minmax(20rem, 1fr))` }}>
              {[...new Set(bl.hs.map((h) => h.branch))].map((br) => (
                <div key={br} className="flex min-w-0 flex-col" data-testid="tree-hunk" data-branch={br}>
                  <div className="px-3 py-1">{byBranch.get(br) && <Who b={byBranch.get(br)!} lanes={lanes} />}</div>
                  {bl.hs.filter((h) => h.branch === br).map((h) => <Hunk key={h.index} h={h} />)}
                </div>
              ))}
            </div>
            </div>
          </div>
        ))}
        {f.cut.length > 0 && <p className="px-3 py-1 text-micro text-faint">Past what the review keeps of {f.cut.map(short).join(", ")}: counted, not shown.</p>}
      </div>
    </section>
  );
}

const ACTION_WORD = { land: "Queued to land", back: "Sent back", drop: "Dropped" } as const;
// An area's decisions in one word for the list: the one action, or "mixed".
const decided = (a: TreeArea) => {
  const acts = [...new Set(a.decisions.map((d) => d.action))];
  return acts.length === 1 ? acts[0]! : acts.length ? "mixed" : "none";
};

function AreaHead({ a, view, lanes, onDecide, busy }: { a: TreeArea; view: TreeView; lanes: Lanes; onDecide: (action: "land" | "back" | "drop" | "undo", note?: string, agents?: string[], branches?: string[]) => Promise<boolean>; busy: boolean }) {
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const agentsHere = view.branches.filter((b) => a.branches.includes(b.branch));
  const [to, setTo] = useState<string[]>(agentsHere.map((b) => b.agent));
  useEffect(() => { setBack(false); setNote(""); setTo(view.branches.filter((b) => a.branches.includes(b.branch)).map((b) => b.agent)); }, [a.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const ds = a.decisions;
  // One line a decision made at once (its branches together).
  const groups = [...ds.reduce((m, d) => {
    const key = `${d.action}\0${d.at}\0${d.outcome}`;
    const g = m.get(key) ?? { key, action: d.action, at: d.at, outcome: d.outcome, note: d.note, current: true, branches: [] as string[] };
    g.branches.push(d.branch);
    g.current &&= d.current;
    return m.set(key, g);
  }, new Map<string, { key: string; action: Decision["action"]; at: number; outcome: string; note: string; current: boolean; branches: string[] }>()).values()];
  const carried = Object.entries(a.carries).filter(([b]) => !view.held[b]);
  const heldHere = a.branches.filter((b) => view.held[b]);
  const btn = "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-caption disabled:opacity-50";
  // The branches that would conflict when landed lie in the order after the one they meet: landing them is
  // the owner's call, so the main button lands the rest and the whole set asks first.
  const risky = wouldConflict(view, a.order);
  const safe = a.order.filter((b) => !risky.includes(b));
  const landAll = async () => {
    if (risky.length && !(await confirmAction({
      title: `Land all ${a.order.length} branches?`,
      body: `${risky.map(short).join(", ")} would conflict when landing: ${risky.length === 1 ? "its agent rebases it" : "their agents rebase them"} onto the branch that lands first.`,
      action: `Land all ${a.order.length}`,
    }))) return;
    await onDecide("land");
  };
  return (
    <div className="flex flex-col gap-2 border-b border-line px-4 py-3" data-testid="tree-area-head">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="min-w-0 truncate font-mono text-ui font-medium text-fg max-md:whitespace-normal max-md:break-all">{a.key === "." ? "top level" : a.key}</h3>
        <span className="text-caption text-muted">{a.files.length} {a.files.length === 1 ? "file" : "files"} · <span className="text-ok">+{a.added}</span> <span className="text-danger">-{a.removed}</span></span>
        <span className="flex-1" />
        {a.order.length > 0 && risky.length > 0 && safe.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void onDecide("land", undefined, undefined, safe)} data-testid="tree-land"
            title={`Queues ${safe.map(short).join(", ")}. ${risky.map(short).join(", ")} would conflict when landing and stays for its agent to rebase.`}
            className={cn(btn, "bg-accent text-accent-fg hover:bg-accent-hover")}>
            <GitMerge className="size-3.5" />Land {safe.length}, {risky.length} would conflict
          </button>
        )}
        <button type="button" disabled={busy || !a.order.length} onClick={() => void landAll()} data-testid={risky.length > 0 && safe.length > 0 ? "tree-land-all" : "tree-land"}
          title={a.order.length ? `Queued in this order: ${a.order.map(short).join(", ")}` : "No branch here can land now: see what holds it"}
          className={cn(btn, risky.length > 0 && safe.length > 0 ? "border border-line text-fg hover:bg-hover" : "bg-accent text-accent-fg hover:bg-accent-hover")}>
          <GitMerge className="size-3.5" />{risky.length > 0 && safe.length > 0 ? `Land all ${a.order.length}` : <>Land {a.order.length > 1 ? `${a.order.length} branches` : "it"}</>}
        </button>
        <button type="button" disabled={busy} onClick={() => { if (!back) { setNote(""); setTo(agentsHere.map((b) => b.agent)); } setBack(!back); }} data-testid="tree-back" className={cn(btn, "border border-line text-fg hover:bg-hover")}>
          <CornerUpLeft className="size-3.5" />Send back
        </button>
        <button type="button" disabled={busy} onClick={() => void onDecide("drop")} data-testid="tree-drop" className={cn(btn, "text-muted hover:bg-hover hover:text-danger")}>
          <Trash2 className="size-3.5" />Drop
        </button>
      </div>
      {a.order.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-caption text-muted" data-testid="tree-area-order">
          Lands as {a.order.length === 1 ? "one entry" : `${a.order.length} entries, in this order`}:
          {a.order.slice(0, NAMES).map((b, i) => (
            <span key={b} className="inline-flex items-center gap-1">
              {i > 0 && <ArrowRight className="size-3 text-faint" aria-hidden="true" />}
              <Dot i={lanes.get(b) ?? 0} className="size-2" /><span className="font-mono text-fg">{short(b)}</span>
            </span>
          ))}
          {a.order.length > NAMES && <span className="inline-flex items-center gap-1" title={a.order.map(short).join(" → ")}><ArrowRight className="size-3 text-faint" aria-hidden="true" />{a.order.length - NAMES} more, in the order on the left</span>}
        </p>
      )}
      {heldHere.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-caption text-muted" data-testid="tree-area-held">
          {heldHere.map((b) => <li key={b} className="flex items-center gap-1.5"><Dot i={lanes.get(b) ?? 0} className="size-2" /><span><span className="font-mono text-fg">{short(b)}</span> is held: {view.held[b]}</span></li>)}
        </ul>
      )}
      {carried.length > 0 && (
        <p className="text-caption text-warn" data-testid="tree-carries" title={carried.map(([b, others]) => `${short(b)} also changes ${others.map(where).join(", ")}`).join("\n")}>
          {carried.length <= NAMES
            ? `${carried.map(([b, others]) => `${short(b)} also changes ${others.map(where).join(", ")}`).join("; ")}: landing this area lands ${carried.length === 1 ? "that" : "those"} too.`
            : `${carried.length} of its branches also change other areas (${(() => { const all = [...new Set(carried.flatMap(([, o]) => o))].sort().map(where); return all.length <= NAMES ? all.join(", ") : `${all.slice(0, NAMES).join(", ")} and ${all.length - NAMES} more`; })()}): landing this area lands those too.`}
        </p>
      )}
      {ds.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-caption" data-testid="tree-decisions">
          <ul className="flex min-w-0 flex-1 flex-col gap-1">
            {groups.map((g) => (
              <li key={g.key} className={cn("min-w-0", g.current ? "text-fg" : "text-warn")} data-testid="tree-decision" data-action={g.action} data-current={String(g.current)}>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {g.branches.map((b) => <span key={b} className="inline-flex items-center gap-1"><Dot i={lanes.get(b) ?? 0} className="size-2" /><span className="font-mono">{short(b)}</span></span>)}
                  <b className="font-medium">{ACTION_WORD[g.action].toLowerCase()}</b> {ago(g.at)}{g.current ? "" : " · its change here is new since: review it again"}.
                </span>{" "}
                <span className="text-muted">{g.outcome}</span>
                {g.note && <span className="block text-muted">Your note: {g.note}</span>}
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={() => void onDecide("undo")} data-testid="tree-undo" className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-muted hover:bg-hover hover:text-fg">
            <Undo2 className="size-3" />Clear
          </button>
        </div>
      )}
      {back && (
        <form className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3" data-testid="tree-back-form"
          onSubmit={(e) => { e.preventDefault(); void onDecide("back", note, to).then((ok) => ok && setBack(false)); }}>
          <div className="flex flex-wrap items-center gap-1.5 text-caption text-muted">
            To
            {agentsHere.map((b) => {
              const on = to.includes(b.agent);
              return (
                <button key={b.agent} type="button" aria-pressed={on} onClick={() => setTo((t) => (on ? t.filter((x) => x !== b.agent) : [...t, b.agent]))}
                  className={cn("inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-micro", on ? "border-line-strong bg-hover text-fg" : "border-line text-faint")}>
                  <Dot i={lanes.get(b.branch) ?? 0} className="size-2" />{b.title}
                </button>
              );
            })}
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What to change in this area" data-testid="tree-back-note" aria-label="Note to the agents"
            className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-1.5 text-caption text-fg placeholder:text-faint focus:border-line-strong focus:outline-none" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setBack(false)} className={cn(btn, "text-muted hover:bg-hover")}>Cancel</button>
            <button type="submit" disabled={busy || !to.length} data-testid="tree-back-send" className={cn(btn, "bg-accent text-accent-fg hover:bg-accent-hover")}>Send to {to.length} {to.length === 1 ? "agent" : "agents"}</button>
          </div>
        </form>
      )}
    </div>
  );
}

// Steps of the order shown before "show all": the list of areas stays in sight under a long order.
const STEPS = 8;
function Order({ view, lanes }: { view: TreeView; lanes: Lanes }) {
  const [all, setAll] = useState(false);
  const held = Object.entries(view.held);
  const steps = all ? view.order.steps : view.order.steps.slice(0, STEPS);
  if (!view.order.steps.length && !held.length) return null;
  return (
    <section className="flex flex-col gap-1.5 px-3 py-3" data-testid="tree-order">
      <h4 className="k-label px-1">Proposed landing order</h4>
      {!view.order.steps.length && <p className="px-1 text-caption text-muted">No branch can land now.</p>}
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 px-1" data-testid="tree-step">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-sunken font-mono text-micro text-muted">{i + 1}</span>
            <span className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-1">
              {s.branches.map((b) => (
                <span key={b} className="inline-flex items-center gap-1 font-mono text-caption text-fg" title={view.order.why[b]} data-testid="tree-step-branch">
                  <Dot i={lanes.get(b) ?? 0} className="size-2" />{short(b)}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
      {view.order.steps.length > STEPS && (
        <button type="button" onClick={() => setAll(!all)} data-testid="tree-order-all" className="self-start rounded-md px-1 text-caption text-muted hover:bg-hover hover:text-fg">
          {all ? "Show the first steps" : `Show all ${view.order.steps.length} steps`}
        </button>
      )}
      {held.length > 0 && (
        <ul className="flex flex-col gap-0.5 px-1 pt-1 text-micro text-muted" data-testid="tree-held">
          {held.map(([b, why]) => (
            <li key={b} className="flex items-start gap-1.5"><Dot i={lanes.get(b) ?? 0} className="mt-1 size-2" /><span><span className="font-mono text-fg">{short(b)}</span> held: {why}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AreaList({ view, lanes, at, onPick }: { view: TreeView; lanes: Lanes; at: string | null; onPick: (k: string) => void }) {
  const ovs = new Map(view.overlaps.map((o) => [o.id, o]));
  return (
    <section className="flex flex-col gap-1 px-3 py-3">
      <h4 className="k-label flex items-center gap-2 px-1">Areas<span className="flex-1" /><span className="font-normal max-md:hidden"><kbd className="font-mono">j</kbd> <kbd className="font-mono">k</kbd> to move</span></h4>
      <ul className="flex flex-col gap-0.5" data-testid="tree-areas">
        {view.areas.map((a) => {
          const conflict = a.overlaps.some((id) => ovs.get(id)?.conflict);
          return (
            <li key={a.key}>
              <button type="button" onClick={() => onPick(a.key)} aria-current={a.key === at ? "true" : undefined} data-testid="tree-area" data-area={a.key} data-decision={decided(a)}
                className={cn("flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left", a.key === at ? "k-picked" : "hover:bg-hover")}>
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg max-md:whitespace-normal max-md:break-all">{a.key === "." ? "top level" : a.key}</span>
                  {decided(a) !== "none" && <span className={cn("shrink-0 text-micro", a.decisions.every((d) => d.current) ? "text-muted" : "text-warn")}>{decided(a) === "mixed" ? "decided in part" : ACTION_WORD[decided(a) as Decision["action"]].toLowerCase()}{a.decisions.every((d) => d.current) ? "" : " · moved"}</span>}
                </span>
                <span className="flex w-full items-center gap-2 whitespace-nowrap text-micro text-muted" data-testid="tree-area-counts">
                  <span className="flex shrink-0 items-center gap-0.5" title={`${a.branches.length} ${a.branches.length === 1 ? "branch" : "branches"}: ${a.branches.map(short).join(", ")}`}>
                    {a.branches.slice(0, DOTS).map((b) => <Dot key={b} i={lanes.get(b) ?? 0} className="size-2" />)}
                    {a.branches.length > DOTS && <span className="pl-0.5 font-mono" data-testid="tree-area-more">+{a.branches.length - DOTS}</span>}
                  </span>
                  <span>{a.files.length} {a.files.length === 1 ? "file" : "files"}</span>
                  <span className="text-ok">+{a.added}</span><span className="text-danger">-{a.removed}</span>
                  <span className="flex-1" />
                  {a.overlaps.length > 0 && <span className={cn("shrink-0", conflict ? "text-danger" : "text-warn")} data-testid="tree-area-overlaps">{a.overlaps.length} {conflict ? (a.overlaps.length === 1 ? "conflict" : "conflicts") : a.overlaps.length === 1 ? "overlap" : "overlaps"}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Branches({ view, lanes }: { view: TreeView; lanes: Lanes }) {
  return (
    <section className="flex flex-col gap-1 px-3 py-3">
      <h4 className="k-label px-1">Branches</h4>
      <ul className="flex flex-col gap-1.5 px-1" data-testid="tree-branches">
        {view.branches.map((b) => (
          <li key={b.branch} className="flex flex-col gap-0.5" data-testid="tree-branch" data-branch={b.branch}>
            <span className="flex min-w-0 items-center gap-2 text-caption">
              <Dot i={lanes.get(b.branch) ?? 0} />
              <span className="min-w-0 truncate font-mono text-fg max-md:whitespace-normal max-md:break-all" title={b.branch}>{short(b.branch)}</span>
              <span className={cn("shrink-0 text-micro font-medium", verdictOf(b).cls)}>{verdictOf(b).word}</span>
            </span>
            <span className="pl-4.5 text-micro text-faint">
              {b.title} <span className="font-mono">{b.agent}</span> · <span className={checksOf(b).cls}>{checksOf(b).word}</span> · {b.files} {b.files === 1 ? "file" : "files"} <span className="text-ok">+{b.added}</span> <span className="text-danger">-{b.removed}</span> at <span className="font-mono">{sha(b.head)}</span>
              {b.working && <span className="text-st-work"> · working</span>}
              {b.base_conflict && <span className="text-danger"> · conflicts with the base</span>}
              {b.error && <span className="text-danger"> · {b.error}</span>}
            </span>
            {b.pictures && !(b.pictures.state === "skipped" && /^(no file of the page changed|only tests changed)$/.test(b.pictures.why ?? "")) && <div className="pl-4.5 pt-1"><PicturesArea fact={b.pictures} sessionId={b.session_id} repo={view.repo} testid="tree-pictures" /></div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TreeReviewDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [view, setView] = useState<TreeView | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [detail, setDetail] = useState<AreaDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [said, setSaid] = useState("");
  // A phone shows one column: the areas, then the one picked (a way back at its top).
  const phone = usePhoneWidth();
  const [step, setStep] = useState<"areas" | "area">("areas");
  const load = useCallback(async (fresh: boolean) => {
    setBusy(true);
    setErr("");
    setSaid("");
    try { setView(await readTree(session.id, fresh, repo)); } catch (e) { setErr(failed(e, { at: "TreeReview" })); } finally { setBusy(false); }
  }, [session.id, repo]);
  useEffect(() => { void load(false); }, [load]);
  // Live while it is up: a branch head of the tree moved (the review feed of src/server/scope.ts), or the
  // repository's landing queue did. Read again quietly: what the owner was told stays.
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const again = () => {
      clearTimeout(quiet.current);
      quiet.current = setTimeout(() => { readTree(session.id, true, repo).then(setView, reportUnlessGone); }, 250);
    };
    const stop = scope.feed(`review:${session.id}`);
    const off = onFeature({
      frame(f) { if ((f.name === "tree_review" || f.name === "landing") && f.session_id === session.id) again(); },
      reconnect: again,
    });
    return () => { stop(); off(); clearTimeout(quiet.current); };
  }, [session.id, repo]);
  // An agent of the tree started, ended or changed state (what the page knows of it): whether it still
  // works holds its branch, so read again a moment later (several often end together).
  const mark = useTreeMark(session.id);
  const marked = useRef(mark);
  useEffect(() => {
    if (marked.current === mark) return;
    marked.current = mark;
    const t = setTimeout(() => { readTree(session.id, true, repo).then(setView, reportUnlessGone); }, 600);
    return () => clearTimeout(t);
  }, [mark, session.id, repo]);
  // The first area, or the one shown while it is still there.
  useEffect(() => { if (view && !view.areas.some((a) => a.key === at)) setAt(view.areas[0]?.key ?? null); }, [view, at]);
  useEffect(() => {
    if (!at || !view) { setDetail(null); return; }
    let live = true;
    readArea(session.id, at, view.repo).then((d) => live && setDetail(d), (e) => live && setErr(failed(e, { at: "TreeReview area" })));
    return () => { live = false; };
  }, [session.id, at, view]);
  const lanes: Lanes = useMemo(() => new Map((view?.branches ?? []).map((b, i) => [b.branch, i])), [view]);
  const area = view?.areas.find((a) => a.key === at) ?? null;
  const onDecide = async (action: "land" | "back" | "drop" | "undo", note?: string, agents?: string[], branches?: string[]) => {
    if (!area) return false;
    setBusy(true);
    setErr("");
    setSaid("");
    try {
      const r = await decide(session.id, { area: area.key, action, note, agents, branches, repo: view?.repo });
      if (r.view) setView(r.view);
      setSaid(r.outcome ?? "");
      return true;
    } catch (e) {
      setErr(failed(e, { at: "TreeReview decide" }));
      return false;
    } finally { setBusy(false); }
  };
  const conflicts = view?.overlaps.filter((o) => o.conflict).length ?? 0;
  // j and k (or the arrows, on the list of areas) move between areas; not while the owner types.
  const onKey = (e: KeyboardEvent) => {
    if (!view?.areas.length || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable=true]")) return;
    const inList = !!t.closest('[data-testid="tree-areas"]');
    const step = e.key === "j" || (inList && e.key === "ArrowDown") ? 1 : e.key === "k" || (inList && e.key === "ArrowUp") ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, view.areas.findIndex((a) => a.key === at));
    const next = view.areas[Math.min(view.areas.length - 1, Math.max(0, i + step))]!;
    setAt(next.key);
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-testid="tree-area"][data-area="${CSS.escape(next.key)}"]`);
    if (inList) el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="tree-review" onKeyDown={onKey} style={{ "--k-dialog-w": "120rem", "--k-dialog-bg": "var(--bg)", height: "calc(100dvh - 2rem)" } as CSSProperties}
          className="k-dialog rounded-xl border border-line bg-bg shadow-3 transition-[scale,opacity] data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <Dialog.Title className="truncate text-ui font-semibold text-fg">Review the tree</Dialog.Title>
              <p className="truncate text-caption text-muted max-md:whitespace-normal max-md:break-words" data-testid="tree-summary">
                {view ? <>
                  {view.branches.length} {view.branches.length === 1 ? "branch" : "branches"} to land · {view.areas.length} {view.areas.length === 1 ? "area" : "areas"} · {view.overlaps.length} {view.overlaps.length === 1 ? "overlap" : "overlaps"}{conflicts ? ` (${conflicts} would conflict)` : ""}
                  {view.base && <> · base <span className="font-mono">{view.base}</span> at <span className="font-mono">{sha(view.base_tip)}</span></>}
                  {view.skipped.landed > 0 && <> · {view.skipped.landed} landed, not shown</>}
                </> : "Reading the branches…"}
              </p>
            </div>
            {view && view.repos.length > 1 && (
              <select value={view.repo ?? ""} onChange={(e) => setRepo(e.target.value)} aria-label="Repository" className="h-7 rounded-lg border border-line bg-raised px-2 text-caption text-fg">
                {view.repos.map((r) => <option key={r} value={r}>{r.split("/").at(-1)}</option>)}
              </select>
            )}
            <button type="button" onClick={() => void load(true)} disabled={busy} data-testid="tree-refresh"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh
            </button>
            <Dialog.Close aria-label="Close" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></Dialog.Close>
          </div>
          {(err || said) && (
            <p className={cn("flex items-start gap-2 border-b border-line px-4 py-2 text-caption", err ? "text-danger" : "text-fg")} data-testid={err ? "tree-error" : "tree-said"}>
              {err ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> : <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />}{err || said}
            </p>
          )}
          {view && !view.branches.length ? (
            <p className="k-empty px-4 py-6"><b>Nothing to review</b>No agent of this session's tree has a branch with work the base lacks.</p>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[24rem_minmax(0,1fr)] max-md:grid-cols-[minmax(0,1fr)]" style={{ flexShrink: 1 }}>
              <div className={cn("min-h-0 divide-y divide-line overflow-y-auto border-r border-line bg-sunken max-md:border-r-0", phone && step === "area" && "hidden")} data-testid="tree-side">
                {view && <Order view={view} lanes={lanes} />}
                {view && <AreaList view={view} lanes={lanes} at={at} onPick={(k) => { setAt(k); setStep("area"); }} />}
                {view && <Branches view={view} lanes={lanes} />}
                {view && <p className="px-4 py-2 text-micro text-faint" data-testid="tree-took">Read {ago(view.at)} in {view.took_ms} ms: {view.stats.diffs} diffs read, {view.stats.kept} kept from before, {view.stats.merges} merges.</p>}
              </div>
              <div className={cn("flex min-h-0 min-w-0 flex-col overflow-y-auto", phone && step === "areas" && "hidden")}>
                {phone && (
                  <button type="button" onClick={() => setStep("areas")} data-testid="tree-areas-back" className="flex items-center gap-1.5 self-start px-4 py-2 text-caption text-muted hover:text-fg">
                    <ArrowLeft className="size-3.5" />Areas
                  </button>
                )}
                {view && area && <AreaHead a={area} view={view} lanes={lanes} onDecide={onDecide} busy={busy} />}
                <div className="flex flex-col gap-3 p-4" data-testid="tree-area-files">
                  {detail && view && detail.key === at ? detail.files.map((f) => <File key={f.path} f={f} view={view} lanes={lanes} />) : <p className="text-caption text-faint">Reading the area…</p>}
                </div>
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
