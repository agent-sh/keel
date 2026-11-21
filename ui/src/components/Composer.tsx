import { ArrowUp, File as FileIcon, FileText, Folder, ListPlus, Paperclip, Slash, Square, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import type { PromptBlock, Session } from "../../../src/core/types.ts";
import { slash, type SlashItem } from "../lib/extend.ts";
import { loadMcpPrompts } from "../lib/tools-ui.ts";
import { fromBlock, toAttachment, toBlock, type Attachment } from "../lib/images.ts";
import { composing, fuzzy, isMac, keyLabel, QUEUE_KEYS, SEND_KEYS } from "../lib/keys.ts";
import { splitId } from "../lib/fleet-ids.ts";
import { draftGone, draftHere, dropImage, fromServer, getDraft, isKeeping, keepImage, textTaken, typing, type Draft } from "../lib/drafts.ts";
import { daemonAway, hasSavedImage, messageRefused, namedSends, savedImages, sendDrafts, setSendDraft, setSendImage, shelfKey, shown, unread, useSendDrafts, type SendDraft } from "../lib/send-drafts.ts";
import { sendWaitingSoon } from "../lib/resend.ts";
import { onFeature, reportError, reportUnlessGone, useStore, failed } from "../lib/store.ts";
import { setUI, useUI } from "../lib/ui.ts";
import { lineage } from "../../../src/core/tree.ts";
import { cn } from "../lib/utils.ts";
import { FallbackChip } from "./Fallback.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ContextMeter, EffortPicker, QueuePanel } from "./TurnControls.tsx";
import { SpeedPicker } from "./SpeedPicker.tsx";
import { LimitChip } from "./Limits.tsx";

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

function useSlashItems() {
  const [, force] = useState(0);
  useEffect(() => slash.subscribe(() => force((n) => n + 1)), []);
  return slash.all();
}

// Images of kept sends being read back from the session's draft after a reload.
const reading = new Set<string>();
const MAX_FILES = 20;
const heading = (d: SendDraft) => (d.state === "waiting" ? "Waiting for Keel" : d.state === "refused" ? (d.queue ? "Not queued" : "Not sent") : d.state === "unconfirmed" ? "Delivery unconfirmed" : "Saved draft");

const OFF_BRANCH = "You are reading another branch. Choose Continue from this branch to reply there, or Back to the current one.";

type ComposerProps = {
  session?: Session;
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

function SessionComposer({
  session, onSend, onQueue, onStop, onEscape, stopLabel = "Stop the turn", working, model, onModel, workspace, autoFocus, focus = true, hold, above, asks,
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
  const queueButton = useRef<HTMLButtonElement>(null);
  const enterSends = useUI((s) => s.enterSends);
  // Reading another branch from search: a reply would go to the session's own branch, so ask first.
  const previewEvent = useUI((s) => (session && s.preview?.session === session.id ? s.preview.event : null));
  const sessionEvents = useStore((s) => (session ? s.events[session.id] : undefined));
  const offBranch = !!previewEvent && !!sessionEvents?.some((e) => e.id === previewEvent) && !lineage(sessionEvents!, session!.head).some((e) => e.id === previewEvent);
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
  const pickModel = (id: string) => {
    const r = onModel(id);
    if (!(r instanceof Promise)) return;
    setSwitching(true);
    r.finally(() => setSwitching(false));
  };
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
    getDraft(sid).then(take).catch(reportError);
    const off = onFeature({
      frame: (f) => { if (f.name === "draft" && f.session_id === sid) take(f.data as Draft); },
      reconnect: () => { getDraft(sid).then(take).catch(reportUnlessGone); },
    });
    return () => { live = false; off(); have.current.clear(); };
  }, [sid]);

  // After a reload the shelf knows its images by reference: read them from the
  // session's draft. One the draft no longer has is named on its item.
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
  }, [saved, sid]);
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
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }, [seed]);

  // The box grows with its text up to two fifths of the window, measured again
  // when the window or the text size changes; the pane's height can still
  // shrink it (see Tray).
  const scale = useUI((s) => s.scale);
  // A window few lines high (small, or large text): the tools take one row.
  const low = () => innerHeight < SHORT_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
  const [short, setShort] = useState(low);
  useEffect(() => {
    const fit = () => {
      setShort(low());
      const el = ref.current;
      if (!el) return;
      el.style.minHeight = "";
      el.style.height = "auto";
      const h = Math.min(el.scrollHeight, Math.round(innerHeight * 0.4));
      el.style.height = `${h}px`;
      // What the pane's height cannot take from it: two lines of a draft that has them (one
      // of an empty box, whose hint may wrap), and from the box: those lines with what is
      // above and under them (the attachments, the tools), so the tools never leave the box.
      const cs = getComputedStyle(el);
      const least = Math.min(h, Math.ceil((el.value ? 2 : 1) * parseFloat(cs.lineHeight) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)));
      el.style.minHeight = `${least}px`;
      const box = el.parentElement!;
      let under = 0;
      for (let x = el.nextElementSibling as HTMLElement | null; x; x = x.nextElementSibling as HTMLElement | null) under += x.offsetHeight;
      box.style.minHeight = `${el.offsetTop + least + under + box.offsetHeight - box.clientHeight}px`;
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [text, scale, short, images.length, notice, synced, info, working]);

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

  const ctx = { session, setText };
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
  }, [menu, slashItems, files, text, session]);

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
    // Lock this snapshot before awaiting anything, including a rapid click
    // on Retry before React has disabled its button.
    setSendDraft(shelf, id, { ...entry, state: "sending" });
    try {
      const send = queue && onQueue ? onQueue : onSend;
      await send(text.trim(), images.map(toBlock), id);
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
          <div id={`${listId}-name`} className="px-2 pb-1 pt-1.5 text-micro font-medium text-faint">{menu.kind === "slash" ? "Commands" : `Files in ${workspace?.split("/").pop()}`}</div>
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
        autoFocus={autoFocus}
        rows={1}
        value={text}
        aria-label="Message"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[sel] ? optionId(sel) : undefined}
        placeholder={working ? `Enter steers, ${queueKeys} queues` : session ? "Reply, / for commands, @ for files" : "Describe the task, / for commands, @ for files"}
        onChange={(e) => { setText(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onSelect={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMenu(null), 100)}
        onPaste={(e) => {
          const fs = [...e.clipboardData.files];
          if (fs.length) { e.preventDefault(); addFiles(fs); }
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
          // Ctrl Shift Enter queues for after the running turn, whichever key sends; with no
          // turn running it sends (the turn may have ended a moment before the press).
          if (e.key === "Enter" && mod && e.shiftKey && !e.altKey) {
            e.preventDefault();
            if (!e.repeat) submit(!!working && !!onQueue);
          // Alt Enter is the pane's (focus it, or show all): not a send.
          } else if (e.key === "Enter" && !e.altKey && ((enterSends && !e.shiftKey && !mod) || (!enterSends && mod))) {
            e.preventDefault();
            submit();
          }
          // Tab with a draft while a turn runs goes to the queue button (Enter there queues),
          // and the key that queues from the box is said, once.
          if (e.key === "Tab" && !e.shiftKey && !mod && !e.altKey && working && onQueue && canSend && queueButton.current) {
            e.preventDefault();
            queueButton.current.focus();
            if (!queueKeySaid) { queueKeySaid = true; setNotice(`${queueKeys} queues`); }
          }
          if (e.key === "Escape" && (onEscape || working)) { e.preventDefault(); (onEscape ?? onStop)?.(); }
        }}
        className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-read leading-relaxed outline-none placeholder:text-faint"
      />
      {/* The tools wrap onto more rows in a narrow box. In a short window they keep one row: the ones on the left scroll sideways, Send and Stop stay. */}
      {short && status}
      <div className={cn("flex shrink-0 items-center gap-x-0.5 gap-y-1 px-2 pb-2", !short && "flex-wrap")} data-short={short || undefined} data-testid="composer-tools">
        <div className={short ? "-my-1 flex min-w-0 flex-1 items-center gap-x-0.5 overflow-x-auto py-1 pr-4 [mask-image:linear-gradient(to_left,transparent,#000_1rem)] [scrollbar-width:none]" : "contents"}>
          <span className={cn("flex items-center gap-x-0.5", short ? "shrink-0" : "min-w-0 max-w-full [&>[data-testid=model-picker]]:min-w-0")}>
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
            <input ref={fileInput} type="file" multiple hidden data-testid="attach-input" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
            <ModelPicker value={model} onChange={pickModel} openSignal={pickerSignal} machine={sid ? splitId(sid)?.machine : undefined} />
          </span>
          {sid && <EffortPicker sessionId={sid} />}
          {sid && <SpeedPicker sessionId={sid} />}
          {session && <FallbackChip session={session} />}
          {model && <LimitChip model={model} />}
          {short && sid && <ContextMeter sessionId={sid} />}
          {!short && status}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!short && sid && <ContextMeter sessionId={sid} />}
          {working && onQueue && (
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
          {working && (
            <button
              type="button"
              data-testid="stop"
              // The button goes away with the turn: the focus goes to the box, not to nowhere
              // (not on a phone, where that would raise the keyboard).
              onClick={() => { onStop?.(); if (DESK.matches) ref.current?.focus(); }}
              title={onEscape ? stopLabel : `${stopLabel} (Esc)`}
              aria-label={stopLabel}
              className={cn("grid h-8 place-items-center rounded-full border border-line-strong text-fg hover:bg-hover", onEscape ? "flex gap-1.5 px-3 text-caption font-medium" : "size-8")}
            >
              <Square className="size-3 fill-current" />
              {onEscape && <span>{stopLabel}</span>}
            </button>
          )}
          <button
            type="button"
            data-testid="send"
            onClick={() => submit()}
            disabled={!canSend}
            title={working ? "Steer into the running turn" : `Send (${keyLabel(SEND_KEYS(enterSends).send).join(" ")})`}
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
}

// The cards of the region above the box, by their test ids, at any depth.
const CARDS = ["approval", "plan-card", "secret-request", "trust-card", "blocked", "held-message", "saved-draft", "queue-item", "dock-job", "live-source"].map((t) => `[data-testid="${t}"]`).join(",");

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
    if (r.top >= top && r.bottom <= box.bottom) return;
    // A whole pixel past the edge: a part of one would leave its last line cut.
    el.scrollTop += r.height > box.bottom - top || r.top < top ? Math.floor(r.top - top - pad()) : Math.ceil(r.bottom - box.bottom) + 1;
  };
  // What holds the focus here stays in view: its card, and the control itself first.
  const keepFocus = () => {
    const a = document.activeElement;
    if (!a || !ref.current?.contains(a)) return false;
    const card = a.closest(CARDS);
    if (card) show(card);
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
      <div ref={gauge} aria-hidden="true" className="pointer-events-none invisible absolute inset-0" />
    </div>
  );
}
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
