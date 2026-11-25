import { Dialog } from "@base-ui/react/dialog";
import { Activity, Bug, Check, CheckCheck, ChevronRight, ClipboardCopy, CornerDownRight, RotateCcw, Wrench, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { agentCanFix, rowFailure, stoppedOn } from "../lib/failure.ts";
import { copyBundle, fixThis, openTrace, type Span, traceOfTurn } from "../lib/observe.ts";
import type { ErrorRecord, ErrorSite } from "../../../src/core/types.ts";
import { elsewhere, ERROR_STATE, errorState, healedWords } from "../../../src/admin/error-rows.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { footSheet } from "./ui.tsx";
import { HelperLook } from "./HelperLook.tsx";
import { modelOf } from "./Mark.tsx";
import { Seg, tabId } from "./Seg.tsx";
import { FailureActions } from "./TurnFailure.tsx";
import { IncidentList } from "./IncidentBand.tsx";
import type { Cause } from "../../../src/admin/stall-cause.ts";
import { CAUSE_LABEL, ownDoing, secs } from "../../../src/admin/stall-rows.ts";

// One row per kind of failure (the daemon folds repeats into a count), with
// every session it happened in (each with its own count, latest time, and a
// way to that session's own turn and trace) and a way to mark it fixed. A
// resolved kind that happens again comes back to Open. Marked read, a kind
// stays on the list but leaves the badge; it is unread again when it happens
// again. A kind whose every occurrence a retry healed is Recovered: kept, and
// out of the open list and the badge until it happens without healing.
const tool = "k-btn";

// What the failing request's span says: the route, the attempt, the HTTP status and the provider's request id.
function Wire({ s }: { s: Span }) {
  const w = s.attrs.wire ?? {};
  const bits = [s.attrs.route, s.attrs.attempt ? `attempt ${s.attrs.attempt}` : "", w.status ?? s.attrs.http_status ? `HTTP ${w.status ?? s.attrs.http_status}` : "", w.request_id ? `request ${w.request_id}` : "", s.error_type ?? ""].filter(Boolean);
  return <div className="font-mono text-micro text-muted" data-testid="error-wire">{bits.join("  ·  ")}</div>;
}

// What took the time of a stall of the daemon: each part the watcher saw,
// the largest first, and what the machine said meanwhile.
function StallCause({ c }: { c: Cause }) {
  const p = c.pressure ?? {};
  const machine = [
    c.load !== undefined ? `load ${c.load.toFixed(1)}` : "",
    p.cpu !== undefined ? `CPU pressure ${Math.round(p.cpu)}%` : "",
    p.io !== undefined ? `IO pressure ${Math.round(p.io)}%` : "",
    p.memory !== undefined ? `memory pressure ${Math.round(p.memory)}%` : "",
    c.suspended_ms ? `suspended ${secs(c.suspended_ms)}` : "",
  ].filter(Boolean);
  const total = c.shares.reduce((n, s) => n + s.ms, 0) || 1;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-raised p-2.5" data-testid="error-cause" data-kind={c.kind}>
      <div className="flex items-baseline gap-2 text-caption">
        <span className={cn("font-medium", ownDoing(c.kind) ? "text-warn" : "text-fg")}>{CAUSE_LABEL[c.kind] ?? CAUSE_LABEL.unknown}</span>
        <span className="text-muted">{ownDoing(c.kind) ? "the daemon's own doing" : c.kind === "unknown" ? c.text : "the machine did not run the daemon"}</span>
      </div>
      {c.shares.filter((s) => s.ms >= 50).map((s) => (
        <div key={s.key} className="grid grid-cols-[3rem_4rem_1fr] items-baseline gap-2 text-caption" data-testid="error-cause-share">
          <span className="tabular-nums text-fg">{secs(s.ms)}</span>
          <span className="h-1 self-center overflow-hidden rounded-full bg-sunken"><span className={cn("block h-full rounded-full", ownDoing(s.kind) ? "bg-warn" : "bg-line-strong")} style={{ width: `${Math.max(4, Math.round((s.ms / total) * 100))}%` }} /></span>
          <span className="min-w-0 break-words text-muted">{s.what}</span>
        </div>
      ))}
      {machine.length > 0 && <div className="text-micro text-faint">Machine then: {machine.join(", ")}</div>}
      {c.note && <div className="text-micro text-faint">Not named: {c.note}.</div>}
    </div>
  );
}

