// Controls the turn needs beside the composer: the queue (steers and queued
// prompts), the context meter with compaction, and the effort picker.
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ArrowUp, Check, ChevronDown, CornerDownRight, Gauge, Layers, ListPlus, Pencil, Play, RotateCcw, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import { lineage } from "../../../src/core/tree.ts";
import { COMPACT_SHARE, contextTokens } from "../../../src/engine/compact.ts";
import type { QueueItem } from "../../../src/core/types.ts";
import { actions, reportError, useStore, type ContextInfo } from "../lib/store.ts";
import { cn, fmtCost, fmtTokens } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";

const chipBtn = "grid size-6 place-items-center rounded-md text-faint hover:text-fg hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

function QueueRow({ q, sessionId, first }: { q: QueueItem; sessionId: string; first: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q.text);
  const save = () => actions.queueEdit(sessionId, q.id, { text: text.trim() }).then(() => setEditing(false), reportError);
  return (
    <li className="group/q flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-hover" data-testid="queue-item">
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
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) save(); if (e.key === "Escape") setEditing(false); }}
          onBlur={() => setEditing(false)}
          className="min-w-0 flex-1 rounded-md border border-line bg-sunken px-2 py-0.5 text-ui outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-ui" title={q.text}>{q.text}</span>
      )}
      <span className="flex shrink-0 items-center opacity-60 group-hover/q:opacity-100">
        {!q.steer && !first && (
          <button type="button" className={chipBtn} title="Move up" aria-label="Move up" onClick={() => actions.queueEdit(sessionId, q.id, { position: 0 }).catch(reportError)}>
            <ArrowUp className="size-3.5" />
          </button>
        )}
        <button type="button" className={chipBtn} title="Edit" aria-label="Edit" onClick={() => { setText(q.text); setEditing(true); }}>
          <Pencil className="size-3.5" />
        </button>
        {!q.steer && (
          <button type="button" className={chipBtn} title="Steer into the running turn instead" aria-label="Make it a steer" onClick={() => actions.queueEdit(sessionId, q.id, { steer: true }).catch(reportError)}>
            <CornerDownRight className="size-3.5" />
          </button>
        )}
        <button type="button" className={chipBtn} data-testid="queue-send-now" title="Send now (stops the running turn)" aria-label="Send now" onClick={() => actions.queueSendNow(sessionId, q.id).catch(reportError)}>
          <Send className="size-3.5" />
        </button>
        <button type="button" className={cn(chipBtn, "hover:text-danger")} data-testid="queue-remove" title="Remove" aria-label="Remove" onClick={() => actions.queueRemove(sessionId, q.id).catch(reportError)}>
          <X className="size-3.5" />
        </button>
      </span>
    </li>
  );
}

export function QueuePanel({ sessionId }: { sessionId: string }) {
  const q = useStore((s) => s.queues[sessionId]);
  if (!q || (!q.queue.length && !q.held)) return null;
  if (!q.queue.length) return null;
  return (
    <div className="mb-2 rounded-lg border border-line bg-raised/80 px-1.5 py-1.5 shadow-2 animate-in" data-testid="queue">
      {q.held && (
        <div className="flex items-center gap-2 px-2 pb-1 text-caption text-muted" data-testid="queue-held">
          <span className="size-1.5 rounded-full bg-warn" /> Paused after the stop. Nothing runs until you send or resume.
          <button type="button" className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={() => actions.queueResume(sessionId).catch(reportError)}>
            <Play className="size-3" /> Resume
          </button>
        </div>
      )}
      <ul className="flex flex-col">
        {q.queue.map((item, i) => <QueueRow key={item.id} q={item} sessionId={sessionId} first={i === 0 || q.queue[i - 1]!.steer} />)}
      </ul>
    </div>
  );
}

function Ring({ share }: { share: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const tone = share >= COMPACT_SHARE ? "text-danger" : share >= 0.6 ? "text-warn" : "text-accent";
  return (
    <svg viewBox="0 0 18 18" className="size-4 -rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.25" className="stroke-line-strong" />
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.25" strokeLinecap="round" stroke="currentColor"
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
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<"" | "compact" | "clear">("");
  const [error, setError] = useState("");
  const window_ = models.find((m) => m.id === session?.model)?.context ?? 0;
  const used = useMemo(() => (all && session ? contextTokens(lineage(all, session.head)).used : 0), [all, session?.head]);
  if (!session || !window_) return null;
  const share = Math.min(1, used / window_);
  const limit = session.settings.compact_at ?? Math.floor(window_ * COMPACT_SHARE);
  const working = session.phase === "working";
  const run = async (what: "compact" | "clear") => {
    setBusy(what);
    setError("");
    try {
      if (what === "compact") await actions.compact(sessionId, focus.trim() || undefined);
      else await actions.clear(sessionId);
      setFocus("");
      setInfo(await actions.context(sessionId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <Popover.Root onOpenChange={(o) => { if (o) actions.context(sessionId).then(setInfo, reportError); }}>
      <Popover.Trigger
        data-testid="context-meter"
        title={`${fmtTokens(used)} of ${fmtTokens(window_)} tokens in context`}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted tabular-nums hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Ring share={share} />
        <span>{share < 0.01 && used ? "<1" : Math.round(share * 100)}%</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className={cn(popupClass, "w-80 p-3.5")} data-testid="context-popup">
            <Popover.Title className="text-ui font-semibold">Context</Popover.Title>
            <p className="mt-0.5 text-caption text-muted tabular-nums">
              {fmtTokens(used)} of {fmtTokens(window_)} tokens · compacts at {fmtTokens(limit)}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className={cn("h-full rounded-full", share >= COMPACT_SHARE ? "bg-danger" : share >= 0.6 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.max(1, share * 100)}%` }} />
            </div>
            {info && (
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-caption tabular-nums">
                {info.zones.filter((z) => z.bytes).map((z) => (
                  <div key={z.key} className="contents">
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
                onClick={() => actions.patch(sessionId, { settings: { effort: e } }).catch(reportError)}
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
