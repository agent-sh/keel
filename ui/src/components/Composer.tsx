import { ArrowUp, File as FileIcon, FileText, Folder, ListPlus, Paperclip, Slash, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PromptBlock, Session } from "../../../src/core/types.ts";
import { slash, type SlashItem } from "../lib/extend.ts";
import { toAttachment, toBlock, type Attachment } from "../lib/images.ts";
import { fuzzy } from "../lib/keys.ts";
import { dropImage, fromServer, getDraft, keepImage, textTaken, typing, type Draft } from "../lib/drafts.ts";
import { onFeature, reportError, useStore } from "../lib/store.ts";
import { setUI, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ContextMeter, EffortPicker, QueuePanel } from "./TurnControls.tsx";
import { SpeedPicker } from "./SpeedPicker.tsx";
import { LimitChip } from "./Limits.tsx";

type Menu =
  | { kind: "slash"; query: string; start: number }
  | { kind: "file"; query: string; start: number };

type Option = { key: string; label: ReactNode; detail?: string; disabled?: boolean; icon: ReactNode; apply: () => void };

const draftKey = (id?: string) => `keel.draft.${id ?? "new"}`;

function useSlashItems() {
  const [, force] = useState(0);
  useEffect(() => slash.subscribe(() => force((n) => n + 1)), []);
  return slash.all();
}

