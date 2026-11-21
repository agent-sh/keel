import { CopyButton } from "./CopyButton.tsx";
import { ArrowDown, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, FileText, GitBranch, ImageOff, Layers, Pencil, Play, RotateCcw, RotateCw, ShieldAlert } from "lucide-react";
import { TurnNotes } from "./MemoryNote.tsx";
import { createContext, memo, startTransition, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { lineage } from "../../../src/core/tree.ts";
import type { AssistantBlock, AttachmentBlock, ImageBlock, PromptBlock, Session, StoredEvent, ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { shownAsPrompt } from "../../../src/core/owner.ts";
import { rowActions } from "../lib/extend.ts";
import { blockKey, buildRows, nextLineage, nextSiblings, PROBE, rowProbe, type Built, type LineageOf, type Row, type SiblingsOf } from "../lib/rows.ts";
import { actions, api, dropSession, failed, forgetEvents, getState, keepEvents, liveNow, onFeature, reportError, useStore, type DraftBlock } from "../lib/store.ts";
import { useSafety } from "../lib/safety.ts";
import { getUI, navigate, seedComposer, setUI, useUI } from "../lib/ui.ts";
import { announce } from "../lib/announce.ts";
import { composing } from "../lib/keys.ts";
import { Kbd } from "./Kbd.tsx";
import { clock, cn, fmtCost, fmtTokens, fmtWait, focusBox, scrollMotion } from "../lib/utils.ts";
import { TurnFailure } from "./TurnFailure.tsx";
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
      {text.trim() && <div className="mt-1.5 max-h-96 overflow-y-auto border-l-2 border-line pl-3.5 text-base leading-relaxed whitespace-pre-wrap">{text}</div>}
    </details>
  );
}

function ActionButton({ label, onClick, children, testid, idle }: { label: string; onClick: () => void; children: ReactNode; testid?: string; idle?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} data-testid={testid} data-idle-only={idle || undefined} onClick={onClick} className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
      {children}
    </button>
  );
}

