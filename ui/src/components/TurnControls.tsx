// Controls the turn needs beside the composer: the queue (steers and queued
// prompts), the context meter with compaction, and the effort picker.
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ArrowUp, ArrowUpCircle, Check, ChevronDown, CornerDownRight, Gauge, GitBranch, Image as ImageIcon, Layers, ListPlus, Pencil, Play, RotateCcw, Send, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, memo } from "react";
import { branchLine } from "../lib/rows.ts";
import { COMPACT_SHARE, contextTokens, setRatio } from "../../../src/engine/compact.ts";
import type { QueueItem } from "../../../src/core/types.ts";
import { bodyOf } from "../../../src/mcp/channel-text.ts";
import { isLive, useAuto } from "../lib/automation.ts";
import { heldWords } from "../../../src/core/state-words.ts";
import { actions, api, reportError, reportUnlessGone, useStore, type BuildState, type ContextInfo, failed, showArchivedRefusal } from "../lib/store.ts";
import { switchSession } from "../lib/switch.ts";
import { seedComposer } from "../lib/ui.ts";
import { cn, fmtCost, fmtTokens, when } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";
import { composing } from "../lib/keys.ts";

const chipBtn = "grid size-6 place-items-center rounded-md text-faint hover:text-fg hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

// `place`: the row's index among the queued (not steered) prompts; `off`: it
// was queued on a branch the chat no longer shows.
// `held`: the session is stopped and its queue waits for the owner to resume.
// A queued event from outside reads as its source and its words, not its frame (src/mcp/channel.ts).
const shownText = (q: QueueItem) => q.meta?.kind === "channel" ? `${String(q.meta.source ?? "")}: ${bodyOf(q.text)}` : q.text;

