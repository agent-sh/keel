import { ArrowUp, File as FileIcon, FileText, Folder, ListPlus, Paperclip, Slash, SlidersHorizontal, Square, X } from "lucide-react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import type { PromptBlock } from "../../../src/core/types.ts";
import { slash, type SlashItem } from "../lib/extend.ts";
import { loadMcpPrompts } from "../lib/tools-ui.ts";
import { fromBlock, toAttachment, toBlock, type Attachment } from "../lib/images.ts";
import { boxRefused, ownFocus } from "../lib/asks.ts";
import { composing, fuzzy, isMac, keyLabel, QUEUE_KEYS, SEND_KEYS } from "../lib/keys.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { draftGone, draftHere, dropImage, fromServer, getDraft, isKeeping, keepImage, keeps, draftListed, textTaken, typing, type Draft } from "../lib/drafts.ts";
import { daemonAway, hasSavedImage, messageRefused, namedSends, savedImages, sendDrafts, setSendDraft, setSendImage, shelfKey, shown, unread, useSendDrafts, type SendDraft } from "../lib/send-drafts.ts";
import { sendWaitingSoon } from "../lib/resend.ts";
import { getState, onFeature, reportError, reportUnlessGone, useStore, failed, whileHeard } from "../lib/store.ts";
import { openFocus } from "../lib/self-focus.ts";
import { stopHeld } from "../lib/looks.ts";
import { setUI, useUI } from "../lib/ui.ts";
import { lineage } from "../../../src/core/tree.ts";
import { pastedFiles, shell, shellPaste } from "../lib/shell.ts";
import { cn, scrollMotion } from "../lib/utils.ts";
import { FallbackChip } from "./Fallback.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ContextMeter, EffortPicker, QueuePanel } from "./TurnControls.tsx";
import { SpeedPicker } from "./SpeedPicker.tsx";
import { LimitChip } from "./Limits.tsx";
import { SETTLE_MS } from "../lib/settle.ts";

// The box's tools draw again only when what they show changes, not with every render of the box (a
// turn that starts or ends, a key): a field drawn again is written again (React sets its name and
// type), and a list of panes that follow busy sessions changed many times a second for nothing.
const Pickers = {
  Model: memo(ModelPicker), Effort: memo(EffortPicker), Speed: memo(SpeedPicker), Fallback: memo(FallbackChip), Limit: memo(LimitChip), Meter: memo(ContextMeter),
};
const FileInput = memo(function FileInput({ at, take }: { at: { current: HTMLInputElement | null }; take: { current: (files: File[]) => void } }) {
  return <input ref={at} type="file" multiple hidden data-testid="attach-input" onChange={(e) => { take.current([...(e.target.files ?? [])]); e.target.value = ""; }} />;
});

type Menu =
  | { kind: "slash"; query: string; start: number }
  | { kind: "file"; query: string; start: number };

type Option = { key: string; label: ReactNode; detail?: string; disabled?: boolean; icon: ReactNode; apply: () => void };

const draftKey = (id?: string) => `keel.draft.${id ?? "new"}`;
// The key that queues a message for after the running turn, as this platform names it.
const queueKeys = keyLabel(QUEUE_KEYS).join(" ");
// Said once in a page's life, the first time Tab goes from a draft to the queue button.
let queueKeySaid = false;
// A desk-sized window: focus may go to the message box by itself there.
const DESK = matchMedia("(min-width: 768px)");
// A window lower than this many rem is short: the toolbar keeps to one row.
const SHORT_REM = 28;
// How full the context must be for a phone's resting box to show its ring.
const REST_RING = 0.8;
// A finger, not a pointer and keys: hints name what is tapped.
const TOUCH = matchMedia("(hover: none) and (pointer: coarse)");

function useSlashItems() {
  const [, force] = useState(0);
  useEffect(() => slash.subscribe(() => force((n) => n + 1)), []);
  return slash.all();
}

// Images of kept sends being read back from the session's draft after a reload.
const reading = new Set<string>();
// The queued prompt of each box that is on its way, by its shelf: the next one goes after it.
const outgoing = new Map<string, Promise<void>>();
const MAX_FILES = 20;
const heading = (d: SendDraft) => (d.state === "waiting" ? "Waiting for Keel" : d.state === "refused" ? (d.queue ? "Not queued" : "Not sent") : d.state === "unconfirmed" ? "Delivery unconfirmed" : "Saved draft");

const OFF_BRANCH = "You are reading another branch. Choose Reply from this branch to reply there, or Back to the current one.";

type ComposerProps = {
  // The session the box writes to (none: the start page). Only its id: the box is not drawn
  // again when the session's row changes.
  session?: { id: string };
  // `id` names the send: a session's route takes the same one once (see lib/resend.ts).
  onSend: (text: string, images: PromptBlock[], id?: string) => Promise<unknown> | void;
  // While a turn runs, Enter steers (the text joins the turn at its next model
  // call) and Ctrl Shift Enter (QUEUE_KEYS) or the queue button queues it for
  // after the turn. Tab queues nothing: with a draft it goes to the queue
  // button, so Tab then Enter queues.
  onQueue?: (text: string, images: PromptBlock[], id?: string) => Promise<unknown> | void;
  onStop?: () => void;
  // What Escape does when no menu is open (default: stop a working turn).
  onEscape?: () => void;
  // What Stop stops when that is not the turn of the session shown (an agent's own work):
  // the button then says it in words. A turn's Stop is the same mark in every pane.
  stopLabel?: string;
  working?: boolean;
  model: string;
  // A switch that asks first (the cache warning) returns its promise: until it
  // settles nothing is sent, so a message never leaves on the model being left.
  onModel: (id: string) => unknown;
  workspace?: string; // the folder @-mentions search
  // Why nothing can be sent now (the place picked for a new session does not
  // answer): Enter says it and the draft stays in the box.
  hold?: string;
  autoFocus?: boolean;
  // The station that has the keys (several message boxes can be on screen): only it answers Alt+M.
  focus?: boolean;
  // The session's cards above the box (its plan and jobs, held messages):
  // they scroll with the queue and the kept messages.
  above?: ReactNode;
  // What waits on the owner's answer (requests of the session and of its
  // agents): shown last, nearest the box, and kept in view.
  asks?: ReactNode;
};

export function Composer(props: ComposerProps) {
  return <SessionComposer key={draftKey(props.session?.id)} {...props} />;
}