// One session a kind happened in: its count, when it last did, whether a
// retry healed it, and the way to that session's own turn, trace and bundle.
function Site({ e, s }: { e: ErrorRecord; s: ErrorSite }) {
  const title = useStore((st) => st.sessions[s.session_id]?.title) || s.title || "a session";
  const [copied, setCopied] = useState(false);
  const healed = healedWords(s);
  const open = () => {
    if (s.turn_event) setUI({ focusEvent: s.turn_event });
    setUI({ errors: false });
    navigate({ name: "session", id: s.session_id });
  };
  const trace = async () => {
    const span = s.span_id ? await api<{ span: Span }>(`/api/debug/spans/${s.span_id}`).then((r) => r.span).catch((err) => { if (err?.status === 404) return null; throw err; }) : null;
    if (span) openTrace(span.session_id, span.trace_id, span.span_id);
    else if (s.turn_event) openTrace(s.session_id, traceOfTurn(s.turn_event));
  };
  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm py-0.5 pl-1 pr-0.5 text-caption hover:bg-sunken" data-testid="error-site" data-session={s.session_id}>
      <span className="text-right tabular-nums text-fg" data-testid="error-site-count">{s.count}x</span>
      <button type="button" onClick={open} className="flex min-w-0 items-baseline gap-2 text-left text-muted hover:text-fg" title={`Opens ${title}${s.turn_event ? " at the turn it last failed in" : ""}`} data-testid="error-site-open">
        <span className="truncate text-fg">{title}</span>
        <span className="shrink-0 tabular-nums text-faint" title={when(s.ts)}>{ago(s.ts)}</span>
        {healed && <span className="shrink-0 text-ok" data-testid="error-site-healed">{healed}</span>}
      </button>
      <span className="flex items-center gap-0.5">
        {(s.turn_event || s.span_id) && (
          <button type="button" className="k-line-act" aria-label={`Trace of the failure in ${title}`} title="Opens this session's own trace at the request or tool call that failed" onClick={() => trace().catch(reportError)} data-testid="error-site-trace">
            <Activity className="size-3.5" />
          </button>
        )}
        <button type="button" className="k-line-act" aria-label={`Copy the debug bundle of the failure in ${title}`} title="Copies the debug bundle of this session's own failure" onClick={(ev) => copyBundle({ error_id: e.id, session_id: s.session_id }, ev.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })} data-testid="error-site-bundle">
          {copied ? <Check className="size-3.5 text-ok" /> : <ClipboardCopy className="size-3.5" />}
        </button>
      </span>
    </li>
  );
}

// Every session the kind happened in, newest first; the first few, then the rest on request.
const SITES_SHOWN = 6;
function Sites({ e }: { e: ErrorRecord }) {
  const [all, setAll] = useState(false);
  const sites = e.sites ?? [];
  const rest = elsewhere(e);
  if (!sites.length) return null;
  const shown = all ? sites : sites.slice(0, SITES_SHOWN);
  return (
    <div className="flex flex-col gap-1" data-testid="error-sites">
      <div className="text-caption text-muted">{sites.length === 1 ? "Happened in one session" : `Happened in ${sites.length} sessions`}{rest > 0 ? `, and ${rest} ${rest === 1 ? "time" : "times"} with no session recorded` : ""}</div>
      <ul className="flex flex-col">{shown.map((s) => <Site key={s.session_id} e={e} s={s} />)}</ul>
      {sites.length > shown.length && (
        <button type="button" className="self-start rounded-sm px-1 text-caption text-muted hover:text-fg" onClick={() => setAll(true)} data-testid="error-sites-more">{sites.length - shown.length} more sessions</button>
      )}
    </div>
  );
}