function QueueRow({ q, sessionId, place, off, held }: { q: QueueItem; sessionId: string; place: number; off: boolean; held: boolean }) {
  // The one word of a message that waits, and when it is taken (src/core/state-words.ts).
  const waits = heldWords({ steer: q.steer, held });
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
      <span data-testid="queue-word" className={cn(
        "shrink-0 rounded px-1.5 py-px text-micro font-semibold",
        q.steer ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted",
      )}>
        {waits.word}
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
        <span className={cn(words, "truncate text-ui")} title={q.text}>{shownText(q)}</span>
      )}
      {!editing && <span className="shrink-0 text-caption text-faint" data-testid="queue-when" data-steer={q.steer || undefined}>{waits.when}</span>}
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
  // The page holds the newest part of the branch: a prompt is marked when the
  // event it was queued at is held and is not on that part, though it is not
  // older than it (an older one may be on the branch further up).
  const branch = useMemo(() => {
    const line = all ? branchLine(sessionId, all, head) : [];
    return { ids: new Set(line.map((e) => e.id)), from: line[0]?.seq ?? Infinity, whole: !line.length || line[0]!.parent === null, seqs: new Map((all ?? []).map((e) => [e.id, e.seq])) };
  }, [all, head]);
  // A prompt queued at an event the page does not hold cannot be told here
  // (the event may be on the branch further up, or on another one): the
  // daemon, which reads the whole branch, is asked which ones are off it.
  const unsure = !!all && !branch.whole && !!q?.queue.some((x) => x.anchor && !branch.ids.has(x.anchor) && !branch.seqs.has(x.anchor));
  const key = unsure ? `${head} ${q!.queue.map((x) => x.id).join(" ")}` : "";
  const [told, setTold] = useState<{ key: string; off: Set<string> } | null>(null);
  useEffect(() => {
    if (!key) return;
    let stop = false;
    api<{ off: string[] }>(`/api/sessions/${sessionId}/queue/off-branch`).then((r) => { if (!stop) setTold({ key, off: new Set(r.off) }); }).catch((e) => reportUnlessGone(e, { at: "queue branch" }));
    return () => { stop = true; };
  }, [key, sessionId]);
  // Reports of this session's agents that wait for it: while it is paused they start no turn.
  const reports = useAuto((s) => Object.values(s.agents).filter((a) => a.parent_id === sessionId && a.handback && !isLive(a)).length);
  // A paused session with nothing queued still shows that it is paused when reports wait for it.
  if (!q || (!q.queue.length && !(q.held && reports))) return null;
  // Only known when the events are loaded; until then nothing is marked.
  const off = (x: QueueItem) => {
    if (!all || !x.anchor || branch.ids.has(x.anchor)) return false;
    const at = branch.seqs.get(x.anchor);
    if (branch.whole || at !== undefined) return branch.whole || at! > branch.from;
    return told?.key === key && told.off.has(x.id);
  };
  const nextOff = !!q.queue.length && off(q.queue[0]!);
  return (
    <div className="@container/queue mb-2 rounded-lg border border-line bg-raised/80 px-1.5 py-1.5 shadow-2 animate-in" data-testid="queue">
      {q.held && (
        <div className="flex items-center gap-2 px-2 pb-1 text-caption text-muted" data-testid="queue-held">
          <span className="size-1.5 shrink-0 rounded-full bg-warn" />
          <span>
            {nextOff ? "Paused: the next prompt was queued on another branch. Send it here or go back to its branch." : "Paused after the stop. Nothing runs until you send or resume."}
            {reports > 0 && <span data-testid="queue-reports" data-count={reports}> {reports} agent report{reports === 1 ? " is" : "s are"} held.</span>}
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
          {q.queue.map((item, i) => <QueueRow key={item.id} q={item} sessionId={sessionId} place={i - q.queue.filter((x) => x.steer).length} off={off(item)} held={q.held} />)}
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
// `above`: shown only once the context is that full (a phone's resting box keeps it out of the way until it matters).
export const ContextMeter = memo(function ContextMeter({ sessionId, above }: { sessionId: string; above?: number }) {
  const all = useStore((s) => s.events[sessionId]);
  const session = useStore((s) => s.sessions[sessionId]);
  const models = useStore((s) => s.models);
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<"" | "compact" | "clear" | "build">("");
  const [build, setBuild] = useState<BuildState | null>(null);
  const [error, setError] = useState("");
  const model = models.find((m) => m.id === session?.model);
  const window_ = model?.context ?? 0;
  // Counted for the session's model, as the daemon counts it: after a switch another model's reply is a floor, not the count.
  const line = useMemo(() => (all && session ? branchLine(sessionId, all, session.head) : null), [all, session?.head]);
  const est = useMemo(() => (line && session ? contextTokens(line, session.model) : null), [line, session?.model]);
  // The page holds the newest part of a long branch. A reply measured in that
  // part counted everything before it, so the count is the whole context's.
  // With none there (an imported history no provider has counted yet), the
  // bytes of the part are not the context: the daemon, which reads the whole
  // branch, is asked for its count.
  const short = !!line?.length && line[0]!.parent !== null && est?.measured === 0;
  const [counted, setCounted] = useState<{ head: string | null; used: number } | null>(null);
  useEffect(() => {
    if (!short || !session) return;
    let stop = false;
    const head = session.head;
    actions.context(sessionId).then((x) => { if (!stop) setCounted({ head, used: x.context_used_tokens }); }).catch(reportError);
    return () => { stop = true; };
  }, [short, session?.head, sessionId]);
  const used = short && counted?.head === session?.head ? counted!.used : est?.used ?? 0;
  // The breakdown follows the conversation while the popup is open: it loads
  // again on each committed event (not on streaming text); only the latest
  // answer is kept.
  const seq = useRef(0);
  const reload = () => {
    const n = ++seq.current;
    // A daemon from before sessions were pinned to a build has no such route: the popup shows the rest.
    return Promise.all([actions.context(sessionId), actions.buildState(sessionId).catch(() => null)]).then(([x, b]) => {
      if (n !== seq.current) return;
      if (x.bytes_per_token && session) setRatio(session.model, x.bytes_per_token);
      setInfo(x);
      setBuild(b);
    });
  };
  useEffect(() => { if (open) reload().catch(reportError); }, [open, session?.head]);
  if (!session) return null;
  // No model row (the listing lacks it): counts and actions stay, without a share.
  const share = window_ ? Math.min(1, used / window_) : 0;
  const limit = session.settings.compact_at ?? (window_ ? Math.floor(window_ * COMPACT_SHARE) : 0);
  // What the ring and its number show: how close the context is to where it
  // compacts. That is its share of the window when the line is the usual share
  // of it; with a line the owner set, the context is as full at that line as
  // any other is at its own.
  const fill = limit ? Math.min(1, (used / limit) * COMPACT_SHARE) : share;
  const windowText = !model ? "window unknown: the model is not in the current listing" : model.context_assumed ? `window unknown; ${fmtTokens(window_)} assumed for automatic compaction` : `${fmtTokens(window_)} window`;
  const usedText = est?.estimated ? `${fmtTokens(used)} tokens (${fmtTokens(est.measured)} measured, ~${fmtTokens(est.estimated)} estimated since)` : `${fmtTokens(used)} tokens`;
  const working = session.phase === "working";
  const run = async (what: "compact" | "clear" | "build") => {
    setBusy(what);
    setError("");
    try {
      if (what === "compact") await actions.compact(sessionId, focus.trim() || undefined);
      else if (what === "build") await actions.adoptBuild(sessionId);
      else await actions.clear(sessionId);
      setFocus("");
      await reload();
    } catch (e) {
      setError(failed(e, { at: "TurnControls" }));
    } finally {
      setBusy("");
    }
  };
  if (above !== undefined && fill < above && !open) return null;
  return (
    <Popover.Root onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="context-meter"
        title={`${usedText} in context; ${windowText}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted tabular-nums hover:bg-hover hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Ring share={fill} />
        {/* As wide for "<1%" as for "88%": the tools beside it do not move as it fills. */}
        <span className="min-w-[1.75rem] text-left">{!window_ ? fmtTokens(used) : `${fill < 0.01 && used ? "<1" : Math.round(fill * 100)}%${model?.context_assumed ? "?" : ""}`}</span>
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
              <div className={cn("h-full rounded-full", fill >= COMPACT_SHARE ? "bg-danger" : fill >= 0.6 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.max(1, share * 100)}%` }} />
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
            {build && <BuildPin build={build} used={used} busy={busy === "build"} disabled={!!busy} onAdopt={() => run("build")} />}
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
});

const some = (names: string[]) => (names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", "));

// Which build the session's tools and system prompt are from, when the
// running build has others: a session keeps what it was last sent across a
// daemon upgrade, so its cached context is not written again, and takes the
// build's when that cache is cold anyway. The owner can take them now.
// `used`: the tokens in context, which taking the build's writes to the cache again.
function BuildPin({ build, used, busy, disabled, onAdopt }: { build: BuildState; used: number; busy: boolean; disabled: boolean; onAdopt: () => void }) {
  const p = build.pinned;
  const { blocks, tools } = build.waiting;
  const behind = blocks.length + tools.length > 0;
  // Not compared yet by this build: only a pin of another build says so.
  const unknown = !build.known && !!p && p.build !== build.build;
  if (!p || (!behind && !unknown && !build.asked)) {
    // Just taken (the button, or the request that found the cache cold): say so once.
    const last = build.adoptions[0];
    if (!last || Date.now() - last.ts > 60_000) return null;
    return <p className="mt-2 text-caption text-faint" data-testid="build-pin-taken">Now on this build's tools and prompt ({last.reason}).</p>;
  }
  const from = p.build && p.build !== build.build ? `build ${p.build}` : "an earlier build";
  const what = [blocks.length ? `the prompt (${some(blocks)})` : "", tools.length ? `the tools (${some(tools)})` : ""].filter(Boolean).join(" and ");
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="build-pin">
      <p className="text-caption text-muted" title={`Since ${when(p.since)}`}>
        Tools and prompt are from <span className="text-fg">{from}</span>, so the cached context is not written again.
      </p>
      <p className="mt-1 text-caption text-faint" data-testid="build-pin-waiting">
        {build.asked
          ? `This build's are taken at the next request, which rewrites about ${fmtTokens(used)} tokens.`
          : behind
            ? `This build (${build.build}) changed ${what}. They are taken at the next compaction or clear, on another model, once the cache has expired${build.takes_at ? `, or on ${when(build.takes_at)} at the latest` : ""}.`
            : `They are compared with this build's (${build.build}) at the session's next request.`}
      </p>
      {!build.asked && (
        <>
          <button
            type="button"
            data-testid="build-adopt"
            disabled={disabled}
            onClick={onAdopt}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <ArrowUpCircle className="size-3.5" /> {busy ? "Taking this build's" : "Use this build's now"}
          </button>
          <p className="mt-1.5 text-caption text-faint tabular-nums" data-testid="build-adopt-cost">Rewrites about {fmtTokens(used)} tokens at the next request.</p>
        </>
      )}
    </div>
  );
}

// The efforts the session's model lists; nothing is offered it does not take.
export const EffortPicker = memo(function EffortPicker({ sessionId }: { sessionId: string }) {
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
});

// Session totals: input (and what of it was cached), output, cost.
export function UsageSummary({ sessionId }: { sessionId: string }) {
  const u = useStore((s) => s.sessions[sessionId]?.usage);
  if (!u) return null;
  const prompt = u.input + u.cache_read + u.cache_write;
  return (
    <span className="k-session-usage text-caption text-faint tabular-nums" data-testid="session-usage" title="This session: tokens in (share read from cache), tokens out, cost at catalog prices">
      {fmtTokens(prompt)} in{prompt ? ` (${Math.round((100 * u.cache_read) / prompt)}% cached)` : ""} · {fmtTokens(u.output)} out
      {u.cost !== undefined ? ` · ${fmtCost(u.cost)}` : ""}
    </span>
  );
}

export const QueueIcon = ListPlus;
