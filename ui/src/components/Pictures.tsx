// Before and after pictures of a branch that changes the page (src/pictures/run.ts): on a work board
// card and in the Review panel, what the run found and the first pair that differs, before beside after
// with the changed areas outlined; Compare opens every pair, one at a time, with the same outlines.
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Images, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { PictureFact } from "../../../src/board/rules.ts";
import type { Session } from "../../../src/core/types.ts";
import type { Pair } from "../../../src/pictures/pairs.ts";
import type { PictureRun } from "../../../src/pictures/run.ts";
import { api, failed, onFeature, reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

type Box = { x: number; y: number; w: number; h: number };
type Shown = { name: string; state: string; w?: number; h?: number; boxes?: Box[] };
const sha = (s: string | null | undefined) => (s ? s.slice(0, 9) : "?");
const src = (id: number, side: "before" | "after", name: string) => `/api/pictures/${id}/${side}/${encodeURIComponent(name)}`;
const STATE_WORD: Record<string, string> = { changed: "changed", unstable: "unstable", new: "new", gone: "gone", same: "same", unread: "not read" };
const secs = (ms?: number | null) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

// What a run says in one line.
export function picturesWords(p: Pick<PictureFact, "state" | "why" | "counts">): string {
  if (p.state === "none") return "not taken yet";
  if (p.state === "queued") return "waiting to be taken";
  if (p.state === "running") return "being taken";
  if (p.state === "skipped") return `not taken: ${p.why}`;
  if (p.state === "failed") return `could not be taken: ${p.why}`;
  const c = p.counts, n = c.changed + c.new + c.gone, all = n + (c.unstable ?? 0) + c.same + c.unread;
  const shaky = c.unstable ? `, ${c.unstable} unstable` : "";
  return n ? `${n} of ${all} differ${shaky}` : `none of ${all} differs${shaky}`;
}

// One side of a pair: the picture, with each changed area outlined at its place (an unstable pair's areas, where
// two runs of the base differ too, dashed). `fit`: the picture as large as the pane holds, by its width or its height.
function Side({ id, side, p, label, marks = true, fit = false }: { id: number; side: "before" | "after"; p: Shown; label: string; marks?: boolean; fit?: boolean }) {
  const absent = (side === "before" && p.state === "new") || (side === "after" && p.state === "gone") || p.state === "same";
  const ratio = p.w && p.h ? p.w / p.h : undefined;
  const shown = (
    <div className={cn("relative overflow-hidden rounded-md border border-line bg-sunken", fit && "mx-auto")}
      style={fit && ratio ? { width: `min(100cqw, calc(100cqh * ${ratio.toFixed(5)}))`, aspectRatio: `${p.w} / ${p.h}` } : undefined}>
      <img src={src(id, side, p.name)} alt={`${label}: ${p.name}`} loading="lazy" className={cn("block w-full", fit && ratio ? "h-full" : "h-auto")} />
      {marks && p.w && p.h && (p.state === "changed" || p.state === "unstable") && (p.boxes ?? []).map((b, i) => (
        <span key={i} data-testid="pictures-mark" data-kind={p.state} aria-hidden="true"
          className={cn("pointer-events-none absolute rounded-xs outline-2 outline-offset-1", p.state === "changed" ? "outline-pic-mark bg-pic-mark/10" : "outline-dashed outline-line-strong")}
          style={{ left: `${(b.x / p.w!) * 100}%`, top: `${(b.y / p.h!) * 100}%`, width: `${(b.w / p.w!) * 100}%`, height: `${(b.h / p.h!) * 100}%` }} />
      ))}
    </div>
  );
  return (
    <figure className={cn("flex min-w-0 flex-1 flex-col gap-1", fit && "min-h-0")} data-testid={`pictures-${side}`}>
      <figcaption className="k-label">{label}</figcaption>
      {absent ? (
        <div className="k-empty grid min-h-16 flex-1 place-items-center rounded-md border border-dashed border-line bg-sunken px-2">
          {p.state === "same" ? "the same on both sides (not kept)" : side === "before" ? "not on the base" : "not on the branch"}
        </div>
      ) : fit ? <div className="min-h-0 flex-1 [container-type:size]">{shown}</div> : shown}
    </figure>
  );
}

function PairView({ id, p, marks = true, fit = false }: { id: number; p: Shown; marks?: boolean; fit?: boolean }) {
  return (
    <div className={cn("flex min-w-0 gap-2", fit && "min-h-0 flex-1")} data-testid="pictures-pair" data-name={p.name} data-state={p.state}>
      <Side id={id} side="before" p={p} label="Before" marks={marks} fit={fit} />
      <Side id={id} side="after" p={p} label="After" marks={marks} fit={fit} />
    </div>
  );
}

// A card's or the tree review's pictures: a head not taken yet shows a line to open them, which takes them
// (the run's start is the opening: src/pictures/run.ts). A head whose change reaches no page file shows nothing.
export function PicturesArea({ fact, sessionId, repo, testid = "board-pictures" }: { fact: PictureFact; sessionId: string; repo?: string | null; testid?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (fact.state === "skipped" && (fact.why === "no file of the page changed" || fact.why === "only tests changed")) return null;
  if (fact.state !== "none") return <PicturesFact fact={fact} sessionId={sessionId} testid={testid} />;
  const open = async () => {
    setBusy(true); setErr("");
    const q = new URLSearchParams({ head: fact.head, ...(repo ? { repo } : {}) });
    try { await api(`/api/sessions/${sessionId}/pictures?${q}`); } catch (e) { setErr(failed(e, { at: "Pictures open" })); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 text-caption" data-testid={testid} data-state="none">
      <div className="flex min-w-0 items-center gap-2">
        {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin text-st-work" aria-hidden="true" /> : <Images className="size-3.5 shrink-0 text-faint" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate text-fg">Pictures <span className="text-muted">not taken yet</span></span>
        <button type="button" onClick={open} disabled={busy} data-testid="pictures-open" title="Take the before and after pictures of this head"
          className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-micro text-accent hover:bg-hover disabled:opacity-50">Take them</button>
      </div>
      {err && <p className="text-danger">{err}</p>}
    </div>
  );
}

// The fact on a card or in Review: the run's line, the first pair that differs, Compare and Take again.
export function PicturesFact({ fact, sessionId, testid = "board-pictures" }: { fact: PictureFact; sessionId: string; testid?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const going = fact.state === "queued" || fact.state === "running";
  const first = fact.differ[0];
  const again = async () => {
    setBusy(true); setErr("");
    try { await api(`/api/sessions/${sessionId}/pictures`, { method: "POST" }); } catch (e) { setErr(failed(e, { at: "Pictures again" })); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-caption" data-testid={testid} data-state={fact.state} data-differ={fact.counts.changed + fact.counts.new + fact.counts.gone}>
      <div className="flex min-w-0 items-center gap-2">
        {going ? <Loader2 className="size-3.5 shrink-0 animate-spin text-st-work" aria-hidden="true" /> : <Images className={cn("size-3.5 shrink-0", fact.state === "failed" ? "text-danger" : "text-faint")} aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate text-fg" data-testid="pictures-line" title={`${fact.specs.join(", ")}`}>
          Pictures <span className="text-muted">{picturesWords(fact)}</span>
        </span>
        {fact.state === "done" && fact.kept && (
          <button type="button" onClick={() => setOpen(true)} data-testid="pictures-compare" className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-micro text-accent hover:bg-hover">Compare</button>
        )}
        {!going && (
          <button type="button" onClick={again} disabled={busy} title="Take them again" aria-label="Take the pictures again" data-testid="pictures-again"
            className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-50">
            <RefreshCw className={cn("size-3", busy && "animate-spin")} />
          </button>
        )}
      </div>
      {first && fact.kept && <button type="button" onClick={() => setOpen(true)} className="block w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Compare ${first.name}`}><PairView id={fact.id} p={first} /></button>}
      {first && <p className="truncate font-mono text-micro text-faint" title={first.name}>{first.name}{fact.differ.length > 1 ? ` and ${fact.counts.changed + fact.counts.new + fact.counts.gone - 1} more` : ""}</p>}
      {err && <p className="text-danger">{err}</p>}
      {open && <PicturesViewer id={fact.id} onClose={() => setOpen(false)} />}
    </div>
  );
}

// Every pair of a run, one at a time: those that differ first, the rest on request.
export function PicturesViewer({ id, onClose }: { id: number; onClose: () => void }) {
  const [run, setRun] = useState<PictureRun | null>(null);
  const [err, setErr] = useState("");
  const [all, setAll] = useState(false);
  const [marks, setMarks] = useState(true);
  const [at, setAt] = useState(0);
  useEffect(() => { api<{ run: PictureRun }>(`/api/pictures/${id}`).then((r) => setRun(r.run)).catch((e) => setErr(failed(e, { at: "PicturesViewer" }))); }, [id]);
  const pairs = useMemo(() => (run?.pairs ?? []).filter((p) => all || p.state !== "same"), [run, all]);
  const p: Pair | undefined = pairs[Math.min(at, pairs.length - 1)];
  const move = useCallback((d: number) => setAt((i) => Math.max(0, Math.min(pairs.length - 1, i + d))), [pairs.length]);
  const keys = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "j") { e.preventDefault(); move(1); }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); move(-1); }
    if (e.key === "o" && !(e.target instanceof HTMLInputElement && e.target.type !== "checkbox")) setMarks((m) => !m);
  };
  const c = run?.counts;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="pictures-viewer" onKeyDown={keys} style={{ "--k-dialog-w": "110rem" } as React.CSSProperties}
          className="k-dialog h-[calc(100dvh-1.5rem)] rounded-xl border border-line bg-bg shadow-3 transition-[scale,opacity] data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
            <Images className="size-4 text-faint" aria-hidden="true" />
            <Dialog.Title className="min-w-0 flex-1 break-words font-semibold">
              Pictures of <span className="font-mono">{sha(run?.head)}</span> <span className="font-normal text-muted">against its base</span> <span className="font-mono">{sha(run?.merge_base)}</span>
            </Dialog.Title>
            <div className="order-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 sm:order-2 sm:w-auto">
              {c && <span className="text-caption text-muted" data-testid="pictures-counts">{c.changed} changed{c.unstable ? ` · ${c.unstable} unstable` : ""} · {c.new} new · {c.gone} gone · {c.same} same</span>}
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-caption text-muted">
                <input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); setAt(0); }} className="accent-accent" data-testid="pictures-all" /> Show the same
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-caption text-muted" title="The changed areas, outlined (o)">
                <input type="checkbox" checked={marks} onChange={(e) => setMarks(e.target.checked)} className="accent-accent" data-testid="pictures-marks" /> Outlines
              </label>
            </div>
            <Dialog.Close aria-label="Close" className="order-2 grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg sm:order-3"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="@container flex min-h-0 flex-1 flex-col">
            {err && <p className="p-4 text-caption text-danger">{err}</p>}
            {!run && !err && <p className="k-empty p-4">Loading…</p>}
            {run && !pairs.length && <p className="k-empty p-4">No picture differs.</p>}
            {run && p && (
              <div className="flex min-h-0 flex-1 flex-col @[48rem]:flex-row">
                <ul className="flex max-h-32 shrink-0 flex-col overflow-y-auto border-b border-line p-1.5 @[48rem]:max-h-none @[48rem]:w-72 @[48rem]:border-r @[48rem]:border-b-0" data-testid="pictures-list" aria-label="Pictures">
                  {pairs.map((x, i) => (
                    <li key={x.name}>
                      <button type="button" onClick={() => setAt(i)} aria-current={x === p ? "true" : undefined}
                        className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-caption hover:bg-hover", x === p && "k-picked")}>
                        <span className={cn("size-1.5 shrink-0 rounded-full", x.state === "changed" ? "bg-pic-mark" : x.state === "same" ? "bg-line-strong" : x.state === "unstable" ? "border border-line-strong" : "bg-st-wait")} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg">{x.shot}</span>
                        <span className="shrink-0 text-micro text-faint">{[x.size, x.theme].filter(Boolean).join(" ")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 truncate font-mono text-caption text-fg" data-testid="pictures-name">{p.name}</span>
                    <span className="text-caption text-muted">{STATE_WORD[p.state]}{p.state === "changed" && p.share != null ? ` · ${(p.share * 100).toFixed(p.share < 0.01 ? 2 : 1)}% of its pixels in ${p.boxes?.length ?? 0} ${(p.boxes?.length ?? 0) === 1 ? "area" : "areas"}` : ""}{p.state === "unstable" ? " · it differs only where two runs of the base differ too: no change of the branch's is seen" : p.noise ? ` · not counted: ${p.noise} pixels where two runs of the base differ too` : ""}{p.resized ? ` · resized from ${p.resized.before.join("x")} to ${p.resized.after.join("x")}` : ""}{p.why ? ` · ${p.why}` : ""}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => move(-1)} disabled={at === 0} aria-label="The one before" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-40"><ChevronLeft className="size-4" /></button>
                    <span className="text-micro text-faint">{Math.min(at, pairs.length - 1) + 1} of {pairs.length}</span>
                    <button type="button" onClick={() => move(1)} disabled={at >= pairs.length - 1} aria-label="The next one" data-testid="pictures-next" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-40"><ChevronRight className="size-4" /></button>
                    </span>
                  </div>
                  <PairView id={run.id} p={p} marks={marks} fit />
                </div>
              </div>
            )}
            {run && (
              <p className="border-t border-line px-4 py-1.5 text-micro text-faint" data-testid="pictures-cost">
                {run.selection?.specs.map((s) => s.path.split("/").pop()).join(", ")}
                {(["before", "after", "again"] as const).map((s) => run.sides[s]?.ms != null ? ` · ${s === "again" ? "the base again" : s} ${secs(run.sides[s]!.ms)}${run.sides[s]!.cpu_ms != null ? `, ${secs(run.sides[s]!.cpu_ms)} of processor` : ""}${run.sides[s]!.state === "failed" ? ` (failed: ${run.sides[s]!.why})` : ""}` : "").join("")}
              </p>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// The Review panel's part: the pictures of the session's head, when its repository names them. Opening the
// panel takes them when the head has none yet (the GET starts the run).
export function SessionPictures({ session }: { session: Session }) {
  const [run, setRun] = useState<PictureRun | null>(null);
  const load = useCallback(() => api<{ run: PictureRun | null; named: boolean }>(`/api/sessions/${session.id}/pictures`).then((r) => setRun(r.run)).catch(reportError), [session.id]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if (f.name === "pictures" && f.session_id === session.id) load(); }, reconnect: load });
  }, [load]);
  if (!run || (run.state === "skipped" && (run.why === "no file of the page changed" || run.why === "only tests changed"))) return null;
  const fact: PictureFact = {
    id: run.id, state: run.state, why: run.why, head: run.head, merge_base: run.merge_base, counts: run.counts,
    specs: run.selection?.specs.map((s) => s.path) ?? [], sides: run.sides, kept: run.kept,
    differ: run.pairs.filter((p) => p.state === "changed" || p.state === "new" || p.state === "gone"),
  };
  return <div className="rounded-lg border border-line bg-raised px-3 py-2"><PicturesFact fact={fact} sessionId={session.id} testid="review-pictures" /></div>;
}
