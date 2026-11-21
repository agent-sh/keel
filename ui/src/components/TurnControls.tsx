// Controls the turn needs beside the composer: the queue (steers and queued
// prompts), the context meter with compaction, and the effort picker.
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ArrowUp, Check, ChevronDown, CornerDownRight, Gauge, GitBranch, Image as ImageIcon, Layers, ListPlus, Pencil, Play, RotateCcw, Send, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { lineage } from "../../../src/core/tree.ts";
import { COMPACT_SHARE, contextTokens } from "../../../src/engine/compact.ts";
import type { QueueItem } from "../../../src/core/types.ts";
import { isLive, useAuto } from "../lib/automation.ts";
import { actions, reportError, useStore, type ContextInfo, failed, showArchivedRefusal } from "../lib/store.ts";
import { switchSession } from "../lib/switch.ts";
import { seedComposer } from "../lib/ui.ts";
import { cn, fmtCost, fmtTokens } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";
import { composing } from "../lib/keys.ts";

const chipBtn = "grid size-6 place-items-center rounded-md text-faint hover:text-fg hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

// `place`: the row's index among the queued (not steered) prompts; `off`: it
// was queued on a branch the chat no longer shows.
function QueueRow({ q, sessionId, place, off }: { q: QueueItem; sessionId: string; place: number; off: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q.text);
  const canSave = !!text.trim() || !!q.images?.length; // a screenshot alone is a prompt
  // A correction that came too late (the prompt was sent meanwhile, the row
  // went away while it was being edited) is not lost: it goes to the message
  // box, unsent.
  const kept = useRef(false);
  const keep = (t: string) => {
    if (kept.current) return;
    kept.current = true;
    if (t.trim() && t.trim() !== q.text) seedComposer(t.trim(), sessionId, { append: true, notice: "That prompt was already sent; your correction is in the box, unsent." });
  };
  const live = useRef({ editing, text });
  live.current = { editing, text };
  useEffect(() => () => { if (live.current.editing) keep(live.current.text); }, []);
  const save = () => actions.queueEdit(sessionId, q.id, { text: text.trim() }).then(() => setEditing(false), (e) => {
    const st = (e as { status?: number }).status;
    if (st === 404 || st === 409) keep(text);
    else failed(e, { at: "queue edit" });
    setEditing(false);
  });
  // Moves and sends that lose a race to the turn are no failure: the row is gone.
  const act = (p: Promise<unknown>, at: string) => p.catch((e) => {
    if (showArchivedRefusal(e)) return;
    const st = (e as { status?: number }).status;
    if (st !== 404 && st !== 409) failed(e, { at });
  });
  // A wide row is one line: badge, text, cues, actions. A narrow one (by the
  // queue's own width) gives the text a line to itself, first, and wraps the
  // badge, the cues and the actions under it, so nothing is squeezed to nothing.
  const words = "order-first min-w-0 basis-full @md/queue:order-none @md/queue:flex-1 @md/queue:basis-0";
  return (
    <li className="group/q flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1 hover:bg-hover @md/queue:flex-nowrap" data-testid="queue-item">
      <span className={cn(
        "shrink-0 rounded px-1.5 py-px text-micro font-semibold uppercase tracking-wide",
        q.steer ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted",
      )}>
        {q.steer ? "Steer" : "Queued"}
      </span>
      {editing ? (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter" && canSave) save(); if (e.key === "Escape") setEditing(false); }}
          onBlur={() => setEditing(false)}
          className={cn(words, "rounded-md border border-line bg-sunken px-2 py-0.5 text-ui outline-none")}
        />
      ) : (
        <span className={cn(words, "truncate text-ui")} title={q.text}>{q.text}</span>
      )}
      {!editing && off && <span className="inline-flex shrink-0 items-center gap-1 text-caption text-warn" data-testid="queue-off-branch" title="Written while the chat showed another branch"><GitBranch className="size-3.5 shrink-0" />On another branch</span>}
      {!editing && !!q.images?.length && <span className="inline-flex shrink-0 items-center gap-1 text-caption text-faint" data-testid="queue-images"><ImageIcon className="size-3.5 shrink-0" />{q.images.length === 1 ? "1 image" : `${q.images.length} images`}</span>}
      <span className="ml-auto flex flex-wrap items-center justify-end opacity-60 group-hover/q:opacity-100 group-focus-within/q:opacity-100 touch:opacity-100 @md/queue:shrink-0 @md/queue:flex-nowrap">
        {!q.steer && place > 0 && (
          <button type="button" className={chipBtn} data-testid="queue-move-up" title="Move up one place" aria-label="Move up one place" onClick={() => act(actions.queueEdit(sessionId, q.id, { position: place - 1 }), "queue move")}>
            <ArrowUp className="size-3.5" />
          </button>
        )}
        <button type="button" className={chipBtn} title="Edit" aria-label="Edit" onClick={() => { setText(q.text); setEditing(true); }}>
          <Pencil className="size-3.5" />
        </button>
        {!q.steer && (
          <button type="button" className={chipBtn} title="Steer into the running turn instead" aria-label="Make it a steer" onClick={() => act(actions.queueEdit(sessionId, q.id, { steer: true }), "queue steer")}>
            <CornerDownRight className="size-3.5" />
          </button>
        )}
        {off ? (
          <>
            <button type="button" className={chipBtn} data-testid="queue-back-to-branch" title="Show the branch it was queued on" aria-label="Back to its branch" onClick={() => act(actions.setHead(sessionId, q.anchor!), "queue back to branch")}>
              <Undo2 className="size-3.5" />
            </button>
            <button type="button" className={chipBtn} data-testid="queue-send-here" title="Send it on this branch now" aria-label="Send here" onClick={() => act(actions.queueSendNow(sessionId, q.id, true), "queue send here")}>
              <Send className="size-3.5" />
            </button>
          </>
        ) : (
          <button type="button" className={chipBtn} data-testid="queue-send-now" title="Send now (stops the running turn)" aria-label="Send now" onClick={() => act(actions.queueSendNow(sessionId, q.id), "queue send now")}>
            <Send className="size-3.5" />
          </button>
        )}
        <button type="button" className={cn(chipBtn, "hover:text-danger")} data-testid="queue-remove" title="Remove" aria-label="Remove" onClick={() => act(actions.queueRemove(sessionId, q.id), "queue remove")}>
          <X className="size-3.5" />
        </button>
      </span>
    </li>
  );
}