// What a finished row reads of its session while the transcript goes on: the
// session, and which turn is the last one. Rows are memo components that get
// only their own content as props; each reads what it shows of the rest here
// with a selector, so a new event renders the rows it changes and no other.
// The session is replaced only when something other than its head, last
// activity and revision changed (those move with every event; no row shows them).
// `last`: the newest event shown. `other`: the head of the branch shown when it is not the session's.
type Tail = { session: Session; lastEnd?: string; last?: string; reading: boolean; other?: string };
const MOVING = new Set(["head", "updated", "rev"]);
const sameSession = (a: Session, b: Session) => {
  if (a === b) return true;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!MOVING.has(k) && (a as any)[k] !== (b as any)[k]) return false;
  return true;
};
function tailStore() {
  let st: Tail | null = null;
  let images: string | undefined;
  let dirty = false;
  const subs = new Set<() => void>();
  return {
    get: () => st!,
    // Called while the transcript renders: rows rendered in the same pass read it at once.
    // `reading`: the transcript shows a run away from the end of the session's branch.
    put(session: Session, lastEnd: string | undefined, last: string | undefined, reading: boolean, other?: string) {
      if (st && st.lastEnd === lastEnd && st.last === last && st.reading === reading && st.other === other && sameSession(st.session, session)) return;
      st = { session, lastEnd, last, reading, other };
      dirty = true;
    },
    // After the commit: rows that did not render ask their selector again.
    flush() {
      if (!dirty) return;
      dirty = false;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
    // The newest note about images left out (it alone offers to send them again).
    lastImages: () => images,
    setImages(id: string | undefined) { if (id !== images) { images = id; dirty = true; } },
  };
}
const TailContext = createContext<ReturnType<typeof tailStore>>(null!);
function useTail<T>(sel: (t: Tail) => T): T {
  const store = useContext(TailContext);
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
const isWorking = (t: Tail) => t.session.phase === "working";

function Extra({ on, e }: { on: "user" | "assistant"; e: StoredEvent }) {
  useSyncExternalStore(rowActions.subscribe, rowActions.version);
  const store = useContext(TailContext);
  // The actions this row offers, as their ids: a session change that offers the same ones renders nothing.
  const shown = useTail((t) => rowActions.all().filter((a) => a.on === on && (!a.when || a.when(e, t.session))).map((a) => a.id).join(" "));
  const ids = new Set(shown.split(" "));
  const s = store.get().session;
  return (
    <>
      {rowActions.all().filter((a) => a.on === on && ids.has(a.id)).map((a) => (
        <ActionButton key={a.id} label={a.label} testid={`rowaction-${a.id}`} idle={a.idle} onClick={() => a.run(e, getState().sessions[s.id] ?? s)}>{typeof a.icon === "function" ? a.icon(e, s) : a.icon}</ActionButton>
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
function UserMessage({ e, sid, vs }: { e: StoredEvent; sid: string; vs: StoredEvent[] }) {
  const text: string = e.data.text ?? "";
  const long = text.length > 1400 || text.split("\n").length > 18;
  const [full, setFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const at = vs.findIndex((v) => v.id === e.id);
  // Only a prompt with versions shows the turn's state (its arrows wait for the turn).
  const working = useTail((t) => vs.length > 1 && isWorking(t));
  const origin: string | undefined = e.data.origin;
  // The other version's branch may end far from its prompt: when the part the
  // page holds of it does not reach the prompt, the transcript opens there.
  const store = useContext(TailContext);
  const pick = (i: number) => actions.setHead(sid, vs[i]!.id).then((r) => {
    const to = vs[i]!.id;
    if (store.get().reading || !lineage(getState().events[sid] ?? [], r.head).some((x) => x.id === to)) setUI({ focusEvent: to, focusStay: to });
  }).catch(reportError);
  if (editing) return <EditPrompt e={e} sid={sid} onDone={() => setEditing(false)} />;
  return (
    <div id={`e-${e.id}`} className="k-user-message group/user row-cv flex scroll-mt-6 flex-col items-end gap-1.5 rounded-lg animate-in" data-testid="user-message" data-event-id={e.id}>
      {origin === "steer" && <span className="k-label" data-testid="origin-steer">Steered into the turn</span>}
      {e.data.edited_from === "steer" && <span className="k-label" data-testid="origin-edited-steer">An edited steer, sent as a new turn</span>}
      {origin === "queued" && <span className="k-label" data-testid="origin-queued">From the queue</span>}
      {e.data.images?.length > 0 && <Images blocks={e.data.images} />}
      {text && (
        <div className="k-user-words relative max-w-[min(85%,40rem)] rounded-xl rounded-br-sm bg-accent-soft px-4 py-2.5 text-read leading-relaxed text-fg">
          <div className={cn("whitespace-pre-wrap break-words", long && !full && "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>{text}</div>
          {long && (
            <button type="button" onClick={() => setFull(!full)} className="k-link mt-1 text-caption font-medium text-accent-ink hover:underline">
              {full ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
      <div className="-mt-0.5 flex h-6 items-center">
        <span className="flex items-center opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <CopyButton text={() => text} label="Copy the message" testid="copy-message" className="size-7" />
          <ActionButton label="Edit and send as a new version" testid="edit-message" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></ActionButton>
          <Extra on="user" e={e} />
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
function EditPrompt({ e, sid, onDone }: { e: StoredEvent; sid: string; onDone: () => void }) {
  const working = useTail(isWorking);
  const raw: string = e.data.text ?? "";
  const [text, setText] = useState<string>(raw);
  const blocks: PromptBlock[] = e.data.images ?? [];
  const n = blocks.length;
  const ok = !!text.trim() || n > 0;
  const send = () => ok && actions.edit(sid, e.id, text.trim()).then(onDone, reportError);
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
            if (composing(x)) return;
            if (x.key === "Escape") onDone();
            if (x.key === "Enter" && !x.shiftKey) { x.preventDefault(); send(); }
          }}
          className="block min-h-16 w-full resize-y bg-transparent px-2 py-1 text-read leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <span className="mr-auto pl-2 text-caption text-faint" data-testid="edit-note">
            {working ? "Stops the turn, then sends this as a new version." : "Sends as a new version; the current one stays as a branch."}
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
function Refusal({ e, sid, handled }: { e: StoredEvent; sid: string; handled?: boolean }) {
  const model = useTail((t) => t.session.model);
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
        <div className="rounded-md border border-line"><ModelPicker value={pick || model} onChange={setPick} /></div>
        <button
          type="button"
          disabled={!pick || pick === model}
          onClick={() =>
            // The picker's switch (with its cache warning): Cancel leaves the model and does not resume.
            switchSession(sid, { model: pick })
              .then(async (ok) => {
                if (!ok) return;
                if (keep) await actions.patch(sid, { settings: { fallback: pick } });
                await actions.resume(sid);
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
function Checkpoint({ e, sid, undoable }: { e: StoredEvent; sid: string; undoable?: boolean }) {
  if (e.data.mode === "clear") {
    return (
      <Divider testid="cleared">
        <span className="flex items-center gap-1.5"><RotateCcw className="size-3.5" /> Context cleared. The model starts fresh from here.</span>
        {undoable && e.data.undo_head && (
          <button type="button" data-testid="undo-clear" className="rounded-sm px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft" onClick={() => actions.setHead(sid, e.data.undo_head, false, false).catch(reportError)}>
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
            {e.data.parts ? ` (too long for one request: read as a transcript${e.data.parts > 1 ? ` in ${e.data.parts} parts` : ""}${e.data.outputs_shortened ? `, ${e.data.outputs_shortened} long tool outputs shortened` : ""}${e.data.steps_left_out ? `, the oldest ${e.data.steps_left_out.toLocaleString()} steps of the work left out of the summary` : ""})` : ""}
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

// The provider refused a request over the session's images: what Keel did so
// the turn went on. Where it left images out, the newest such note offers to
// send them again (the session's images_out is cleared; a provider that
// refuses them again has them left out again).
function ImagesNote({ e, sid }: { e: StoredEvent; sid: string }) {
  const store = useContext(TailContext);
  const out = useTail((t) => t.session.settings.images_out?.length ?? 0);
  const last = useSyncExternalStore(store.subscribe, () => store.lastImages() === e.id);
  return (
    <Divider testid="images-note">
      <span className="flex items-center gap-1.5"><ImageOff className="size-3.5 shrink-0" /> {e.data.text}</span>
      {last && e.data.left_out > 0 && (out > 0 ? (
        <button type="button" data-testid="images-restore" className="shrink-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft" onClick={() => actions.patch(sid, { settings: { images_out: null } }).catch(reportError)}>
          Send them again
        </button>
      ) : <span data-testid="images-restored" className="shrink-0 whitespace-nowrap text-muted">Sending them again</span>)}
    </Divider>
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

// A history too long for one request: what reading it in parts takes, said
// before the first request and counted as they finish.
function compactPlan(plan?: { requests: number; done: number; input_tokens: number; cost?: number; steps_left_out?: number }): string {
  if (!plan || plan.requests < 2) return "";
  return `: too long for one request, read in ${plan.requests} requests of about ${fmtTokens(Math.round(plan.input_tokens / plan.requests))} tokens (${fmtTokens(plan.input_tokens)} in all${plan.cost !== undefined ? `, about ${fmtCost(plan.cost)}` : ""})${plan.steps_left_out ? `, the oldest ${plan.steps_left_out.toLocaleString()} steps left out` : ""}; ${plan.done} of ${plan.requests} done`;
}

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
    return <div className="flex items-center gap-2 text-ui text-muted animate-pulse-dot" data-testid="compacting"><Layers className="size-3.5 shrink-0" /> <span>Compacting the context{compactPlan(st.plan)}</span></div>;
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-raised px-3 py-2 text-ui" data-testid="retrying">
      <span className="size-1.5 rounded-full bg-warn animate-pulse-dot" />
      <span className="min-w-0 flex-1 truncate text-muted" title={st.message}>{st.message}</span>
      <span className="shrink-0 tabular-nums text-faint">retrying in {fmtWait(st.at - liveNow())}, attempt {st.attempt} of {st.max}</span>
    </div>
  );
}

function AssistantBlocks({ blocks, results, sid }: { blocks: AssistantBlock[]; results: (ToolResultBlock | undefined)[]; sid: string }) {
  const remote = useTail((t) => !!t.session.machine);
  const cwd = useTail((t) => t.session.workspace);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text") return b.text.trim() ? <div key={i} data-testid="assistant-text"><Markdown text={b.text} sessionId={remote ? undefined : sid} /></div> : null;
        // A thought may carry only opaque state for replay (an encrypted item): nothing to show.
        if (b.type === "thinking") return b.thinking.trim() ? <Thinking key={i} text={b.thinking} /> : null;
        if (b.type === "tool_use") return <ToolCall key={b.id} use={b} result={results[i]} sessionId={sid} cwd={cwd} />;
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
  const s = from ? Math.max(0, Math.round((liveNow() - from) / 1000)) : 0; // stopped while the daemon is unreachable
  const what = approving ? "Waiting for your approval" : st?.kind === "model" ? (st.preparing === "images" ? `Scaling images for ${st.model}` : st.connected ? `Connected to ${st.model}, no output yet` : `Waiting on ${st.model}`) : st?.kind === "tool" ? `Running ${st.names.join(", ")}` : "Working";
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

// `boxed`: the turn failed and its failure box is shown above. The box has the
// way on (try again, the fix), and a turn with no reply has nothing to copy,
// mark or rate: the footer keeps only what applies.
// `times`: how many restarts in a row this footer stands for.
// `partial`: the turn began before the events the page holds (a turn longer
// than a part): Copy reads the whole reply from the daemon.
function TurnFooter({ e, reply, prompt, sid, notes, boxed = false, times = 1, partial = false }: { e: StoredEvent; reply: string[]; prompt?: StoredEvent; sid: string; notes: StoredEvent[]; boxed?: boolean; times?: number; partial?: boolean }) {
  const last = useTail((t) => t.lastEnd === e.id);
  // The turn's state shows on the last footer (its actions) and on a restart chip.
  const working = useTail((t) => (last || notes.some((n) => n.kind === "user")) && isWorking(t));
  const tailOf = useContext(TailContext);
  const u = e.data.usage;
  const input = u ? u.input + u.cache_read + u.cache_write : 0;
  const cached = u && input ? Math.round((100 * u.cache_read) / input) : 0;
  return (
    <div className="k-turn-foot group/foot -mt-1 flex h-7 items-center gap-0.5" data-quiet={!last || undefined}>
      {(reply.length > 0 || partial) && <CopyButton text={() => (partial ? actions.reply(sid, { before: e.seq, head: tailOf.get().other }) : reply.join("\n\n"))} label="Copy the reply" testid="copy-reply" className="size-7" />}
      {prompt && last && !working && (
        <ActionButton label="Answer again (a new version; this one stays a branch)" testid="retry" onClick={() => actions.edit(sid, prompt.id, prompt.data.text).catch(reportError)}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      )}
      {!(boxed && !reply.length) && <Extra on="assistant" e={e} />}
      <TurnNotes notes={notes} working={working} />
      <span className="k-turn-end ml-2 flex gap-3 text-micro tabular-nums text-faint select-none" data-testid="turn-end">
        {REASONS[e.data.reason] && <span className={e.data.reason === "error" ? "text-st-fail" : "text-warn"} data-testid="turn-reason">{REASONS[e.data.reason]}{STOP_BY[e.data.stopped_by] ?? ""}{times > 1 ? `, ${times} times` : ""}</span>}
        <span>{(e.data.ms / 1000).toFixed(1)}s</span>
        {u && <span>{fmtTokens(input)} in{cached ? `, ${cached}% cached` : ""}</span>}
        {u && <span>{fmtTokens(u.output)} out</span>}
        {u?.cost !== undefined && !u.unpriced ? <span data-testid="turn-cost">{fmtCost(u.cost)}</span> : u?.unpriced ? <span>cost unknown</span> : null}
      </span>
      {last && !working && REASONS[e.data.reason] && !boxed && (
        <button type="button" data-testid="resume" onClick={() => actions.resume(sid).catch(reportError)} className="ml-2 flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption font-medium text-accent-ink hover:bg-accent-soft">
          <Play className="size-3" /> Resume
        </button>
      )}
    </div>
  );
}

// What a screen reader hears about the turn: why it waits, once per change.
// The visible clocks above tick; this region changes only when the reason
// does, and a replayed status after a reconnect says nothing new.
function Announcer({ sessionId, working, asking }: { sessionId: string; working: boolean; asking: boolean }) {
  const st = useStore((x) => x.status[sessionId]);
  const approving = useSafety((x) => (x.approvals[sessionId]?.length ?? 0) > 0);
  const said = useRef<string | null>(null);
  let text = "";
  if (approving) text = "Waiting for your approval.";
  // A question card takes the place of the working line: the region says what the turn waits on.
  else if (asking) text = "Waiting for your answer.";
  else if (st?.kind === "retry") text = `The provider failed: ${st.message}. Retrying, attempt ${st.attempt} of ${st.max}.`;
  else if (st?.kind === "compacting") text = `Compacting the context${compactPlan(st.plan)}.`;
  else if (working) text = "Working.";
  else if (said.current) text = "The turn ended.";
  if (said.current === null && !working && !approving && !asking) text = ""; // opening an idle session announces nothing
  said.current = text || said.current;
  return <div className="sr-only" role="status" aria-live="polite" data-testid="turn-announcer">{text}</div>;
}

// The streaming reply and the working line. Deltas re-render only this, not
// the whole transcript above it.
function Live({ sessionId, working, asking, since, elsewhere }: { sessionId: string; working: boolean; asking: boolean; since?: number; elsewhere: "branch" | "earlier" | null }) {
  const draft = useStore((s) => s.drafts[sessionId]);
  const hasDraft = draft && Object.values(draft).some((b) => b.text.trim() || b.kind !== "text");
  // The reply streams at the end of the current branch: under another branch,
  // or under an earlier part of this one, it would read as written there.
  if (elsewhere) {
    return (
      <>
        {working && (
          <div className="flex items-center gap-2.5 py-1 text-caption text-faint" data-testid="replying-elsewhere">
            <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /> {elsewhere === "branch" ? "The current branch is replying. Back to the current one to read it." : "A reply is being written at the end. Latest shows it."}
          </div>
        )}
        <Announcer sessionId={sessionId} working={working} asking={asking} />
      </>
    );
  }
  return (
    <>
      {hasDraft && <div className="flex flex-col gap-3" data-testid="draft"><Draft draft={draft} /></div>}
      <Status sessionId={sessionId} />
      {working && !hasDraft && !asking && <Working since={since} sessionId={sessionId} />}
      <Announcer sessionId={sessionId} working={working} asking={asking} />
    </>
  );
}

const TAIL = 150; // events rendered first when a long session opens

// A prompt of the owner's, as the transcript shows one (not a note of the
// harness, a system input or another session's message).
const isPrompt = shownAsPrompt;

// Who stopped a turn, as the footer says it (a child's turn records the same actor as its agent card).
const STOP_BY: Record<string, string> = { owner: " by you", parent: " by the parent agent", parent_turn: " with the parent's turn", time_limit: ": its time limit passed", parent_archived: ": its parent session was archived" };

const isInput = (e: StoredEvent) => SYSTEM_INPUT.has(e.data.kind) || isPeerMessage(e);

// One row. Its props are its own content (the row object stays the same while
// that does not change), so a reply streaming or an event added below renders
// nothing here.
const TranscriptRow = memo(function TranscriptRow({ row, sid }: { row: Row; sid: string }) {
  if (PROBE) rowProbe.rendered?.(row.id);
  const e = row.e;
  switch (row.kind) {
    case "harness":
      return <p id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-md text-center text-caption text-faint" data-testid="harness-note">{String(e.data.text).replace(/^\[harness\]\s*/, "")}</p>;
    case "input":
      return <div id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-lg">{SYSTEM_INPUT.has(e.data.kind) ? <InputNotice e={e} /> : <PeerMessage e={e} />}</div>;
    case "user":
      return <UserMessage e={e} sid={sid} vs={row.vs!} />;
    case "checkpoint":
      return <Checkpoint e={e} sid={sid} undoable={row.undoable} />;
    case "refusal":
      return <Refusal e={e} sid={sid} handled={row.handled} />;
    case "assistant":
      return <div id={`e-${e.id}`} className="row-cv flex flex-col gap-3 rounded-lg" data-event-id={e.id}><AssistantBlocks blocks={e.data.blocks} results={row.results!} sid={sid} /></div>;
    case "error":
      return <Failure e={e} after={row.after} />;
    case "images":
      return <ImagesNote e={e} sid={sid} />;
    case "fork":
      return <ForkNote e={e} />;
    case "peer_refused":
      return <RefusedNote e={e} />;
    case "model": {
      // A model switch: who made it and when, inline where it took effect.
      const at = clock(e.ts);
      return <Divider testid="model-note"><span>{e.data.text} <span className="text-faint">{e.data.by === "cli" ? "From keel run" : "By you"}, {at}</span></span></Divider>;
    }
    case "note": {
      // A note for the model (a background job ended) reads short here: no tags, no log path.
      const text = e.data.short ? e.data.short : e.data.skill ? `Loaded the ${e.data.skill} skill` : e.data.mcp_prompt ? `Loaded the ${e.data.mcp_prompt} prompt` : e.data.kind === "skill_mode" ? (e.data.skill_mode ? `Skill mode: ${e.data.skill_mode}` : "Skill mode off") : e.data.model ? String(e.data.text).replace(/<\/?system-reminder>/g, "").replace(/\. Output: \S+/g, ".").trim() : e.data.text;
      return <Divider testid="note"><span>{text}</span></Divider>;
    }
    case "end":
      // A restart the next restart's footer stands for.
      if (row.folded) return null;
      // A failed turn says what failed first, then its footer.
      return (
        <>
          {row.failures?.map((f) => <Failure key={f.id} e={f} end={e.id} />)}
          <TurnFooter e={e} reply={row.reply!} prompt={row.prompt} sid={sid} notes={row.notes!} boxed={!!row.failures?.length} times={row.times} partial={row.partial} />
        </>
      );
  }
});

// The box of a failed turn (TurnFailure.tsx). It offers the way on while the
// failure is where the session stands: above the last footer (`end`), or by
// itself right after the last turn's end or as the newest event, and no turn runs.
function Failure({ e, end, after }: { e: StoredEvent; end?: string; after?: string }) {
  const s = useTail((t) => t.session);
  const live = useTail((t) => !isWorking(t) && (end ? t.lastEnd === end : (after !== undefined && after === t.lastEnd) || t.last === e.id));
  return <TurnFailure e={e} s={s} live={live} />;
}

// A run of rows (see rows.ts): one that did not change is not walked again.
const RowBlock = memo(function RowBlock({ rows, sid }: { rows: Row[]; sid: string }) {
  return <>{rows.map((r) => <TranscriptRow key={r.id} row={r} sid={sid} />)}</>;
});

const TAIL_BLOCKS = 6; // blocks of rows rendered first when a long session opens
const NONE: StoredEvent[] = [];

export function Transcript({ sessionId }: { sessionId: string }) {
  const all = useStore((s) => s.events[sessionId]);
  const session = useStore((s) => s.sessions[sessionId])!;
  // A search hit on another branch is read in place: that branch is shown, the
  // session's own branch (where the next reply goes) does not move.
  const preview = useUI((s) => (s.preview?.session === sessionId ? s.preview.event : null));
  const focus = useUI((s) => s.focusEvent);
  // The page holds the session in parts (the store's PAGE): the end of its
  // branch, and what was read since. Away from that end the transcript shows
  // one run of a branch: `view` names the event it was opened at, the branch
  // (its end) and where the run stops short of that end. Another branch is
  // read while its search hit stays picked; an earlier part of the session's
  // own branch until Latest.
  const [view, setView] = useState<{ event: string; head: string | null; end: string | null; other: boolean } | null>(null);
  const reading = view && (!view.other || preview === view.event) ? view : null;
  const shownHead = reading ? reading.end ?? reading.head : session.head;
  const previewing = !!reading?.other;
  const earlier = !!reading && !reading.other;
  useEffect(() => { if (view?.other && preview !== view.event) setView(null); }, [preview, view]);
  const short = useRef(false); // the run shown stops short of its branch's end
  short.current = !!reading?.end;
  // The branch shown, its prompts' versions and its rows, each from the one
  // before: an event added at the end is read alone (see rows.ts).
  const line = useRef<LineageOf | undefined>(undefined);
  const sibs = useRef<SiblingsOf | undefined>(undefined);
  const rows = useRef<Built | undefined>(undefined);
  const events = all ? (line.current = nextLineage(line.current, all, shownHead)).out : undefined;
  const siblings = (sibs.current = nextSiblings(sibs.current, all ?? NONE)).map;
  const built = events ? (rows.current = buildRows(rows.current, events, siblings, previewing, isInput)) : undefined;
  const tail = useMemo(tailStore, []);
  useLayoutEffect(() => tail.flush());
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const settling = useRef(false);
  // Where the scroll was last put, by the reader or by this transcript. A
  // scroll event that finds it lower is the reader going up (a wheel, a key,
  // the scroll bar, the browser's find): following the end stops. One that
  // only reports where this transcript put it is not, also when the content
  // grew meanwhile (a reply streams between the pin and its event) or shrank
  // (a streamed draft gave way to its stored reply, old rows were let go).
  const lastTop = useRef(0);
  const pin = (el: HTMLElement) => { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; };
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
    // Rows stack in order: the first whose bottom is below the top, by halving
    // over the rows where they are (no copy of the list: a long transcript is
    // scrolled through many times a second). What leads them and is no row
    // (the sticky branch banner, the button for earlier messages) is passed
    // over; it marks itself `data-pinned`.
    const rows = c.children;
    let lo = 0, hi = rows.length;
    while (lo < hi && lo < 3 && (rows.item(lo) as HTMLElement).dataset.pinned) lo++;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows.item(mid)!.getBoundingClientRect().bottom > top + 1) hi = mid; else lo = mid + 1; }
    const row = rows.item(lo);
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

  // The earlier part read leaves with its view: the events the page holds of
  // the session's own branch are the ones that reach its end.
  const leave = () => {
    if (!view || view.other) return;
    const s = getState().sessions[sessionId];
    const line = lineage(getState().events[sessionId] ?? [], s?.head ?? null);
    // A head the page does not hold yet (the session's row comes just before
    // its new event; the end of another branch is on its way): nothing is let
    // go, or the run that leads to that head would go with the part.
    if (!line.length) return setView(null);
    const kept = new Set(line.map((e) => e.id));
    // The other versions of the prompts that stay are still counted on them.
    const versions = new Set(line.filter((e) => e.kind === "user" && !e.data.origin).map((e) => e.parent));
    forgetEvents(sessionId, (events ?? []).filter((e) => !kept.has(e.id) && !(e.kind === "user" && !e.data.origin && versions.has(e.parent))).map((e) => e.id));
    setView(null);
  };
  const leaving = useRef(leave);
  leaving.current = leave;
  useEffect(() => () => leaving.current(), []);
  // The session went to another branch (a version chosen, a rewind): the
  // earlier part read was of the branch it left. Events added at the end keep it.
  useEffect(() => {
    if (!view || view.other || !all || session.head === view.head || !all.findLast((e) => e.id === session.head)) return;
    if (!lineage(all, session.head).some((e) => e.id === view.head)) leave();
  }, [session.head, all, view]);

  const toEnd = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    leaving.current();
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? scrollMotion() : "instant" });
    lastTop.current = el.scrollTop;
  };

  // Follow the end while it grows (streaming, a tool row opening), unless the reader scrolled up.
  // The streaming draft grows inside `content`, so the ResizeObserver below follows it.
  // Here only when the transcript opens or shows another run of events: the
  // end is on screen at the first paint. Events added to the run shown grow
  // the content, which the size observer below follows in the same frame
  // without a layout made on the spot for every event.
  const shownFrom = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    const from = events?.[0]?.id;
    const same = shownFrom.current !== undefined && shownFrom.current === from;
    shownFrom.current = from;
    if (el && !same && stick.current && !reading?.end) pin(el);
  }, [events]);
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    let late = 0;
    const ro = new ResizeObserver(() => {
      // A size change queued before the transcript left the page lands after it: nothing to measure.
      const el = scroller.current;
      if (!el) return;
      // The message box keeps the column's edges: it gets the scroll bar's width as padding.
      // Set on this session's own column, and only when it changes: a write on the
      // document restyled every station's transcript at each streamed line.
      // It is written a frame later: it changes the width of what other observers watch (the
      // message box's tray, the list of requests), and a size changed from inside an observer's
      // call, which they cannot be told of in the same pass, is reported by the browser as an error.
      const box = el.closest<HTMLElement>(".k-session");
      const sbw = `${el.offsetWidth - el.clientWidth}px`;
      if (box && box.style.getPropertyValue("--sbw") !== sbw) { cancelAnimationFrame(late); late = requestAnimationFrame(() => box.style.setProperty("--sbw", sbw)); }
      if (stick.current && !short.current) pin(el);
      else if (anchor.current?.el.isConnected) {
        // The anchor stays the one the reader chose by scrolling: after rows
        // are added above it (an earlier part read), the row now at the top is
        // one of those, still at its estimated height, and holding on to it
        // would let the reader's row slide as it takes its real height.
        const moved = anchor.current.el.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.top;
        if (Math.abs(moved) >= 0.5) {
          const was = el.scrollTop;
          el.scrollTop += moved;
          settling.current = el.scrollTop !== was; // a scroll event follows only when it moved
          lastTop.current = el.scrollTop;
        }
        return;
      }
      remember();
    });
    ro.observe(c);
    // The view's own height too: the message box under it grows with a draft, and a transcript
    // that follows its end keeps the end in view (its last lines would go under the box).
    if (scroller.current) ro.observe(scroller.current);
    // End is for the pane worked in: the command names its session.
    const onEnd = (e: Event) => { if ((e as CustomEvent<string>).detail === sessionId) toEnd(true); };
    addEventListener("keel:end", onEnd);
    return () => { ro.disconnect(); cancelAnimationFrame(late); removeEventListener("keel:end", onEnd); };
  }, [!!events, sessionId]);

  // History read away from the end stays whole in the store meanwhile.
  useEffect(() => (away || reading ? keepEvents(sessionId) : undefined), [away, !!reading, sessionId]);

  // Older events of the branch shown load when the reader nears the top, newer
  // ones of a run that stops short when they near its end.
  const more = !!events?.length && events[0]!.parent !== null;
  const busy = useRef({ older: false, later: false });
  const [loading, setLoading] = useState(false);
  // A part that did not load is said where it would have come in, with a way
  // to ask again. It is not asked for again by the scroll that asked for it
  // (`auto`), only by the owner or when the page reconnects. A session that
  // was deleted meanwhile is no failure: its view says it is gone.
  const [unread, setUnread] = useState<{ older?: string; later?: string }>({});
  const unreadNow = useRef(unread);
  unreadNow.current = unread;
  const partFailed = (which: "older" | "later") => (e: unknown) => {
    // Only the daemon's "no such session" says the session is gone; another 404 (an event the branch no longer has) is a failure to say.
    const err = e as { status?: number; body?: { error?: unknown } };
    if (err.status === 404 && err.body?.error === "no such session") return dropSession(sessionId);
    // An unreachable daemon is a state the page already shows, not an error of its own.
    setUnread((u) => ({ ...u, [which]: e instanceof TypeError ? "Keel is not reachable." : failed(e, { at: "transcript part", session_id: sessionId }) }));
  };
  const older = (auto = false): Promise<unknown> | undefined => {
    if (!more || busy.current.older || !events || (auto && unreadNow.current.older)) return;
    busy.current.older = true;
    setLoading(true);
    setUnread((u) => (u.older ? { ...u, older: undefined } : u));
    return actions.page(sessionId, { head: events.at(-1)!.id, before: events[0]!.seq }).catch(partFailed("older")).finally(() => { busy.current.older = false; setLoading(false); });
  };
  const later = (auto = false): Promise<unknown> | undefined => {
    if (!reading?.end || busy.current.later || !events || (auto && unreadNow.current.later)) return;
    busy.current.later = true;
    setUnread((u) => (u.later ? { ...u, later: undefined } : u));
    const from = reading;
    return actions.page(sessionId, { head: from.other ? from.head ?? undefined : undefined, after: events.at(-1)!.seq })
      .then((p) => setView((v) => (v !== from ? v : p.end || !p.last ? (from.other ? { ...from, end: null } : null) : { ...from, end: p.last })))
      .catch(partFailed("later"))
      .finally(() => { busy.current.later = false; });
  };
  // The connection is back: what did not load is asked for again.
  const reads = useRef({ older, later });
  reads.current = { older, later };
  useEffect(() => onFeature({ reconnect: () => { if (unreadNow.current.older) void reads.current.older(); if (unreadNow.current.later) void reads.current.later(); } }), []);
  // The owner's prompts of the branch outside the part shown, counted once per
  // part: "Prompt 12 of 44" counts the whole branch, not what the page holds.
  const outside = useRef<{ key: string; before: number; after: number } | null>(null);
  const promptsOutside = async (): Promise<{ before: number; after: number }> => {
    if (!events?.length || (!more && !reading?.end)) return { before: 0, after: 0 };
    const key = `${events[0]!.id} ${reading?.end ?? ""}`;
    if (outside.current?.key === key) return outside.current;
    const q = new URLSearchParams({ head: reading?.end ? (reading.other ? reading.head : session.head) ?? "" : events.at(-1)!.id, before: String(events[0]!.seq) });
    if (reading?.end) q.set("after", String(events.at(-1)!.seq));
    const r = await api<{ before: number; after: number }>(`/api/sessions/${sessionId}/users?${q}`);
    outside.current = { key, before: r.before, after: r.after };
    return outside.current;
  };
  // A page that does not fill the view asks for the one before it.
  useEffect(() => {
    const el = scroller.current;
    if (more && el && el.scrollHeight <= el.clientHeight) older(true);
  }, [events]);

  // An event to show that is not on the run shown (a search hit, a jump from
  // the timeline or the branch tree, a link): the part of its branch around
  // it is read, and the transcript shows that part.
  const want = focus ?? preview;
  const reaching = useRef<string | null>(null);
  useEffect(() => {
    if (!want || !events || reaching.current === want || events.some((e) => e.id === want)) return;
    reaching.current = want;
    const jump = !!focus;
    actions.page(sessionId, { around: want }, (p) => {
      // A hit on the session's own branch is not another branch: the message box has nothing to warn about.
      if (p.on_head && getUI().preview?.event === want) setUI({ preview: null });
    }).then((p) => {
      reaching.current = null;
      if (p.on_head && !jump) return;
      const head = getState().sessions[sessionId]?.head ?? null;
      const joined = p.on_head && lineage(getState().events[sessionId] ?? [], head).some((e) => e.id === want);
      setView(joined ? null : { event: want, head: p.head, end: p.end ? null : p.last, other: !p.on_head });
    }, (e) => { if ((e as { status?: number }).status !== 404) reportError(e); }); // 404: an event of another session
  }, [want, events]);

  // A prompt this page sends while an earlier part is read goes to the end,
  // and so does the transcript. Nothing else moves the reader: not an agent's
  // report, a wake or a peer's message, and not a prompt from another tab.
  useEffect(() => {
    if (!earlier) return;
    const onSent = (e: Event) => { if ((e as CustomEvent<string>).detail === sessionId) toEnd(); };
    addEventListener("keel:sent", onSent);
    return () => removeEventListener("keel:sent", onSent);
  }, [earlier, sessionId]);

  // The browser's own Find reaches what is in the page, and the page holds a
  // part of a long session: on its key, a note says so and offers the search
  // that reads the whole conversation.
  const partial = more || !!reading?.end;
  const [findNote, setFindNote] = useState(false);
  useEffect(() => {
    if (!partial) return setFindNote(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      // In the pane with the keys, or the only one.
      const at = document.activeElement?.closest("[data-station]");
      if (at && at !== scroller.current?.closest("[data-station]")) return;
      setFindNote(true);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [partial]);
  useEffect(() => {
    if (!findNote) return;
    const t = setTimeout(() => setFindNote(false), 12_000);
    return () => clearTimeout(t);
  }, [findNote]);

  // A search hit opens the session at its message.
  // The request is checked when the frame runs, before anything moves: one
  // cleared or replaced meanwhile scrolls nothing. The row becomes the
  // keyboard's place too, so the next Tab reaches its actions; a jump that
  // says so (`focusStay`, the branch tree's) leaves the keyboard where it is.
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

  // A session opens at its end: the newest rows of the part held render
  // first, and the rest of that part join in a transition right after (input
  // and streaming keep the main thread meanwhile). What the page holds ends
  // up mounted, so the browser's find reaches it; the parts not held are read
  // on scroll, on a jump, or by the app's own search.
  const [whole, setWhole] = useState(false);
  useEffect(() => setWhole(false), [sessionId]);
  const blocks = built?.blocks ?? [];
  const cut = Math.max(0, blocks.length - TAIL_BLOCKS);
  // A jump above the first rows mounts everything at once, and it stays so:
  // the rows above must not leave again when the jump is done.
  const jumped = useRef(false);
  if (focus && (built?.at.get(focus) ?? 0) < cut) jumped.current = true;
  const from = whole || jumped.current ? 0 : cut;
  useEffect(() => {
    if (from === 0) return;
    const t = setTimeout(() => startTransition(() => setWhole(true)), 0);
    return () => clearTimeout(t);
  }, [from > 0]);

  // Previous and Next prompt (the commands of builtins.ts, for the pane with
  // the keys): the keyboard moves through the owner's prompts on the branch
  // shown, from the one it is on, else from the one nearest above the middle
  // of the view (the newest, while the view follows the end). The prompt is brought under the top of the view and takes
  // the focus, so Tab goes on to its actions. Nothing else changes: not the
  // branch, not the draft. Each move says where it is, and the ends say so.
  const [at, setAt] = useState<{ id: string; n: number; text: string } | null>(null);
  useEffect(() => {
    const onPrompt = async (ev: Event) => {
      const detail = (ev as CustomEvent<{ session: string; dir: 1 | -1 }>).detail;
      const { session: target, dir } = detail;
      const sc = scroller.current;
      if (target !== sessionId || !events || !sc) return;
      const prompts = events.filter(isPrompt);
      // The page may hold a part of the branch: the prompts outside it count
      // too, and a move past the part's edge reads the part beyond it first.
      const out = await promptsOutside().catch((e) => { reportError(e, { at: "prompts outside the part" }); return { before: 0, after: 0 }; });
      const again = (read: Promise<unknown> | undefined) => void read?.then(() => setTimeout(() => dispatchEvent(new CustomEvent("keel:prompt", { detail })), 0));
      if (!prompts.length) return out.before && dir < 0 ? again(older()) : out.after && dir > 0 ? again(later()) : announce("This conversation has no prompts yet.");
      const total = out.before + prompts.length + out.after;
      const row = (e: StoredEvent) => document.getElementById(`e-${e.id}`);
      const on = document.activeElement?.closest<HTMLElement>("[data-event-id]")?.dataset.eventId;
      let i = prompts.findIndex((e) => e.id === on);
      if (i < 0) {
        // Not on a prompt: the last one that starts above the middle of the view, or anywhere in
        // it while the view follows the end (rows not rendered yet are above it).
        const line = sc.getBoundingClientRect().top + sc.clientHeight / (stick.current ? 1 : 2);
        const above = prompts.findLastIndex((e) => { const el = row(e); return !el || el.getBoundingClientRect().top < line; });
        i = dir < 0 ? above + 1 : above;
      }
      const to = Math.min(prompts.length - 1, Math.max(0, i + dir));
      if (to === i && dir < 0 && out.before) return again(older());
      if (to === i && dir > 0 && out.after) return again(later());
      const edge = to === i ? (dir < 0 ? "This is the first prompt." : "This is the last prompt.") : "";
      const text = edge || `Prompt ${out.before + to + 1} of ${total}`;
      // Leaving the message box for the conversation: the way back is said with the place.
      announce(`${edge ? `${edge} Prompt ${out.before + to + 1} of ${total}.` : text}${on ? "" : `${edge ? "" : "."} Escape returns to the message box.`}`);
      setWhole(true); // a prompt before the rows rendered first is rendered now
      setAt((cur) => ({ id: prompts[to]!.id, n: (cur?.n ?? 0) + 1, text }));
    };
    addEventListener("keel:prompt", onPrompt);
    return () => removeEventListener("keel:prompt", onPrompt);
  }, [events, sessionId]);
  useEffect(() => {
    if (!at) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`e-${at.id}`);
      const sc = scroller.current;
      if (!el || !sc) return;
      const pinned = content.current?.querySelector<HTMLElement>("[data-pinned]")?.offsetHeight ?? 0;
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - parseFloat(getComputedStyle(el).scrollMarginTop) - pinned;
      // Where the view ended says whether it follows: at the end (the newest
      // prompt of a short tail) it goes on following, anywhere else the Latest
      // pill shows. A move that changed nothing sends no scroll event to say so.
      stick.current = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80 && !short.current;
      lastTop.current = sc.scrollTop;
      setAway(!stick.current);
      remember();
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
      el.classList.remove("flash");
      void el.offsetWidth; // the glow starts again on a second press at an end
      el.classList.add("flash");
    });
    const t = setTimeout(() => setAt((cur) => (cur === at ? null : cur)), 1800);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [at]);

  // A question card waiting on the owner says so itself; no "Working" under it.
  const asking = useStore((s) => !!s.questionCalls[sessionId]?.length);
  if (!events || !built) return <div className="flex-1" />;
  const lastStart = events.findLast((e) => e.kind === "turn_start");
  // A run that stops short of its branch's end has no last turn: its last
  // footer is a turn in the middle of the session, and what acts on the
  // session where it stands (Answer again, Continue, a failure's Try again,
  // sending the images again) is not offered there.
  const short_ = !!reading?.end;
  tail.setImages(short_ ? undefined : events.findLast((e) => e.kind === "note" && e.data.kind === "images")?.id);
  tail.put(session, short_ ? undefined : events.findLast((e) => e.kind === "turn_end")?.id, short_ ? undefined : events.at(-1)?.id, !!reading, reading?.other ? reading.head ?? undefined : undefined);

  return (
    // A strip of the conversation stays above a tall stack of cards and a long
    // draft, in a pane with room for one (none in a pane under 24rem high).
    <div className="relative min-h-[clamp(0px,calc((100%-24rem)/2),6rem)] flex-1">
      <div
        ref={scroller}
        className="k-reading relative h-full overflow-y-auto [scrollbar-gutter:stable] [overflow-anchor:none]"
        // A row that holds the keyboard itself (reached by Previous or Next prompt, or from a
        // search hit) gives it back to the pane's message box on Escape. The press ends
        // there: it does not also stop the turn or leave an agent's session.
        onKeyDown={(e) => {
          const row = e.target as HTMLElement;
          if (e.key !== "Escape" || e.shiftKey || row.tabIndex !== -1 || !row.hasAttribute("data-event-id")) return;
          e.preventDefault();
          e.stopPropagation();
          focusBox(sessionId);
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          // Following the end stops when the reader moves up, not when content
          // grew since the last scroll (rows mounted above, a reply streaming):
          // that leaves the scroll where it was, and the size observer puts it
          // back at the end. A run that stops short of the branch's end is not
          // followed: its end is not where replies arrive.
          const up = el.scrollTop < lastTop.current, down = el.scrollTop > lastTop.current;
          if (near) stick.current = !reading?.end;
          else if (up) stick.current = false;
          lastTop.current = el.scrollTop;
          if (away === stick.current) setAway(!stick.current);
          // The scroll this transcript made itself to hold the anchor in place is not the reader's.
          if (settling.current) settling.current = false;
          else remember();
          // The reader moving toward an edge reads the part beyond it (not a
          // scroll that only followed the content changing size).
          if (!stick.current && up && el.scrollTop < el.clientHeight) older(true);
          if (near && down) later(true);
        }}
      >
        <div ref={content} className="k-transcript mx-auto flex max-w-[48rem] flex-col gap-4 px-4 py-8 md:px-6" data-testid="transcript" data-working={session.phase === "working" || undefined}>
          {previewing && (
            <div className="sticky top-2 z-10 flex items-center gap-2 rounded-lg border border-brass/50 bg-raised px-3.5 py-2 text-ui shadow-2" data-testid="branch-preview" data-pinned="1">
              <GitBranch className="size-4 shrink-0 text-brass" />
              <span className="min-w-0 flex-1 text-muted">You are reading another branch. Replies still go to the current one.</span>
              <button type="button" data-testid="preview-continue" disabled={session.phase === "working"} title={session.phase === "working" ? "Possible when the turn ends" : undefined}
                onClick={() => actions.setHead(sessionId, preview!, true).then(() => setUI({ preview: null })).catch(reportError)}
                className="h-7 rounded-md bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">Reply from this branch</button>
              <button type="button" data-testid="preview-back" onClick={() => setUI({ preview: null })} className="h-7 rounded-md px-2.5 text-caption text-muted hover:bg-hover hover:text-fg">Back to the current one</button>
            </div>
          )}
          {events.length === 0 && session.phase !== "working" && <p className="k-empty py-4">No messages yet.</p>}
          {more && (
            <div className="flex flex-wrap items-center justify-center gap-x-2" data-testid="earlier-messages" data-pinned="1">
              {unread.older && !loading && <span role="status" data-testid="earlier-failed" className="text-caption text-warn">Earlier messages did not load: {unread.older}</span>}
              <button type="button" data-testid="load-earlier" disabled={loading} onClick={() => void older()} className={cn("h-7 rounded-md px-2.5 text-caption font-medium hover:bg-hover hover:text-fg disabled:opacity-60", unread.older && !loading ? "border border-line text-fg" : "text-muted")}>
                {loading ? "Loading earlier messages" : unread.older ? "Try again" : "Load earlier messages"}
              </button>
            </div>
          )}
          <TailContext.Provider value={tail}>
            {(from ? blocks.slice(from) : blocks).map((rows) => <RowBlock key={blockKey(rows)} rows={rows} sid={sessionId} />)}
          </TailContext.Provider>
          {built.pending.length > 0 && <div className="flex" data-testid="pending-notes"><TurnNotes notes={built.pending} working={session.phase === "working"} /></div>}
          {reading?.end && (
            // Clear of the Latest pill, which floats over the foot of the view while a part is read.
            <div className="mb-10 flex items-center justify-center gap-1 py-1 text-caption text-faint" data-testid="later-messages" data-pinned="1">
              {unread.later
                ? <span role="status" data-testid="later-failed" className="text-warn">Later messages did not load: {unread.later}</span>
                : <span>Later messages are not shown here.</span>}
              <button type="button" data-testid="load-later" onClick={() => void later()} className="h-7 rounded-md px-2 font-medium text-accent-ink hover:bg-accent-soft">{unread.later ? "Try again" : "Load later messages"}</button>
            </div>
          )}
          <Live sessionId={sessionId} working={session.phase === "working"} asking={asking} since={lastStart?.ts} elsewhere={previewing ? "branch" : earlier ? "earlier" : null} />
        </div>
      </div>
      {at && (
        <div aria-hidden="true" className={cn("pointer-events-none absolute left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-raised px-3 text-caption font-medium tabular-nums text-muted shadow-2 animate-pop", away ? "bottom-[3.25rem]" : "bottom-3")}>
          <span data-testid="prompt-place">{at.text}</span>
          <span className="flex items-center gap-1 border-l border-line pl-2 font-normal text-faint" data-testid="prompt-place-back"><Kbd keys="escape" /> message box</span>
        </div>
      )}
      {findNote && (
        <div role="status" data-testid="find-note" className="absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-raised px-3 py-1.5 text-caption text-muted shadow-2 animate-pop">
          <span>Find in page reaches only the messages loaded here.</span>
          <button type="button" data-testid="find-note-search" onClick={() => { setFindNote(false); setUI({ palette: true }); }} className="h-7 shrink-0 rounded-md px-2 font-medium text-accent-ink hover:bg-accent-soft">Search the whole conversation</button>
        </div>
      )}
      {(away || earlier) && (
        <button
          type="button"
          onClick={() => toEnd(true)}
          data-testid="jump-latest"
          data-live={session.phase === "working" || undefined}
          title="Go to the latest messages"
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-caption font-medium text-muted shadow-2 animate-pop hover:text-fg"
        >
          {/* A reply being written below the view (a prompt sent from elsewhere moves no reader): the way there says so. */}
          {session.phase === "working"
            ? <><span className="size-1.5 rounded-full bg-brass animate-pulse-dot" aria-hidden="true" /> A reply is being written</>
            : <><ArrowDown className="size-3.5" /> Latest</>}
        </button>
      )}
    </div>
  );
}
