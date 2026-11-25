// The Conversation lens (src/core/lens.ts): the owner's messages, the replies to them, and
// between them one folded line for each stretch of work nobody asked for in that moment, saying
// what came of it. A line opens that stretch's full stream in place. The lens is read from the
// daemon (GET /api/sessions/:id/lens): a folded stretch costs its line, never its events, until
// it is opened. New since read lands on the first new item of the lens.
import { ArrowDown, ArrowUp, Check, ChevronRight } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { joinRuns, runWords, span, dollars, type EndFacts, type LensItem } from "../../../src/core/lens.ts";
import { MARK_READ, newSinceAt } from "../../../src/core/state-words.ts";
import type { Page } from "../../../src/core/tree.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import { presentAt } from "../lib/automation.ts";
import { setLensView } from "../lib/lens-view.ts";
import { placeOf, putPlace } from "../lib/place.ts";
import { api, failed, useStore } from "../lib/store.ts";
import { clock, cn } from "../lib/utils.ts";
import { useWatch } from "../lib/watch.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Live, StreamRows } from "./Transcript.tsx";

type LensPage = {
  items: LensItem[]; events: Record<string, StoredEvent>; stable: number; stable_id: string | null;
  last: { id: string; seq: number } | null; earlier?: boolean; whole?: boolean;
};
type Run = Extract<LensItem, { t: "run" }>;
const keyOf = (it: LensItem) => (it.t === "run" ? `r:${it.first}` : it.id);
const endOf = (it: LensItem) => (it.t === "run" ? it.to : it.seq);

// A page read after the last one: what was open in the one before is read again.
function merged(was: LensPage | null, got: LensPage): LensPage {
  if (!was || got.whole) return got;
  return { ...got, items: [...was.items.filter((x) => !x.open), ...got.items], events: { ...was.events, ...got.events }, earlier: was.earlier };
}

// The events of a part that are on its branch: the page also brings the other versions of its prompts.
function onBranch(events: StoredEvent[]): StoredEvent[] {
  if (!events.length) return events;
  const by = new Map(events.map((e) => [e.id, e]));
  const keep = new Set<string>();
  for (let e: StoredEvent | undefined = events.at(-1); e; e = e.parent ? by.get(e.parent) : undefined) keep.add(e.id);
  return events.filter((e) => keep.has(e.id));
}

const PART = 200;