function Row({ e }: { e: ErrorRecord }) {
  const session = useStore((s) => (e.session_id ? s.sessions[e.session_id] : undefined));
  const modelName = useStore((s) => s.models.find((m) => m.id === session?.model)?.name);
  // The span this failure names, once asked for: kept, or gone (null: spans are pruned after a while).
  const [got, setGot] = useState<{ id: string; span: Span | null }>();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [stack, setStack] = useState(false);
  // What fits the failure is offered on the row, folded or not: a provider's
  // failure gets the acts of the session's own failure box (the page that fixes
  // it, and Try again and another model while its session is stopped on it);
  // Fix this goes only where an agent handed the bundle could fix the cause.
  const failure = rowFailure(e);
  const live = useStore((st) => !!e.session_id && stoppedOn(st.errors, e.session_id, st.sessions[e.session_id]?.settings.failed_ms) === e.id);
  const fixable = agentCanFix(e);
  const acts = !!failure && !!(live || failure.fix || failure.page);
  // One primary action a row, and only where there is one to lead with: the page that fixes it, else trying again.
  // The rest, Fix this included, are text.
  const n = e.count ?? 1;
  const unread = !e.read_ts;
  const state = errorState(e);
  const sited = (e.sites?.length ?? 0) > 0;
  const target = { error_id: e.id };
  // The tooltip of the row: the session it happened in and the model it ran on.
  const where = e.session_id ? `in ${session?.title || e.sites?.[0]?.title || "its session"}${session ? ` · ${modelName ?? modelOf(session.model)}` : ""}${(e.sites?.length ?? 0) > 1 ? ` and ${e.sites!.length - 1} more ${e.sites!.length === 2 ? "session" : "sessions"}` : ""}` : undefined;
  const named = got && got.id === e.span_id ? got.span : undefined;
  const find = async () => {
    const id = e.span_id;
    if (!id || named !== undefined) return named ?? null;
    // Only a 404 says the span is gone. Any other failure is reported and asked again next time.
    const span = await api<{ span: Span }>(`/api/debug/spans/${id}`).then((r) => r.span).catch((err) => { if (err?.status === 404) return null; throw err; });
    setGot({ id, span });
    return span;
  };
  // Asked when the row opens, and again when a new occurrence names another span while it is open.
  useEffect(() => { if (open) find().catch((err) => reportError(err, { at: "error span" })); }, [open, e.span_id]);
  // The trace opens on the span that failed, in whatever trace holds it: a
  // request outside any turn (a side question) has a trace of its own. A
  // failure with no span, or whose span is gone, opens its turn's trace.
  const toSpan = !!e.span_id && named !== null;
  const trace = async () => {
    const s = await find();
    if (s) openTrace(s.session_id, s.trace_id, s.span_id);
    else if (e.turn_event) openTrace(e.session_id!, traceOfTurn(e.turn_event));
  };
  const goTo = () => {
    if (e.turn_event) setUI({ focusEvent: e.turn_event });
    setUI({ errors: false });
    navigate({ name: "session", id: e.session_id! });
  };
  return (
    <div>
    <details className="group relative rounded-md px-3 py-2 hover:bg-hover" data-testid="error-row" data-read={unread ? undefined : "1"} onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
      {/* Where it happened (the session and its model) is the row's tooltip; a touch screen has no tooltip, so there it is a line when the row is opened. */}
      <summary className="flex cursor-default list-none flex-col gap-1.5 text-ui [&::-webkit-details-marker]:hidden" title={where} data-testid="error-head">
        <span className="flex items-baseline gap-2 max-sm:items-center">
        {/* The row opens: a marker of its own says so, and turns when it has. */}
        <ChevronRight aria-hidden className="size-3.5 shrink-0 self-center text-faint transition-transform group-open:rotate-90 group-open:text-fg" data-testid="error-marker" />
        {/* The message leads; where it came from is a quiet word after it, not a red tag on every row (the drawer is all failures). */}
        {/* On a phone a row is one line: the message cut to the room, the count and the age. Opened, the message is read whole
            and the source, the places and the acts are under it. */}
        {/* The message has the width: at least half the line, the words after it give way first (cut, or out of the folded line). */}
        <span className={cn("min-w-[55%] flex-1 truncate max-md:group-open:whitespace-normal max-md:group-open:break-words", unread ? "font-medium text-fg" : "text-muted")} data-testid="error-message">{e.message}</span>
        {/* Where it came from is said when the row is open (and in the drawer's filters): not a word on every folded line. */}
        <span className="hidden shrink-0 text-micro text-faint group-open:inline" data-testid="error-source">{e.source}</span>
        {/* Where it happened, on the folded line (a phone has it on a line of its own below). */}
        {e.session_id && <span className="min-w-[2.5rem] max-w-[7rem] shrink truncate text-micro text-faint max-sm:hidden pointer-coarse:hidden" title={where} data-testid="error-in">in {session?.title || e.sites?.[0]?.title || "its session"}</span>}
        {state === "recovered" && <span className="shrink-0 text-micro text-ok" title={`Every time, a retry of the request passed. Last healed ${when(e.recovered_ts!)}`} data-testid="error-recovered">{ERROR_STATE.recovered}</span>}
        {n > 1 && (
          <span className="k-face-figure shrink-0 text-micro text-muted" data-testid="error-count" title={`${n} times since ${when(e.first_ts ?? e.ts)}${(e.sites?.length ?? 0) > 1 ? `, in ${e.sites!.length} sessions` : ""}`}>
            {n}x
          </span>
        )}
        {/* One age: how long ago it last happened; the time itself is its tooltip. */}
        <span className="shrink-0 text-micro text-faint tabular-nums" title={when(e.ts)} data-testid="error-time">{ago(e.ts)}</span>
        {state === "open" && (
          <button
            type="button"
            className="grid size-6 shrink-0 place-items-center self-center rounded-md text-faint hover:bg-hover hover:text-fg"
            aria-label={unread ? "Mark read" : "Mark unread"}
            title={unread ? "Mark read: it leaves the badge and stays here" : "Mark unread"}
            onClick={(ev) => { ev.preventDefault(); actions.readError(e.id, unread).catch(reportError); }}
            data-testid="error-read"
          >
            {unread ? <span className="size-2 rounded-full bg-fg" /> : <Check className="size-3.5" />}
          </button>
        )}
        </span>
        {/* The acts of the row, on the row: buttons and links here do not fold or unfold it. */}
        {/* Where it happened: the session as a link, and the model it ran on. */}
        {e.session_id && (
          <span className="ml-[1.375rem] hidden min-w-0 flex-wrap items-baseline gap-x-1.5 text-caption text-muted max-sm:group-open:flex pointer-coarse:group-open:flex" data-testid="error-where">
            <span>in</span>
            <button type="button" onClick={(ev) => { ev.preventDefault(); goTo(); }} className="min-w-0 max-w-full truncate rounded-sm text-accent-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="error-where-session" title="Open the session at this failure">
              {session?.title || e.sites?.[0]?.title || "its session"}
            </button>
            {session && <><span aria-hidden="true">·</span><span className="truncate" data-testid="error-where-model">{modelName ?? modelOf(session.model)}</span></>}
            {(e.sites?.length ?? 0) > 1 && <span className="text-faint">and {e.sites!.length - 1} more {e.sites!.length === 2 ? "session" : "sessions"}</span>}
          </span>
        )}
        {(acts || fixable) && (
          // Where there is a pointer the acts appear on the row when it is hovered or a key is in it (they are in the tab
          // order meanwhile); on a touch screen they are a line of their own.
          <span className={cn("ml-[1.375rem] hidden flex-wrap items-center gap-1.5 group-open:flex sm:pointer-fine:flex", "sm:pointer-fine:absolute sm:pointer-fine:right-10 sm:pointer-fine:top-1.5 sm:pointer-fine:z-10 sm:pointer-fine:ml-0 sm:pointer-fine:rounded-md sm:pointer-fine:bg-raised sm:pointer-fine:pl-2 sm:pointer-fine:opacity-0 sm:pointer-fine:shadow-sm sm:pointer-fine:group-hover:bg-[image:linear-gradient(var(--hover),var(--hover))] sm:pointer-fine:group-hover:opacity-100 sm:pointer-fine:group-focus-within:opacity-100")} data-testid="error-acts">
            {acts && <FailureActions f={failure!} s={session} retry={live} quiet />}
            {fixable && (
              <button
                type="button"
                className={tool}
                data-quiet=""
                disabled={fixing}
                title="Starts a session that reads this failure's debug bundle and fixes the cause"
                onClick={() => { setFixing(true); fixThis(target).catch(reportError).finally(() => setFixing(false)); }}
                data-testid="error-fix"
              >
                <Wrench className="size-3.5 text-accent" /> {fixing ? "Starting" : "Fix this"}
              </button>
            )}
          </span>
        )}
      </summary>
      <div className="mt-2 ml-[1.375rem] flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
          <span>First <span className="tabular-nums text-fg">{when(e.first_ts ?? e.ts)}</span></span>
          {n > 1 && <span>Last <span className="tabular-nums text-fg">{when(e.ts)}</span></span>}
          {e.read_ts && state === "open" && <span>Read <span className="tabular-nums text-fg">{when(e.read_ts)}</span></span>}
          {state === "recovered" && <span>Healed by a retry <span className="tabular-nums text-fg">{when(e.recovered_ts!)}</span></span>}
          {e.resolved_ts && <span>Resolved <span className="tabular-nums text-fg">{when(e.resolved_ts)}</span></span>}
        </div>
        {e.unwritten && (
          <p className="text-caption text-warn" data-testid="error-unwritten">
            Kept in memory: the store did not take this row ({e.unwritten}). It is written as soon as the store takes rows again, and is lost if the daemon stops first.
          </p>
        )}
        {named && <Wire s={named} />}
        <Sites e={e} />
        {e.context?.kind === "stall" && e.context.cause && <StallCause c={e.context.cause as Cause} />}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={tool}
            data-quiet=""
            title="The failure, its trace, the transcript before it and the daemon log, as Markdown"
            onClick={(e) => copyBundle(target, e.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })}
            data-testid="error-bundle"
          >
            <ClipboardCopy className="size-3.5" /> {copied ? "Copied" : "Copy debug bundle"}
          </button>
          {e.session_id && (e.turn_event || (e.span_id && named !== null)) && (
            <button
              type="button"
              className={tool}
              data-quiet=""
              title={toSpan ? "Opens the trace at the request or tool call that failed" : e.span_id ? "Opens the trace of the turn it failed in: the span that failed is no longer kept" : "Opens the trace of the turn it failed in"}
              onClick={() => trace().catch(reportError)}
              data-testid="error-trace"
            >
              <Activity className="size-3.5" /> Trace
            </button>
          )}
          {e.session_id && !sited && (
            <button type="button" onClick={goTo} className="k-btn max-w-80" data-quiet="" data-testid="error-session">
              <CornerDownRight className="size-3.5 shrink-0" />
              <span className="truncate">{n > 1 ? "Last in " : ""}{session?.title || (n > 1 ? "its session" : "Open the session")}</span>
              {e.turn_event && <span className="shrink-0 text-faint">at its turn</span>}
            </button>
          )}
          <button
            type="button"
            onClick={() => actions.resolveError(e.id, !e.resolved_ts).catch(reportError)}
            className="k-btn ml-auto"
            data-quiet=""
            data-testid="error-resolve"
          >
            {e.resolved_ts ? <><RotateCcw className="size-3.5" /> Open again</> : <><Check className="size-3.5 text-ok" /> Resolve</>}
          </button>
        </div>
        {/* What a program reads (the context and the stack), folded under a disclosure of its own. (Not a
            nested <details>: the row's own <summary> stays the only one.) */}
        {(e.stack || e.context) && (
          <div className="flex flex-col gap-1.5">
            <button type="button" aria-expanded={stack} onClick={() => setStack(!stack)} className="flex w-fit items-center gap-1 rounded-sm text-caption text-muted hover:text-fg" data-testid="error-details">
              <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", stack && "rotate-90")} /> Details
            </button>
            {stack && (
              <pre className="max-h-64 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-micro text-muted whitespace-pre-wrap break-all" data-testid="error-stack">
                {e.context ? JSON.stringify(e.context, null, 2) + "\n\n" : ""}{e.stack}
              </pre>
            )}
          </div>
        )}
      </div>
    </details>
    <HelperLook errorId={e.id} />
    </div>
  );
}

