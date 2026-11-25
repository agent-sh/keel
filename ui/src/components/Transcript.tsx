import { Popover } from "@base-ui/react/popover";
import { HelperFace, useHelperName } from "./HelperFace.tsx";
import { Menu } from "@base-ui/react/menu";
import { CopyButton, copyWords } from "./CopyButton.tsx";
import { usePhoneWidth } from "../lib/list-hold.ts";
import { itemClass, popupClass } from "./ui.tsx";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Ellipsis, FileText, GitBranch, ImageOff, Layers, Pencil, Play, RotateCcw, ShieldAlert, Square, Undo2 } from "lucide-react";
import { undoRewindOrReport } from "../lib/rewind-act.ts";
import { TurnNotes } from "./MemoryNote.tsx";
import { createContext, Fragment, lazy, memo, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { quoteParts } from "../lib/quote.ts";
import { flushSync } from "react-dom";
import { lineage } from "../../../src/core/tree.ts";
import type { AssistantBlock, AttachmentBlock, ImageBlock, PromptBlock, Session, StoredEvent, ToolUseBlock } from "../../../src/core/types.ts";
import { shownAsPrompt } from "../../../src/core/owner.ts";
import { rowActions } from "../lib/extend.ts";
import { blockKey, buildRows, nextLineage, nextSiblings, PROBE, rowProbe, type Built, type LineageOf, type Row, type SiblingsOf } from "../lib/rows.ts";
import { EmptyTranscript } from "./EmptyTranscript.tsx";
import { actions, api, dropSession, failed, forgetEvents, getState, keepEvents, liveNow, onFeature, reportError, useStore, type DraftBlock } from "../lib/store.ts";
import { useSafety } from "../lib/safety.ts";
import { getUI, navigate, seedComposer, setUI, useUI } from "../lib/ui.ts";
import { announce } from "../lib/announce.ts";
import { useAgentCount, useToldState } from "../lib/watch.ts";
import { composing, isMac } from "../lib/keys.ts";
import { findKey } from "../lib/find.ts";
import { Kbd } from "./Kbd.tsx";
import { clock, cn, fmtCost, fmtSize, fmtTokens, fmtWait, focusBox, scrollMotion } from "../lib/utils.ts";
import { preloadSettled } from "../lib/preload.ts";
import { every } from "../lib/clock.ts";
import { flushPlaces, isLater, newAfter, offsetAt, placeOf, putPlace, WRITE_MS, type Place } from "../lib/place.ts";
import { auto, autoState, panesInView, presentAt } from "../lib/automation.ts";
import { STOPPERS } from "../../../src/core/stoppers.ts";
import type { PaneSwap } from "../lib/looks.ts";
import { ProviderStatus } from "./ProviderStatus.tsx";
import { TurnFailure } from "./TurnFailure.tsx";
import { Markdown, NearView } from "./Markdown.tsx";
import { estimate, heldWords, sameKeys, shares, windowOf, type Span } from "../lib/window.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { switchSession } from "../lib/switch.ts";
import { ToolCall } from "./ToolCall.tsx";
import { InputNotice, SYSTEM_INPUT } from "./automation/TranscriptExtras.tsx";
import { LiveWork, Thinking, Work } from "./Work.tsx";
import { useKept } from "../lib/kept.ts";
import { carryPick, heldPick, type HeldPick } from "../lib/held-range.ts";
import { OwnerWords, ToldModel, toldOf } from "./Words.tsx";
import { ensureMarks } from "../lib/marks.ts";
import { isPeerMessage, PeerMessage, RefusedNote } from "./FleetMessages.tsx";
import { attemptWords, CUT_BY_RESTART, FAIL_WORD, MARK_READ, NEEDS, newSinceAt, STATE_WORD, stateWords, unreachableSince } from "../../../src/core/state-words.ts";
import { agentLive, hhmm, LIMIT_WAIT, limitText } from "../../../src/core/watch.ts";
import { probeWords } from "../../../src/engine/trail.ts";
import { appSaysNow } from "./Stale.tsx";

// The find bar is drawn on the find key only: its code is its own chunk, fetched once the page has settled,
// so the first press finds it there (lib/preload.ts).
const loadFindBar = () => import("./FindBar.tsx");
const FindBar = lazy(() => loadFindBar().then((m) => ({ default: m.FindBar })));
preloadSettled(loadFindBar);

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

// On a phone a message's actions are one button at its edge and a menu of them by name: six icons in a
// row took a row of the page for each message. `lead`: the actions of the message itself (copy, edit,
// answer again); the registered ones follow, as `Extra` draws them.
type Lead = { id: string; label: string; icon: ReactNode; testid: string; run: () => void };
function MessageMenu({ on, e, lead }: { on: "user" | "assistant"; e: StoredEvent; lead: Lead[] }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label="Message actions" title="Message actions" data-testid="message-menu" className="k-msg-menu grid size-7 shrink-0 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg">
        <Ellipsis className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={2} className="z-50 outline-none">
          <Menu.Popup className={`${popupClass} min-w-52`} data-testid="message-menu-popup"><MessageRows on={on} e={e} lead={lead} /></Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
// (Drawn only while the menu is open: a row of the page never reads the turn's state for it.)
function MessageRows({ on, e, lead }: { on: "user" | "assistant"; e: StoredEvent; lead: Lead[] }) {
  useSyncExternalStore(rowActions.subscribe, rowActions.version);
  const store = useContext(TailContext);
  const working = useTail(isWorking);
  const s = store.get().session;
  const row = (id: string, testid: string, icon: ReactNode, label: string, run: () => void) => (
    <Menu.Item key={id} className={itemClass} data-testid={testid} onClick={run}>
      <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
    </Menu.Item>
  );
  return (
    <>
      {lead.map((l) => row(l.id, l.testid, l.icon, l.label, l.run))}
      {rowActions.all().filter((a) => a.on === on && (!a.when || a.when(e, s)) && !(a.idle && working)).map((a) =>
        row(a.id, `rowaction-${a.id}`, typeof a.icon === "function" ? a.icon(e, s) : a.icon, a.label, () => a.run(e, getState().sessions[s.id] ?? s)))}
    </>
  );
}

// Attachments in the order they were sent (the order the model reads them),
// files and images interleaved, so "the second one" means one thing.
function Images({ blocks }: { blocks: PromptBlock[] }) {
  const [big, setBig] = useState<number | null>(null);
  let n = 0;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {blocks.map((b, i) => {
        if (b.type === "attachment") {
          const f = b as AttachmentBlock;
          return (
            <a key={i} href={`/api/attachments/${f.id}?name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.media_type)}`} download={f.name} data-testid="message-file" title={`${f.name}, ${f.media_type}`}
              className="flex h-10 max-w-64 items-center gap-2 rounded-lg border border-line bg-raised px-3 text-ui shadow-1 hover:border-line-strong">
              <FileText className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 truncate">{f.name}</span>
              <span className="shrink-0 text-micro tabular-nums text-faint">{fmtSize(f.size)}</span>
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
  // (What the words quote is set apart as it is shown: the text kept and sent is the owner's own.)
  const parts = useMemo(() => quoteParts(text), [text]);
  const [shownAll, setFull] = useKept(`full:${sid}:${e.id}`);
  const full = !!shownAll;
  // `keys`: opened by Up in the message box, where the keyboard goes back when the edit ends.
  const [editing, setEditing] = useState<false | "click" | "keys">(false);
  // Up in an empty message box asked for this prompt's edit box (lib/edit-last.ts).
  const asked = useUI((s) => s.editPrompt?.session === sid && s.editPrompt.event === e.id);
  useEffect(() => {
    if (!asked) return;
    setUI({ editPrompt: null });
    setEditing("keys");
  }, [asked]);
  const at = vs.findIndex((v) => v.id === e.id);
  const narrow = usePhoneWidth();
  // Only a prompt with versions shows the turn's state (its arrows wait for the turn).
  const working = useTail((t) => vs.length > 1 && isWorking(t));
  const origin: string | undefined = e.data.origin;
  // The other version's branch may end far from its prompt: the transcript opens at the prompt,
  // read first when the part the page holds of it does not reach it. (Its rows are new to the
  // page and stand at an estimate until they are drawn: the view goes to the prompt itself.)
  const pick = (i: number) => actions.setHead(sid, vs[i]!.id).then(() => {
    const to = vs[i]!.id;
    setUI({ focusEvent: to, focusStay: to });
  }).catch(reportError);
  if (editing) return <EditPrompt e={e} sid={sid} back={editing === "keys"} onDone={() => setEditing(false)} />;
  return (
    <div id={`e-${e.id}`} className="k-user-message group/user row-cv flex scroll-mt-6 flex-col items-end gap-1.5 rounded-lg animate-in" data-testid="user-message" data-event-id={e.id} data-quote-from="your message">
      <div className={narrow ? "flex items-start gap-0.5" : "contents"}>
      <div className={narrow ? "min-w-0 flex-1" : "contents"}>
      <OwnerWords
        className="k-user-words"
        label={origin === "steer" ? <span className="k-label" data-testid="origin-steer">Steered into the turn</span>
          : e.data.edited_from === "steer" ? <span className="k-label" data-testid="origin-edited-steer">An edited steer, sent as a new turn</span>
          : origin === "queued" ? <span className="k-label" data-testid="origin-queued">From the queue</span> : undefined}
        attached={e.data.images?.length > 0 ? <Images blocks={e.data.images} /> : undefined}
      >
        {text && (
          <>
            <div className={cn("whitespace-pre-wrap break-words", long && !full && "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>{parts.map((p, i) => p.quote ? <blockquote key={i} data-testid="user-quote" className="k-quote my-1.5 text-muted">{p.text}</blockquote> : <Fragment key={i}>{p.text}</Fragment>)}</div>
            {long && (
              <button type="button" onClick={() => setFull(!full)} className="k-link mt-1 text-caption font-medium text-accent-ink hover:underline">
                {full ? "Show less" : "Show all"}
              </button>
            )}
          </>
        )}
      </OwnerWords>
      </div>
      {narrow && <MessageMenu on="user" e={e} lead={[
        { id: "copy", testid: "copy-message", label: "Copy the message", icon: <Copy />, run: () => void copyWords(text) },
        { id: "edit", testid: "edit-message", label: "Edit and send as a new version", icon: <Pencil />, run: () => setEditing("click") },
      ]} />}
      </div>
      <div className={cn("-mt-0.5 flex items-center", narrow ? "empty:hidden" : "h-6")}>
        {!narrow && <span className="flex items-center opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <CopyButton text={() => text} label="Copy the message" testid="copy-message" className="size-7" />
          <ActionButton label="Edit and send as a new version" testid="edit-message" onClick={() => setEditing("click")}><Pencil className="size-3.5" /></ActionButton>
          <Extra on="user" e={e} />
        </span>}
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
// `back`: it was opened from the message box by Up, and the keyboard goes back
// there when it is sent or cancelled.
function EditPrompt({ e, sid, back, onDone }: { e: StoredEvent; sid: string; back?: boolean; onDone: () => void }) {
  const working = useTail(isWorking);
  const raw: string = e.data.text ?? "";
  const [text, setText] = useState<string>(raw);
  const blocks: PromptBlock[] = e.data.images ?? [];
  const n = blocks.length;
  const ok = !!text.trim() || n > 0;
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // The caret at the end of the words, where a change to them is usually made, and in view.
  useLayoutEffect(() => { const b = box.current; if (b) { b.setSelectionRange(b.value.length, b.value.length); b.scrollTop = b.scrollHeight; } }, []);
  const done = () => {
    const composer = back ? root.current?.closest(".k-session")?.querySelector<HTMLTextAreaElement>("[data-testid=composer]") : null;
    onDone();
    composer?.focus();
  };
  // The files from this prompt on: the new version may also start from them as they were before it.
  const [nFiles, setNFiles] = useState<number | null>(null);
  const [files, setFiles] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ files: string[]; skipped: string[]; merged: string[]; turn: number | null }>(`/api/sessions/${sid}/rewind`, { method: "POST", body: JSON.stringify({ prompt_event: e.id, preview: true }) })
      .then((p) => live && setNFiles(p.turn === null ? 0 : p.files.length + p.merged.length), () => {});
    return () => { live = false; };
  }, [sid, e.id]);
  const send = () => ok && actions.edit(sid, e.id, text.trim(), files && !!nFiles).then(done, reportError);
  return (
    // (`data-keep`: its block stays drawn while it is open, with what is typed in it.)
    <div ref={root} className="flex justify-end animate-in" data-event-id={e.id} data-keep="">
      <div className="w-[min(85%,40rem)] rounded-xl border border-line-strong bg-raised p-2 shadow-2">
        {n > 0 && (
          <div className="mb-1.5 flex flex-col gap-1.5 px-1 pt-1" data-testid="edit-attachments">
            <Images blocks={blocks} />
          </div>
        )}
        <textarea
          ref={box}
          data-testid="edit-box"
          autoFocus
          value={text}
          aria-label="Edit the prompt"
          placeholder={n ? "Words to send with the attachments (optional)" : undefined}
          onChange={(x) => setText(x.target.value)}
          onKeyDown={(x) => {
            if (composing(x)) return;
            if (x.key === "Escape") done();
            if (x.key === "Enter" && !x.shiftKey) { x.preventDefault(); send(); }
          }}
          className="block min-h-16 w-full resize-y bg-transparent px-2 py-1 text-read leading-relaxed outline-none placeholder:text-faint"
        />
        {!!nFiles && (
          <label className="flex items-start gap-2 px-2 pt-1.5 text-ui">
            <input type="checkbox" checked={files} onChange={(x) => setFiles(x.target.checked)} data-testid="edit-files" className="mt-0.5 accent-[var(--accent)]" />
            <span>Also put the files back as they were before this prompt <span className="text-faint">({nFiles === 1 ? "1 file" : `${nFiles} files`})</span></span>
          </label>
        )}
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <span className="mr-auto pl-2 text-caption text-faint" data-testid="edit-note">
            {working ? "Stops the turn, then sends this as a new version." : "Sends as a new version; the current one stays as a branch."}
            {n > 0 && ` The ${n === 1 ? "attachment goes" : `${n} attachments go`} with it as before.`}
          </span>
          <button type="button" onClick={done} className="h-7 rounded-md px-2.5 text-ui text-muted hover:bg-hover">Cancel</button>
          <button type="button" data-testid="edit-send" disabled={!ok} onClick={send} className="h-7 rounded-md bg-accent px-2.5 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// A declined reply: what the provider said, and a way on with another model.
function Refusal({ e, sid, handled, end }: { e: StoredEvent; sid: string; handled?: boolean; end?: string }) {
  const model = useTail((t) => t.session.model);
  // A session of the owner's own (not an agent) whose last turn this declined: it can start again from a capsule of its records.
  const fresh = useTail((t) => !handled && !t.session.parent_id && end !== undefined && t.lastEnd === end && !isWorking(t));
  const [pick, setPick] = useState("");
  const [keep, setKeep] = useState(false);
  const d = e.data.stop_details ?? {};
  return (
    <div id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-lg border border-warn/40 bg-raised px-3.5 py-3 text-ui" data-testid="refusal">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 text-warn" /> The model declined this request
        {d.category && <span className="rounded-sm bg-sunken px-1.5 py-px text-micro text-muted">{d.category}</span>}
      </div>
      {d.explanation && <p className="mt-1 text-muted">{d.explanation}</p>}
      <p className="mt-1 text-muted">Its partial reply is left out of the context.{handled ? " The fallback model took the request." : " Another model can take the same request."}</p>
      {!handled && <div className="mt-2 flex items-center gap-2 max-md:flex-col max-md:items-stretch">
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
          className="h-8 rounded-md bg-accent px-3 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40 max-md:min-h-tap max-md:w-full"
        >
          Retry on it
        </button>
        <label className="flex items-center gap-1.5 text-caption text-muted max-md:min-h-tap" title="When a model declines later in this session, the turn goes on by itself on this one">
          <input type="checkbox" data-testid="refusal-keep-fallback" checked={keep} onChange={(x) => setKeep(x.target.checked)} className="accent-[var(--accent)]" />
          Also use it when a model declines later
        </label>
      </div>}
      {fresh && <div className="mt-2 flex items-center gap-2">
        <button type="button" data-testid="refusal-fresh" onClick={() => actions.freshStart(sid).catch(reportError)} className="k-btn k-btn-lg">
          Start fresh from a capsule
        </button>
        <span className="text-caption text-muted">A summary of the session's records made without a model; your messages stay word for word and the declined reply is left out.</span>
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
  if (e.data.kind === "rewound") {
    return (
      <Divider testid="rewound">
        <span className="flex items-center gap-1.5"><Undo2 className="size-3.5" /> {e.data.text}{e.data.files ? ` ${e.data.files === 1 ? "One file" : `${e.data.files} files`} put back.` : ""}</span>
        {undoable && (
          <button type="button" data-testid="undo-rewind" className="rounded-sm px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft" onClick={() => undoRewindOrReport(sid, e.id)}>
            Undo
          </button>
        )}
      </Divider>
    );
  }
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
            {e.data.label ? e.data.label : e.data.trigger === "price" && e.data.price ? `Context compacted by price with a summary prepared ahead (the newest steps stay as they were): over the ${Math.round(e.data.price.steps)} steps expected ahead it saves about ${fmtCost(e.data.price.save_usd)} of reading and costs ${fmtCost(e.data.price.cost_usd)}` : e.data.trigger === "idle" ? "Context compacted: the cache expired while the session was idle, so a summary written before it did replaces the history" : e.data.ahead ? "Context compacted with a summary prepared ahead; the newest steps stay as they were" : e.data.auto ? "Context compacted automatically" : "Context compacted"}
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
      {probeWords(e.data.probe) && <p className="mt-2 px-1 text-caption text-muted" data-testid="compacted-probe">What it kept of the work, counted by the harness: {probeWords(e.data.probe)}.</p>}
      {e.data.trail_text && (
        <div className="mt-2 rounded-lg border border-line bg-sunken px-4 py-3 text-caption text-muted" data-testid="compacted-trail">
          <div className="k-label mb-1.5">Artifact trail, made from the events by the harness, not by the model</div>
          <pre className="whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted">{String(e.data.trail_text).replace(/^\[[^\n]*\]\n+/, "")}</pre>
        </div>
      )}
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
    return every(500, () => tick((n) => n + 1));
  }, [st]);
  if (!st || st.kind === "idle" || st.kind === "model" || st.kind === "tool") return null;
  if (st.kind === "compacting") {
    return <div className="flex items-center gap-2 text-ui text-muted animate-pulse-dot" data-testid="compacting"><Layers className="size-3.5 shrink-0" /> <span>Compacting the context{compactPlan(st.plan)}</span></div>;
  }
  // A provider that cannot be reached is waited for, with no count and no countdown: since when, and what the transport said.
  if (st.unreachable) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-warn/40 bg-raised px-3 py-2 text-ui" data-testid="provider-wait">
        <span className="size-1.5 shrink-0 rounded-full bg-warn animate-pulse-dot" />
        {/* The words wrap whole on a narrow page; the transport's message takes what is left, or a line of its own. */}
        <span className="min-w-0 max-w-[calc(100%-1rem)] text-fg" data-testid="provider-wait-since">{unreachableSince(hhmm(st.unreachable))}</span>
        <span className="min-w-[8rem] flex-1 truncate text-faint" title={st.message}>{st.message}</span>
        <ProviderStatus sessionId={sessionId} />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-raised px-3 py-2 text-ui" data-testid="retrying">
      <span className="size-1.5 rounded-full bg-warn animate-pulse-dot" />
      <span className="min-w-0 flex-1 truncate text-muted" title={st.message}>{st.message}</span>
      {/* Its retry waits in the account's line, with the other requests the account's limit holds. */}
      {st.limit ? <span className="shrink-0 text-muted" title={st.limit} data-testid="retry-limit">{LIMIT_WAIT}</span> : null}
      <span className="shrink-0 tabular-nums text-faint">retrying in {fmtWait(st.at - liveNow())}, {attemptWords(st.attempt, st.max)}</span>
      <ProviderStatus sessionId={sessionId} />
    </div>
  );
}

// What a reply says at length, and what it thought when it called no tool: the
// rest of a reply that calls tools is in the run of work under it (rows.ts).
// In the helper's own conversation a reply says who speaks: its picture and the name the owner gave it.
function HelperVoice({ sid }: { sid: string }) {
  const helper = useStore((s) => !!s.sessions[sid]?.settings.helper);
  const name = useHelperName();
  if (!helper) return null;
  return <div className="flex items-center gap-2 text-caption text-muted" data-testid="helper-voice"><HelperFace size="voice" testid="helper-voice-face" /><span data-testid="helper-voice-name">{name}</span></div>;
}

function AssistantBlocks({ blocks, prose, sid }: { blocks: AssistantBlock[]; prose: number[]; sid: string }) {
  const remote = useTail((t) => !!t.session.machine);
  return (
    <>
      {prose.map((i) => {
        const b = blocks[i]!;
        if (b.type === "text") return <div key={i} data-testid="assistant-text" data-quote-from="the reply"><Markdown text={b.text} sessionId={remote ? undefined : sid} /></div>;
        // A thought may carry only opaque state for replay (an encrypted item): nothing to show.
        if (b.type === "thinking") return b.thinking.trim() ? <Thinking key={i} text={b.thinking} /> : null;
        return null;
      })}
    </>
  );
}

function WorkRow({ row, sid }: { row: Row; sid: string }) {
  const remote = useTail((t) => !!t.session.machine);
  const cwd = useTail((t) => t.session.workspace);
  return <Work row={row} sid={sid} cwd={cwd} remote={remote} />;
}

// Whether a text holds anything but white space.
const WORDS = /\S/;
function Draft({ draft }: { draft: Record<number, DraftBlock> }) {
  const blocks = Object.entries(draft).sort(([a], [b]) => Number(a) - Number(b));
  return (
    <>
      {blocks.map(([i, b]) => {
        if (b.kind === "text") return WORDS.test(b.text) ? <div key={i}><Markdown text={b.text} live /></div> : null;
        if (b.kind === "thinking") return <Thinking key={i} text={b.text} live />;
        let input: any = {};
        try { input = JSON.parse(b.text); } catch {}
        const use: ToolUseBlock = { type: "tool_use", id: `draft-${i}`, name: b.name ?? "tool", input };
        return <LiveWork key={i}><ToolCall use={use} live /></LiveWork>;
      })}
    </>
  );
}

// What the turn waits on: the model's first bytes, a tool, or just working.
function Working({ since, sessionId }: { since?: number; sessionId: string }) {
  const st = useStore((x) => x.status[sessionId]);
  const approving = useSafety((x) => (x.approvals[sessionId]?.length ?? 0) > 0);
  const [, tick] = useState(0);
  useEffect(() => every(1000, () => tick((n) => n + 1)), []);
  const from = st?.kind === "model" || st?.kind === "tool" ? st.since : since;
  // A turn that waits for a provider it cannot reach does not work: the line above says what it waits for.
  if (st?.kind === "retry" && st.unreachable) return null;
  // The approval card says it, and so do the head and the step: a third line of it is only height.
  if (approving) return null;
  const s = from ? Math.max(0, Math.round((liveNow() - from) / 1000)) : 0; // stopped while the daemon is unreachable
  // What waits on the owner is said as that, in the words every surface uses: an approval, a plan to
  // approve, a secret to give (an approval has its card and no line). (A tool that asks is not a tool that runs.)
  const needs = st?.kind === "tool" ? st.names.map((n) => ASKS[n]).find(Boolean) : undefined;
  // (A request on its way to the model is work, never a wait: "Calling", as the session's row says.)
  // A request held in its account's line says so, with how long the account said the wait lasts.
  const what = needs ? `${STATE_WORD.need}: ${needs}` : st?.kind === "model" && st.limit ? limitText(st.limit.until, liveNow(), st.limit.spend) : st?.kind === "model" ? (st.preparing === "images" ? `Scaling images for ${st.model}` : st.connected ? `Connected to ${st.model}, no output yet` : `Calling ${st.model}`) : st?.kind === "tool" ? `Running ${st.names.join(", ")}` : STATE_WORD.work;
  return (
    <div className="flex min-h-[1.875rem] items-center gap-2.5 py-1 text-ui text-muted" data-testid="working">
      <span className="flex gap-1">
        {/* Waiting on the owner is their color and does not pulse: nothing runs until they answer. */}
        {[0, 1, 2].map((i) => <span key={i} className={cn("size-1.5 rounded-full", needs ? "bg-st-need" : "bg-st-work animate-pulse-dot")} style={needs ? undefined : { animationDelay: `${i * 160}ms` }} />)}
      </span>
      <span data-testid="working-what" title={st?.kind === "model" ? st.limit?.why : undefined}>{what}</span>
      {s >= 2 ? <span className="tabular-nums text-faint">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span> : null}
    </div>
  );
}

// How a turn ended, in the words of the one state vocabulary: Stopped (by whom), Failed (its
// class), Declined. A turn Keel goes on with by itself is not a failure: it waits.
const REASONS: Record<string, string> = { interrupted: STATE_WORD.stop, max_tokens: `${STATE_WORD.fail}: ${FAIL_WORD.max_tokens}`, refusal: STATE_WORD.declined, error: STATE_WORD.fail, restart: CUT_BY_RESTART };
// The tools that ask the owner for something: what the turn needs while one of them is out.
const ASKS: Record<string, string> = { present_plan: NEEDS.plan!, ExitPlanMode: NEEDS.plan!, exit_plan_mode: NEEDS.plan!, request_secret: NEEDS.secret! };

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
  const narrow = usePhoneWidth();
  const u = e.data.usage;
  const input = u ? u.input + u.cache_read + u.cache_write : 0;
  const cached = u && input ? Math.round((100 * u.cache_read) / input) : 0;
  const secs = `${(e.data.ms / 1000).toFixed(1)}s`;
  const cost = u?.cost !== undefined && !u.unpriced ? fmtCost(u.cost) : "";
  // A turn that sent nothing (it failed before the model answered, or was stopped at once) has no figures to say:
  // "0.0s 0 in 0 out" under a failure only repeats that nothing happened.
  const counted = !!u && (input > 0 || u.output > 0);
  const figures = counted || e.data.ms >= 100;
  // The session's own state, for the last footer: a turn that ended on a failure or a restart and
  // that Keel goes on with by itself (the provider asked for a wait, a restart cut it) waits.
  const told = useToldState(last ? sid : undefined);
  const waits = !last || e.data.reason === "interrupted" || e.data.reason === "refusal" ? "" : told?.watch === "resume" || (told?.watch === "wait" && told.why === "resume") ? stateWords(told).phrase : "";
  // The owner's Stop ends the turn, not the agents it started: they go on, and the line says so with a way to stop them too.
  const ownStop = last && e.data.reason === "interrupted" && STOPPERS[e.data.stopped_by]?.owner;
  const goOn = useAgentCount(ownStop ? sid : undefined);
  return (
    <div className="k-turn-foot group/foot -mt-1 flex h-7 items-center gap-0.5" data-quiet={!last || undefined}>
      {narrow ? (!(boxed && !reply.length) || reply.length > 0 || partial || (prompt && last && !working)) && <MessageMenu on="assistant" e={e} lead={[
        ...(reply.length > 0 || partial ? [{ id: "copy", testid: "copy-reply", label: "Copy the reply", icon: <Copy />, run: () => void copyWords(() => (partial ? actions.reply(sid, { before: e.seq, head: tailOf.get().other }) : reply.join("\n\n"))) }] : []),
        ...(prompt && last && !working ? [{ id: "retry", testid: "retry", label: "Answer again (a new version; this one stays a branch)", icon: <RotateCcw />, run: () => void actions.edit(sid, prompt.id, prompt.data.text).catch(reportError) }] : []),
      ]} /> : <>
      {(reply.length > 0 || partial) && <CopyButton text={() => (partial ? actions.reply(sid, { before: e.seq, head: tailOf.get().other }) : reply.join("\n\n"))} label="Copy the reply" testid="copy-reply" className="size-7" />}
      {prompt && last && !working ? (
        <ActionButton label="Answer again (a new version; this one stays a branch)" testid="retry" onClick={() => actions.edit(sid, prompt.id, prompt.data.text).catch(reportError)}>
          <RotateCcw className="size-3.5" />
        </ActionButton>
      ) : prompt ? <span className="size-7 shrink-0" aria-hidden="true" /> /* its place, kept: the rest of the row does not move when a turn starts or ends */ : null}
      {!(boxed && !reply.length) && <Extra on="assistant" e={e} />}
      </>}
      <TurnNotes notes={notes} working={working} />
      <span className="k-turn-end ml-2 flex gap-3 text-micro tabular-nums text-faint select-none" data-testid="turn-end">
        {REASONS[e.data.reason] && (waits
          ? <span className="k-turn-reason text-muted" data-testid="turn-reason">{waits}</span>
          : <span className={cn("k-turn-reason", e.data.reason === "error" || e.data.reason === "max_tokens" ? "text-st-fail" : "text-warn")} data-testid="turn-reason">{REASONS[e.data.reason]}{STOP_BY[e.data.stopped_by] ?? ""}{times > 1 ? `, ${times} times` : ""}</span>)}
        {goOn > 0 && <span className="text-muted" data-testid="agents-go-on">{goOn === 1 ? "its agent goes on" : `its ${goOn} agents go on`}</span>}
        {/* At the desk every figure is in the row; on a phone the row keeps one line: the cost (the
            time when it has none), and the other figures a tap away on it. */}
        {figures && <span className="max-md:hidden">{secs}</span>}
        {counted && <span className="max-md:hidden">{fmtTokens(input)} in{cached ? `, ${cached}% cached` : ""}</span>}
        {counted && <span className="max-md:hidden">{fmtTokens(u.output)} out</span>}
        {!figures ? null : cost ? <span className="max-md:hidden" data-testid="turn-cost">{cost}</span> : u?.unpriced ? <span className="max-md:hidden">cost unknown</span> : null}
        {figures && <Popover.Root>
          <Popover.Trigger className="k-turn-figs hidden whitespace-nowrap rounded-xs px-1 hover:bg-hover hover:text-muted max-md:inline-flex" aria-label="Time, tokens and cost" data-testid="turn-figures">
            {cost || secs}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={4} align="end" className="z-50 outline-none">
              <Popover.Popup className="flex flex-col gap-0.5 rounded-md border border-line-strong bg-raised px-3 py-2 text-caption tabular-nums text-muted shadow-2" data-testid="turn-figures-full">
                <span>{secs}</span>
                {counted && <span>{fmtTokens(input)} in{cached ? `, ${cached}% cached` : ""}</span>}
                {counted && <span>{fmtTokens(u.output)} out</span>}
                {cost ? <span>{cost}</span> : u?.unpriced ? <span>cost unknown</span> : null}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>}
      </span>
      {goOn > 0 && (
        <button type="button" data-testid="stop-agents" onClick={() => stopAgentsOf(sid)} className="ml-2 flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption font-medium text-warn hover:bg-hover">
          <Square className="size-2.5 fill-current" /> {goOn === 1 ? "Stop it too" : "Stop them too"}
        </button>
      )}
      {last && !working && REASONS[e.data.reason] && !boxed && (
        <button type="button" data-testid="resume" onClick={() => actions.resume(sid).catch(reportError)} className="k-turn-resume ml-2 flex h-6 items-center gap-1 rounded-sm px-1.5 text-caption font-medium text-accent-ink hover:bg-accent-soft">
          <Play className="size-3" /> Resume
        </button>
      )}
    </div>
  );
}

// Stops every agent of the session that still works, as each card's Stop does (by the owner).
function stopAgentsOf(sid: string) {
  for (const a of Object.values(autoState().agents)) if (a.parent_id === sid && agentLive(a)) auto.stopAgent(a).catch(reportError);
}

// What a screen reader hears about the turn: why it waits, once per change.
// The visible clocks above tick; this region changes only when the reason
// does, and a replayed status after a reconnect says nothing new.
function Announcer({ sessionId, working, asking }: { sessionId: string; working: boolean; asking: boolean }) {
  const st = useStore((x) => x.status[sessionId]);
  const approving = useSafety((x) => (x.approvals[sessionId]?.length ?? 0) > 0);
  const said = useRef<string | null>(null);
  let text = "";
  if (approving) text = `${STATE_WORD.need}: ${NEEDS.approval}.`;
  // A question card takes the place of the working line: the region says what the turn waits on.
  else if (asking) text = `${STATE_WORD.need}: ${NEEDS.owner}.`;
  else if (st?.kind === "retry" && st.unreachable) text = `${unreachableSince(hhmm(st.unreachable))}.`;
  else if (st?.kind === "retry") text = `The provider failed: ${st.message}. ${st.limit ? `${LIMIT_WAIT}. ` : ""}Retrying, ${attemptWords(st.attempt, st.max)}.`;
  else if (st?.kind === "compacting") text = `Compacting the context${compactPlan(st.plan)}.`;
  else if (st?.kind === "model" && st.limit) text = `${limitText(undefined, 0, st.limit.spend)}.`;
  else if (working) text = `${STATE_WORD.work}.`;
  else if (said.current) text = "The turn ended.";
  if (said.current === null && !working && !approving && !asking) text = ""; // opening an idle session announces nothing
  said.current = text || said.current;
  return <div className="sr-only" role="status" aria-live="polite" data-testid="turn-announcer">{text}</div>;
}

// The streaming reply and the working line. Deltas re-render only this, not
// the whole transcript above it.
// `onTail`: told in the frame what stands here changes (the working line, the reply, a status row, a
// question that takes the line's place), so the transcript keeps the height of its end through it.
function Live({ sessionId, working, asking, since, elsewhere, onTail }: { sessionId: string; working: boolean; asking: boolean; since?: number; elsewhere: "branch" | "earlier" | null; onTail: () => void }) {
  const draft = useStore((s) => s.drafts[sessionId]);
  // (Asked without a copy of the text: it grows with every delta, and `trim` would copy it each time.)
  const hasDraft = draft && Object.values(draft).some((b) => b.kind !== "text" || WORDS.test(b.text));
  const status = useStore((x) => { const st = x.status[sessionId]; return !st || st.kind === "idle" || st.kind === "model" || st.kind === "tool" ? "" : st.kind; });
  // What the turn does now is said once, by the line over the message box (DockNow.tsx), with its mark and its clock.
  // Only a session another harness runs has no such line (its bar takes the box's place): there the working line says it.
  const docked = useStore((x) => !x.sessions[sessionId]?.outside);
  useLayoutEffect(() => onTail(), [working, !!hasDraft, asking, status]);
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
      {/* (No lower than the working line it takes the place of: the first words of a reply drop no line above them.) */}
      {hasDraft && <div className="flex min-h-[1.875rem] flex-col gap-3" data-testid="draft"><Draft draft={draft} /></div>}
      <Status sessionId={sessionId} />
      {working && !hasDraft && !asking && !docked && <Working since={since} sessionId={sessionId} />}
      <Announcer sessionId={sessionId} working={working} asking={asking} />
    </>
  );
}

const TAIL = 150; // events rendered first when a long session opens

// A prompt of the owner's, as the transcript shows one (not a note of the
// harness, a system input or another session's message).
const isPrompt = shownAsPrompt;

// Who stopped a turn, as the footer says it (a child's turn records the same actor as its agent card).
// The stoppers of src/core/stoppers.ts, as the owner reads them; a stop nobody named is "Stopped" and no more.
const STOP_BY: Record<string, string> = {
  owner: " by you", phone: " by you, from the phone", edit: ": you edited an earlier prompt", send_now: ": you sent a new message",
  parent: " by the parent agent", ancestor: " with an agent above it", parent_turn: " with the parent's turn", time_limit: ": its time limit passed", parent_archived: ": its parent session was archived",
  pause: " when you paused the fleet", hook: " by a hook", supervisor: " by the supervisor", review: " with its review", handoff: " to move the session",
  archive: ": the session was archived", delete: ": the session was deleted", api: " through the API",
};

const isInput = (e: StoredEvent) => SYSTEM_INPUT.has(e.data.kind) || isPeerMessage(e);

// One row. Its props are its own content (the row object stays the same while
// that does not change), so a reply streaming or an event added below renders
// nothing here.
const TranscriptRow = memo(function TranscriptRow({ row, sid }: { row: Row; sid: string }) {
  if (PROBE) rowProbe.rendered?.(row.e.id);
  const e = row.e;
  switch (row.kind) {
    case "harness":
      return <ToldModel id={e.id} testid="harness-note" {...toldOf(e.data)} />;
    case "input":
      return <div id={`e-${e.id}`} data-event-id={e.id} className="scroll-mt-6 rounded-lg">{SYSTEM_INPUT.has(e.data.kind) ? <InputNotice e={e} /> : <PeerMessage e={e} />}</div>;
    case "user":
      return <UserMessage e={e} sid={sid} vs={row.vs!} />;
    case "checkpoint":
      return <Checkpoint e={e} sid={sid} undoable={row.undoable} />;
    case "refusal":
      return <Refusal e={e} sid={sid} handled={row.handled} end={row.after} />;
    case "assistant":
      // The first row of a reply carries its event's id; a later stretch of its prose is found by the event all the same.
      return <div id={row.id === e.id ? `e-${e.id}` : undefined} className="row-cv flex flex-col gap-3 rounded-lg" data-event-id={e.id}>{row.id === e.id && <HelperVoice sid={sid} />}<AssistantBlocks blocks={e.data.blocks} prose={row.prose!} sid={sid} /></div>;
    case "work":
      return <WorkRow row={row} sid={sid} />;
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
      // What Keel did, in its own words to the owner: a line across the conversation.
      const own = e.data.skill ? `Loaded the ${e.data.skill} skill` : e.data.mcp_prompt ? `Loaded the ${e.data.mcp_prompt} prompt` : e.data.kind === "skill_mode" ? (e.data.skill_mode ? `Skill mode: ${e.data.skill_mode}` : "Skill mode off") : !e.data.model ? e.data.short ?? e.data.text : null;
      if (own !== null) return <Divider testid="note"><span>{own}</span></Divider>;
      // A note written for the model (a background job ended, the task list changed): said as that, the words sent behind it.
      return <ToldModel id={e.id} testid="note" {...toldOf(e.data)} />;
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

// A block that is not drawn (lib/window.ts): one box as tall as the block stood, `span` with the
// gap under it, holding its rows' words (Find and a screen reader reach them; they are not seen)
// and their event ids (a jump, a place and the rule of what is new find where they stand).
const Hold = memo(function Hold({ rows, span, gap, rem, width }: { rows: Row[]; span: number; gap: number; rem: number; width: number }) {
  const at = shares(rows, span - gap, width, rem, gap);
  return (
    <div className="k-hold" style={{ height: Math.max(0, span - gap) }}>
      {rows.map((r, i) => {
        const h = { height: at[i] };
        if (r.kind === "end") return h.height ? <div key={r.id} style={h} /> : null;
        const words = heldWords(r);
        if (r.kind === "work") return <div key={r.id} style={h} role="group" aria-label="What the model did" data-kind="work" data-events={r.events!.join(" ")}>{words}</div>;
        return <p key={r.id} style={h} id={r.id === r.e.id ? `e-${r.e.id}` : undefined} data-kind={r.kind} data-event-id={r.e.id}>{words}</p>;
      })}
    </div>
  );
});

const TAIL_BLOCKS = 3; // blocks of rows drawn first when a session opens, before the view says which
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
  // While the reader follows the end, nothing above the end gets shorter. What was open while
  // it ran stays open when it ends, as it was (lib/held.ts: a command's card with the tail of its
  // output, what the model thought), and folds once it has left the view. What is left of that is
  // caught here: when an event makes the end of the conversation shorter (a streamed reply's row
  // that stands lower than the reply did), its last row keeps what was lost as room at its own end,
  // which what the next event adds there takes up, and which goes when the row has left the view.
  // No room is kept at the conversation's foot, and nothing closes over time.
  // `foot`: at the last frame's layout, the last row and how far its top stood from the
  // conversation's end. Only what an event takes away below that top is kept (what changes above it
  // moves no line a reader at the end sees), and only what an event adds after a kept room takes it
  // up (taken up by anything else, the lines between would drop by it).
  type Kept = { row: HTMLElement; room: number; mark: Element | null; after: number };
  const foot = useRef<{ ref: Element | null; len: number }>({ ref: null, len: 0 });
  const kept = useRef<Kept[]>([]);
  const unseen = useRef<IntersectionObserver | null>(null);
  const setRoom = (k: Kept, room: number) => {
    k.room = room;
    k.row.style.paddingBottom = room ? `${room}px` : "";
    if (!room) { kept.current = kept.current.filter((x) => x !== k); unseen.current?.unobserve(k.row); }
  };
  // At the frame's layout: where the tail stands, and how much stands after each kept room.
  const standing = (c: HTMLElement) => {
    const end = c.getBoundingClientRect().bottom;
    const ref = lastRow.current;
    // (Where the row will stand: one that is still coming in is drawn a little lower for a moment.)
    foot.current = { ref, len: ref ? end - yOf(ref) : 0 };
    for (const k of kept.current) { k.mark = k.row.lastElementChild; k.after = k.mark ? end - k.mark.getBoundingClientRect().bottom - k.room : 0; }
  };
  // After an event's rows are drawn. `was`: the tail as it stood before them.
  const keepHeight = (was: { ref: Element | null; len: number }) => {
    const c = content.current, el = scroller.current, row = lastRow.current as HTMLElement | null;
    if (!c || !el || !was.ref?.isConnected) return;
    const end = c.getBoundingClientRect().bottom;
    const lost = was.len - (end - yOf(was.ref));
    if (lost >= 1) {
      // (Only for a row the reader can see: one below the view moves nothing by standing lower.)
      if (!row || row.getBoundingClientRect().top >= el.getBoundingClientRect().bottom) return;
      const k = kept.current.find((x) => x.row === row) ?? { row, room: 0, mark: null, after: 0 };
      if (!kept.current.includes(k)) kept.current.push(k);
      setRoom(k, k.room + Math.ceil(lost));
      unseen.current ??= new IntersectionObserver((seen) => {
        for (const e of seen) if (!e.isIntersecting) { const gone = kept.current.find((x) => x.row === e.target); if (gone) setRoom(gone, 0); }
      }, { root: el });
      unseen.current.observe(row);
      return;
    }
    // What this event added after a kept room stands where the blank was.
    for (const k of [...kept.current].reverse()) {
      if (!k.mark?.isConnected) continue;
      const grew = c.getBoundingClientRect().bottom - k.mark.getBoundingClientRect().bottom - k.room - k.after;
      if (grew >= 1) setRoom(k, k.room - Math.min(k.room, Math.floor(grew)));
    }
  };
  useEffect(() => () => unseen.current?.disconnect(), []);
  // `lastRow`: the last row of the conversation (a row of its own, `.row-cv`).
  const lastRow = useRef<Element | null>(null);
  const findLast = () => {
    let el = content.current?.lastElementChild ?? null;
    while (el && !el.classList.contains("row-cv")) el = el.previousElementSibling;
    lastRow.current = el;
  };
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
  // Where this transcript put the scroll to hold the reader's line: the scroll event that reports
  // that place is not the reader's. (One that finds the scroll elsewhere is: the reader moved too.)
  const settling = useRef<number | null>(null);
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
  // `ev`: the event that element shows, and where its row or step stood: when
  // the element itself is taken away (its step was made again as older events
  // joined it), the place is found again by the event.
  const anchor = useRef<{ el: Element; top: number; ev?: string; evTop?: number } | null>(null);
  // Where an element's top stands on screen once it has arrived: a row that is still coming in is
  // drawn a little under its place for a moment (animate-in), and a place measured there is off by that.
  const yOf = (el: Element) => {
    let y = el.getBoundingClientRect().top;
    for (let a = el.closest<HTMLElement>(".animate-in"); a && content.current?.contains(a); a = a.parentElement?.closest<HTMLElement>(".animate-in") ?? null) {
      const t = getComputedStyle(a).transform;
      if (t && t !== "none") y -= new DOMMatrixReadOnly(t).m42;
    }
    return y;
  };
  // Rows stack in order: the first whose bottom is below the top, by halving
  // over the rows where they are (no copy of the list: a long transcript is
  // scrolled through many times a second). What leads them and is no row
  // (the sticky branch banner, the button for earlier messages) is passed
  // over; it marks itself `data-pinned`.
  const rowAt = (c: HTMLElement, top: number) => {
    const rows = c.children;
    let lo = 0, hi = rows.length;
    while (lo < hi && lo < 3 && (rows.item(lo) as HTMLElement).dataset.pinned) lo++;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows.item(mid)!.getBoundingClientRect().bottom > top + 1) hi = mid; else lo = mid + 1; }
    return lo;
  };
  const remember = () => {
    const el = scroller.current;
    const c = content.current;
    anchor.current = null;
    if (!el || !c || stick.current) return;
    const top = el.getBoundingClientRect().top;
    let row = c.children.item(rowAt(c, top));
    // (Not a block's mark: rows read in above a row of the same block come in after it.)
    while (row?.classList.contains("k-block-mark")) row = row.nextElementSibling;
    if (!row) return;
    let part: Element = row;
    // Down to the deepest block crossing the top (a paragraph of a tall reply):
    // what grows before it inside the same reply moves it too.
    for (let depth = 0; depth < 6 && part.getBoundingClientRect().top < top; depth++) {
      const inner: Element | undefined = [...part.children].find((x) => { const r = x.getBoundingClientRect(); return r.height > 0 && r.bottom > top + 1; });
      if (!inner) break;
      part = inner;
    }
    const holder = part.closest<HTMLElement>("[data-events], [data-event-id]");
    const ev = holder ? holder.dataset.eventId ?? holder.dataset.events!.split(" ")[0] : undefined;
    anchor.current = { el: part, top: yOf(part) - top, ev, evTop: holder ? yOf(holder) - top : undefined };
  };
  const holderOf = (ev: string) => content.current?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(ev)}"], [data-events~="${CSS.escape(ev)}"]`);

  // ---------- The owner's place in this session, and how far they have read (lib/place.ts) ----------
  // What the owner's own hand moved: a wheel, a key, a press that is held (the scroll bar), a touch
  // and the glide after it. A scroll the page makes itself (rows taking their heights after a load
  // or a reconnect, the view held on its line) is not where the owner is, and is never kept.
  const hand = useRef({ at: -1e9, held: false, touch: -1e9 });
  const byHand = () => { const h = hand.current, now = performance.now(); return h.held || now - h.at < 1500 || now - h.touch < 4000; };
  const placing = useRef<Place | null>(null);
  // The first row at or under the view's top that shows an event. What stands at the top may show
  // none (a turn's end line): the place is then this row, at its distance under the top.
  const under = (top: number): HTMLElement | null => {
    const c = content.current;
    if (!c) return null;
    const rows = c.children;
    for (let i = rowAt(c, top), n = 0; i < rows.length && n < 12; i++, n++) {
      const row = rows.item(i) as HTMLElement;
      const list = row.matches("[data-event-id], [data-events]") ? [row] : [...row.querySelectorAll<HTMLElement>("[data-event-id], [data-events]")];
      const hit = list.find((x) => yOf(x) >= top - 1);
      if (hit) return hit;
    }
    return null;
  };
  // The place is kept: what stands at the top of the view, or that the end is followed.
  const moved = useRef(false); // the owner moved the view since the place was last kept
  const saving = useRef(0);
  const savePlace = () => {
    clearTimeout(saving.current);
    saving.current = 0;
    moved.current = false;
    const el = scroller.current;
    if (!el || placing.current) return;
    if (stick.current && !short.current) return putPlace(sessionId, { end: true, ev: undefined, off: undefined, h: undefined });
    const top = el.getBoundingClientRect().top;
    // (A line of a reply that still streams has no event yet: the place stays the last one that had.)
    const holder = (anchor.current?.ev ? holderOf(anchor.current.ev) : null) ?? under(top);
    const ev = holder ? holder.dataset.eventId ?? holder.dataset.events?.split(" ")[0] : undefined;
    if (!holder || !ev) return;
    putPlace(sessionId, { end: false, ev, off: Math.round(yOf(holder) - top), h: Math.round(holder.getBoundingClientRect().height) });
  };
  // Kept at most once in WRITE_MS while the owner scrolls, and when they leave if they moved since.
  // `own`: an act of the owner's that moves the view by itself (the way to the end, to what is new, to a search hit).
  const saveSoon = (own = false) => {
    if (own) hand.current.at = performance.now();
    else if (!byHand()) return;
    moved.current = true;
    saving.current ||= window.setTimeout(savePlace, WRITE_MS);
  };
  const leavePlace = () => { if (moved.current) savePlace(); flushPlaces(); };
  useEffect(() => {
    const box = scroller.current?.closest<HTMLElement>(".k-session") ?? scroller.current;
    if (!box) return;
    const h = hand.current;
    const stamp = () => { h.at = performance.now(); };
    const down = (e: PointerEvent) => { if (e.pointerType === "touch") h.touch = performance.now(); else h.held = true; };
    const up = () => { if (h.held) { h.held = false; h.at = performance.now(); } };
    const touch = () => { h.touch = performance.now(); };
    const o = { passive: true, capture: true } as const;
    box.addEventListener("wheel", stamp, o);
    box.addEventListener("keydown", stamp, o);
    box.addEventListener("pointerdown", down, o);
    for (const k of ["touchstart", "touchmove", "touchend"] as const) box.addEventListener(k, touch, o);
    addEventListener("pointerup", up, o);
    addEventListener("pointercancel", up, o);
    // The page going away (a reload, a closed tab).
    addEventListener("pagehide", leavePlace);
    return () => {
      box.removeEventListener("wheel", stamp, o);
      box.removeEventListener("keydown", stamp, o);
      box.removeEventListener("pointerdown", down, o);
      for (const k of ["touchstart", "touchmove", "touchend"] as const) box.removeEventListener(k, touch, o);
      removeEventListener("pointerup", up, o);
      removeEventListener("pointercancel", up, o);
      removeEventListener("pagehide", leavePlace);
    };
  }, [sessionId, !!events]);
  // The view is put where it stood: the event's row at the same distance from the view's top. False
  // when the row is not on the page (its part is not loaded). From then on the reading anchor holds the
  // line under the view's top there while the rows around it take their heights and the pane its width.
  const place = (p: Place): boolean => {
    const el = scroller.current, holder = p.ev ? holderOf(p.ev) : null;
    if (!el || !holder) return false;
    const off = offsetAt(p, holder.getBoundingClientRect().height);
    stick.current = false;
    const was = el.scrollTop;
    el.scrollTop += yOf(holder) - el.getBoundingClientRect().top - off;
    // (The scroll event that follows reports this, not the reader.)
    if (el.scrollTop !== was) settling.current = el.scrollTop;
    lastTop.current = el.scrollTop;
    remember();
    if (!anchor.current) anchor.current = { el: holder, top: off, ev: p.ev, evTop: off };
    setAway(true);
    return true;
  };
  // A place is put back in the frame its rows are first drawn in, and a row can stand at another
  // height for a moment then (its text before the page's own typeface is in, a row that folds once
  // it has measured itself): the place is put back once more two frames later and when the
  // typefaces are in, with the row as it stands then. Only while nothing else moved the view: not
  // the owner, and not a scroll the page made on purpose.
  const again = useRef<Place | null>(null);
  const settle = (p: Place) => {
    again.current = p;
    const re = () => { const el = scroller.current; if (again.current === p && el && !moved.current && el.scrollTop === lastTop.current) place(p); };
    requestAnimationFrame(() => requestAnimationFrame(re));
    if (document.fonts?.status === "loading") void document.fonts.ready.then(() => requestAnimationFrame(re));
    setTimeout(() => { if (again.current === p) again.current = null; }, 1500);
  };
  // While the part that holds the place is read the conversation is not shown: it appears where the
  // owner was, with no jump from its end. A wait that can be seen says what it is; after three
  // seconds the end is shown, and the place stays kept for the next time.
  const [finding, setFinding] = useState(false);
  const findT = useRef(0);
  const veil = (on: boolean) => {
    const c = content.current;
    if (c) c.style.visibility = on ? "hidden" : "";
    clearTimeout(findT.current);
    findT.current = on ? window.setTimeout(() => setFinding(true), 400) : 0;
    if (!on) setFinding(false);
  };
  const placed = useRef(false);
  const comeBack = () => {
    if (!events) return;
    if (!placed.current) {
      placed.current = true;
      const p = placeOf(sessionId);
      // (Not over a jump that is under way: a search hit or a link names its own place.)
      if (p && !p.end && p.ev && !getUI().focusEvent && !reading) placing.current = p;
    }
    const p = placing.current;
    if (!p) return;
    const end = (to: boolean) => { placing.current = null; veil(false); if (!to) toEnd(false, false); };
    if (place(p)) { settle(p); return end(true); }
    // Its row is not here. An event of the run shown that has no row of its own (it was folded into
    // a turn's notes) has no place; one of an earlier part is read with its part.
    if (events.some((e) => e.id === p.ev) || reaching.current === p.ev) return events.some((e) => e.id === p.ev) ? end(false) : undefined;
    reaching.current = p.ev!;
    veil(true);
    setTimeout(() => { if (placing.current === p) end(false); }, 3000);
    actions.page(sessionId, { around: p.ev! }).then((pg) => {
      reaching.current = null;
      if (placing.current !== p) return;
      // (A place on a branch that is not the session's own any more is not gone back to.)
      if (!pg.on_head) return end(false);
      const head = getState().sessions[sessionId]?.head ?? null;
      const joined = lineage(getState().events[sessionId] ?? [], head).some((e) => e.id === p.ev);
      if (!joined) setView({ event: p.ev!, head: pg.head, end: pg.end ? null : pg.last, other: false });
    }, () => { reaching.current = null; if (placing.current === p) end(false); });
  };
  // A pane's session going under a look or leaving the pane: its place is written, if the owner
  // moved since. Under a look the view stays as it is (it is not drawn, and not scrolled), so
  // nothing is put back when it shows again: what is new since is worked out then.
  useEffect(() => {
    const onSwap = (e: Event) => {
      const d = (e as CustomEvent<PaneSwap>).detail;
      if (d.session !== sessionId) return;
      if (d.state === "restored") { arrive.current = true; lookSoon(); }
      else leavePlace();
    };
    addEventListener("keel:pane-swap", onSwap);
    return () => removeEventListener("keel:pane-swap", onSwap);
  }, [sessionId]);
  useLayoutEffect(() => () => { leavePlace(); clearTimeout(saving.current); clearTimeout(findT.current); clearTimeout(looking.current); clearTimeout(going.current); }, [sessionId]);

  // Where what is new to the owner starts: a rule above the first row that came after the last one
  // they read, with that row's time. `ev` null: that row is in a part above that is not on the page.
  // One at a time. While it stands the read mark stays before it, so a reload, a switch or a blur
  // brings the same rule back: it goes once its first line and then the end were seen (or the owner
  // says so, or sends a prompt), and the mark is written then.
  const [fresh, setFresh] = useState<{ ev: string | null; at: number } | null>(null);
  // Where it is against the view: above it, below it, or in it (null).
  const [freshAt, setFreshAt] = useState<"above" | "below" | null>(null);
  // Whether the start of the last reply is above the view while the reader is inside it: a reply longer
  // than the view opens at its end, and a way to its first line stands at the conversation's foot.
  const [replyUp, setReplyUp] = useState(false);
  const lastReply = () => { const all = content.current?.querySelectorAll<HTMLElement>('[data-testid="assistant-text"]'); return all?.length ? all[all.length - 1]! : null; };
  // The last reply's element, kept between looks: a look runs on every scroll, and the element changes
  // only when the events or the rows drawn do (or it leaves the page).
  const replyEl = useRef<{ events: unknown; rows: number; el: HTMLElement | null } | null>(null);
  const lookReply = (view: DOMRect) => {
    const rows = content.current?.children.length ?? 0;
    let kept = replyEl.current;
    if (!kept || kept.events !== events || kept.rows !== rows || (kept.el && !kept.el.isConnected)) kept = replyEl.current = { events, rows, el: lastReply() };
    const r = kept.el?.getBoundingClientRect();
    const up = !!r && r.height > view.height && r.top < view.top - 8 && r.bottom > view.top + 8;
    if (up !== replyUp) setReplyUp(up);
  };
  // To it: its first line at the view's top, as the reader's own move (the view stops following the end).
  const toReply = () => {
    const el = scroller.current, at = lastReply();
    if (!el || !at) return;
    stick.current = false;
    setAway(true);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    el.scrollTop += at.getBoundingClientRect().top - el.getBoundingClientRect().top - 0.75 * rem;
    lastTop.current = el.scrollTop;
    remember();
    saveSoon(true);
    looks.current();
  };
  const arrive = useRef(true); // the owner is coming (back) to this conversation: what came since is new, on screen or not
  const sawFresh = useRef(false);
  // The new events came while the owner was watching (a turn they follow, not one they come back to):
  // the end followed for a few seconds is reading them, though the rule's own line went by above the view.
  const watched = useRef(false);
  // The page is on screen with the owner's focus and this is the one conversation in it (a phone's page, a single
  // pane): what streams into the end of the view is watched as it comes, with no touch needed (a touch is what makes
  // a line read, not what makes it seen). A pane beside the one worked in is not watched because it is on screen.
  const watching = () => !document.hidden && document.hasFocus() && panesInView().join() === sessionId;
  const going = useRef(0);
  const rule = useRef<HTMLElement | null>(null);
  // The last event whose row (or step) has its top on screen.
  const lastSeen = (): string | undefined => {
    const el = scroller.current, c = content.current;
    if (!el || !c) return undefined;
    const bottom = el.getBoundingClientRect().bottom - 8;
    const rows = c.children;
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows.item(mid)!.getBoundingClientRect().top < bottom) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0; i--) {
      const row = rows.item(i) as HTMLElement;
      if (row.dataset.eventId) return row.dataset.eventId;
      const steps = [...row.querySelectorAll<HTMLElement>("[data-events]")].filter((x) => x.getBoundingClientRect().top < bottom);
      if (steps.length) return steps.at(-1)!.dataset.events!.split(" ").at(-1);
    }
    return undefined;
  };
  // The rule is drawn by the style sheet over the gap above its row, from an attribute: it takes no
  // room, so nothing moves when it comes or goes. (A run's first step is marked on the run's own
  // row: the rule stands between two rows.) A screen reader is told of it by a separator of its own,
  // the last thing in the row before, so it is said where it stands: after what was read, before what is new.
  const ruleRow = () => content.current?.querySelector<HTMLElement>("[data-new-since]") ?? null;
  const drawRule = () => {
    const c = content.current;
    const holder = fresh?.ev ? holderOf(fresh.ev) : null;
    const row = holder?.closest<HTMLElement>(".row-cv");
    const on = holder && row && holder !== row && row.querySelector("[data-events]") === holder ? row : holder;
    for (const old of c?.querySelectorAll("[data-new-since]") ?? []) if (old !== on) old.removeAttribute("data-new-since");
    const before = on?.previousElementSibling;
    if (!on || !fresh || !before || (before as HTMLElement).dataset.pinned) rule.current?.remove();
    if (!on || !fresh) return;
    const says = newSinceAt(clock(fresh.at));
    if (on.dataset.newSince !== says) on.dataset.newSince = says;
    if (!before || (before as HTMLElement).dataset.pinned) return;
    if (!rule.current) {
      rule.current = document.createElement("span");
      rule.current.className = "sr-only";
      rule.current.setAttribute("role", "separator");
    }
    if (rule.current.getAttribute("aria-label") !== says) rule.current.setAttribute("aria-label", says);
    if (before.lastChild !== rule.current) before.append(rule.current);
  };
  useLayoutEffect(drawRule, [fresh, events]);
  // The rule goes: the owner has read to the end (or said so), and the mark is written there.
  const endFresh = () => {
    clearTimeout(going.current);
    going.current = 0;
    sawFresh.current = false;
    watched.current = false;
    setFresh(null);
    const last = events?.at(-1);
    if (last && !reading) putPlace(sessionId, { read: last.id, readSeq: last.seq, readAt: Date.now() });
  };
  // What is on screen is looked at when it can have changed: the owner scrolled, events came, the
  // view changed size, or the owner came to this pane or left it (keel:present). No timer runs for it.
  // - No rule stands: when events came after the mark that the owner cannot have read (they were not
  //   here, or are here with the first of them below the view, or have just come back), the rule is
  //   set at the first; else, while they are here, the mark follows what is on screen.
  // - A rule stands: where it is against the view, and whether its first line and then the end were seen.
  const look = () => {
    clearTimeout(looking.current);
    looking.current = 0;
    const el = scroller.current;
    if (!el || !events?.length || document.hidden) return;
    const here = presentAt(sessionId);
    const view = el.getBoundingClientRect();
    lookReply(view);
    if (!reading && !fresh) {
      // At this conversation: the owner works in it, or has the page open on its end as the turn streams in.
      const near = here || (watching() && stick.current && !short.current);
      const p = placeOf(sessionId);
      const last = events.at(-1)!;
      // The first sight of this conversation on this device: what is here is not new.
      if (!p?.read) putPlace(sessionId, { read: last.id, readSeq: last.seq, readAt: Date.now() });
      else {
        const after = newAfter(events, p);
        const first = after === "before" ? undefined : after.find((e) => holderOf(e.id));
        // (Nothing is below the view of a reader who follows the end: a row that has just come is
        // looked at before the view was put at the end again.)
        const below = !!first && !stick.current && yOf(holderOf(first.id)!) > view.bottom - 24;
        if ((first || after === "before") && (arrive.current || !near || below)) {
          sawFresh.current = false;
          watched.current = watching() && !arrive.current;
          setFresh({ ev: first?.id ?? null, at: first?.ts ?? p.readAt ?? Date.now() });
        } else if (near) {
          const id = stick.current && !short.current ? last.id : lastSeen();
          const seen = id === last.id ? last : id ? events.find((e) => e.id === id) : undefined;
          if (seen && isLater(p, seen)) putPlace(sessionId, { read: seen.id, readSeq: seen.seq, readAt: Date.now() });
        }
      }
      arrive.current = false;
      return;
    }
    if (!fresh) return;
    if (fresh.ev && !ruleRow()) drawRule();
    const top = ruleRow()?.getBoundingClientRect().top;
    // (Its row is not on the page: in a part above, or below the earlier part that is read.)
    const where = top === undefined ? (fresh.ev && short.current ? "below" : "above") : top < view.top - 4 ? "above" : top > view.bottom - 24 ? "below" : null;
    if (where !== freshAt) setFreshAt(where);
    if (!here && !(watched.current && watching())) return;
    if (here && !where) sawFresh.current = true;
    const atEnd = !short.current && el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const read = sawFresh.current || watched.current;
    if (read && atEnd && !going.current) going.current = window.setTimeout(endFresh, 4000);
    // (Scrolled up again before the seconds were out: only a rule that was seen keeps its timer.)
    else if (!atEnd && going.current && !sawFresh.current) { clearTimeout(going.current); going.current = 0; }
  };
  const looks = useRef(look);
  looks.current = look;
  const looking = useRef(0);
  const lookSoon = () => { looking.current ||= window.setTimeout(() => looks.current(), 200); };
  useEffect(() => {
    const on = () => lookSoon();
    addEventListener("keel:present", on);
    document.addEventListener("visibilitychange", on);
    return () => { removeEventListener("keel:present", on); document.removeEventListener("visibilitychange", on); };
  }, []);
  // (At once when the conversation shows and when a rule comes, so the rule and the way to it are
  // there with it; a moment later when events came, once the view has followed them.)
  useEffect(() => { if (events) looks.current(); }, [!!events, !!fresh, !!reading]);
  useEffect(() => { if (events) lookSoon(); }, [events, fresh]);
  useEffect(() => { if (!fresh) setFreshAt(null); }, [fresh]);
  // A rule whose row was in a part above: once that part is on the page it stands on its row.
  useEffect(() => {
    if (!fresh || fresh.ev !== null || !events) return;
    const after = newAfter(events, placeOf(sessionId));
    const first = after === "before" ? undefined : after.find((e) => holderOf(e.id));
    if (first) setFresh({ ev: first.id, at: first.ts });
  }, [fresh, events]);
  // A prompt sent from here ends it: the owner is done with what was new.
  useEffect(() => {
    const onSent = (e: Event) => { if ((e as CustomEvent<string>).detail === sessionId && fresh) endFresh(); };
    addEventListener("keel:sent", onSent);
    return () => removeEventListener("keel:sent", onSent);
  }, [sessionId, fresh, events, !!reading]);
  // To it: the rule at the view's top, so the new text reads down from there and nothing above it
  // is cut in half. (A rule in a part that is not on the page is reached as a search hit is: by the
  // last line that was read.)
  const toFresh = () => {
    const el = scroller.current, on = ruleRow();
    if (!fresh) return;
    if (!el || !on) { const to = fresh.ev ?? placeOf(sessionId)?.read; if (to) setUI({ focusEvent: to, focusStay: to }); return; }
    stick.current = false;
    setAway(true);
    // (The rule stands half a gap above its row, its words a line high: the row a little over a rem
    // under the top; a step's rule is on its edge. In rem: the text size the owner picked scales it.)
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    el.scrollTop += on.getBoundingClientRect().top - el.getBoundingClientRect().top - (on.classList.contains("k-step") ? 0.5 : 1.0625) * rem;
    lastTop.current = el.scrollTop;
    remember();
    saveSoon(true);
    looks.current();
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

  // `own`: the owner went there (Latest, End, a prompt sent): the end is their place from now.
  const toEnd = (smooth = false, own = true) => {
    const el = scroller.current;
    if (!el) return;
    leaving.current();
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? scrollMotion() : "instant" });
    lastTop.current = el.scrollTop;
    if (own) saveSoon(true);
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
    const was = foot.current;
    findLast();
    // (Not for another run of events, or an earlier part read above this one.)
    if (same) keepHeight(was);
    else { foot.current = { ref: null, len: 0 }; for (const k of [...kept.current]) setRoom(k, 0); }
    drawn.current = events;
    // The owner comes back to where they were, before the first paint.
    comeBack();
    if (el && !same && stick.current && !reading?.end) pin(el);
    // (The end as it stands now: two changes in one frame are each measured against the one before.)
    if (content.current) standing(content.current);
  }, [events]);
  // The conversation's end changes with no event too: the working line goes when the session is told
  // it is at rest, which may be a frame or more before its turn's end line comes; a status row goes; a
  // question takes the line's place. The height of the end is kept through that as through an
  // event: the last row keeps what was lost as room, and what comes next takes it up. (Not in a
  // frame that also draws an event: that one is kept above, with the new last row.)
  const drawn = useRef<StoredEvent[] | undefined>(undefined);
  const tailChanged = useRef(() => {});
  tailChanged.current = () => {
    if (!events || events !== drawn.current || !stick.current || short.current) return;
    keepHeight(foot.current);
    if (content.current) standing(content.current);
  };
  const onTail = useRef(() => tailChanged.current()).current;
  const viewSize = useRef(0);
  const holdView = useRef<(el: HTMLDivElement) => void>(() => {});
  // A reply drawn near the view changed by itself (its math set, lib Markdown.tsx): the reader's
  // line is held before the frame is painted.
  const enhanced = useRef(() => {
    const el = scroller.current;
    if (el && (!stick.current || short.current) && el.scrollTop === lastTop.current) holdView.current(el);
  }).current;
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    let late = 0, lateUnder = 0;
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
      const size = el.clientWidth * 100_000 + el.clientHeight;
      if (size !== viewSize.current) { viewSize.current = size; lookSoon(); }
      const box = el.closest<HTMLElement>(".k-session");
      const sbw = `${el.offsetWidth - el.clientWidth}px`;
      if (box && box.style.getPropertyValue("--sbw") !== sbw) { cancelAnimationFrame(late); late = requestAnimationFrame(() => box.style.setProperty("--sbw", sbw)); }
      // The room under the last row of a conversation that does not fill its view: a card that waits on the
      // owner (the tray over the message box) stands that much higher, right under its step (bridge.css).
      // None where the conversation fills the view: the card is at the box then, as it was.
      const rest = el.scrollHeight > el.clientHeight + 1 ? 0 : Math.max(0, Math.floor(el.clientHeight - (c.offsetHeight - parseFloat(getComputedStyle(c).paddingBottom)) - parseFloat(getComputedStyle(document.documentElement).fontSize)));
      if (box && box.style.getPropertyValue("--k-under") !== `${rest}px`) { cancelAnimationFrame(lateUnder); lateUnder = requestAnimationFrame(() => box.style.setProperty("--k-under", `${rest}px`)); }
      standing(c);
      hold(el);
      // Then which blocks to draw, with the view where it now stands. (Here the layout is done:
      // where the blocks stand is read for nothing.)
      measures.current();
    });
    // The view is kept where the reader has it: at the end, or on the line they read. (Also after
    // other blocks are drawn: a block held and drawn again in one frame changes no size the
    // observer is told of, and the scroll the browser cut short meanwhile would stay so.)
    const hold = (el: HTMLDivElement) => {
      if (stick.current && !short.current) pin(el);
      else if (anchor.current && !anchor.current.el.isConnected && anchor.current.ev && holderOf(anchor.current.ev)) {
        // The element read was made again: its event's row or step is put back where it stood.
        const a = anchor.current;
        const moved = yOf(holderOf(a.ev!)!) - el.getBoundingClientRect().top - a.evTop!;
        if (Math.abs(moved) >= 0.5) {
          const was = el.scrollTop;
          el.scrollTop += moved;
          settling.current = el.scrollTop !== was ? el.scrollTop : null;
          lastTop.current = el.scrollTop;
        }
      } else if (anchor.current?.el.isConnected) {
        // The anchor stays the one the reader chose by scrolling: after rows
        // are added above it (an earlier part read), the row now at the top is
        // one of those, still at its estimated height, and holding on to it
        // would let the reader's row slide as it takes its real height.
        const moved = yOf(anchor.current.el) - el.getBoundingClientRect().top - anchor.current.top;
        if (Math.abs(moved) >= 0.5) {
          const was = el.scrollTop;
          el.scrollTop += moved;
          settling.current = el.scrollTop !== was ? el.scrollTop : null; // a scroll event follows only when it moved
          lastTop.current = el.scrollTop;
        }
        return;
      }
      remember();
    };
    holdView.current = hold;
    ro.observe(c);
    // The view's own height too: the message box under it grows with a draft, and a transcript
    // that follows its end keeps the end in view (its last lines would go under the box).
    if (scroller.current) ro.observe(scroller.current);
    // End is for the pane worked in: the command names its session.
    const onEnd = (e: Event) => { if ((e as CustomEvent<string>).detail === sessionId) toEnd(true); };
    addEventListener("keel:end", onEnd);
    return () => { ro.disconnect(); cancelAnimationFrame(late); cancelAnimationFrame(lateUnder); removeEventListener("keel:end", onEnd); };
  }, [!!events, sessionId]);

  // History read away from the end stays whole in the store meanwhile, also under a cover (a
  // look over the pane): the place the reader left is in it, and a session that takes one
  // step under the look would otherwise be cut to its newest part and the place lost.
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
    setUnread((u) => ({ ...u, [which]: e instanceof TypeError ? `${appSaysNow() ?? "Keel is not reachable"}.` : failed(e, { at: "transcript part", session_id: sessionId }) }));
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
  // A page that does not fill the view asks for the one before it. Measured by
  // the height the rows have once they are drawn, not by how many there are:
  // a block not drawn stands at an estimate (lib/window.ts), and a page of a
  // few tall rows (one long run of work) read as a short one.
  useEffect(() => {
    if (!more) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => { const el = scroller.current; if (el && el.scrollHeight <= el.clientHeight) reads.current.older(true); });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [events, more]);

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

  // The way to where what is new starts, and the owner's word that they have read it.
  const wayNew = fresh && freshAt ? (
    <span className="k-new-jump">
      <button type="button" data-testid="new-since-jump" data-where={freshAt} onClick={toFresh}>{freshAt === "above" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}{newSinceAt(clock(fresh.at))}</button>
      <button type="button" data-testid="new-since-read" aria-label={MARK_READ} title={MARK_READ} onClick={endFresh}><Check className="size-3.5" /></button>
    </span>
  ) : null;

  const wayStart = replyUp ? (
    <span className="k-new-jump">
      <button type="button" data-testid="reply-start-jump" onClick={toReply}><ArrowUp className="size-3.5" />Start of the reply</button>
    </span>
  ) : null;

  // A prompt this page sends while an earlier part is read goes to the end,
  // and so does the transcript. Nothing else moves the reader: not an agent's
  // report, a wake or a peer's message, and not a prompt from another tab.
  useEffect(() => {
    if (!earlier) return;
    const onSent = (e: Event) => { if ((e as CustomEvent<string>).detail === sessionId) toEnd(); };
    addEventListener("keel:sent", onSent);
    return () => removeEventListener("keel:sent", onSent);
  }, [earlier, sessionId]);

  // The page's own Find (FindBar.tsx) on the find key: the browser's reaches only what is drawn,
  // and this one every place of the branch shown, folded, not drawn or not read yet. The key is the
  // conversation's in its pane (the pane with the keys; with the keys in no pane, the one at the
  // helm or the only one) from anywhere but a text field: in the message box it is the
  // conversation's too, and any other field (a terminal's, a panel's, a menu's) keeps its own.
  const [findAsk, setFindAsk] = useState(0);
  const findFrom = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !findKey(e, isMac)) return;
      const mine = scroller.current?.closest("[data-station]");
      const t = document.activeElement as HTMLElement | null;
      const at = t?.closest("[data-station]");
      if (at ? at !== mine : !!mine && !mine.hasAttribute("data-helm")) return;
      const field = !!t && (t.matches("input, textarea, select") || t.isContentEditable);
      if (field && !t.matches('[data-testid="composer"], [data-testid="find-input"]')) return;
      if (!scroller.current?.offsetParent) return; // not shown (a view under another)
      e.preventDefault();
      if (!t?.closest('[data-testid="find-bar"]')) findFrom.current = t;
      setFindAsk((n) => n + 1);
    };
    // (On the document: it is asked before the page's Find of the desktop app, on the window, at any order of mounting.)
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setFindAsk(0), [sessionId]);
  const closeFind = () => {
    setFindAsk(0);
    const back = findFrom.current;
    findFrom.current = null;
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    else focusBox(sessionId);
  };
  // A match brought into the view as the reader's own move (the view stops following the end);
  // one in view already moves nothing.
  const bringFound = (r: DOMRect) => {
    const sc = scroller.current;
    if (!sc) return;
    const box = sc.getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    if (r.top >= box.top + 4 * rem && r.bottom <= box.bottom - 3 * rem) return;
    stick.current = false;
    sc.scrollTop += r.top - box.top - Math.max(0, (box.height - r.height) / 2);
  };

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
      // An event inside a run of work is its step there.
      // Its row, or its step in a run of work: whichever comes first on the page.
      const el = content.current?.querySelector<HTMLElement>(`[id="e-${CSS.escape(focus)}"], [data-events~="${CSS.escape(focus)}"]`) ?? document.getElementById(`e-${focus}`);
      if (!el) return; // folded into a turn's notes: the session opens at its end as usual
      stick.current = false;
      // Centered in the transcript's own scroller (scrollIntoView would also move clipped ancestors).
      const sc = scroller.current;
      if (sc) {
        const r = el.getBoundingClientRect();
        const box = sc.getBoundingClientRect();
        sc.scrollTop += r.top - box.top - Math.max(0, (box.height - r.height) / 2);
        lastTop.current = sc.scrollTop;
      }
      remember();
      saveSoon(true);
      if (!stay) {
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
      }
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    });
    return () => cancelAnimationFrame(raf);
  }, [focus, events]);

  // ---------- Blocks drawn near the view (lib/window.ts) ----------
  // A block of rows near the view is drawn; every other block stands as one light box as tall as
  // it was when it was last drawn (an estimate before that), with its rows' words and event ids in
  // it: Find, a screen reader and a selection reach them, a jump or a place finds where they are.
  // Each block is led by a mark of no height, which says where the block begins on screen.
  // `win`: the blocks the view asked for, of this session. A block also stays drawn while
  // something needs it (`pins`, below): a jump or a place put back, the keyboard, a selection.
  const blocks = built?.blocks ?? [];
  const heights = useRef(new Map<number, number>());
  // (`seen`: the blocks there were when it was asked: one that came since is drawn until it is measured.)
  const [win, setWin] = useState<{ sid: string; keys: Set<number>; seen: Set<number> } | null>(null);
  const drawnKeys = useRef<Set<number>>(new Set());
  const pinsRef = useRef<Set<number>>(new Set());
  const [hands, setHands] = useState<{ sel: string; focus: number | null }>({ sel: "", focus: null });
  const heightsOf = useRef(sessionId);
  if (heightsOf.current !== sessionId) { heightsOf.current = sessionId; heights.current = new Map(); }
  // The block a node of the transcript is in: its row's mark, the nearest one before it.
  const blockOfNode = (n: Node | null): number | undefined => {
    const c = content.current;
    let el: Element | null = !n ? null : n instanceof Element ? n : n.parentElement;
    while (el && el.parentElement !== c) el = el.parentElement;
    for (let x = el; x; x = x.previousElementSibling) if ((x as HTMLElement).dataset.block !== undefined) return Number((x as HTMLElement).dataset.block);
    return undefined;
  };
  // Where each block stands, and which ones to draw: after an event, a scroll and a change of size.
  const measuring = useRef(0);
  const printingNow = useRef(false);
  const again_ = useRef(0);
  const sizes = useRef({ rem: 16, gap: 14, width: 768 }); // the text size, the rows' gap and the column's width, for estimates
  const measureWindow = () => {
    cancelAnimationFrame(measuring.current);
    measuring.current = 0;
    const c = content.current, el = scroller.current;
    // (Printed, every block is drawn: nothing is measured until the print is done.)
    if (!c || !el || printingNow.current) return;
    const marks = c.querySelectorAll<HTMLElement>(":scope > [data-block]");
    const spans: Span[] = [];
    for (const m of marks) {
      const top = m.getBoundingClientRect().top;
      if (spans.length) spans.at(-1)!.bottom = top;
      spans.push({ key: Number(m.dataset.block), top, bottom: top });
    }
    if (!spans.length) return;
    spans.at(-1)!.bottom = c.getBoundingClientRect().bottom;
    sizes.current = { rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, gap: parseFloat(getComputedStyle(c).rowGap) || 0, width: c.clientWidth };
    // What an open edit or the like asks to keep.
    const pins = new Set(pinsRef.current);
    for (const k of c.querySelectorAll("[data-keep]")) { const b = blockOfNode(k); if (b !== undefined) pins.add(b); }
    const drawn = drawnKeys.current;
    // A view that follows the end is where the end will be once it is put there (a commit can be
    // measured before the size observer puts it back at the end).
    const box = el.getBoundingClientRect();
    const behind = stick.current && !short.current ? Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) : 0;
    const next = windowOf(spans, { top: box.top + behind, bottom: box.bottom + behind }, drawn, pins);
    if (sameKeys(drawn, next)) return;
    // A block that leaves is kept at the height it stands at now.
    for (const s of spans) if (drawn.has(s.key) && !next.has(s.key)) heights.current.set(s.key, s.bottom - s.top);
    again_.current = 1;
    setWin({ sid: sessionId, keys: next, seen: new Set(spans.map((x) => x.key)) });
  };
  const measures = useRef(measureWindow);
  measures.current = measureWindow;
  const measureLater = useRef(() => { measuring.current ||= requestAnimationFrame(() => measures.current()); }).current;
  // After a commit that drew other blocks, they are measured again before the frame is painted:
  // a block drawn at its real height can bring the next one into the view.
  // After every commit the view is held where the reader has it, in the same task, before the
  // frame is painted: what the commit drew, held or read in above the reader's line (a block at
  // its real height, a part read in at the top) would otherwise stand for one frame where the
  // layout put it, until the size observer puts it back. Followed to its end, the view moves only
  // when other blocks were drawn (the size observer follows what streams). Not when the view moved
  // since this transcript last saw it (a wheel, a jump) and its scroll event is still to come:
  // the place it went to is the reader's.
  const drawnSig = useRef("");
  // A selection in one held row (Find's, as a rule): carried to the row when it is drawn.
  const picked = useRef<HeldPick | null>(null);
  // The blocks drawn at the last commit, of which session: a block drawn again after it was held
  // shows its rows where they stand, with no entrance (they arrived long ago; a row coming in is
  // drawn 0.25rem low for a moment, and a reader scrolling back saw each block slide into place).
  // Only the conversation's newest block, where new rows land, and a session's first frame keep it.
  const drawnBefore = useRef<{ sid: string; keys: Set<number> } | null>(null);
  const still = (k: number) => {
    const mark = content.current?.querySelector(`:scope > [data-block="${k}"]`);
    for (let x = mark?.nextElementSibling; x && !x.classList.contains("k-block-mark"); x = x.nextElementSibling)
      for (const a of x.getAnimations({ subtree: true })) if ((a as CSSAnimation).animationName === "fade-up") a.finish();
  };
  useLayoutEffect(() => {
    const sig = [...drawnKeys.current].join(" ");
    const other = sig !== drawnSig.current;
    drawnSig.current = sig;
    const was = drawnBefore.current;
    if (other && was?.sid === sessionId && blocks.length) {
      const newest = blockKey(blocks.at(-1)!);
      for (const k of drawnKeys.current) if (k !== newest && !was.keys.has(k)) still(k);
    }
    if (other || was?.sid !== sessionId) drawnBefore.current = { sid: sessionId, keys: drawnKeys.current };
    const el = scroller.current;
    if (el && (other || !stick.current || short.current) && el.scrollTop === lastTop.current) holdView.current(el);
    // What a selection held in a row that is drawn now (lib/held-range.ts).
    const p = picked.current;
    if (p && !p.row.isConnected) {
      picked.current = null;
      const h = holderOf(p.ev);
      if (h) carryPick(h, p);
    }
    if (!again_.current) return;
    again_.current = 0;
    measureWindow();
  });
  // A session's first frame: the view says which blocks before it is painted. (After that, what
  // changes size is measured by the size observer, when the layout is done.)
  useLayoutEffect(() => { if (events && win?.sid !== sessionId) measureWindow(); }, [events]);
  // The blocks under the keyboard and a selection stay drawn: the row that holds the focus, and every
  // drawn block a selection spans (what is copied is what is drawn; a selection made by dragging
  // has drawn every block it passed).
  useEffect(() => {
    const c = content.current;
    if (!c) return;
    const onSel = () => {
      const s = document.getSelection();
      const p = heldPick(s);
      picked.current = p && c.contains(p.row) ? p : null;
      let sel = "";
      if (s && !s.isCollapsed && s.rangeCount) {
        const r = s.getRangeAt(0);
        if (r.intersectsNode(c)) {
          const keys = [...c.querySelectorAll<HTMLElement>(":scope > [data-block]")].map((m) => Number(m.dataset.block));
          // (A point on the column itself, between its rows, is the row beside it.)
          const at = (n: Node, off: number, end: boolean) => (n === c ? blockOfNode(c.childNodes[end ? off - 1 : off] ?? null) : blockOfNode(n));
          const a = c.contains(r.startContainer) ? at(r.startContainer, r.startOffset, false) : keys[0];
          const b = c.contains(r.endContainer) ? at(r.endContainer, r.endOffset, true) : keys.at(-1);
          const i = a === undefined ? -1 : keys.indexOf(a), j = b === undefined ? -1 : keys.indexOf(b);
          // (Only the blocks that are drawn: one that is held keeps its words in the selection as they
          // are. Drawing it would take the selected words away, and a Find that selects what it found
          // would lose it.)
          if (i >= 0 && j >= i) sel = keys.slice(i, j + 1).filter((k) => drawnKeys.current.has(k)).join(" ");
        }
      }
      setHands((h) => (h.sel === sel ? h : { ...h, sel }));
    };
    const onFocus = (e: FocusEvent) => { const k = blockOfNode(e.target as Node) ?? null; setHands((h) => (h.focus === k ? h : { ...h, focus: k })); };
    const onBlur = (e: FocusEvent) => { if (!c.contains(e.relatedTarget as Node | null)) setHands((h) => (h.focus === null ? h : { ...h, focus: null })); };
    document.addEventListener("selectionchange", onSel);
    c.addEventListener("focusin", onFocus);
    c.addEventListener("focusout", onBlur);
    return () => { document.removeEventListener("selectionchange", onSel); c.removeEventListener("focusin", onFocus); c.removeEventListener("focusout", onBlur); };
  }, [!!events, sessionId]);
  // A page printed has every block drawn: what the page holds of the conversation is printed as it
  // is shown, not as held boxes. (beforeprint lets the page change before it is laid out for print.)
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => { printingNow.current = true; flushSync(() => setPrinting(true)); };
    const after = () => { printingNow.current = false; setPrinting(false); measureLater(); };
    addEventListener("beforeprint", before);
    addEventListener("afterprint", after);
    return () => { removeEventListener("beforeprint", before); removeEventListener("afterprint", after); };
  }, []);
  // What a pin kept drawn goes once nothing needs it, the next time the view is measured: now.
  const pinned = useRef("");
  useEffect(() => {
    const now = [...pinsRef.current].sort((a, b) => a - b).join(" ");
    if (now !== pinned.current) { pinned.current = now; measureLater(); }
  });
  // The block of an event (a row's, or one step of a run of work).
  const keyOf = (id: string | null | undefined): number | undefined => {
    if (!id || !built) return undefined;
    let j = built.at.get(id) ?? built.at.get(`w:${id}`);
    if (j === undefined) j = blocks.findIndex((rows) => rows.some((r) => r.events?.includes(id)));
    return j === undefined || j < 0 ? undefined : blockKey(blocks[j]!);
  };
  // A place that is put back: its row is looked for in the frame its events are drawn in.
  const back = placed.current ? placing.current : placeOf(sessionId);

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

  // What the daemon marks on the calls shown (lib/marks.ts): asked for once per reply that calls a tool.
  useEffect(() => {
    if (!events) return;
    const ids: string[] = [];
    for (const e of events) if (e.kind === "assistant" && e.data.stop !== "refusal" && (e.data.blocks as { type: string }[]).some((b) => b.type === "tool_use")) ids.push(e.id);
    if (ids.length) ensureMarks(sessionId, ids);
  }, [events, sessionId]);

  // A question card waiting on the owner says so itself; no "Working" under it.
  const asking = useStore((s) => !!s.questionCalls[sessionId]?.length);
  if (!events || !built) return <div className="flex-1" />;
  const lastStart = events.findLast((e) => e.kind === "turn_start");
  // A run that stops short of its branch's end has no last turn: its last
  // footer is a turn in the middle of the session, and what acts on the
  // session where it stands (Answer again, Continue, a failure's Try again,
  // sending the images again) is not offered there.
  const short_ = !!reading?.end;
  // What needs its block drawn now: a jump and a place put back (looked for in the frame their
  // events are drawn in), the prompt the keyboard moves to, where what is new starts, the keyboard
  // and a selection.
  const pins = new Set<number>();
  for (const id of [want, at?.id, back && !back.end ? back.ev : undefined, fresh?.ev]) { const k = keyOf(id); if (k !== undefined) pins.add(k); }
  for (const k of hands.sel ? hands.sel.split(" ") : []) pins.add(Number(k));
  if (hands.focus !== null) pins.add(hands.focus);
  pinsRef.current = pins;
  const asked = win?.sid === sessionId ? win.keys : null;
  const shown = new Set<number>();
  const before = drawnKeys.current;
  blocks.forEach((rows, i) => {
    const k = blockKey(rows);
    if (printing || (!asked ? i >= blocks.length - TAIL_BLOCKS : asked.has(k) || i >= blocks.length - 2 || (!win!.seen.has(k) && (before.has(k) || i >= blocks.length - TAIL_BLOCKS)))) shown.add(k);
  });
  for (const k of pins) shown.add(k);
  drawnKeys.current = shown;
  // (What the last measure read: a render reads no layout.)
  const { rem, gap, width } = sizes.current;
  tail.setImages(short_ ? undefined : events.findLast((e) => e.kind === "note" && e.data.kind === "images")?.id);
  tail.put(session, short_ ? undefined : events.findLast((e) => e.kind === "turn_end")?.id, short_ ? undefined : events.at(-1)?.id, !!reading, reading?.other ? reading.head ?? undefined : undefined);

  return (
    // A strip of the conversation stays above a tall stack of cards and a long
    // draft, in a pane with room for one (none in a pane under 24rem high; on a
    // phone, a finger's height while a card waits: bridge.css).
    <div className="k-reading-room relative min-h-[clamp(0px,calc((100%-24rem)/2),6rem)] flex-1">
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
          if (settling.current !== null && Math.abs(el.scrollTop - settling.current) < 1) settling.current = null;
          else { settling.current = null; again.current = null; remember(); saveSoon(); lookSoon(); }
          // Which blocks to draw where the view went. (A scroll that only reports where this
          // transcript put the view, as it follows the end, is measured by the size observer.)
          if (up || down) measureLater();
          // The reader moving toward an edge reads the part beyond it (not a
          // scroll that only followed the content changing size).
          if (!stick.current && up && el.scrollTop < el.clientHeight) older(true);
          if (near && down) later(true);
        }}
      >
        <div ref={content} className="k-transcript mx-auto flex max-w-[48rem] flex-col gap-[var(--k-row-gap,1rem)] px-4 py-8 md:px-6" data-testid="transcript" data-quote-from="the conversation" data-working={session.phase === "working" || undefined}>
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
          {events.length === 0 && session.phase !== "working" && <EmptyTranscript sessionId={sessionId} />}
          {more && (
            <div className="flex flex-wrap items-center justify-center gap-x-2" data-testid="earlier-messages" data-pinned="1">
              {unread.older && !loading && <span role="status" data-testid="earlier-failed" className="text-caption text-warn">Earlier messages did not load: {unread.older}</span>}
              <button type="button" data-testid="load-earlier" disabled={loading} onClick={() => void older()} className={cn("h-7 rounded-md px-2.5 text-caption font-medium hover:bg-hover hover:text-fg disabled:opacity-60", unread.older && !loading ? "border border-line text-fg" : "text-muted")}>
                {loading ? "Loading earlier messages" : unread.older ? "Try again" : "Load earlier messages"}
              </button>
            </div>
          )}
          <TailContext.Provider value={tail}>
            <NearView.Provider value={enhanced}>
              {blocks.map((rows) => {
                const k = blockKey(rows);
                return (
                  <Fragment key={k}>
                    <div data-block={k} className="k-block-mark" aria-hidden="true" />
                    {shown.has(k) ? <RowBlock rows={rows} sid={sessionId} /> : <Hold rows={rows} span={heights.current.get(k) ?? estimate(rows, width, rem, gap)} gap={gap} rem={rem} width={width} />}
                  </Fragment>
                );
              })}
            </NearView.Provider>
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
          {/* (Once the turn's end is on the page nothing says it works: its footer takes the working line's
              place in the same frame, so the lines above do not drop when the session's state follows.) */}
          <Live sessionId={sessionId} working={session.phase === "working" && events?.at(-1)?.kind !== "turn_end"} asking={asking} since={lastStart?.ts} elsewhere={previewing ? "branch" : earlier ? "earlier" : null} onTail={onTail} />
        </div>
      </div>
      {at && (
        <div aria-hidden="true" className={cn("pointer-events-none absolute left-1/2 z-10 flex h-7 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-raised px-3 text-caption font-medium tabular-nums text-muted shadow-2 animate-pop", away ? "bottom-[3.25rem]" : "bottom-3")}>
          <span data-testid="prompt-place">{at.text}</span>
          <span className="flex items-center gap-1 border-l border-line pl-2 font-normal text-faint" data-testid="prompt-place-back"><Kbd keys="escape" /> message box</span>
        </div>
      )}
      {finding && <p role="status" data-testid="finding-place" className="k-place-wait">Finding your place</p>}
      {findAsk > 0 && events.length > 0 && (
        <Suspense fallback={null}>
          <FindBar sessionId={sessionId} events={events} head={reading?.other ? reading.head ?? undefined : undefined} before={events[0]!.seq} after={reading?.end ? events.at(-1)!.seq : undefined}
            whole={!more} content={content} bring={bringFound} ask={findAsk} onClose={closeFind} />
        </Suspense>
      )}
      {/* The way to where what is new starts, while that line is not in view, stands at the conversation's
          foot: with the way to the end when the reader is away from it; when they follow the end, over the
          room under the last line, where no line is. */}
      {!(away || earlier) && (wayNew || wayStart) && <div className="k-new-bar">{wayNew ?? wayStart}</div>}
      {(away || earlier) && (
        // A strip of its own under the conversation: the way to the end never lies over a line being read.
        <div className="k-latest-bar">
          {wayNew ?? wayStart}
          <button
            type="button"
            onClick={() => toEnd(true)}
            data-testid="jump-latest"
            data-live={session.phase === "working" || undefined}
            title="Go to the latest messages"
            className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-caption font-medium text-muted animate-pop hover:text-fg"
          >
            {/* A reply being written below the view (a prompt sent from elsewhere moves no reader): the way there says so. */}
            {session.phase === "working"
              ? <><span className="size-1.5 rounded-full bg-brass animate-pulse-dot" aria-hidden="true" /> A reply is being written</>
              : <><ArrowDown className="size-3.5" /> Latest</>}
          </button>
        </div>
      )}
    </div>
  );
}
