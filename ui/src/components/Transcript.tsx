import { CopyButton } from "./CopyButton.tsx";
import { ArrowDown, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, FileText, GitBranch, Layers, Pencil, Play, RotateCcw, RotateCw, ShieldAlert } from "lucide-react";
import { TurnNotes } from "./MemoryNote.tsx";
import { Fragment, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { leafOf, lineage } from "../../../src/core/tree.ts";
import type { AssistantBlock, AttachmentBlock, ImageBlock, PromptBlock, Session, StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { rowActions } from "../lib/extend.ts";
import { actions, reportError, useStore, type DraftBlock } from "../lib/store.ts";
import { useSafety } from "../lib/safety.ts";
import { getUI, navigate, seedComposer, setUI, useUI } from "../lib/ui.ts";
import { cn, fmtCost, fmtTokens, fmtWait } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { switchSession } from "../lib/switch.ts";
import { ToolCall } from "./ToolCall.tsx";
import { InputNotice, SYSTEM_INPUT } from "./automation/TranscriptExtras.tsx";
import { isPeerMessage, PeerMessage, RefusedNote } from "./FleetMessages.tsx";

function Thinking({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim() && !live) return null;
  return (
    <details className="group/think text-ui text-muted" open={live}>
      <summary className="inline-flex cursor-default list-none items-center gap-1.5 rounded-sm py-0.5 pr-1 select-none hover:text-fg">
        <Brain className="size-3.5" />
        <span className={live ? "animate-pulse-dot" : ""}>{live ? "Thinking" : "Thought"}</span>
        {!live && <ChevronDown className="size-3 -rotate-90 transition-transform group-open/think:rotate-0" />}
      </summary>
      {text.trim() && <div className="mt-1.5 max-h-96 overflow-y-auto border-l-2 border-line pl-3.5 text-[0.9688rem] leading-relaxed whitespace-pre-wrap">{text}</div>}
    </details>
  );
}

function ActionButton({ label, onClick, children, testid }: { label: string; onClick: () => void; children: ReactNode; testid?: string }) {
  return (
    <button type="button" title={label} aria-label={label} data-testid={testid} onClick={onClick} className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

function Extra({ on, e, s }: { on: "user" | "assistant"; e: StoredEvent; s: Session }) {
  useSyncExternalStore(rowActions.subscribe, rowActions.version);
  return (
    <>
      {rowActions.all().filter((a) => a.on === on && (!a.when || a.when(e, s))).map((a) => (
        <ActionButton key={a.id} label={a.label} testid={`rowaction-${a.id}`} onClick={() => a.run(e, s)}>{typeof a.icon === "function" ? a.icon(e, s) : a.icon}</ActionButton>
      ))}
    </>
  );
}

// Attachments in the order they were sent (the order the model reads them),
// files and images interleaved, so "the second one" means one thing.
function Images({ blocks }: { blocks: PromptBlock[] }) {
  const [big, setBig] = useState<number | null>(null);
  let n = 0;
  return (
    <div className="flex flex-wrap items-end justify-end gap-2">
      {blocks.map((b, i) => {
        if (b.type === "attachment") {
          const f = b as AttachmentBlock;
          return (
            <a key={i} href={`/api/attachments/${f.id}?name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.media_type)}`} download={f.name} data-testid="message-file" title={`${f.name}, ${f.media_type}`}
              className="flex h-10 max-w-64 items-center gap-2 rounded-lg border border-line bg-raised px-3 text-ui shadow-1 hover:border-line-strong">
              <FileText className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 truncate">{f.name}</span>
              <span className="shrink-0 text-micro tabular-nums text-faint">{f.size < 1024 * 1024 ? `${Math.max(1, Math.round(f.size / 1024))} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`}</span>
            </a>
          );
        }
        if (b.type !== "image") return null;
        const im = b as ImageBlock;
        n++;
        return (
          // A control of its own: Tab reaches it, Enter and Space change its size.
          <button
            key={i}
            type="button"
            data-testid="message-image-toggle"
            aria-expanded={big === i}
            title={big === i ? "Show it smaller" : "Show it larger"}
            onClick={() => setBig(big === i ? null : i)}
            className="k-image-toggle block max-w-full"
          >
            <img
              src={`data:${im.media_type};base64,${im.data}`}
              alt={`Attached image ${n}`}
              data-testid="message-image"
              className={cn("block rounded-lg border border-line object-cover shadow-1", big === i ? "max-h-[70vh] max-w-full" : "max-h-40 max-w-60")}
            />
          </button>
        );
      })}
    </div>
  );
}

// Edit-and-resend makes a new version of the prompt (a sibling in the event
// tree); the arrows move between versions, each its own branch.
function UserMessage({ e, s, vs }: { e: StoredEvent; s: Session; vs: StoredEvent[] }) {
  const text: string = e.data.text ?? "";
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [full, setFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const at = vs.findIndex((v) => v.id === e.id);
  const working = s.phase === "working";
  const origin: string | undefined = e.data.origin;
  const pick = (i: number) => actions.setHead(s.id, vs[i]!.id).catch(reportError);
  if (editing) return <EditPrompt e={e} s={s} onDone={() => setEditing(false)} />;
  return (
    <div id={`e-${e.id}`} className="group/user row-cv flex scroll-mt-6 flex-col items-end gap-1.5 rounded-lg animate-in" data-testid="user-message" data-event-id={e.id}>
      {origin === "steer" && <span className="text-micro font-medium text-faint" data-testid="origin-steer">Steered into the turn</span>}
      {e.data.edited_from === "steer" && <span className="text-micro font-medium text-faint" data-testid="origin-edited-steer">An edited steer, sent as a new turn</span>}
      {origin === "queued" && <span className="text-micro font-medium text-faint" data-testid="origin-queued">From the queue</span>}
      {e.data.images?.length > 0 && <Images blocks={e.data.images} />}
      {text && (
        <div className="relative max-w-[min(85%,40rem)] rounded-xl rounded-br-sm bg-accent-soft px-4 py-2.5 text-read leading-relaxed text-fg">
          <div className={cn("whitespace-pre-wrap break-words", long && !full && "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>{text}</div>
          {long && (
            <button type="button" onClick={() => setFull(!full)} className="mt-1 text-caption font-medium text-accent-ink hover:underline">
              {full ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
      <div className="-mt-0.5 flex h-6 items-center">
        <span className="flex items-center opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <CopyButton text={() => text} label="Copy the message" testid="copy-message" className="size-7" />
          <ActionButton label="Edit and send as a new version" testid="edit-message" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></ActionButton>
          <Extra on="user" e={e} s={s} />
        </span>
        {vs.length > 1 && (
          <span className="flex items-center text-caption tabular-nums text-faint" data-testid="branch-nav">
            <button type="button" aria-label="Previous version" title="Previous version" disabled={at <= 0 || working} onClick={() => pick(at - 1)} className="grid size-7 place-items-center rounded-sm hover:bg-hover hover:text-fg disabled:opacity-40">
              <ChevronLeft className="size-3.5" />
            </button>
            <span data-testid="branch-pos">{at + 1}/{vs.length}</span>
            <button type="button" aria-label="Next version" title="Next version" disabled={at >= vs.length - 1 || working} onClick={() => pick(at + 1)} className="grid size-7 place-items-center rounded-sm hover:bg-hover hover:text-fg disabled:opacity-40">
              <ChevronRight className="size-3.5" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// The new version keeps the prompt's attachments, in their order: they are
// shown here before Send, and only the words change.
function EditPrompt({ e, s, onDone }: { e: StoredEvent; s: Session; onDone: () => void }) {
  const raw: string = e.data.text ?? "";
  const [text, setText] = useState<string>(raw);
  const blocks: PromptBlock[] = e.data.images ?? [];
  const n = blocks.length;
  const ok = !!text.trim() || n > 0;
  const send = () => ok && actions.edit(s.id, e.id, text.trim()).then(onDone, reportError);
  return (
    <div className="flex justify-end animate-in" data-event-id={e.id}>
      <div className="w-[min(85%,40rem)] rounded-xl border border-line-strong bg-raised p-2 shadow-2">
        {n > 0 && (
          <div className="mb-1.5 flex flex-col items-end gap-1.5 px-1 pt-1" data-testid="edit-attachments">
            <Images blocks={blocks} />
          </div>
        )}
        <textarea
          data-testid="edit-box"
          autoFocus
          value={text}
          aria-label="Edit the prompt"
          placeholder={n ? "Words to send with the attachments (optional)" : undefined}
          onChange={(x) => setText(x.target.value)}
          onKeyDown={(x) => {
            if (x.key === "Escape") onDone();
            if (x.key === "Enter" && !x.shiftKey) { x.preventDefault(); send(); }
          }}
          className="block min-h-16 w-full resize-y bg-transparent px-2 py-1 text-read leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <span className="mr-auto pl-2 text-caption text-faint" data-testid="edit-note">
            {s.phase === "working" ? "Stops the turn, then sends this as a new version." : "Sends as a new version; the current one stays as a branch."}
            {n > 0 && ` The ${n === 1 ? "attachment goes" : `${n} attachments go`} with it as before.`}
          </span>
          <button type="button" onClick={onDone} className="h-7 rounded-md px-2.5 text-ui text-muted hover:bg-hover">Cancel</button>
          <button type="button" data-testid="edit-send" disabled={!ok} onClick={send} className="h-7 rounded-md bg-accent px-2.5 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// A declined reply: what the provider said, and a way on with another model.
function Refusal({ e, s, handled }: { e: StoredEvent; s: Session; handled?: boolean }) {
  const [pick, setPick] = useState("");
  const [keep, setKeep] = useState(false);
  const d = e.data.stop_details ?? {};
  return (
    <div id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-lg border border-warn/40 bg-raised px-3.5 py-3 text-ui" data-testid="refusal">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-warn" /> The model declined this request
        {d.category && <span className="rounded-sm bg-sunken px-1.5 py-px text-micro uppercase tracking-wide text-muted">{d.category}</span>}
      </div>
      {d.explanation && <p className="mt-1 text-muted">{d.explanation}</p>}
      <p className="mt-1 text-muted">Its partial reply is left out of the context.{handled ? " The fallback model took the request." : " Another model can take the same request."}</p>
      {!handled && <div className="mt-2 flex items-center gap-2">
        <div className="rounded-md border border-line"><ModelPicker value={pick || s.model} onChange={setPick} /></div>
        <button
          type="button"
          disabled={!pick || pick === s.model}
          onClick={() =>
            // The picker's switch (with its cache warning): Cancel leaves the model and does not resume.
            switchSession(s.id, { model: pick })
              .then(async (ok) => {
                if (!ok) return;
                if (keep) await actions.patch(s.id, { settings: { fallback: pick } });
                await actions.resume(s.id);
              })
              .catch(reportError)}
          className="h-8 rounded-md bg-accent px-3 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
        >
          Retry on it
        </button>
        <label className="flex items-center gap-1.5 text-caption text-muted" title="When a model declines later in this session, the turn goes on by itself on this one">
          <input type="checkbox" data-testid="refusal-keep-fallback" checked={keep} onChange={(x) => setKeep(x.target.checked)} className="accent-[var(--accent)]" />
          Also use it when a model declines later
        </label>
      </div>}
    </div>
  );
}

function Divider({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-caption text-faint" data-testid={testid}>
      <span className="h-px flex-1 bg-line" />
      {children}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// A context checkpoint: a summary (expandable) or a clear (undo while it is the head).
function Checkpoint({ e, s, undoable }: { e: StoredEvent; s: Session; undoable?: boolean }) {
  if (e.data.mode === "clear") {
    return (
      <Divider testid="cleared">
        <span className="flex items-center gap-1.5"><RotateCcw className="size-3.5" /> Context cleared. The model starts fresh from here.</span>
        {undoable && e.data.undo_head && (
          <button type="button" data-testid="undo-clear" className="rounded-sm px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft" onClick={() => actions.setHead(s.id, e.data.undo_head, false, false).catch(reportError)}>
            Undo
          </button>
        )}
      </Divider>
    );
  }
  return (
    <details className="group/cp" data-testid="compacted">
      <summary className="list-none cursor-default">
        <Divider>
          <span className="flex items-center gap-1.5 hover:text-fg">
            <Layers className="size-3.5" />
            {e.data.label ? e.data.label : e.data.trigger === "idle" ? "Context compacted: the cache expired while the session was idle, so a summary written before it did replaces the history" : e.data.ahead ? "Context compacted with a summary prepared ahead; the newest steps stay as they were" : e.data.auto ? "Context compacted automatically" : "Context compacted"}
            {e.data.tokens_before ? `, ${fmtTokens(e.data.tokens_before)} tokens into a summary` : ""}
            {e.data.parts ? ` (too long for one request: read as a transcript${e.data.parts > 1 ? ` in ${e.data.parts} parts` : ""}${e.data.outputs_shortened ? `, ${e.data.outputs_shortened} long tool outputs shortened` : ""})` : ""}
            {e.data.owner_messages_shortened ? `; the oldest of the owner's messages kept word for word is cut to its start and end` : ""}
            {e.data.other_messages_shortened ? `; the oldest kept report or other delivered message is cut to its start and end` : ""}
            {e.data.statements_dropped?.length ? `; ${e.data.statements_dropped.length === 1 ? "one statement" : `${e.data.statements_dropped.length} statements`} the summary did not quote word for word left out` : ""}
            {e.data.statements_done?.length ? `; ${e.data.statements_done.length === 1 ? "one request" : `${e.data.statements_done.length} requests`} marked done` : ""}
            <ChevronDown className="size-3 -rotate-90 transition-transform group-open/cp:rotate-0" />
          </span>
        </Divider>
      </summary>
      <div className="mt-2 rounded-lg border border-line bg-raised px-4 py-3 text-ui text-muted"><Markdown text={e.data.summary} /></div>
    </details>
  );
}

// Where a fork came from, with a way back (its queued prompts stayed there).
function ForkNote({ e }: { e: StoredEvent }) {
  const from = useStore((x) => x.sessions[e.data.from_session]);
  const left: number = e.data.queue_left ?? 0;
  return (
    <Divider testid="fork-note">
      <span className="flex items-center gap-1.5">
        <GitBranch className="size-3.5" /> Forked from
        <button type="button" data-testid="fork-source" onClick={() => navigate({ name: "session", id: e.data.from_session })} className="rounded-sm px-1 font-medium text-accent-ink hover:bg-accent-soft">
          {from?.title || e.data.from_title || "the source session"}
        </button>
        {left > 0 && <span data-testid="fork-queue-left">{left === 1 ? "One queued message stays there." : `${left} queued messages stay there.`}</span>}
      </span>
    </Divider>
  );
}

// Live, not stored: a retry wait or a compaction in progress.
function Status({ sessionId }: { sessionId: string }) {
  const st = useStore((x) => x.status[sessionId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (st?.kind !== "retry") return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [st]);
  if (!st || st.kind === "idle" || st.kind === "model" || st.kind === "tool") return null;
  if (st.kind === "compacting") {
    return <div className="flex items-center gap-2 text-ui text-muted animate-pulse-dot" data-testid="compacting"><Layers className="size-3.5" /> Compacting the context</div>;
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-raised px-3 py-2 text-ui" data-testid="retrying">
      <span className="size-1.5 rounded-full bg-warn animate-pulse-dot" />
      <span className="min-w-0 flex-1 truncate text-muted" title={st.message}>{st.message}</span>
      <span className="shrink-0 tabular-nums text-faint">retrying in {fmtWait(st.at - Date.now())}, attempt {st.attempt} of {st.max}</span>
    </div>
  );
}

function AssistantBlocks({ blocks, results, s }: { blocks: AssistantBlock[]; results: Map<string, ToolResultBlock>; s: Session }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return b.text.trim() ? <div key={i} data-testid="assistant-text"><Markdown text={b.text} sessionId={s.machine ? undefined : s.id} /></div> : null;
        // A thought may carry only opaque state for replay (an encrypted item): nothing to show.
        if (b.type === "thinking") return b.thinking.trim() ? <Thinking key={i} text={b.thinking} /> : null;
        if (b.type === "tool_use") return <ToolCall key={b.id} use={b} result={results.get(b.id)} sessionId={s.id} cwd={s.workspace} />;
        return null;
      })}
    </>
  );
}

function Draft({ draft }: { draft: Record<number, DraftBlock> }) {
  const blocks = Object.entries(draft).sort(([a], [b]) => Number(a) - Number(b));
  return (
    <>
      {blocks.map(([i, b]) => {
        if (b.kind === "text") return b.text.trim() ? <div key={i}><Markdown text={b.text} live /></div> : null;
        if (b.kind === "thinking") return <Thinking key={i} text={b.text} live />;
        let input: any = {};
        try { input = JSON.parse(b.text); } catch {}
        const use: ToolUseBlock = { type: "tool_use", id: `draft-${i}`, name: b.name ?? "tool", input };
        return <ToolCall key={i} use={use} live />;
      })}
    </>
  );
}

// What the turn waits on: the model's first bytes, a tool, or just working.
function Working({ since, sessionId }: { since?: number; sessionId: string }) {
  const st = useStore((x) => x.status[sessionId]);
  const approving = useSafety((x) => (x.approvals[sessionId]?.length ?? 0) > 0);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const from = st?.kind === "model" || st?.kind === "tool" ? st.since : since;
  const s = from ? Math.max(0, Math.round((Date.now() - from) / 1000)) : 0;
  const what = approving ? "Waiting for your approval" : st?.kind === "model" ? (st.connected ? `Connected to ${st.model}, no output yet` : `Waiting on ${st.model}`) : st?.kind === "tool" ? `Running ${st.names.join(", ")}` : "Working";
  return (
    <div className="flex items-center gap-2.5 py-1 text-ui text-muted" data-testid="working">
      <span className="flex gap-1">
        {/* Waiting on the owner is their color and does not pulse: nothing runs until they answer. */}
        {[0, 1, 2].map((i) => <span key={i} className={cn("size-1.5 rounded-full", approving ? "bg-st-need" : "bg-brass animate-pulse-dot")} style={approving ? undefined : { animationDelay: `${i * 160}ms` }} />)}
      </span>
      <span data-testid="working-what">{what}</span>
      {s >= 2 ? <span className="tabular-nums text-faint">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span> : null}
    </div>
  );
}

const REASONS: Record<string, string> = { interrupted: "Stopped", max_tokens: "Cut at the output limit", refusal: "Declined", error: "Failed", restart: "Cut by a daemon restart" };

function TurnFooter({ e, reply, prompt, s, last, notes = [] }: { e: StoredEvent; reply: string; prompt?: StoredEvent; s: Session; last: boolean; notes?: StoredEvent[] }) {
  const u = e.data.usage;
  const input = u ? u.input + u.cache_read + u.cache_write : 0;
  const cached = u && input ? Math.round((100 * u.cache_read) / input) : 0;
  return (
    <div className={cn("group/foot -mt-1 flex h-7 items-center gap-0.5", !last && "opacity-50 hover:opacity-100 focus-within:opacity-100 max-md:opacity-100")}>
      {reply && <CopyButton text={() => reply} label="Copy the reply" testid="copy-reply" className="size-7" />}
      {prompt && last && s.phase !== "working" && (
        <ActionButton label="Answer again (a new version; this one stays a branch)" testid="retry" onClick={() => actions.edit(s.id, prompt.id, prompt.data.text).catch(reportError)}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      )}
      <Extra on="assistant" e={e} s={s} />
      <TurnNotes notes={notes} working={s.phase === "working"} />
      <span className="ml-2 flex gap-3 text-micro tabular-nums text-faint select-none" data-testid="turn-end">
        {REASONS[e.data.reason] && <span className={e.data.reason === "error" ? "text-st-fail" : "text-warn"} data-testid="turn-reason">{REASONS[e.data.reason]}{STOP_BY[e.data.stopped_by] ?? ""}</span>}
        <span>{(e.data.ms / 1000).toFixed(1)}s</span>
        {u && <span>{fmtTokens(input)} in{cached ? `, ${cached}% cached` : ""}</span>}
        {u && <span>{fmtTokens(u.output)} out</span>}
        {u?.cost !== undefined && !u.unpriced ? <span data-testid="turn-cost">{fmtCost(u.cost)}</span> : u?.unpriced ? <span>cost unknown</span> : null}
      </span>
      {last && s.phase !== "working" && REASONS[e.data.reason] && (
        <button type="button" data-testid="resume" onClick={() => actions.resume(s.id).catch(reportError)} className="ml-2 flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption font-medium text-accent-ink hover:bg-accent-soft">
          <Play className="size-3" /> Continue
        </button>
      )}
    </div>
  );
}

// What a screen reader hears about the turn: why it waits, once per change.
// The visible clocks above tick; this region changes only when the reason
// does, and a replayed status after a reconnect says nothing new.
function Announcer({ sessionId, working }: { sessionId: string; working: boolean }) {
  const st = useStore((x) => x.status[sessionId]);
  const approving = useSafety((x) => (x.approvals[sessionId]?.length ?? 0) > 0);
  const said = useRef<string | null>(null);
  let text = "";
  if (approving) text = "Waiting for your approval.";
  else if (st?.kind === "retry") text = `The provider failed: ${st.message}. Retrying, attempt ${st.attempt} of ${st.max}.`;
  else if (st?.kind === "compacting") text = "Compacting the context.";
  else if (working) text = "Working.";
  else if (said.current) text = "The turn ended.";
  if (said.current === null && !working && !approving) text = ""; // opening an idle session announces nothing
  said.current = text || said.current;
  return <div className="sr-only" role="status" aria-live="polite" data-testid="turn-announcer">{text}</div>;
}

// The streaming reply and the working line. Deltas re-render only this, not
// the whole transcript above it.
function Live({ sessionId, working, asking, since, previewing }: { sessionId: string; working: boolean; asking: boolean; since?: number; previewing: boolean }) {
  const draft = useStore((s) => s.drafts[sessionId]);
  const hasDraft = draft && Object.values(draft).some((b) => b.text.trim() || b.kind !== "text");
  // The reply streams on the current branch: under another branch it would read as that branch's.
  if (previewing) {
    return (
      <>
        {working && (
          <div className="flex items-center gap-2.5 py-1 text-caption text-faint" data-testid="replying-elsewhere">
            <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /> The current branch is replying. Back to the current one to read it.
          </div>
        )}
        <Announcer sessionId={sessionId} working={working} />
      </>
    );
  }
  return (
    <>
      {hasDraft && <div className="flex flex-col gap-3" data-testid="draft"><Draft draft={draft} /></div>}
      <Status sessionId={sessionId} />
      {working && !hasDraft && !asking && <Working since={since} sessionId={sessionId} />}
      <Announcer sessionId={sessionId} working={working} />
    </>
  );
}

const TAIL = 150; // events rendered first when a long session opens

// Who stopped a turn, as the footer says it (a child's turn records the same actor as its agent card).
const STOP_BY: Record<string, string> = { owner: " by you", parent: " by the parent agent", parent_turn: " with the parent's turn", time_limit: ": its time limit passed", parent_archived: ": its parent session was archived" };

export function Transcript({ sessionId }: { sessionId: string }) {
  const all = useStore((s) => s.events[sessionId]);
  const session = useStore((s) => s.sessions[sessionId])!;
  // A search hit on another branch is read in place: that branch is shown, the
  // session's own branch (where the next reply goes) does not move.
  const preview = useUI((s) => (s.preview?.session === sessionId ? s.preview.event : null));
  const shownHead = useMemo(() => {
    if (!all || !preview || !all.some((e) => e.id === preview) || lineage(all, session.head).some((e) => e.id === preview)) return session.head;
    return leafOf(all, preview);
  }, [all, preview, session.head]);
  const previewing = shownHead !== session.head;
  const events = useMemo(() => (all ? lineage(all, shownHead) : undefined), [all, shownHead]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  // What the reader looks at when not following the end: the deepest block
  // crossing the top of the view, and its offset there. A
  // size change above it (a report opening, an image loading, rows rendering
  // in) moves the scroll by as much, so the words stay under the eyes.
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const remember = () => {
    const el = scroller.current;
    const c = content.current;
    anchor.current = null;
    if (!el || !c || stick.current) return;
    const top = el.getBoundingClientRect().top;
    // Rows stack in order: the first whose bottom is below the top, by halving.
    const over = (all: HTMLCollection) => {
      const list = [...all].filter((x) => !(x as HTMLElement).dataset.pinned); // the sticky branch banner does not scroll
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]!.getBoundingClientRect().bottom > top + 1) hi = mid; else lo = mid + 1; }
      return list[lo];
    };
    const row = over(c.children);
    if (!row) return;
    let part: Element = row;
    // Down to the deepest block crossing the top (a paragraph of a tall reply):
    // what grows before it inside the same reply moves it too.
    for (let depth = 0; depth < 6 && part.getBoundingClientRect().top < top; depth++) {
      const inner: Element | undefined = [...part.children].find((x) => { const r = x.getBoundingClientRect(); return r.height > 0 && r.bottom > top + 1; });
      if (!inner) break;
      part = inner;
    }
    anchor.current = { el: part, top: part.getBoundingClientRect().top - top };
  };

  // The versions of each prompt (see versions() in tree.ts), grouped once per change of the list.
  const siblings = useMemo(() => {
    const m = new Map<string | null, StoredEvent[]>();
    for (const e of all ?? []) if (e.kind === "user" && !e.data.origin) (m.get(e.parent) ?? m.set(e.parent, []).get(e.parent)!).push(e);
    return m;
  }, [all]);

  const results = useMemo(() => {
    const m = new Map<string, ToolResultBlock>();
    // A call's `shown` (the owner's answers to a question) rides with its result, for the card only.
    for (const e of events ?? []) if (e.kind === "tool_result") for (const r of e.data.results) m.set(r.tool_use_id, e.data.shown?.[r.tool_use_id] ? { ...r, shown: e.data.shown[r.tool_use_id] } as ToolResultBlock : r);
    return m;
  }, [events]);

  const toEnd = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  };

  // Follow the end while it grows (streaming, a tool row opening), unless the reader scrolled up.
  // The streaming draft grows inside `content`, so the ResizeObserver below follows it.
  useLayoutEffect(() => { if (stick.current) toEnd(); }, [events]);
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      // A size change queued before the transcript left the page lands after it: nothing to measure.
      const el = scroller.current;
      if (!el) return;
      // The message box keeps the column's edges: it gets the scroll bar's width as padding.
      // Set on this session's own column, and only when it changes: a write on the
      // document restyled every station's transcript at each streamed line.
      const box = el.closest<HTMLElement>(".k-session");
      const sbw = `${el.offsetWidth - el.clientWidth}px`;
      if (box && box.style.getPropertyValue("--sbw") !== sbw) box.style.setProperty("--sbw", sbw);
      if (stick.current) el.scrollTop = el.scrollHeight;
      else if (anchor.current?.el.isConnected) {
        const moved = anchor.current.el.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.top;
        if (Math.abs(moved) >= 0.5) el.scrollTop += moved;
      }
      remember();
    });
    ro.observe(c);
    const onEnd = () => toEnd(true);
    addEventListener("keel:end", onEnd);
    return () => { ro.disconnect(); removeEventListener("keel:end", onEnd); };
  }, [!!events]);

  // A search hit opens the session at its message.
  // The request is checked when the frame runs, before anything moves: one
  // cleared or replaced meanwhile scrolls nothing. The row becomes the
  // keyboard's place too, so the next Tab reaches its actions; a jump that
  // says so (`focusStay`, the branch tree's) leaves the keyboard where it is.
  const focus = useUI((s) => s.focusEvent);
  useEffect(() => {
    if (!focus || !events?.some((e) => e.id === focus)) return;
    const raf = requestAnimationFrame(() => {
      if (getUI().focusEvent !== focus) return;
      const stay = getUI().focusStay === focus;
      setUI({ focusEvent: null, focusStay: null });
      const el = document.getElementById(`e-${focus}`);
      if (!el) return; // folded into a turn's notes: the session opens at its end as usual
      stick.current = false;
      // Centered in the transcript's own scroller (scrollIntoView would also move clipped ancestors).
      const sc = scroller.current;
      if (sc) {
        const r = el.getBoundingClientRect();
        const box = sc.getBoundingClientRect();
        sc.scrollTop += r.top - box.top - Math.max(0, (box.height - r.height) / 2);
      }
      remember();
      if (!stay) {
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
      }
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    });
    return () => cancelAnimationFrame(raf);
  }, [focus, events]);

  // A long session opens at its end: its newest events render first, from the
  // turn they belong to, and the rest join in a transition right after (input
  // and streaming keep the main thread meanwhile). Everything ends up mounted,
  // so the browser's find and a jump to any event still work.
  const [whole, setWhole] = useState(false);
  useEffect(() => setWhole(false), [sessionId]);
  const cut = useMemo(() => {
    if (!events || events.length <= TAIL) return 0;
    for (let i = events.length - TAIL; i > 0; i--) if (events[i]!.kind === "user" && !events[i]!.data.origin) return i;
    return 0;
  }, [events]);
  const from = whole || (focus && events?.findIndex((e) => e.id === focus)! < cut) ? 0 : cut;
  useEffect(() => {
    if (from === 0) return;
    const t = setTimeout(() => startTransition(() => setWhole(true)), 0);
    return () => clearTimeout(t);
  }, [from]);

  // A question card waiting on the owner says so itself; no "Working" under it.
  const asking = useStore((s) => !!s.questionCalls[sessionId]?.length);
  if (!events) return <div className="flex-1" />;
  const lastStart = [...events].reverse().find((e) => e.kind === "turn_start");

  // Per turn: the prompt that started it and the text of its replies, for the footer's actions.
  let prompt: StoredEvent | undefined;
  let reply: string[] = [];
  let notes: StoredEvent[] = []; // harness notes of the turn, shown on its footer
  const lastEnd = [...events].reverse().find((e) => e.kind === "turn_end")?.id;

  return (
    // A strip of the conversation stays above a tall stack of cards and a long
    // draft, in a pane with room for one (none in a pane under 24rem high).
    <div className="relative min-h-[clamp(0px,calc((100%-24rem)/2),6rem)] flex-1">
      <div
        ref={scroller}
        className="relative h-full overflow-y-auto [scrollbar-gutter:stable] [overflow-anchor:none]"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          if (away === near) setAway(!near);
          remember();
        }}
      >
        <div ref={content} className="mx-auto flex max-w-[48rem] flex-col gap-4 px-4 py-8 md:px-6" data-testid="transcript">
          {previewing && (
            <div className="sticky top-2 z-10 flex items-center gap-2 rounded-lg border border-brass/50 bg-raised px-3.5 py-2 text-ui shadow-2" data-testid="branch-preview" data-pinned="1">
              <GitBranch className="size-4 shrink-0 text-brass" />
              <span className="min-w-0 flex-1 text-muted">You are reading another branch. Replies still go to the current one.</span>
              <button type="button" data-testid="preview-continue" disabled={session.phase === "working"} title={session.phase === "working" ? "Possible when the turn ends" : undefined}
                onClick={() => actions.setHead(sessionId, preview!, true).then(() => setUI({ preview: null })).catch(reportError)}
                className="h-7 rounded-md bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">Continue from this branch</button>
              <button type="button" data-testid="preview-back" onClick={() => setUI({ preview: null })} className="h-7 rounded-md px-2.5 text-caption text-muted hover:bg-hover hover:text-fg">Back to the current one</button>
            </div>
          )}
          {events.length === 0 && session.phase !== "working" && <p className="py-10 text-center text-ui text-faint">No messages yet.</p>}
          {events.slice(from).map((e, i) => {
            const idx = from + i;
            if (e.kind === "user") {
              // Folded into the turn's notes (the footer); the cut itself shows on the footer.
              if (e.data.origin === "restart") { notes.push(e); return null; }
              if (e.data.origin === "harness") {
                return <p key={e.id} id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-md text-center text-caption text-faint" data-testid="harness-note">{String(e.data.text).replace(/^\[harness\]\s*/, "")}</p>;
              }
              prompt = e;
              reply = [];
              if (SYSTEM_INPUT.has(e.data.kind) || isPeerMessage(e)) {
                return <div key={e.id} id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-lg">{SYSTEM_INPUT.has(e.data.kind) ? <InputNotice e={e} /> : <PeerMessage e={e} />}</div>;
              }
              return <UserMessage key={e.id} e={e} s={session} vs={siblings.get(e.parent) ?? []} />;
            }
            // A clear is undone while nothing the model reads came after it (a note of the page may have).
            if (e.kind === "compaction") return <Checkpoint key={e.id} e={e} s={session} undoable={!previewing && events.slice(idx + 1).every((x) => x.kind === "note" && !x.data.model)} />;
            if (e.kind === "assistant" && e.data.stop === "refusal") return <Refusal key={e.id} e={e} s={session} handled={events[idx + 1]?.kind === "note" && events[idx + 1]!.data.kind === "fallback"} />;
            if (e.kind === "assistant") {
              for (const b of e.data.blocks) if (b.type === "text" && b.text.trim()) reply.push(b.text);
              return <div key={e.id} id={`e-${e.id}`} className="row-cv flex flex-col gap-3 rounded-lg" data-event-id={e.id}><AssistantBlocks blocks={e.data.blocks} results={results} s={session} /></div>;
            }
            if (e.kind === "error") {
              return (
                <div key={e.id} className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-ui text-danger" data-testid="turn-error">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="whitespace-pre-wrap break-words">{e.data.message}</span>
                </div>
              );
            }
            // Memory and hook notes fold into the turn's notes on its footer: quiet at six stations.
            if (e.kind === "note" && (e.data.hook || e.data.memory)) { notes.push(e); return null; }
            if (e.kind === "note" && e.data.kind === "summary") return <Checkpoint key={e.id} e={e} s={session} />;
            if (e.kind === "note" && e.data.kind === "fork") return <ForkNote key={e.id} e={e} />;
            if (e.kind === "note" && e.data.kind === "peer_refused") return <RefusedNote key={e.id} e={e} />;
            // What the new model is told after a switch: the switch note above already says it.
            if (e.kind === "note" && e.data.kind === "model_told") return null;
            // A model switch: who made it and when, inline where it took effect.
            if (e.kind === "note" && e.data.kind === "model") {
              const at = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
              return <Divider key={e.id} testid="model-note"><span>{e.data.text} <span className="text-faint">{e.data.by === "cli" ? "From keel run" : "By you"}, {at}</span></span></Divider>;
            }
            if (e.kind === "note") {
              // A note for the model (a background job ended) reads short here: no tags, no log path.
              const text = e.data.short ? e.data.short : e.data.skill ? `Loaded the ${e.data.skill} skill` : e.data.mcp_prompt ? `Loaded the ${e.data.mcp_prompt} prompt` : e.data.kind === "skill_mode" ? (e.data.skill_mode ? `Skill mode: ${e.data.skill_mode}` : "Skill mode off") : e.data.model ? String(e.data.text).replace(/<\/?system-reminder>/g, "").replace(/\. Output: \S+/g, ".").trim() : e.data.text;
              return <Divider key={e.id} testid="note"><span>{text}</span></Divider>;
            }
            if (e.kind === "turn_end") {
              const r = reply.join("\n\n");
              const mine = notes;
              notes = [];
              return <Fragment key={e.id}><TurnFooter e={e} reply={r} prompt={prompt} s={session} last={e.id === lastEnd} notes={mine} /></Fragment>;
            }
            return null;
          })}
          {notes.length > 0 && <div className="flex" data-testid="pending-notes"><TurnNotes notes={notes} working={session.phase === "working"} /></div>}
          <Live sessionId={sessionId} working={session.phase === "working"} asking={asking} since={lastStart?.ts} previewing={previewing} />
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={() => toEnd(true)}
          data-testid="jump-latest"
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-caption font-medium text-muted shadow-2 animate-pop hover:text-fg"
        >
          <ArrowDown className="size-3.5" /> Latest
        </button>
      )}
    </div>
  );
}