export function ErrorsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const errors = useStore((s) => s.errors);
  const [tab, setTab] = useState<"open" | "recovered" | "resolved">("open");
  const panel = useId();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const openList = errors.filter((e) => errorState(e) === "open");
  const unread = openList.filter((e) => !e.read_ts);
  const recovered = errors.filter((e) => errorState(e) === "recovered");
  const resolved = errors.filter((e) => e.resolved_ts);
  const list = tab === "open" ? (unreadOnly ? unread : openList) : tab === "recovered" ? recovered : resolved;
  // A few open errors are a popover over the corner they are reached from, not a drawer of a page's height; the
  // tabs that hold nothing are not drawn, and with only one left there is no strip.
  const popover = tab === "open" && openList.length < 3;
  const tabs = ([["open", ERROR_STATE.open, openList.length], ["recovered", ERROR_STATE.recovered, recovered.length], ["resolved", ERROR_STATE.resolved, resolved.length]] as const).filter(([id, , n]) => n > 0 || id === tab);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={cn("fixed inset-0 z-40 transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0", popover ? "bg-transparent" : "bg-overlay")} />
        <Dialog.Popup
          data-testid="errors-panel"
          data-mode={popover ? "popover" : "drawer"}
          data-float
          className={popover
            ? "k-surface fixed bottom-12 left-3 z-50 max-h-[min(34rem,calc(100dvh-4rem))] w-[min(30rem,calc(100vw-1.5rem))] transition-[transform,opacity] duration-(--dur-move) data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0"
            : footSheet()}
        >
          {/* On a phone the note has a line of its own under the title, read whole. */}
          <div className="k-surface-head k-errors-head">
            <Bug className="k-surface-icon" />
            <Dialog.Title className="k-surface-title">Errors</Dialog.Title>
            {!popover && <span className="k-surface-note" data-testid="errors-note">from the daemon, the page, providers and tools</span>}
            <Dialog.Close className="k-surface-close" aria-label="Close">
              <X />
            </Dialog.Close>
          </div>
          <IncidentList />
          {/* One band: which errors, then what to do with the open ones at its right end. */}
          <div className={cn("flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3 py-2 whitespace-nowrap", tabs.length > 1 || (tab === "open" && openList.length > 1) ? "flex" : "hidden")}>
            {tabs.length > 1 && <Seg
              wrap
              kind="tabs"
              panel={panel}
              label="Which errors"
              value={tab}
              onChange={setTab}
              options={tabs.map(([id, label, n]) => ({ value: id, label: <>{label}<span className="text-micro tabular-nums text-faint">{n}</span></> }))}
            />}
            <div className={cn("ml-auto items-center gap-1 max-md:flex-wrap", tab === "open" && openList.length > 0 ? "flex" : "hidden")}>
            {tab === "open" && !popover && (
              <label className="flex h-ctl-md items-center gap-1.5 px-1.5 text-caption text-muted max-md:h-11">
                <input type="checkbox" checked={unreadOnly} onChange={(ev) => setUnreadOnly(ev.currentTarget.checked)} className="accent-[var(--accent)]" data-testid="errors-unread-only" />
                Unread only
              </label>
            )}
            {tab === "open" && unread.length > 0 && (
              <button type="button" onClick={() => actions.readAllErrors(unread).catch(reportError)} className="flex h-ctl-md items-center gap-1.5 rounded-md px-2.5 text-caption text-muted hover:bg-hover hover:text-fg" data-testid="errors-read-all">
                <CheckCheck className="size-3.5" /> Mark all read
              </button>
            )}
            {tab === "open" && openList.length > 1 && (
              <button type="button" onClick={() => actions.resolveAllErrors(openList).catch(reportError)} className="h-ctl-md rounded-md px-2.5 text-caption text-muted hover:bg-hover hover:text-fg">
                Resolve all
              </button>
            )}
            </div>
          </div>
          <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} className="flex-1 overflow-y-auto p-2">
            {list.length === 0 && <p className="k-empty px-3 py-4">{tab === "open" ? (unreadOnly && openList.length ? "Everything open is read." : "Nothing open has failed.") : tab === "recovered" ? "Nothing failed and then passed on a retry." : "Nothing is marked resolved."}</p>}
            {list.map((e) => <Row key={e.id} e={e} />)}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