export function QueuePanel({ sessionId }: { sessionId: string }) {
  const q = useStore((s) => s.queues[sessionId]);
  const all = useStore((s) => s.events[sessionId]);
  const head = useStore((s) => s.sessions[sessionId]?.head ?? null);
  const shown = useMemo(() => new Set(all ? lineage(all, head).map((e) => e.id) : []), [all, head]);
  // Reports of this session's agents that wait for it: while it is paused they start no turn.
  const reports = useAuto((s) => Object.values(s.agents).filter((a) => a.parent_id === sessionId && a.handback && !isLive(a)).length);
  // A paused session with nothing queued still shows that it is paused when reports wait for it.
  if (!q || (!q.queue.length && !(q.held && reports))) return null;
  // Only known when the events are loaded; until then nothing is marked.
  const off = (x: QueueItem) => !!all && !!x.anchor && !shown.has(x.anchor);
  const nextOff = !!q.queue.length && off(q.queue[0]!);
  return (
    <div className="@container/queue mb-2 rounded-lg border border-line bg-raised/80 px-1.5 py-1.5 shadow-2 animate-in" data-testid="queue">
      {q.held && (
        <div className="flex items-center gap-2 px-2 pb-1 text-caption text-muted" data-testid="queue-held">
          <span className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span>
            {nextOff ? "Paused: the next prompt was queued on another branch. Send it here or go back to its branch." : "Paused after the stop. Nothing runs until you send or resume."}
            {reports > 0 && <span data-testid="queue-reports" data-count={reports}> {reports} agent report{reports === 1 ? " is" : "s are"} waiting.</span>}
          </span>
          {!nextOff && (
            <button type="button" className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={() => actions.queueResume(sessionId).catch((e) => { if (!showArchivedRefusal(e)) failed(e, { at: "queue resume" }); })}>
              <Play className="size-3" /> Resume
            </button>
          )}
        </div>
      )}
      {q.queue.length > 0 && (
        <ul className="flex flex-col">
          {q.queue.map((item, i) => <QueueRow key={item.id} q={item} sessionId={sessionId} place={i - q.queue.filter((x) => x.steer).length} off={off(item)} />)}
        </ul>
      )}
    </div>
  );
}