export function Composer({
  session, onSend, onQueue, onStop, working, model, onModel, workspace, autoFocus, focus = true,
}: {
  session?: Session;
  onSend: (text: string, images: PromptBlock[]) => Promise<unknown> | void;
  // While a turn runs, Enter steers (the text joins the turn at its next model
  // call) and Tab or the queue button queues it for after the turn.
  onQueue?: (text: string, images: PromptBlock[]) => Promise<unknown> | void;
  onStop?: () => void;
  working?: boolean;
  model: string;
  onModel: (id: string) => void;
  workspace?: string; // the folder @-mentions search
  autoFocus?: boolean;
  // The station that has the keys (several message boxes can be on screen): only it answers Alt+M.
  focus?: boolean;
}) {
  const [text, setText] = useState(() => localStorage.getItem(draftKey(session?.id)) ?? "");
  const [images, setImages] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<{ path: string; dir: boolean }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const enterSends = useUI((s) => s.enterSends);
  const modelSignal = useUI((s) => s.modelMenu);
  const [pickerSignal, setPickerSignal] = useState(0);
  const lastSignal = useRef(modelSignal);
  useEffect(() => {
    if (modelSignal !== lastSignal.current && focus) setPickerSignal((n) => n + 1);
    lastSignal.current = modelSignal;
  }, [modelSignal]);
  const seed = useUI((s) => (s.composerSeed && s.composerSeed.session === session?.id ? s.composerSeed : null)); // only this box's
  const connected = useStore((s) => s.connected);
  const slashItems = useSlashItems();

  // Each session keeps its own unsent text.
  useEffect(() => {
    setText(localStorage.getItem(draftKey(session?.id)) ?? "");
    setImages([]);
    setMenu(null);
  }, [session?.id]);
  // The session's server draft: images kept until sent, and whatever was put
  // in from outside (text is added to the box once, then emptied there).
  const have = useRef(new Set<string>()); // draft files already in the box
  const pendingKeep = useRef(new Set<string>()); // added here, not yet stored
  const sidRef = useRef(session?.id);
  sidRef.current = session?.id;
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    let live = true;
    const take = async (d: Draft) => {
      if (!live || sidRef.current !== sid) return;
      if (d.text) {
        const add = d.text;
        setText((cur) => (cur.trim() ? `${cur}${cur.endsWith("\n") ? "" : "\n"}${add}` : add));
        textTaken(sid);
        setNotice(d.origin && d.origin !== "page" ? `Text added from ${d.origin}.` : "Text added from outside the page.");
      }
      const ids = new Set(d.attachments.map((f) => f.id));
      setImages((cur) => cur.filter((a) => ids.has(a.id) || pendingKeep.current.has(a.id)));
      for (const f of d.attachments) {
        if (have.current.has(f.id)) continue;
        have.current.add(f.id);
        try {
          const a = await fromServer(sid, f);
          if (live && sidRef.current === sid) setImages((cur) => (cur.some((x) => x.id === a.id) ? cur : [...cur, a]));
        } catch (e) {
          have.current.delete(f.id);
          reportError(e, { at: "draft image" });
        }
      }
    };
    getDraft(sid).then(take).catch(reportError);
    const off = onFeature({
      frame: (f) => { if (f.name === "draft" && f.session_id === sid) take(f.data as Draft); },
      reconnect: () => { getDraft(sid).then(take).catch(reportError); },
    });
    return () => { live = false; off(); have.current.clear(); };
  }, [session?.id]);

  useEffect(() => {
    if (text && session?.id) typing(session.id);
    if (text) localStorage.setItem(draftKey(session?.id), text);
    else localStorage.removeItem(draftKey(session?.id));
  }, [text, session?.id]);
  useEffect(() => {
    if (!seed) return;
    setUI({ composerSeed: null }); // consumed: another message box mounted later must not take it
    setText(seed.text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.setSelectionRange(seed.text.length, seed.text.length); }
    });
  }, [seed]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [text]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Files dropped or pasted anywhere on the page land here.
  const addFiles = async (list: File[]) => {
    for (const f of list) {
      try {
        const a = await toAttachment(f);
        let added = false;
        setImages((cur) => (cur.length >= 20 ? cur : ((added = true), [...cur, a])));
        const sid = sidRef.current;
        if (added && sid && !a.file) {
          have.current.add(a.id);
          pendingKeep.current.add(a.id);
          keepImage(sid, a).finally(() => pendingKeep.current.delete(a.id));
        }
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

  // The menu under the caret: "/" at the start, "@" after a space.
  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const sm = before.match(/^\/([\w-]*)$/);
    if (sm) return setMenu({ kind: "slash", query: sm[1]!, start: 0 });
    const fm = before.match(/(^|\s)@([^\s@]*)$/);
    if (fm && workspace) return setMenu({ kind: "file", query: fm[2]!, start: caret - fm[2]!.length - 1 });
    setMenu(null);
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
    setText("");
    setMenu(null);
    try { await item.run(arg, ctx); } catch (e) {
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

  const submit = async (queue = false) => {
    const t = text.trim();
    if (!t && !images.length) return;
    const cmd = t.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
    if (cmd && !images.length) {
      const item = slashItems.find((i) => i.id === cmd[1]);
      if (item) return runSlash(item, (cmd[2] ?? "").trim());
    }
    // The box clears at once (the next prompt can be typed while this one is on
    // its way); a failed send puts the text back if the box is still empty.
    const sent = images;
    const sid = session?.id;
    setText("");
    setImages([]);
    setMenu(null);
    try {
      const blank = sent.some((a) => !a.file) ? "(image)" : "(attached file)";
      if (queue && onQueue) await onQueue(t || blank, sent.map(toBlock));
      else await onSend(t || blank, sent.map(toBlock));
      if (sid) for (const a of sent) dropImage(sid, a.id); // only what was sent: an image added meanwhile stays
    } catch (e) {
      // Nothing was sent: the text and images come back, unless something new was typed.
      setText((cur) => cur || t);
      setImages((cur) => (cur.length ? cur : sent));
      setNotice(String((e as Error).message));
    } finally {
      ref.current?.focus();
    }
  };

  const open = menu && options.length > 0;
  const canSend = !!text.trim() || images.length > 0;
  const sid = session?.id;

  return (
    <>
    {sid && <QueuePanel sessionId={sid} />}
    <div
      className={cn(
        "relative rounded-xl border bg-raised shadow-2 transition-[border-color,box-shadow] duration-150",
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
          role="listbox"
          data-testid={menu.kind === "slash" ? "slash-menu" : "mention-menu"}
          className="absolute inset-x-0 bottom-[calc(100%+8px)] z-30 max-h-72 overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-3 animate-pop"
        >
          <div className="px-2 pb-1 pt-1.5 text-micro font-medium text-faint">{menu.kind === "slash" ? "Commands" : `Files in ${workspace?.split("/").pop()}`}</div>
          {options.map((o, i) => (
            <div
              key={o.key}
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
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="attachments">
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
                  if (session?.id) dropImage(session.id, a.id);
                }}
                className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-fg/75 text-bg opacity-0 transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
              >
                <X className="size-3" strokeWidth={2.5} />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        data-testid="composer"
        autoFocus={autoFocus}
        rows={1}
        value={text}
        aria-label="Message"
        placeholder={working ? "Enter steers the running turn, Tab queues for after it" : session ? "Reply, / for commands, @ for files" : "Describe the task, / for commands, @ for files"}
        onChange={(e) => { setText(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onSelect={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setMenu(null), 100)}
        onPaste={(e) => {
          const fs = [...e.clipboardData.files];
          if (fs.length) { e.preventDefault(); addFiles(fs); }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open) {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % options.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + options.length) % options.length); return; }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); options[sel]?.apply(); return; }
            if (e.key === "Escape") { e.preventDefault(); setMenu(null); return; }
          }
          const mod = e.metaKey || e.ctrlKey;
          if (e.key === "Enter" && ((enterSends && !e.shiftKey && !mod) || (!enterSends && mod))) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Tab" && !e.shiftKey && working && onQueue && text.trim()) { e.preventDefault(); submit(true); }
          if (e.key === "Escape" && working) { e.preventDefault(); onStop?.(); }
        }}
        className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-read leading-relaxed outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-0.5 px-2 pb-2">
        <button
          type="button"
          title="Attach images or files (or paste, or drop them here)"
          aria-label="Attach images or files"
          data-testid="attach"
          onClick={() => fileInput.current?.click()}
          className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"
        >
          <Paperclip className="size-4" />
        </button>
        <input ref={fileInput} type="file" multiple hidden data-testid="attach-input" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <ModelPicker value={model} onChange={onModel} openSignal={pickerSignal} />
        {sid && <EffortPicker sessionId={sid} />}
        {sid && <SpeedPicker sessionId={sid} />}
        {model && <LimitChip model={model} />}
        {notice && <span className="ml-1 min-w-0 truncate text-caption text-warn animate-in" role="status" data-testid="composer-notice">{notice}</span>}
        {!connected && !notice && <span className="ml-1 truncate text-caption text-faint">Reconnecting</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {sid && <ContextMeter sessionId={sid} />}
          {working && onQueue && (
            <button
              type="button"
              data-testid="queue-button"
              onClick={() => submit(true)}
              disabled={!text.trim()}
              title="Queue for after this turn (Tab)"
              aria-label="Queue for after this turn"
              className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-40"
            >
              <ListPlus className="size-4" />
            </button>
          )}
          {working && (
            <button
              type="button"
              data-testid="stop"
              onClick={onStop}
              title="Stop (Esc)"
              aria-label="Stop the turn"
              className="grid size-8 place-items-center rounded-full border border-line-strong text-fg hover:bg-hover"
            >
              <Square className="size-3 fill-current" />
            </button>
          )}
          <button
            type="button"
            data-testid="send"
            onClick={() => submit()}
            disabled={!canSend}
            title={working ? "Steer into the running turn" : enterSends ? "Send (Enter)" : "Send (Ctrl Enter)"}
            aria-label="Send"
            className={cn(
              "grid size-8 place-items-center rounded-full bg-accent text-accent-fg transition-[background-color,opacity,transform] duration-150",
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
