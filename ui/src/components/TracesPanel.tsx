// The session's traces in the side panel: one per turn, newest first. A trace
// opens as a waterfall of its model requests and tool calls; a span shows what
// was sent (its shape), what the wire saw, and the failure, with "send again"
// for a failed request, the debug bundle and "fix this".
import { ClipboardCopy, RefreshCw, Send, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { copyBundle, fixThis, fmtMs, type Span, spanMs, traceFocus } from "../lib/observe.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";

const tone = (s: Span["status"]) => ({ ok: "bg-ok", error: "bg-danger", running: "bg-accent", interrupted: "bg-line-strong" })[s];
const btn = "flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50";
// The picked row of a list: lifted off the panel, with an ink bar at its edge. Read at a glance in both themes.
const picked = "relative bg-raised hover:bg-raised before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent";
const label = (s: Span) => (s.kind === "turn" ? `${s.attrs.parent_session ? "Subagent turn" : "Turn"} on ${String(s.attrs.model ?? "").split(":").pop()}` : s.kind === "tool" ? s.attrs.tool : s.attrs.replay_of ? `Replay on ${s.attrs.route}` : s.attrs.model);

export function TracesPanel({ session }: { session: Session }) {
  const [list, setList] = useState<Span[] | null>(null);
  const focus = useSyncExternalStore(traceFocus.subscribe, traceFocus.get);
  const [open, setOpen] = useState<string | null>(focus?.trace ?? null);
  // The span to pick in the open trace, when something asked for one (an error's own span).
  const [span, setSpan] = useState<string | null>(focus?.span ?? null);
  // Counts the times a span was asked for: asking for the same one again picks it again.
  const [asks, setAsks] = useState(0);
  const show = (trace: string, pick: string | null = null) => { setOpen(trace); setSpan(pick); };
  const ends = useStore((s) => (s.events[session.id] ?? []).filter((e) => e.kind === "turn_end" || e.kind === "error").length);

  const load = useCallback(() => {
    api<{ traces: Span[] }>(`/api/debug/traces?session_id=${session.id}`).then((r) => {
      setList(r.traces);
      setOpen((o) => o ?? r.traces[0]?.trace_id ?? null);
    }).catch((e) => reportError(e, { at: "traces panel" }));
  }, [session.id]);
  useEffect(load, [load, ends]);
  useEffect(() => {
    if (!focus) return;
    show(focus.trace, focus.span);
    setAsks((n) => n + 1);
    traceFocus.set(null);
    // A trace made since the list was read (a side question's request) is not on it yet.
    if (list) load();
  }, [focus]);

  if (!list) return <p className="p-4 text-ui text-faint">Loading traces.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="traces-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-caption text-faint">One trace per turn: its model requests, tool calls and timings.</span>
        <button type="button" onClick={load} className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg" aria-label="Reload traces">
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      {list.length === 0 && <p className="k-empty px-4 py-4">No turn has run in this session yet.</p>}
      <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-line p-1.5">
        {list.map((t) => (
          <button
            key={t.span_id}
            type="button"
            onClick={() => show(t.trace_id)}
            data-testid="trace-row"
            data-status={t.status}
            aria-current={open === t.trace_id}
            className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-ui hover:bg-hover", open === t.trace_id && picked)}
          >
            <span className={cn("size-2 shrink-0 rounded-full", tone(t.status))} />
            <span className="w-16 shrink-0 text-caption tabular-nums text-faint" title={when(t.start_ms)}>{ago(t.start_ms)}</span>
            <span className="min-w-0 flex-1 truncate">{t.error ?? label(t)}</span>
            <span className="shrink-0 text-caption tabular-nums text-muted">{fmtMs(spanMs(t))}</span>
          </button>
        ))}
      </div>
      {open && <Trace key={`${open} ${span ?? ""} ${asks}`} id={open} span={span} ends={ends} onOpen={show} onReplayed={load} />}
    </div>
  );
}