const SessionComposer = memo(function SessionComposer({
  session, onSend, onQueue, onStop, onEscape, stopLabel, working, model, onModel, workspace, autoFocus, focus = true, hold, above, asks,
}: ComposerProps) {
  const sid = session?.id;
  const key = draftKey(sid);
  const shelf = shelfKey(sid);
  const saved = useSendDrafts(shelf);
  const [text, commitText] = useState(() => localStorage.getItem(key) ?? "");
  const [images, commitImages] = useState<Attachment[]>([]);
  // Resolve changes immediately so a late response reads the whole current
  // draft, including edits or attachments React has not painted yet.
  const draft = useRef({ text, images });
  const setText = (next: SetStateAction<string>) => commitText(draft.current.text = typeof next === "function" ? next(draft.current.text) : next);
  const setImages = (next: SetStateAction<Attachment[]>) => commitImages(draft.current.images = typeof next === "function" ? next(draft.current.images) : next);
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<{ path: string; dir: boolean }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The box takes the keyboard as its page or its session opens: once, and not from a control
  // the owner went to since (lib/self-focus.ts). It is drawn when its session and its chunks
  // are in, which may be long after; an autofocus attribute takes the keyboard whenever that is.
  const took = useRef(false);
  useLayoutEffect(() => {
    if (!autoFocus || took.current) return;
    took.current = true;
    openFocus(ref.current);
  }, []);
  const queueButton = useRef<HTMLButtonElement>(null);
  const enterSends = useUI((s) => s.enterSends);
  // Reading another branch from search: a reply would go to the session's own branch, so ask first.
  const previewEvent = useUI((s) => (session && s.preview?.session === session.id ? s.preview.event : null));
  // Read only while a version is previewed: the events change with every step of a turn.
  const sessionEvents = useStore((s) => (session && previewEvent ? s.events[session.id] : undefined));
  const head = useStore((s) => (session && previewEvent ? s.sessions[session.id]?.head ?? null : null));
  const offBranch = !!previewEvent && !!sessionEvents?.some((e) => e.id === previewEvent) && !lineage(sessionEvents!, head).some((e) => e.id === previewEvent);
  const modelSignal = useUI((s) => s.modelMenu);
  const [pickerSignal, setPickerSignal] = useState(0);
  const lastSignal = useRef(modelSignal);
  useEffect(() => {
    if (modelSignal !== lastSignal.current && focus) setPickerSignal((n) => n + 1);
    lastSignal.current = modelSignal;
  }, [modelSignal]);
  const seed = useUI((s) => (s.composerSeed && s.composerSeed.session === session?.id ? s.composerSeed : null)); // only this box's
  const connected = useStore((s) => s.connected);
  const synced = useStore((s) => s.synced);
  const slashItems = useSlashItems();
  const [switching, setSwitching] = useState(false);
  const pick = useRef(onModel);
  pick.current = onModel;
  // One function for the box's life: the model list is not drawn again at every key.
  const pickModel = useMemo(() => (id: string) => {
    const r = pick.current(id);
    if (!(r instanceof Promise)) return;
    setSwitching(true);
    r.finally(() => setSwitching(false));
  }, []);
  const info = useStore((s) => s.models.find((m) => m.id === model));

  // The session's server draft: images kept until sent, and whatever was put
  // in from outside (text is added to the box once, then emptied there).
  const have = useRef(new Set<string>()); // draft files already in the box
  // The server draft takes 20 images, and the kept sends' images are in it too.
  const held = () => (sid ? savedImages(shelf) : 0);
  const room = () => MAX_FILES - draft.current.images.length - held();
  const keep = (id: string, a: Attachment) => {
    have.current.add(a.id);
    void keepImage(id, a);
  };
  const drop = async (id: string, a: Attachment) => {
    if (!a.file) await dropImage(id, a.id);
  };
  useEffect(() => {
    if (!sid) return;
    let live = true;
    let tookAt = 0; // the write whose text is in the box already: a repeat of it adds nothing
    let ids = new Set<string>(); // the draft's files as last heard
    const take = async (d: Draft) => {
      if (!live) return;
      if (d.text && d.text_ms !== tookAt) {
        const add = d.text;
        tookAt = d.text_ms ?? 0;
        setText((cur) => (cur.trim() ? `${cur}${cur.endsWith("\n") ? "" : "\n"}${add}` : add));
        if (d.text_ms !== undefined) textTaken(sid, d.text_ms);
        setNotice(d.origin && d.origin !== "page" ? `Text added from ${d.origin}.` : "Text added from outside the page.");
      }
      ids = new Set(d.attachments.map((f) => f.id));
      const now = ids;
      draftListed(now);
      setImages((cur) => cur.filter((a) => a.file || now.has(a.id) || isKeeping(a.id)));
      for (const f of d.attachments) {
        if (have.current.has(f.id) || hasSavedImage(shelf, f.id)) continue;
        have.current.add(f.id);
        try {
          const a = await fromServer(sid, f);
          // Gone meanwhile, or dropped by a newer update while it loaded: not added.
          if (a && live && ids.has(a.id) && !hasSavedImage(shelf, a.id)) setImages((cur) => (cur.some((x) => x.id === a.id) ? cur : [...cur, a]));
        } catch (e) {
          have.current.delete(f.id);
          reportError(e, { at: "draft image" });
        }
      }
    };
    // A read answered after a keep of this page started or finished may be from before the keep
    // (a fork puts a picture in a new box as the box reads its draft): it is read again, so the
    // draft taken is one asked for with every keep known. A picture was lost from the box that way.
    const read = async (): Promise<void> => {
      const at = keeps();
      const d = await getDraft(sid);
      return live && keeps() !== at ? read() : take(d);
    };
    read().catch(reportError);
    const off = onFeature({
      frame: (f) => { if (f.name === "draft" && f.session_id === sid) take(f.data as Draft); },
      reconnect: () => { read().catch(reportUnlessGone); },
    });
    return () => { live = false; off(); have.current.clear(); };
  }, [sid]);

  // An image a kept send holds is that send's: it leaves this box. In the
  // page that sent it the box was emptied already; another tab on the session
  // learns of it here, when the shelf it shares takes the image, and would
  // else send it again with its own next message.
  useEffect(() => {
    if (draft.current.images.some((a) => hasSavedImage(shelf, a.id))) setImages((cur) => cur.filter((a) => !hasSavedImage(shelf, a.id)));
  }, [saved]);

  // After a reload the shelf knows its images by reference: read them from the
  // session's draft. One the draft no longer has is named on its item.
  // A read that failed (the daemon was away) is made again when the page
  // reconnects: until an image is read its item can be neither sent nor restored.
  const [reread, setReread] = useState(0);
  useEffect(() => onFeature({ reconnect: () => setReread((n) => n + 1) }), []);
  useEffect(() => {
    if (!sid) return;
    for (const d of saved) for (const a of d.images) {
      if (!unread(a) || reading.has(a.id)) continue;
      reading.add(a.id);
      fromServer(sid, { id: a.id, name: a.name, mime: a.media_type, bytes: a.bytes, origin: null, added_ms: 0 })
        .then((got) => setSendImage(shelf, d.id, a.id, got))
        .catch((e) => reportError(e, { at: "kept image" }))
        .finally(() => reading.delete(a.id));
    }
  }, [saved, sid, reread]);
  // One live region, mounted before any item: it says each kept item once.
  const told = useRef(new Set<string>());
  const [said, setSaid] = useState("");
  useEffect(() => {
    const fresh = saved.filter((d) => shown(d) && !told.current.has(`${d.id} ${d.state}`));
    for (const d of fresh) told.current.add(`${d.id} ${d.state}`);
    const d = fresh.at(-1);
    if (d) setSaid([`${heading(d)}: ${d.text.trim() || "attachments only"}`, d.state !== "parked" && d.error].filter(Boolean).join(". "));
  }, [saved]);

  useEffect(() => {
    if (text && session?.id) typing(session.id);
    if (text) localStorage.setItem(draftKey(session?.id), text);
    else localStorage.removeItem(draftKey(session?.id));
  }, [text, session?.id]);
  const unsent = !!text.trim() || images.length > 0;
  const hasUnsent = unsent || saved.some((d) => d.state === "refused" || d.state === "parked" || d.state === "waiting");
  useEffect(() => (sid ? draftHere(sid, hasUnsent) : undefined), [hasUnsent, sid]);
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    const gone = () => draftGone(sid);
    addEventListener("pagehide", gone);
    return () => { removeEventListener("pagehide", gone); gone(); };
  }, [session?.id]);
  useEffect(() => {
    if (!seed) return;
    setUI({ composerSeed: null }); // consumed: another message box mounted later must not take it
    setText((cur) => (seed.append && cur.trim() ? `${cur}${cur.endsWith("\n") ? "" : "\n"}${seed.text}` : seed.text));
    if (seed.notice) setNotice(seed.notice);
    if (seed.blocks?.length) {
      // Attachments in their order: a picture is kept in the server draft like a pasted one.
      const add = seed.blocks.map(fromBlock).slice(0, Math.max(0, room()));
      setImages((cur) => [...cur, ...add]);
      if (sid) for (const a of add) if (!a.file) keep(sid, a);
    }
    // (What the owner asked to have put in the box: the keyboard goes with it as theirs.)
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { ownFocus(el, true); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }, [seed]);

  // The box grows with its text up to two fifths of the window, measured again
  // when the window or the text size changes; the pane's height can still
  // shrink it (see Tray).
  const scale = useUI((s) => s.scale);
  // A window few lines high (small, or large text): the tools take one row.
  // A phone's box keeps its tools to one row too: the conversation has the screen.
  const low = () => innerHeight < SHORT_REM * parseFloat(getComputedStyle(document.documentElement).fontSize) || !DESK.matches;
  const [short, setShort] = useState(low);
  // On a phone, in a conversation, the box rests as one line: its tools show
  // once it is tapped (or holds a draft, a file, a note to read, a running
  // turn's Stop) and go when the next tap lands outside it. A tap in a menu
  // the box opened (the model list) is inside.
  const boxEl = useRef<HTMLDivElement>(null);
  const [tapped, setTapped] = useState(false);
  const [narrow, setNarrow] = useState(!DESK.matches);
  useEffect(() => {
    const on = () => setNarrow(!DESK.matches);
    DESK.addEventListener("change", on);
    return () => DESK.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!tapped) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      // A tap beside a menu the box opened (the model list's sheet) closes that menu: it is not a
      // tap away from the box. The tools stay, with the control the menu hangs from.
      if (boxEl.current?.querySelector('[aria-expanded="true"]')) return;
      if (t && !boxEl.current?.contains(t) && !t.closest?.('[role="listbox"], [role="menu"], [role="dialog"], [data-base-ui-portal]')) setTapped(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [tapped]);
  // What the box shows of a turn that runs (its hint, Stop, Queue): at once for a turn sent from this box,
  // and for one that started elsewhere (a report, a loop, another device) once it has run SETTLE_MS, as the
  // list shows it: a turn of a second came and went with the box's tools moving twice. What a key does
  // (Enter steers, Esc stops) follows the turn itself.
  const sentHere = useRef(0);
  const [runShown, setRunShown] = useState(!!working);
  useEffect(() => {
    if (!working) return setRunShown(false);
    if (Date.now() - sentHere.current < 5000) return setRunShown(true);
    const t = setTimeout(() => setRunShown(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [working]);
  const busy = !!working && runShown;
  // (Whether the box rests follows the turn itself: it changes the box's height, which a turn that has begun to stream must not see change.)
  const rest = narrow && !!session && !tapped && !text && !images.length && !working && !notice && synced;
  // Whether the window is low changes with the window and the text size, never with what is
  // typed: it is not asked at every key (the question makes the browser style the whole page
  // on the spot, a reply that streams above included).
  const lowAt = useRef<number | null>(null);
  // What the box's least heights were measured for: a key that leaves it so (most keys: the
  // draft keeps its lines) measures the text alone, and the page is laid out once less.
  const shapeAt = useRef({ key: "", least: "" });
  const fit = (resized = false) => {
    if (resized || lowAt.current !== scale) { lowAt.current = scale; setShort(low()); }
    const el = ref.current;
    if (!el) return;
    const box = el.parentElement!;
    // The text is measured with the box held at the height it has: measured in a box left
    // free, a draft of several lines is one row high for that moment, the conversation
    // above takes the room, the browser moves its scroll up to fit, and it stays there
    // (a reply that streams then brings it back down, at every key).
    const width = el.clientWidth;
    box.style.height = `${box.getBoundingClientRect().height}px`;
    box.style.flex = "none";
    el.style.minHeight = "";
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, Math.round(innerHeight * 0.4));
    el.style.height = `${h}px`;
    const shape = `${resized}|${h}|${width}|${innerHeight}|${!!el.value}|${scale}|${short}|${images.length}|${notice}|${synced}|${info?.id}|${working}|${rest}`;
    if (!resized && shape === shapeAt.current.key) {
      el.style.minHeight = shapeAt.current.least;
      box.style.height = box.style.flex = "";
      return;
    }
    // What the pane's height cannot take from it: two lines of a draft that has them (one
    // of an empty box, whose hint may wrap), and from the box: those lines with what is
    // above and under them (the attachments, the tools), so the tools never leave the box.
    const cs = getComputedStyle(el);
    const least = Math.min(h, Math.ceil((el.value ? 2 : 1) * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)));
    el.style.minHeight = `${least}px`;
    shapeAt.current = { key: shape, least: `${least}px` };
    box.style.height = box.style.flex = "";
    // In parts of a pixel, as they are laid out: whole pixels add up to more than the box is
    // high at a text size that makes its rows fractional, and the box would grow by the rest.
    let under = 0;
    // (What lies over the box, like the resting box's tools button, takes no room under the text.)
    for (let x = el.nextElementSibling as HTMLElement | null; x; x = x.nextElementSibling as HTMLElement | null) if (getComputedStyle(x).position !== "absolute") under += x.getBoundingClientRect().height;
    const above = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.style.minHeight = `${above + least + under + parseFloat(getComputedStyle(box).borderBottomWidth)}px`;
  };
  const fitNow = useRef(fit);
  fitNow.current = fit;
  // Measured again only when what it measures changed: a turn that starts or ends changes the hint,
  // and a hint of the same length in a box of the same width is the same height (each measure writes the box's styles).
  const fitSig = useRef("");
  useEffect(() => {
    const el = ref.current;
    const sig = el ? `${el.value}|${el.placeholder}|${el.clientWidth}|${scale}|${short}|${images.length}|${notice}|${synced}|${rest}|${info?.id ?? ""}` : "";
    if (!el || sig !== fitSig.current) { fitSig.current = sig; fit(); }
    const resized = () => fit(true);
    addEventListener("resize", resized);
    return () => removeEventListener("resize", resized);
  }, [text, scale, short, images.length, notice, synced, info, busy, rest]);
  // A pane made wider or narrower (its divider, the list, a side panel) wraps the draft and
  // the tools anew with no resize of the window: measured again then, a frame later (a size
  // written inside the observer's own call would loop it), not at the next key.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0, width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitNow.current());
    });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!session?.id) return;
    const onRefusal = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== session.id) return;
      e.preventDefault();
      setNotice("Restore this session before working in it again.");
    };
    addEventListener("keel:archived-refusal", onRefusal);
    return () => removeEventListener("keel:archived-refusal", onRefusal);
  }, [session?.id]);

  // Files dropped or pasted anywhere on the page land here.
  const takeFiles = useRef((list: File[]) => {});
  takeFiles.current = (list: File[]) => void addFiles(list);
  const addFiles = async (list: File[]) => {
    for (const f of list) {
      try {
        const a = await toAttachment(f);
        if (!mounted.current) continue;
        if (room() <= 0) {
          setNotice(held() ? `Not attached: the draft takes ${MAX_FILES} images, counting the kept messages above. Send or discard one first.` : `Not attached: a message takes at most ${MAX_FILES} files.`);
          continue;
        }
        setImages((cur) => [...cur, a]);
        if (sid && !a.file) keep(sid, a);
      } catch (e) {
        setNotice(String((e as Error).message));
        reportError(e, { kind: "attach" });
      }
    }
  };
  useEffect(() => {
    const on = (e: Event) => addFiles((e as CustomEvent<File[]>).detail);
    addEventListener("keel:files", on);
    return () => removeEventListener("keel:files", on);
  });

  // The menu under the caret: "/" at the start, "@" after a space. One closed
  // with Escape stays closed while the caret is in the same word.
  const closed = useRef<string | null>(null);
  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const sm = before.match(/^\/([\w:.-]*)$/);
    const fm = sm ? null : before.match(/(^|\s)@([^\s@]*)$/);
    const next: Menu | null = sm ? { kind: "slash", query: sm[1]!, start: 0 } : fm && workspace ? { kind: "file", query: fm[2]!, start: caret - fm[2]!.length - 1 } : null;
    if (!next || closed.current !== `${next.kind} ${next.start}`) closed.current = null;
    if (!next || closed.current) return setMenu(null);
    if (next.kind === "slash") loadMcpPrompts();
    setMenu(next);
  };

  useEffect(() => {
    if (menu?.kind !== "file" || !workspace) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/fs/files?path=${encodeURIComponent(workspace)}&q=${encodeURIComponent(menu.query)}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((r) => setFiles(r.hits ?? []))
        .catch((e) => e.name !== "AbortError" && reportError(e, { kind: "file-search" }));
    }, 60);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [menu?.kind, menu?.query, workspace]);

  // The session as it is when a command asks, not as it was when the box was drawn.
  const ctx = { get session() { return sid ? getState().sessions[sid] : undefined; }, setText };
  const runSlash = async (item: SlashItem, arg: string) => {
    if (!item.run) return setNotice(`/${item.id} is not available yet.`);
    // A command that prompts the model is held like a typed message while another branch is read.
    if (item.sends && offBranch) { setMenu(null); return setNotice(OFF_BRANCH); }
    setNotice(null);
    setText("");
    setMenu(null);
    try { await item.run(arg, ctx); } catch (e) {
      // Nothing ran: the command as typed comes back, unless something new was typed.
      setText((cur) => cur || `/${item.id}${arg ? ` ${arg}` : ""}`);
      setNotice(String((e as Error).message));
      if (!(e as { usage?: boolean }).usage) reportError(e, { kind: "slash", id: item.id }); // a mistyped argument is not a failure
    }
  };

  // While the command menu is open, what it offers follows the session as it changes.
  const listed = useStore((s) => (sid && menu?.kind === "slash" ? s.sessions[sid] : undefined));
  const options = useMemo<Option[]>(() => {
    if (!menu) return [];
    if (menu.kind === "slash") {
      return slashItems
        .filter((i) => !i.when || i.when(ctx))
        .map((i) => ({ i, s: fuzzy(menu.query, i.id + " " + i.label) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => Number(!!b.i.run) - Number(!!a.i.run) || b.s - a.s)
        .map(({ i }) => ({
          key: i.id,
          icon: <Slash className="size-3.5" />,
          label: (
            <>
              <span className="font-medium text-fg">/{i.id}</span>
              {i.hint && <span className="ml-1.5 text-faint">{i.hint}</span>}
            </>
          ),
          detail: i.run ? i.label : "not available yet",
          disabled: !i.run,
          apply: () => {
            if (!i.run) return setNotice(`/${i.id} is not available yet.`);
            // A command whose argument is optional ("[...]") runs when typed in full; otherwise the argument is asked for.
            if (i.hint && !(i.hint.startsWith("[") && menu.query === i.id)) { setText(`/${i.id} `); setMenu(null); ref.current?.focus(); }
            else runSlash(i, "");
          },
        }));
    }
    return files.map((f) => ({
      key: f.path,
      icon: f.dir ? <Folder className="size-3.5" /> : <FileIcon className="size-3.5" />,
      label: <span className="font-mono text-caption text-fg">{f.path}</span>,
      apply: () => {
        const el = ref.current!;
        const caret = el.selectionStart;
        const insert = `@${f.path}${f.dir ? "" : " "}`;
        const next = text.slice(0, menu.start) + insert + text.slice(caret);
        setText(next);
        const pos = menu.start + insert.length;
        requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); detect(next, pos); });
        if (!f.dir) setMenu(null);
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, slashItems, files, text, listed]);

  useEffect(() => setSel(0), [menu?.kind, menu?.query]);
  // The list and its options have ids: the box, which keeps the focus, names
  // the list it controls and the option the arrows are on.
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;
  const popup = useRef<HTMLDivElement>(null);
  // The option the arrows are on stays in the popup's view (its own scroll only).
  useLayoutEffect(() => {
    const box = popup.current;
    const el = box && document.getElementById(optionId(sel));
    if (!box || !el) return;
    const r = el.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (r.top < view.top) box.scrollTop -= sel === 0 ? box.scrollTop : view.top - r.top;
    else if (r.bottom > view.bottom) box.scrollTop += sel === options.length - 1 ? box.scrollHeight : r.bottom - view.bottom;
  }, [sel, menu?.kind, menu?.query, options.length]);

  const named = namedSends(shelf);
  const blocked = (attachments: Attachment[]) => {
    if (offBranch) return OFF_BRANCH;
    // A message this page cannot send again by itself (a new session, a session of another machine) is not sent into a link that is down.
    if (!named && !getState().connected) return "Not sent: Keel is not reachable. Send it again when it is back.";
    if (switching) return "The model switch is not confirmed yet: nothing was sent.";
    if (hold) return hold;
    // A new screenshot for a model that says it reads none: nothing starts until
    // the owner switches model or removes the image to send the text alone.
    // Images already in the history are not this check's (the turn notes them).
    if (info?.images === false && attachments.some((a) => !a.file)) return "Not sent: switch model, or remove the screenshot to send the text alone.";
    return null;
  };

  const attempt = async (entry: SendDraft, fromBox: boolean) => {
    const { id, text, images, queue } = entry;
    // Keel is not heard: the message waits on its shelf at once and goes out by itself, once, when
    // it is back. (Sent into a link that says nothing, it was nowhere on the page until the link answered.)
    if (named && !getState().connected) {
      setSendDraft(shelf, id, { ...entry, state: "waiting", error: undefined });
      return sendWaitingSoon();
    }
    // Lock this snapshot before awaiting anything, including a rapid click
    // on Retry before React has disabled its button.
    setSendDraft(shelf, id, { ...entry, state: "sending" });
    try {
      // A named send whose request is out when Keel stops being heard is not waited for (a request
      // into a link that says nothing may hang as long as the link does): it waits on its shelf
      // like one sent after, and goes out again under its id, which Keel takes once.
      if (queue && onQueue) {
        // Queued prompts go one at a time, in the order they were queued: three queued in quick
        // succession are three requests, and the daemon keeps the order they arrive in, which is
        // not the order they were sent in once one of them waits for a connection.
        const before = outgoing.get(shelf);
        const go = () => onQueue(text.trim(), images.map(toBlock), id);
        const mine = before ? before.then(go) : Promise.resolve(go());
        const settled = mine.then(() => {}, () => {});
        outgoing.set(shelf, settled);
        void settled.then(() => { if (outgoing.get(shelf) === settled) outgoing.delete(shelf); });
        await (named ? whileHeard(mine) : mine);
      } else {
        const out = onSend(text.trim(), images.map(toBlock), id);
        await (named ? whileHeard(Promise.resolve(out)) : out);
      }
    } catch (e) {
      // The daemon was away or restarting: the message waits on its shelf and
      // goes out by itself, once, when the daemon is back.
      if (named && daemonAway(e)) {
        setSendDraft(shelf, id, { ...entry, state: "waiting", error: undefined });
        return sendWaitingSoon();
      }
      // The New box sends through a create: its refusal is as certain as a message's.
      const refused = messageRefused(e, sid);
      const words = failed(e, { at: "send", ...(sid && { session_id: sid }) });
      // A request the network dropped has no words of the daemon's to show.
      const error = e instanceof TypeError ? "The daemon's answer did not arrive." : words;
      if (refused && fromBox && mounted.current && !draft.current.text.trim() && !draft.current.images.length) {
        // Preserve the old quick repair when the entire box is still empty.
        // Never restore just one part or restore after unconfirmed delivery.
        setText(text);
        setImages(images);
        setNotice(error);
        setSendDraft(shelf, id);
      } else {
        setSendDraft(shelf, id, { ...entry, state: refused ? "refused" : "unconfirmed", error });
      }
      return;
    }
    // Both a sent message and an accepted queue entry count as success. The
    // stored copy goes now; these images stay out of draft broadcasts until
    // their individual deletes land.
    setSendDraft(shelf, id, { ...entry, state: "done" });
    if (sid) await Promise.all(images.map((a) => drop(sid, a)));
    setSendDraft(shelf, id);
  };

  const submit = (queue = false) => {
    sentHere.current = Date.now();
    const { text, images } = draft.current;
    const t = text.trim();
    if (!t && !images.length) return;
    const cmd = t.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
    if (cmd && !images.length) {
      const item = slashItems.find((i) => i.id === cmd[1]);
      if (item) return runSlash(item, (cmd[2] ?? "").trim());
    }
    const why = blocked(images);
    if (why) return setNotice(why);
    setText("");
    setImages([]);
    setMenu(null);
    setNotice(null);
    ref.current?.focus();
    void attempt({ id: crypto.randomUUID(), text, images, queue, state: "sending" }, true);
  };

  const retry = (id: string) => {
    const entry = sendDrafts(shelf).find((d) => d.id === id);
    // A named send may go again whatever became of the first try: the daemon takes it once.
    if (!entry || !(entry.state === "refused" || (named && entry.state === "unconfirmed")) || entry.images.some(unread)) return;
    const why = blocked(entry.images);
    if (why) return setNotice(why);
    ref.current?.focus();
    void attempt(entry, false);
  };

  const restore = (id: string) => {
    const entry = sendDrafts(shelf).find((d) => d.id === id);
    if (!entry || !shown(entry) || entry.images.some(unread)) return;
    const { text, images } = draft.current;
    if (text.trim() || images.length) {
      const swap = { id: crypto.randomUUID(), text, images, queue: false, state: "parked" } as const;
      setSendDraft(shelf, swap.id, swap);
    }
    setText(entry.text);
    setImages(entry.images);
    setMenu(null);
    setNotice(entry.state === "unconfirmed" ? (sid ? "Check the conversation before sending this draft again." : "Check the session list before sending this draft again.") : null);
    setSendDraft(shelf, id);
    ref.current?.focus();
  };

  const discard = async (id: string) => {
    const entry = sendDrafts(shelf).find((d) => d.id === id);
    if (!entry || !shown(entry)) return;
    setSendDraft(shelf, id, { ...entry, state: "done" });
    if (sid) await Promise.all(entry.images.map((a) => drop(sid, a)));
    setSendDraft(shelf, id);
    ref.current?.focus();
  };

  const open = menu && options.length > 0;
  const canSend = !!text.trim() || images.length > 0;
  // What the box says about itself: among the tools, or on a line of its own
  // above a one-row toolbar. Cut where the room ends, whole in its tip.
  const status = notice
    ? <span className={cn("min-w-0 truncate text-caption text-warn animate-in", short ? "block shrink-0 px-4 pb-1" : "ml-1")} title={notice} role="status" data-testid="composer-notice">{notice}</span>
    : !synced ? <span className={cn("truncate text-caption text-faint", short ? "block shrink-0 px-4 pb-1" : "ml-1")} role="status" data-testid="sync-state">{connected ? "Catching up" : "Reconnecting"}</span> : null;

  return (
    <>
    <Tray asks={asks}>
      {above}
      {sid && <QueuePanel sessionId={sid} />}
      {saved.some(shown) && (
        <div className="mb-2 flex flex-col gap-1.5" data-testid="saved-drafts">
          {saved.filter(shown).map((d) => {
            const waiting = d.images.some(unread);
            return (
              <div key={d.id} role="group" aria-label={`${heading(d)}: ${d.text.trim().slice(0, 80) || "attachments only"}`} data-testid="saved-draft" data-state={d.state} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line bg-raised px-3 py-2 text-caption shadow-1">
                <div className="min-w-0 flex-1 basis-48">
                  <p className={d.state === "parked" ? "font-medium text-muted" : "font-medium text-fg"}>{d.state !== "parked" && <span aria-hidden className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", d.state === "waiting" ? "bg-brass animate-pulse-dot" : "bg-warn")} />}{heading(d)}</p>
                  <p className="truncate text-fg" title={d.text}>{d.text.trim() || "Attachments only"}</p>
                  {!!d.images.length && <p className="truncate text-muted" title={d.images.map((a) => a.name).join(", ")}>{d.images.map((a) => a.name).join(", ")}</p>}
                  {!!d.lost?.length && <p className="break-words text-warn" data-testid="saved-lost">Not kept across the reload: {d.lost.join(", ")}</p>}
                  {d.state !== "parked" && d.error && <p className="break-words text-muted" data-testid="saved-reason">{d.error}</p>}
                  {d.state === "waiting" && <p className="text-muted" data-testid="saved-waiting">{connected ? "Keel takes no new work right now. This goes out by itself, once, when it does." : "Keel is not reachable. This goes out by itself, once, when it is back."}</p>}
                  {d.state === "unconfirmed" && <p className="text-muted">{named ? "It may have arrived. Sending it again is safe: Keel takes it once." : sid ? "It may have arrived. Check before sending again." : "The session may have been made. Check the list before sending again."}</p>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {(d.state === "refused" || (named && d.state === "unconfirmed")) && <button type="button" disabled={waiting} className={cn(draftButton, "bg-accent text-accent-fg hover:bg-accent-hover")} onClick={() => retry(d.id)}>{d.queue ? "Retry queue" : "Retry send"}</button>}
                  <button type="button" disabled={waiting} className={cn(draftButton, "border border-line text-fg hover:bg-hover")} title="Move this into the box without sending. The current draft is kept." onClick={() => restore(d.id)}>Restore draft</button>
                  <button type="button" className={cn(draftButton, "text-muted hover:bg-hover hover:text-fg")} onClick={() => void discard(d.id)}>Discard</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Tray>
    <div
      className={cn(
        "k-composer-box k-box relative flex min-h-0 flex-col rounded-xl border bg-raised shadow-2 transition-[border-color,box-shadow] duration-150",
        "border-line-strong/70 focus-within:border-line-strong focus-within:shadow-[var(--shadow-2),0_0_0_3px_var(--accent-soft)]",
        dragging && "border-accent shadow-[var(--shadow-2),0_0_0_3px_var(--accent-soft)]",
      )}
      data-testid="composer-box"
      data-rest={rest || undefined}
      ref={boxEl}
      onFocus={() => setTapped(true)}
      // A tap in a box that kept the focus while it went to rest (a scroll drag outside) brings no
      // focus event. The tools open once the tap is over, on its click: opened when the finger
      // goes down, they would move under it and take the tap.
      onClick={() => setTapped(true)}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {open && (
        <div
          ref={popup}
          data-testid={menu.kind === "slash" ? "slash-menu" : "mention-menu"}
          className="absolute inset-x-0 bottom-[calc(100%+8px)] z-30 max-h-72 overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-3 animate-pop"
        >
          <div id={`${listId}-name`} className="px-2 pb-1 pt-1.5 k-label">{menu.kind === "slash" ? "Commands" : `Files in ${workspace?.split("/").pop()}`}</div>
          <div role="listbox" id={listId} aria-labelledby={`${listId}-name`}>
            {options.map((o, i) => (
              <div
                key={o.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === sel}
                aria-disabled={o.disabled}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => { e.preventDefault(); o.apply(); }}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2 text-ui",
                  i === sel && "bg-hover",
                  o.disabled && "opacity-55",
                )}
              >
                <span className="text-faint">{o.icon}</span>
                <span className="min-w-0 truncate">{o.label}</span>
                {o.detail && <span className="ml-auto shrink-0 truncate pl-3 text-caption text-faint">{o.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <p role="status" className="sr-only" data-testid="saved-status">{said}</p>
      {images.length > 0 && (
        <div className="flex max-h-[9.25rem] shrink-0 flex-wrap gap-2 overflow-y-auto px-3 pt-3" data-testid="attachments">
          {images.map((a) => (
            <div key={a.id} className="group/att relative size-16 overflow-hidden rounded-md border border-line bg-sunken animate-pop" title={`${a.name}, ${Math.round(a.bytes / 1024)} KB`}>
              {a.file ? (
                <div className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center" data-testid="attached-file">
                  <FileText className="size-5 text-muted" />
                  <span className="w-full truncate text-micro text-muted">{a.name}</span>
                </div>
              ) : <img src={a.url} alt={a.name} className="size-full object-cover" />}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => {
                  setImages((cur) => cur.filter((x) => x.id !== a.id));
                  if (sid) void drop(sid, a);
                }}
                className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-fg/75 text-bg opacity-0 transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
              >
                <X className="size-3" strokeWidth={2.5} />
              </button>
            </div>
          ))}
        </div>
      )}
      {info?.tools === false && (
        <div className="px-4 pt-1.5 text-caption text-warn" data-testid="model-no-tools" role="status">
          {info.name} cannot use tools{info.known_from?.tools ? ` (${TOOLS_FROM[info.known_from.tools]})` : ""}: it answers in text only, without reading files or running commands.
        </div>
      )}
      {images.length > 0 && info && <Capability name={info.name} images={info.images} pdf={info.pdf} shots={images.some((a) => !a.file)} pdfs={images.some((a) => a.file?.media_type === "application/pdf")} />}

      <textarea
        ref={ref}
        data-testid="composer"
        rows={1}
        value={text}
        aria-label="Message"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[sel] ? optionId(sel) : undefined}
        placeholder={busy ? (TOUCH.matches ? (onQueue ? "Send steers, the list button queues" : "Send steers the running turn") : `Enter steers, ${queueKeys} queues`) : rest ? "Reply" : session ? "Reply, / for commands, @ for files" : "Describe the task, / for commands, @ for files"}
        onChange={(e) => { setText(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onSelect={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMenu(null), 100)}
        onPaste={(e) => {
          const fs = [...e.clipboardData.files];
          if (fs.length) { e.preventDefault(); addFiles(fs); return; }
          // In the desktop app the engine hands a paste nothing at all for a copied picture.
          // There, on the owner's own paste, the app reads the clipboard and hands the picture
          // over (lib/shell.ts). A browser tab asks no clipboard for anything.
          if (shell && !e.clipboardData.types.length && e.nativeEvent.isTrusted) {
            shellPaste().then((got) => { const files = pastedFiles(got?.images ?? []); if (files.length) addFiles(files); }).catch(() => {});
          }
        }}
        onKeyDown={(e) => {
          if (composing(e)) return;
          if (open) {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % options.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + options.length) % options.length); return; }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); options[sel]?.apply(); return; }
            if (e.key === "Escape") { e.preventDefault(); closed.current = `${menu.kind} ${menu.start}`; setMenu(null); return; }
          }
          const mod = e.metaKey || e.ctrlKey;
          // An empty box has no caret to move: End, Page Up and Page Down are the
          // conversation's there, as they are when nothing holds the keyboard.
          if (sid && !e.currentTarget.value && !mod && !e.altKey && !e.shiftKey && (e.key === "End" || e.key === "PageUp" || e.key === "PageDown")) {
            e.preventDefault();
            const view = e.currentTarget.closest(".k-session")?.querySelector<HTMLElement>(".k-reading");
            if (e.key === "End") dispatchEvent(new CustomEvent("keel:end", { detail: sid }));
            // A held key pages at once: a glide started again at each repeat would crawl.
            else view?.scrollBy({ top: (e.key === "PageUp" ? -0.9 : 0.9) * view.clientHeight, behavior: e.repeat ? "instant" : scrollMotion() });
            return;
          }
          // Ctrl Shift Enter queues for after the running turn, whichever key sends; with no
          // turn running it sends (the turn may have ended a moment before the press).
          const queues = e.key === "Enter" && mod && e.shiftKey && !e.altKey;
          // Alt Enter is the pane's (focus it, or show all): not a send.
          if (queues || (e.key === "Enter" && !e.altKey && ((enterSends && !e.shiftKey && !mod) || (!enterSends && mod)))) {
            e.preventDefault();
            // A held Enter sends nothing: it may have gone down somewhere else (on an answer that was
            // given, and the keyboard came here). And Enter sends nothing from a box that code moved
            // the keyboard to from a card within the settle time, until the owner typed in it or
            // pressed it (lib/asks.ts): a second Enter after an answer does not send what this box holds.
            if (e.repeat) return;
            const no = canSend ? boxRefused(e.currentTarget) : "";
            if (no) return setNotice(no);
            submit(queues && !!working && !!onQueue);
          }
          // Tab with a draft while a turn runs goes to the queue button (Enter there queues),
          // and the key that queues from the box is said, once.
          if (e.key === "Tab" && !e.shiftKey && !mod && !e.altKey && busy && onQueue && canSend && queueButton.current) {
            e.preventDefault();
            queueButton.current.focus();
            if (!queueKeySaid) { queueKeySaid = true; setNotice(`${queueKeys} queues`); }
          }
          // (Escape right after the pane was uncovered, a look or the start page left, stops nothing: lib/looks.ts.)
          if (e.key === "Escape" && (onEscape || working)) { e.preventDefault(); if (onEscape) onEscape(); else if (!session || !stopHeld(session.id)) onStop?.(); }
        }}
        className={cn("block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 text-read leading-relaxed outline-none placeholder:text-faint", rest ? "pb-3 pr-12" : "pb-1.5")}
      />
      {/* At rest a context that is nearly full still shows its ring: it is the one tool that warns. */}
      {rest && sid && <span className="absolute right-11 top-1/2 -translate-y-1/2" data-testid="rest-meter"><ContextMeter sessionId={sid} above={REST_RING} /></span>}
      {/* At rest the tools are one tap away without raising the keyboard. */}
      {rest && (
        <button type="button" data-testid="composer-open" aria-label="Show the model and tools" onClick={() => setTapped(true)}
          className="absolute right-1.5 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
          <SlidersHorizontal className="size-4" />
        </button>
      )}
      {/* The tools wrap onto more rows in a narrow box. In a short window they keep one row: the ones on the left scroll sideways, Send and Stop stay. */}
      {short && status}
      <div className={cn("k-compose-tools flex shrink-0 items-center gap-x-0.5 gap-y-1 px-2 pb-2", !short && "flex-wrap", rest && "hidden")} data-short={short || undefined} data-busy={(narrow && busy) || undefined} data-talk={session ? "" : undefined} data-testid="composer-tools">
        <div className={short ? "-my-1 flex min-w-0 flex-1 items-center gap-x-0.5 overflow-x-auto py-1 pr-4 [mask-image:linear-gradient(to_left,transparent,#000_1rem)] [scrollbar-width:none]" : "contents"}>
          <span className={cn("k-compose-lead flex items-center gap-x-0.5", short ? "shrink-0" : "min-w-0 max-w-full [&>[data-testid=model-picker]]:min-w-0")}>
            <button
              type="button"
              title="Attach images or files (or paste, or drop them here)"
              aria-label="Attach images or files"
              data-testid="attach"
              onClick={() => fileInput.current?.click()}
              className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"
            >
              <Paperclip className="size-4" />
            </button>
            <FileInput at={fileInput} take={takeFiles} />
            <Pickers.Model value={model} onChange={pickModel} openSignal={pickerSignal} machine={sid ? splitId(sid)?.machine : undefined} />
          </span>
          {sid && <Pickers.Effort sessionId={sid} />}
          {sid && <Pickers.Speed sessionId={sid} />}
          {sid && <Pickers.Fallback sessionId={sid} />}
          {model && <Pickers.Limit model={model} />}
          {short && !narrow && sid && <Pickers.Meter sessionId={sid} />}
          {!short && status}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* On a phone the ring stands with Send, out of what scrolls. */}
          {(!short || narrow) && sid && <Pickers.Meter sessionId={sid} />}
          {busy && onQueue && (
            <button
              ref={queueButton}
              type="button"
              data-testid="queue-button"
              onClick={() => submit(true)}
              disabled={!canSend}
              title={`Queue for after this turn (${queueKeys})`}
              aria-label="Queue for after this turn"
              aria-keyshortcuts={isMac ? "Meta+Shift+Enter" : "Control+Shift+Enter"}
              className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-40"
            >
              <ListPlus className="size-4" />
            </button>
          )}
          {busy && (
            <button
              type="button"
              data-testid="stop"
              // The button goes away with the turn: the focus goes to the box, not to nowhere
              // (not on a phone, where that would raise the keyboard).
              onClick={() => { onStop?.(); if (DESK.matches) ref.current?.focus(); }}
              title={onEscape ? stopLabel ?? "Stop the turn" : `${stopLabel ?? "Stop the turn"} (Esc)`}
              aria-label={stopLabel ?? "Stop the turn"}
              className={cn("grid h-8 place-items-center rounded-full border border-line-strong text-fg hover:bg-hover", stopLabel ? "flex gap-1.5 px-3 text-caption font-medium" : "size-8")}
            >
              <Square className="size-3 fill-current" />
              {stopLabel && <span>{stopLabel}</span>}
            </button>
          )}
          <button
            type="button"
            data-testid="send"
            onClick={() => submit()}
            disabled={!canSend}
            title={busy ? "Steer into the running turn" : `Send (${keyLabel(SEND_KEYS(enterSends).send).join(" ")})`}
            aria-label="Send"
            className={cn(
              "k-send grid size-8 place-items-center rounded-full bg-accent text-accent-fg transition-[background-color,opacity,transform] duration-150",
              "hover:bg-accent-hover active:scale-95 disabled:bg-line-strong disabled:text-raised disabled:opacity-70",
            )}
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
    </>
  );
});

// The cards of the region above the box, by their test ids, at any depth.
const CARDS = ["approval", "question", "plan-card", "secret-request", "trust-card", "blocked", "held-message", "saved-draft", "queue-item", "dock-job", "live-source"].map((t) => `[data-testid="${t}"]`).join(",");

// What waits above the box: the session's cards, the queue, the messages kept
// after a send that did not go, and last, nearest the box, what waits on the
// owner's answer (`asks`). The pane's height is one budget: the box under this
// keeps its place with its buttons, and this region takes what is left and
// scrolls. It rests at its end, or, when what waits on the owner does not fit
// whole, at the oldest of those, until it is scrolled. A card that arrives out
// of view is brought into it, and whatever holds the focus here is in view:
// Enter never answers a card that is not shown.
function Tray({ children, asks }: { children: ReactNode; asks?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const wait = useRef<HTMLDivElement>(null);
  const gauge = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pad = () => parseFloat(getComputedStyle(ref.current!).paddingTop);
  const home = () => {
    const el = ref.current!;
    const w = wait.current!;
    const end = el.scrollHeight - el.clientHeight;
    return w.offsetHeight ? Math.max(0, Math.min(end, w.offsetTop - pad())) : end;
  };
  const mark = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = Math.abs(el.scrollTop - home()) < 4;
    // Where cards are scrolled out of view, that edge fades (styles.css).
    el.dataset.more = [el.scrollTop > 1 && "up", el.scrollHeight - el.scrollTop - el.clientHeight > 1 && "down"].filter(Boolean).join(" ");
  };
  // Into the region's view: whole when it fits, else from its top.
  const show = (t: Element) => {
    const el = ref.current!;
    const r = t.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    // A list of requests may keep its bar at the region's top while it is scrolled: its rows show under the bar.
    const bar = t.closest(".k-ask-list[data-bar-stays]")?.querySelector<HTMLElement>(":scope > .k-ask-bar");
    const top = box.top + (bar && !bar.contains(t) ? bar.offsetHeight : 0);
    // A waiting question keeps its Answer row at the region's lower edge while it is scrolled: its parts show over that row.
    const foot = t.closest('[data-testid="question"]')?.querySelector<HTMLElement>(':scope [data-testid="question-foot"]');
    const bottom = box.bottom - (foot && !foot.contains(t) && t !== foot.parentElement?.parentElement ? foot.offsetHeight : 0);
    if (r.top >= top && r.bottom <= bottom) return;
    // A whole pixel past the edge: a part of one would leave its last line cut.
    el.scrollTop += r.height > bottom - top || r.top < top ? Math.floor(r.top - top - pad()) : Math.ceil(r.bottom - bottom) + 1;
  };
  // What holds the focus here stays in view: its card, and the control itself first.
  const keepFocus = () => {
    const a = document.activeElement;
    if (!a || !ref.current?.contains(a)) return false;
    const card = a.closest(CARDS);
    // (A card taller than the region cannot show whole. Where the control that holds the keyboard
    // is in view already, as a card's answers are that stay at the region's foot, nothing moves:
    // the text stays where the owner is reading it.)
    const box = ref.current.getBoundingClientRect(), at = a.getBoundingClientRect();
    const stays = !!card && card.getBoundingClientRect().height > box.height && at.top >= box.top && at.bottom <= box.bottom;
    if (card && !stays) show(card);
    show(a);
    return true;
  };
  useLayoutEffect(() => {
    const el = ref.current!;
    const c = inner.current!;
    const w = wait.current!;
    let raf = 0;
    const settle = () => {
      // The cards keep as much as they need up to three tenths of the pane; a
      // long draft gives way to them down to its two lines, then they scroll.
      // While something waits on the owner the draft gives way first (styles.css).
      const pane = el.closest<HTMLElement>(".k-session");
      el.style.minHeight = pane && c.offsetHeight ? `${Math.min(Math.ceil(c.offsetHeight + pad()), Math.round(pane.clientHeight * 0.3))}px` : "";
      el.toggleAttribute("data-asking", w.offsetHeight > 0);
      // The scroll bar sits in the column's side padding: the cards keep the box's edges.
      const bar = el.offsetWidth - el.clientWidth;
      el.style.marginRight = bar ? `calc(-0.25rem - ${bar}px)` : "";
      if (!keepFocus() && stick.current) el.scrollTop = home();
      mark();
    };
    // Sizes are written a frame later: a write inside the observer's own call would loop it.
    // The region's own size is watched through a child that fills it: the transcript's
    // observer changes this column's width from inside its call, and an observer is told
    // of such a change in the same pass only for elements deeper than the one that made it.
    const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(settle); };
    const ro = new ResizeObserver(later);
    ro.observe(gauge.current!);
    ro.observe(c);
    addEventListener("resize", later);
    const mo = new MutationObserver((list) => {
      const added = list.flatMap((m) => [...m.addedNodes]).filter((n): n is HTMLElement => n instanceof HTMLElement);
      // New cards, at any depth: the node added is one, or holds one. A node added inside a
      // card that is already there (a list a control of the card opens) is not a new card,
      // and moves nothing.
      const cards = [...new Set(added.map((n) => (n.matches(CARDS) ? n : n.querySelector<HTMLElement>(CARDS))).filter((x): x is HTMLElement => !!x))];
      if (!cards.length) return;
      const held = cards.find((card) => card.contains(document.activeElement));
      if (!held && el.contains(document.activeElement)) return; // in use on another card: nothing moves under the hand
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // The pane may be gone by now (the owner went on as the card came): nothing is left to place.
        if (!el.isConnected || !ref.current) return;
        if (keepFocus()) return mark();
        // A new request for the owner: the region goes to the oldest one waiting. Any other
        // new card is shown, unless a request waits: then the region stays on that.
        if (cards.some((card) => w.contains(card))) el.scrollTop = home();
        else if (!w.offsetHeight && cards.at(-1)!.isConnected) show(cards.at(-1)!);
        mark();
      }));
    });
    mo.observe(c, { childList: true, subtree: true });
    settle();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); removeEventListener("resize", later); };
  }, []);
  return (
    <div
      ref={ref}
      data-testid="composer-tray"
      onScroll={mark}
      onFocus={() => requestAnimationFrame(() => { if (keepFocus()) mark(); })}
      className="k-tray relative -mx-1 min-h-0 shrink-[99] overflow-y-auto px-1 pt-1"
    >
      <div ref={inner}>
        {children}
        <div ref={wait} className="k-asks" data-testid="composer-asks">{asks}</div>
      </div>
      {/* (Whoever else watches the region's size watches this too: see trayGauge.) */}
      <div ref={gauge} data-tray-gauge="" aria-hidden="true" className="pointer-events-none invisible absolute inset-0" />
    </div>
  );
}
// The element to watch for the size of the region above a message box: a child that fills
// it, not the region itself. The transcript's observer changes this column's width from
// inside its call, and an observer is told of that in the same pass only for an element
// deeper than the transcript's own; one on the region is left undelivered, which the
// browser reports as an error ("ResizeObserver loop completed with undelivered notifications").
export const trayGauge = (tray: HTMLElement | null | undefined): HTMLElement | null => tray?.querySelector<HTMLElement>(":scope > [data-tray-gauge]") ?? tray ?? null;
// Retry is the main action (filled), Restore the second (outlined), Discard the quiet one.
const draftButton = "h-7 rounded-md px-2 font-medium disabled:opacity-40";

// Who said a model takes no tools (an owner's "yes" wins over the rest).
const TOOLS_FROM = { owner: "you set it", probe: "the probe found it", listing: "its server says so", catalog: "the catalog says so" } as const;

// What the chosen model does with what is attached, before Send: a model that
// says yes, one that says no, and one whose listing says nothing are three
// different answers.
function Capability({ name, images, pdf, shots, pdfs }: { name: string; images?: boolean; pdf?: boolean; shots: boolean; pdfs: boolean }) {
  const lines: { text: string; warn: boolean }[] = [];
  if (shots) {
    lines.push(images === true ? { text: "Reads images", warn: false }
      : images === false ? { text: `Screenshot will not be sent: ${name} does not read images`, warn: true }
      : { text: "Image support unverified; the screenshot will be sent", warn: false });
  }
  if (pdfs) {
    lines.push(pdf === true ? { text: "Reads PDFs", warn: false }
      : pdf === false ? { text: `${name} does not read PDFs: the file goes as a saved path`, warn: true }
      : { text: "PDF support unverified; the file goes as a saved path, not inline", warn: false });
  }
  return (
    <div className="flex flex-wrap gap-x-3 px-4 pt-1.5 text-caption" data-testid="attach-capability" role="status">
      {lines.map((l) => <span key={l.text} className={l.warn ? "text-warn" : "text-faint"}>{l.text}</span>)}
    </div>
  );
}