// One folded stretch: its line, and its full stream in place once opened (read a part at a time).
const RunLine = memo(function RunLine({ sid, run, live, needs, fresh, lensKey }: { sid: string; run: Run; live: boolean; needs: boolean; fresh?: string; lensKey: string }) {
  const [open, setOpen] = useState(false);
  const [part, setPart] = useState<{ events: StoredEvent[]; done: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const w = runWords(run, { live, needs });
  const read = (after: number) => {
    setLoading(true);
    setError(null);
    api<Page>(`/api/sessions/${sid}/page?after=${after}&limit=${PART}`)
      .then((p) => {
        const mine = onBranch(p.events).filter((e) => e.seq > after && e.seq <= run.to);
        setPart((was) => ({ events: [...(was?.events ?? []), ...mine], done: p.end || !mine.length || mine.at(-1)!.seq >= run.to }));
      }, (e) => setError(failed(e, { at: "lens run", session_id: sid })))
      .finally(() => setLoading(false));
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !part) read(run.from - 1);
  };
  // A stretch that grew since it was opened (it is the one at work) has more to read.
  const more = !!part && (!part.done || (part.events.at(-1)?.seq ?? run.from) < run.to);
  return (
    <div className="k-lens-run row-cv" data-testid="lens-run" data-state={w.state} data-open={open || undefined} data-new-since={fresh} data-lens-key={lensKey} data-events={`${run.first} ${run.last}`}>
      <button type="button" className="k-lens-line" data-testid="lens-run-toggle" aria-expanded={open} title={w.took} onClick={toggle}>
        <span className="k-lens-dot" aria-hidden="true" />
        <span className="k-lens-came" data-testid="lens-run-came">{w.came}</span>
        <span className="k-lens-took" data-testid="lens-run-took">{w.took}</span>
        <ChevronRight className="k-lens-chev size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div className="k-lens-stream" data-testid="lens-run-stream">
          {part && part.events.length > 0 && <StreamRows sessionId={sid} events={part.events} />}
          {loading && <p className="text-caption text-faint" role="status">Reading this stretch</p>}
          {error && <p className="text-caption text-warn" role="status">This stretch did not load: {error}</p>}
          {!loading && (error || more) && (
            <button type="button" data-testid="lens-run-more" className="k-btn self-start" onClick={() => read(part?.events.at(-1)?.seq ?? run.from - 1)}>
              {error ? "Try again" : "Show the rest of this stretch"}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// What a reply's turn took, under it, and its words to copy.
function ReplyFoot({ e, turn }: { e: StoredEvent; turn?: EndFacts }) {
  const text = ((e.data.blocks ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text!).join("\n\n");
  const figures = [turn?.ms ? span(turn.ms) : "", turn?.cost ? dollars(turn.cost) : ""].filter(Boolean).join(", ");
  return (
    <div className="k-turn-foot -mt-1 flex h-7 items-center gap-0.5" data-quiet="">
      {text && <CopyButton text={text} label="Copy the reply" testid="copy-reply" className="size-7" />}
      {figures && <span className="k-lens-figs ml-2 text-micro tabular-nums text-faint" data-testid="lens-reply-took">{figures}</span>}
    </div>
  );
}

const Shown = memo(function Shown({ sid, e, turn, fresh, lensKey }: { sid: string; e: StoredEvent; turn?: EndFacts; fresh?: string; lensKey: string }) {
  const events = useMemo(() => [e], [e]);
  return (
    <div className={cn("flex flex-col gap-[var(--k-row-gap,1rem)]", e.kind === "assistant" && "k-lens-reply")} data-lens-item={e.kind === "user" ? "you" : "reply"} data-new-since={fresh} data-lens-key={lensKey}>
      <StreamRows sessionId={sid} events={events} />
      {e.kind === "assistant" && <ReplyFoot e={e} turn={turn} />}
    </div>
  );
});

export function Lens({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const watch = useWatch(session);
  const [data, setData] = useState<LensPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useRef<LensPage | null>(null);
  now.current = data;
  // One read at a time; what changes meanwhile is read once after it.
  const busy = useRef(false), again = useRef(false), soon = useRef(0);
  const pull = () => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    const was = now.current;
    const q = was?.stable && was.stable_id ? `?after=${was.stable}&at=${encodeURIComponent(was.stable_id)}` : "";
    api<LensPage>(`/api/sessions/${sessionId}/lens${q}`)
      .then((r) => { setError(null); setData((d) => merged(d, r)); }, (e) => setError(failed(e, { at: "lens", session_id: sessionId })))
      .finally(() => { busy.current = false; if (again.current) { again.current = false; pull(); } });
  };
  const head = session?.head;
  useEffect(() => {
    if (!now.current) { pull(); return; }
    clearTimeout(soon.current);
    soon.current = window.setTimeout(pull, 600);
  }, [head]);
  useEffect(() => () => clearTimeout(soon.current), []);
  useEffect(() => {
    const onSent = (e: Event) => { if ((e as CustomEvent<string>).detail === sessionId) pull(); };
    addEventListener("keel:sent", onSent);
    return () => removeEventListener("keel:sent", onSent);
  }, [sessionId]);

  const items = useMemo(() => (data ? joinRuns(data.items) : []), [data]);
  const working = session?.phase === "working";
  // The owner's own turn runs (a message of his has no reply yet): its reply streams here.
  const lastYou = items.findLastIndex((x) => x.t === "you");
  const awaited = working && lastYou >= 0 && !items.slice(lastYou).some((x) => x.t === "reply");

  // ---------- Where what is new starts (lib/place.ts keeps how far the owner has read) ----------
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [fresh, setFresh] = useState<{ key: string; at: number } | null>(null);
  const [freshAt, setFreshAt] = useState<"above" | "below" | null>(null);
  const saw = useRef(false), going = useRef(0), arrived = useRef(false);
  const markRead = () => {
    const last = now.current?.last;
    if (last) putPlace(sessionId, { read: last.id, readSeq: last.seq, readAt: Date.now() });
  };
  const endFresh = () => { clearTimeout(going.current); going.current = 0; saw.current = false; setFresh(null); markRead(); };
  useEffect(() => {
    if (!data || arrived.current) return;
    arrived.current = true;
    const p = placeOf(sessionId);
    if (p?.readSeq === undefined) return markRead(); // the first sight of it on this device: nothing is new
    const first = items.find((x) => endOf(x) > p.readSeq!);
    if (first && (data.last?.seq ?? 0) > p.readSeq) setFresh({ key: keyOf(first), at: first.t === "run" ? first.ts0 : first.ts });
  }, [data]);
  const freshEl = () => (fresh ? content.current?.querySelector<HTMLElement>(`[data-lens-key="${CSS.escape(fresh.key)}"]`) ?? null : null);
  const look = () => {
    const el = scroller.current;
    if (!el || document.hidden) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const here = presentAt(sessionId);
    if (!fresh) { if (here && atEnd && now.current) markRead(); return; }
    const r = freshEl()?.getBoundingClientRect(), v = el.getBoundingClientRect();
    const where = !r ? "above" : r.top < v.top - 4 ? "above" : r.top > v.bottom - 24 ? "below" : null;
    if (where !== freshAt) setFreshAt(where);
    if (here && !where) saw.current = true;
    if (here && saw.current && atEnd && !going.current) going.current = window.setTimeout(endFresh, 4000);
  };
  const looks = useRef(look);
  looks.current = look;
  useEffect(() => { const t = setTimeout(() => looks.current(), 200); return () => clearTimeout(t); }, [items, fresh]);
  useEffect(() => () => clearTimeout(going.current), []);
  const toFresh = () => {
    const el = scroller.current, on = freshEl();
    if (!el || !on) return;
    stick.current = false;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    el.scrollTop += on.getBoundingClientRect().top - el.getBoundingClientRect().top - 1.25 * rem;
    looks.current();
  };

  // ---------- The end is followed while the reader is at it ----------
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [items, awaited]);
  useEffect(() => {
    const c = content.current, el = scroller.current;
    if (!c || !el) return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(c);
    return () => ro.disconnect();
  }, [!!data]);

  if (!session) return <div className="flex-1" />;
  const needs = watch === "need";
  const lastRun = items.findLastIndex((x) => x.t === "run");
  const said = (it: LensItem) => (fresh && keyOf(it) === fresh.key ? newSinceAt(clock(fresh.at)) : undefined);
  return (
    <div className="k-reading-room relative min-h-[clamp(0px,calc((100%-24rem)/2),6rem)] flex-1">
      <div
        ref={scroller}
        className="k-reading relative h-full overflow-y-auto [scrollbar-gutter:stable] [overflow-anchor:none]"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          looks.current();
        }}
      >
        <div ref={content} className="k-transcript k-lens mx-auto flex max-w-[48rem] flex-col gap-[var(--k-row-gap,1rem)] px-4 py-8 md:px-6" data-testid="lens">
          <div className="k-lens-head" data-pinned="1">
            <button type="button" data-testid="lens-to-stream" title={data?.earlier ? "This shows the last few days; the full stream has every turn." : "Every turn, every call"} onClick={() => setLensView(sessionId, "stream")}>Show the full stream</button>
          </div>
          {error && !data && (
            <p role="status" className="text-caption text-warn" data-testid="lens-failed">
              The conversation did not load: {error}{" "}
              <button type="button" className="k-btn ml-1" onClick={pull}>Try again</button>
            </p>
          )}
          {data && !items.length && <p className="text-caption text-faint" data-testid="lens-empty">No messages yet.</p>}
          {items.map((it, i) => {
            const k = keyOf(it);
            if (it.t === "run") return <RunLine key={k} lensKey={k} sid={sessionId} run={it} live={working && i === items.length - 1} needs={needs && i === lastRun && i === items.length - 1} fresh={said(it)} />;
            const e = data!.events[it.id];
            if (!e) return null;
            return <Shown key={k} lensKey={k} sid={sessionId} e={e} turn={it.t === "reply" ? it.turn : undefined} fresh={said(it)} />;
          })}
          {awaited && <Live sessionId={sessionId} working asking={false} elsewhere={null} onTail={() => {}} />}
        </div>
      </div>
      {fresh && freshAt && (
        <div className="k-new-bar">
          <span className="k-new-jump">
            <button type="button" data-testid="new-since-jump" data-where={freshAt} onClick={toFresh}>{freshAt === "above" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}{newSinceAt(clock(fresh.at))}</button>
            <button type="button" data-testid="new-since-read" aria-label={MARK_READ} title={MARK_READ} onClick={endFresh}><Check className="size-3.5" /></button>
          </span>
        </div>
      )}
    </div>
  );
}