// Depth first, children by start: a subagent's turn comes right under the call that started it.
function tree(spans: Span[]): { s: Span; depth: number }[] {
  const ids = new Set(spans.map((s) => s.span_id));
  const kids = new Map<string | null, Span[]>();
  for (const s of spans) {
    const p = s.parent_id && ids.has(s.parent_id) ? s.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  const out: { s: Span; depth: number }[] = [];
  const walk = (p: string | null, depth: number) => {
    for (const s of kids.get(p) ?? []) { out.push({ s, depth }); walk(s.span_id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

// `span`: the one to open on (the span an error names). Without it, or when the
// trace no longer holds it, the first failed request or call is picked.
// `ends`: how many turns of the session have ended. The open trace is read
// again when one does, so a trace opened while its turn ran shows how it ended.
// `onReplayed`: a request was sent again. The replay is a trace of its own, so the list is read again.
function Trace({ id, span, ends, onOpen, onReplayed }: { id: string; span: string | null; ends: number; onOpen: (trace: string) => void; onReplayed: () => void }) {
  const [spans, setSpans] = useState<Span[] | null>(null);
  const [sel, setSel] = useState<string | null>(span);
  // Spans are kept for a while: a trace opened from an old error may be gone.
  const [gone, setGone] = useState(false);
  const asked = useRef<HTMLButtonElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  // One read at a time: answers then arrive in the order they were asked, and
  // a read asked for meanwhile runs once the one in flight is back.
  const busy = useRef(false);
  const again = useRef(false);
  const load = useCallback(() => {
    if (busy.current) return void (again.current = true);
    busy.current = true;
    api<{ spans: Span[] }>(`/api/debug/traces/${id}`).then((r) => {
      setGone(false);
      setSpans(r.spans);
      setSel((s) => (s && r.spans.some((x) => x.span_id === s) ? s : (r.spans.find((x) => x.status === "error" && x.kind !== "turn") ?? r.spans[0])?.span_id ?? null));
    }).catch((e) => {
      if (e?.status !== 404) return reportError(e, { at: "trace" });
      // Gone: nothing is left to follow.
      setGone(true);
      setSpans(null);
    }).finally(() => {
      busy.current = false;
      if (again.current) { again.current = false; load(); }
    });
  }, [id]);
  useEffect(load, [load, ends]);
  // A span still running: looked at again every two seconds, so the calls a
  // turn makes show as they end, and a turn whose end was missed is caught up.
  // Not while the tab is hidden: it is read once when the tab shows again.
  const running = !!spans?.some((s) => s.status === "running");
  useEffect(() => {
    if (!running) return;
    const look = () => { if (!document.hidden) load(); };
    const t = setInterval(look, 2000);
    document.addEventListener("visibilitychange", look);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", look); };
  }, [running, load]);
  // In a long trace the span that was asked for may sit below the fold, and
  // its detail under every row: the row first, then the detail, which wins
  // when the two do not fit together (the row stays marked above it).
  const loaded = !!spans;
  useEffect(() => {
    if (!loaded || !asked.current) return;
    asked.current.scrollIntoView({ block: "nearest" });
    detail.current?.scrollIntoView({ block: "nearest" });
  }, [loaded]);
  if (gone) return <p className="k-empty px-4 py-4" data-testid="trace-gone">This trace is no longer kept.</p>;
  if (!spans) return null;
  // A retried request: every request row then says which attempt it is.
  const retried = spans.some((s) => s.kind === "request" && s.attrs.attempt > 1);
  const t0 = Math.min(...spans.map((s) => s.start_ms));
  const total = Math.max(1, Math.max(...spans.map((s) => (s.end_ms ?? Date.now()))) - t0);
  const pick = spans.find((s) => s.span_id === sel);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="trace-view">
      <div className="flex flex-col gap-px p-1.5" role="list" aria-label="Spans">
        {tree(spans).map(({ s, depth }) => (
          <button
            key={s.span_id}
            ref={s.span_id === span ? asked : undefined}
            type="button"
            role="listitem"
            aria-current={sel === s.span_id}
            onClick={() => setSel(s.span_id)}
            data-testid="span-row"
            data-status={s.status}
            data-kind={s.kind}
            data-depth={depth}
            className={cn("grid grid-cols-[minmax(0,11rem)_1fr_4.5rem] items-center gap-2 rounded-sm px-2 py-1 text-left text-caption hover:bg-hover", sel === s.span_id && picked)}
          >
            <span className={cn("flex min-w-0 items-baseline gap-1.5", depth ? "text-muted" : "font-medium", s.kind === "turn" && depth > 0 && "text-fg", s.status === "error" && "text-danger")} style={{ paddingLeft: `${depth * 0.75}rem` }}>
              <span className="truncate">{label(s)}</span>
              {retried && s.kind === "request" && s.attrs.attempt && <span className="shrink-0 font-normal tabular-nums text-faint" data-testid="span-attempt">attempt {s.attrs.attempt}</span>}
            </span>
            <span className={cn("relative h-2.5 rounded-xs", sel === s.span_id ? "bg-sunken" : "bg-sunken")}>
              <span
                className={cn("absolute inset-y-0 rounded-xs", tone(s.status), s.kind === "turn" && "opacity-40")}
                style={{ left: `${((s.start_ms - t0) / total) * 100}%`, width: `max(2px, ${(spanMs(s) / total) * 100}%)` }}
              />
            </span>
            <span className="text-right tabular-nums text-faint">{fmtMs(spanMs(s))}</span>
          </button>
        ))}
      </div>
      <div ref={detail}>{pick && <Detail s={pick} onReplayed={() => { load(); onReplayed(); }} onOpen={onOpen} />}</div>
    </div>
  );
}

function Fact({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <>
      <dt className="text-faint">{k}</dt>
      <dd className={cn("min-w-0 break-all text-fg", mono && "font-mono text-micro")}>{v}</dd>
    </>
  );
}

// A replay the model declined, in the words a declined turn uses: the category and the explanation when the provider gave them.
function declined(s: Span) {
  const d = s.attrs.result?.stop_details;
  return `Declined${d?.category ? ` (${d.category})` : ""} in ${fmtMs(spanMs(s))}${d?.explanation ? `: ${d.explanation}` : "."}`;
}

function Detail({ s, onReplayed, onOpen }: { s: Span; onReplayed: () => void; onOpen: (trace: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [replay, setReplay] = useState<{ ok: boolean; error?: string; text?: string; stop?: string; span: Span } | null>(null);
  const [copied, setCopied] = useState(false);
  const a = s.attrs;
  const w = a.wire ?? {};
  const u = a.result?.usage;
  // The bundle and the fix are about this span: its id goes with its turn and its error row.
  const target = { session_id: s.session_id, turn_event: a.turn_event as string | undefined, error_id: s.error_id ?? undefined, span_id: s.span_id };
  const again = async () => {
    setBusy(true);
    try {
      setReplay(await api(`/api/debug/spans/${s.span_id}/replay`, { method: "POST", body: "{}" }));
      onReplayed();
    } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2.5 border-t border-line px-3 py-3" data-testid="span-detail">
      <div className="flex items-baseline gap-2">
        <span className={cn("size-2 shrink-0 self-center rounded-full", tone(s.status))} />
        <span className="font-mono text-caption">{s.name}</span>
        <span className="text-caption text-faint">{s.status}{s.error_type ? `, ${s.error_type}` : ""}</span>
      </div>
      {s.error && <pre className="max-h-40 overflow-auto rounded-md border border-line bg-code p-2 font-mono text-micro whitespace-pre-wrap break-all text-danger">{s.error}</pre>}
      <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 text-caption">
        <Fact k="Started" v={when(s.start_ms)} />
        <Fact k="Took" v={s.end_ms === null ? `${fmtMs(spanMs(s))}, still running` : fmtMs(spanMs(s))} />
        <Fact k="Route" v={a.route} mono />
        <Fact k="Attempt" v={a.attempt} />
        <Fact k="First token" v={a.ttft_ms !== undefined ? fmtMs(a.ttft_ms) : undefined} />
        <Fact k="HTTP" v={w.status ?? a.http_status} />
        <Fact k="Endpoint" v={w.url} mono />
        <Fact k="Request id" v={w.request_id} mono />
        <Fact k="Headers after" v={w.headers_ms !== undefined ? fmtMs(w.headers_ms) : undefined} />
        <Fact k="Streamed" v={w.events !== undefined ? `${w.events} events, ${w.bytes_in ?? 0} bytes${w.last_event ? `, last ${w.last_event}` : ""}` : undefined} />
        <Fact k="Stop" v={a.result?.stop ?? a.reason} />
        <Fact k="Tokens" v={u ? `${u.input} in, ${u.cache_read} cached, ${u.cache_write} written, ${u.output} out` : undefined} />
        <Fact k="Sent" v={a.shape ? `${a.shape.messages} message${a.shape.messages === 1 ? "" : "s"}, ${a.shape.tools} tools, ${a.shape.system_chars} system chars${a.shape.effort ? `, effort ${a.shape.effort}` : ""}` : undefined} />
        <Fact k="Tool input" v={a.input_keys ? `${a.input_keys.join(", ") || "none"} (${a.input_bytes} bytes), ${a.result_bytes} bytes out` : undefined} />
        <Fact k="Span" v={s.span_id} mono />
        <Fact
          k="Started by"
          v={(a.links as { trace_id: string; span_id: string }[] | undefined)?.length && a.links.map((l: { trace_id: string; span_id: string }) => (
            <button key={l.span_id} type="button" className="text-accent hover:underline" onClick={() => onOpen(l.trace_id)} data-testid="span-link">
              the parent's spawn call
            </button>
          ))}
        />
      </dl>
      {w.error_body && <pre className="max-h-32 overflow-auto rounded-md border border-line bg-code p-2 font-mono text-micro whitespace-pre-wrap break-all text-muted">{w.error_body}</pre>}
      <div className="flex flex-wrap gap-2">
        {s.replayable && (
          <button type="button" className={btn} disabled={busy} onClick={() => again().catch(reportError)} data-testid="span-replay">
            <Send className="size-3.5" /> {busy ? "Sending" : "Send again"}
          </button>
        )}
        <button
          type="button"
          className={btn}
          onClick={(e) => copyBundle(target, e.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })}
          data-testid="span-bundle"
        >
          <ClipboardCopy className="size-3.5" /> {copied ? "Copied" : "Copy debug bundle"}
        </button>
        {s.status === "error" && (
          <button type="button" className={btn} onClick={() => fixThis(target).catch(reportError)} data-testid="span-fix">
            <Wrench className="size-3.5" /> Fix this
          </button>
        )}
      </div>
      {replay && (
        <p className={cn("rounded-md border px-2.5 py-2 text-caption", replay.ok ? "border-line text-fg" : "border-danger-soft bg-danger-soft text-danger")} data-testid="replay-result">
          {replay.ok ? `Answered in ${fmtMs(spanMs(replay.span))}${replay.text ? `: ${replay.text.slice(0, 300)}` : "."}` : replay.stop === "refusal" ? declined(replay.span) : `Failed again: ${replay.error}`}
        </p>
      )}
    </div>
  );
}

export default TracesPanel;