function Ring({ share }: { share: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  // A bar, not a word: the arc takes the state's fill, not its text ink.
  const tone = share >= COMPACT_SHARE ? "stroke-danger" : share >= 0.6 ? "stroke-warn" : "stroke-accent";
  return (
    <svg viewBox="0 0 18 18" className="size-4 -rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.25" className="stroke-line-strong" />
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.25" strokeLinecap="round" data-testid="context-arc"
        className={tone} strokeDasharray={`${Math.max(0.5, share * c)} ${c}`} />
    </svg>
  );
}

const ZONE: Record<string, string> = {
  conversation: "Conversation", tool_results: "Tool results", tool_calls: "Tool calls", thinking: "Thinking", summary: "Summary",
};

// Tokens the next request carries against the model's listed window.
export function ContextMeter({ sessionId }: { sessionId: string }) {
  const all = useStore((s) => s.events[sessionId]);
  const session = useStore((s) => s.sessions[sessionId]);
  const models = useStore((s) => s.models);
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<"" | "compact" | "clear">("");
  const [error, setError] = useState("");
  const model = models.find((m) => m.id === session?.model);
  const window_ = model?.context ?? 0;
  // Counted for the session's model, as the daemon counts it: after a switch another model's reply is a floor, not the count.
  const est = useMemo(() => (all && session ? contextTokens(lineage(all, session.head), session.model) : null), [all, session?.head, session?.model]);
  const used = est?.used ?? 0;
  // The breakdown follows the conversation while the popup is open: it loads
  // again on each committed event (not on streaming text); only the latest
  // answer is kept.
  const seq = useRef(0);
  const reload = () => { const n = ++seq.current; return actions.context(sessionId).then((x) => { if (n === seq.current) setInfo(x); }); };
  useEffect(() => { if (open) reload().catch(reportError); }, [open, session?.head]);
  if (!session) return null;
  // No model row (the listing lacks it): counts and actions stay, without a share.
  const share = window_ ? Math.min(1, used / window_) : 0;
  const limit = session.settings.compact_at ?? (window_ ? Math.floor(window_ * COMPACT_SHARE) : 0);
  const windowText = !model ? "window unknown: the model is not in the current listing" : model.context_assumed ? `window unknown; ${fmtTokens(window_)} assumed for automatic compaction` : `${fmtTokens(window_)} window`;
  const usedText = est?.estimated ? `${fmtTokens(used)} tokens (${fmtTokens(est.measured)} measured, ~${fmtTokens(est.estimated)} estimated since)` : `${fmtTokens(used)} tokens`;
  const working = session.phase === "working";
  const run = async (what: "compact" | "clear") => {
    setBusy(what);
    setError("");
    try {
      if (what === "compact") await actions.compact(sessionId, focus.trim() || undefined);
      else await actions.clear(sessionId);
      setFocus("");
      await reload();
    } catch (e) {
      setError(failed(e, { at: "TurnControls" }));
    } finally {
      setBusy("");
    }
  };
  return (
    <Popover.Root onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="context-meter"
        title={`${usedText} in context; ${windowText}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted tabular-nums hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Ring share={share} />
        <span>{!window_ ? fmtTokens(used) : `${share < 0.01 && used ? "<1" : Math.round(share * 100)}%${model?.context_assumed ? "?" : ""}`}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className={cn(popupClass, "w-80 p-3.5")} data-testid="context-popup">
            <Popover.Title className="text-ui font-semibold">Context</Popover.Title>
            <p className="mt-0.5 text-caption text-muted tabular-nums" data-testid="context-summary">
              {est?.estimated ? "~" : ""}{fmtTokens(used)}{window_ && !model?.context_assumed ? ` of ${fmtTokens(window_)}` : ""} tokens{limit ? ` · compacts at ${fmtTokens(limit)}` : ""}
            </p>
            {(!model || model.context_assumed) && <p className="mt-0.5 text-caption text-faint" data-testid="context-window-unknown">{windowText}</p>}
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className={cn("h-full rounded-full", share >= COMPACT_SHARE ? "bg-danger" : share >= 0.6 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.max(1, share * 100)}%` }} />
            </div>
            {info && (
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-caption tabular-nums">
                {info.zones.filter((z) => z.bytes).map((z) => (
                  <div key={z.key} className="contents" data-testid={`zone-${z.key}`}>
                    <dt className="text-muted">{ZONE[z.key] ?? z.key}</dt>
                    <dd className="text-right">~{fmtTokens(z.estimated_tokens)}</dd>
                  </div>
                ))}
                {info.last_usage && (
                  <div className="contents">
                    <dt className="text-muted">Last request read from cache</dt>
                    <dd className="text-right">{fmtTokens(info.last_usage.cache_read)}</dd>
                  </div>
                )}
              </dl>
            )}
            <p className="mt-3 text-caption text-faint">System prompt and tools are counted in the measured total; they stay cached.</p>
            <div className="mt-3 border-t border-line pt-3">
              <input
                data-testid="compact-focus"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="What the summary should keep (optional)"
                className="h-8 w-full rounded-lg border border-line bg-sunken px-2.5 text-caption outline-none placeholder:text-faint focus:border-line-strong"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="compact-now"
                  disabled={working || !!busy}
                  onClick={() => run("compact")}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-caption font-medium text-accent-fg disabled:opacity-40"
                >
                  <Layers className="size-3.5" /> {busy === "compact" ? "Compacting" : "Compact now"}
                </button>
                <button
                  type="button"
                  data-testid="clear-context"
                  disabled={working || !!busy}
                  onClick={() => run("clear")}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                >
                  <RotateCcw className="size-3.5" /> Clear
                </button>
              </div>
              {working && <p className="mt-1.5 text-caption text-faint">Compaction runs between turns; during a turn it happens by itself near the limit.</p>}
              {error && <p className="mt-1.5 text-caption text-danger">{error}</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The efforts the session's model lists; nothing is offered it does not take.
export function EffortPicker({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const models = useStore((s) => s.models);
  const efforts = models.find((m) => m.id === session?.model)?.efforts ?? [];
  if (!session || !efforts.length) return null;
  const cur = session.settings.effort && efforts.includes(session.settings.effort) ? session.settings.effort : efforts.includes("high") ? "high" : efforts[0]!;
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="effort-picker"
        title="Reasoning effort (applies from the next turn)"
        className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-ui text-muted hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-popup-open:bg-hover"
      >
        <Gauge className="size-3.5" /> {cur} <ChevronDown className="size-3 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className={cn(popupClass, "min-w-40")}>
            <div className="px-2 pt-1 pb-1.5 text-micro text-faint">Effort, from the next turn</div>
            {efforts.map((e) => (
              <Menu.Item
                key={e}
                onClick={() => { if (e !== cur) switchSession(sessionId, { effort: e }).catch(reportError); }}
                className={itemClass}
              >
                <span className="w-3.5">{e === cur && <Check className="size-3.5 text-accent" />}</span>
                {e}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// Session totals: input (and what of it was cached), output, cost.
export function UsageSummary({ sessionId }: { sessionId: string }) {
  const u = useStore((s) => s.sessions[sessionId]?.usage);
  if (!u) return null;
  const prompt = u.input + u.cache_read + u.cache_write;
  return (
    <span className="text-caption text-faint tabular-nums" data-testid="session-usage" title="This session: tokens in (share read from cache), tokens out, cost at catalog prices">
      {fmtTokens(prompt)} in{prompt ? ` (${Math.round((100 * u.cache_read) / prompt)}% cached)` : ""} · {fmtTokens(u.output)} out
      {u.cost !== undefined ? ` · ${fmtCost(u.cost)}` : ""}
    </span>
  );
}

export const QueueIcon = ListPlus;
