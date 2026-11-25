// Rewind from a prompt of the conversation: the chat and the files go back to before it, or only one of them.
// The list is the branch shown's prompts, each with the files the turns it started changed; the choice below
// it says what goes back. The prompt returns to the message box. One Undo (a line in the conversation) takes
// back both. Files go through the same preview, protection of edits made outside and undo point as the
// Changes panel's revert (src/safety/checkpoints.ts); the chat moves as a version arrow does, and the abandoned
// branch stays. Opened from a prompt's menu, /rewind and /undo, and Esc twice in an empty message box.
import { Dialog } from "@base-ui/react/dialog";
import { FileDiff } from "lucide-react";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PromptBlock } from "../../../src/core/types.ts";
import { promptRows, promptRowsOf } from "../lib/rewind.ts";
import { sessionLine } from "../lib/rewind-act.ts";
import { stoppingShells } from "../lib/shells.ts";
import { api, failed, useStore } from "../lib/store.ts";
import { seedComposer } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { NotUndoneList, type NotUndone } from "./NotUndone.tsx";
import { Seg } from "./Seg.tsx";

type Ask = { sessionId: string; eventId?: string };
type Mode = "both" | "chat" | "files";
type Preview = {
  files: string[]; skipped: string[]; merged: string[]; removes: string[]; versions: Record<string, string>; turn: number | null; uncaptured: string[];
  not_undone?: NotUndone[];
};
type Done = { chat: { prompt_text: string; prompt_images?: PromptBlock[] } | null };


let current: Ask | null = null;
const subs = new Set<() => void>();
const set = (a: Ask | null) => { current = a; subs.forEach((f) => f()); };

let mounted = false;
export function openRewind(a: Ask) {
  if (!mounted) {
    mounted = true;
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(<Host />);
  }
  set(a);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const SHOWN = 6;

function Host() {
  const ask = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  return ask ? <RewindDialog key={`${ask.sessionId}:${ask.eventId ?? ""}`} ask={ask} onClose={() => set(null)} /> : null;
}

function RewindDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const sid = ask.sessionId;
  const events = useStore((s) => s.events[sid]);
  const head = useStore((s) => s.sessions[sid]?.head);
  const [turns, setTurns] = useState<{ turn: number; files: unknown[] }[] | null>(null);
  // The branch's prompts from the daemon: the page holds only the newest part of a long one. Until they come (or
  // when they cannot be read) the page's own are listed.
  const [asked, setAsked] = useState<{ prompts: { id: string; seq: number; text: string; attachments: boolean }[]; starts: number[] } | null>(null);
  const rows = useMemo(() => (asked ? promptRowsOf(asked.prompts, new Set(asked.starts), turns ?? []) : promptRows(sessionLine(sid), turns ?? [])), [events, head, turns, sid, asked]);
  const [picked, setPicked] = useState<string | null>(ask.eventId ?? null);
  const [mode, setMode] = useState<Mode>("both");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [outside, setOutside] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api<{ turns: { turn: number; files: unknown[]; elsewhere?: string }[] }>(`/api/sessions/${sid}/checkpoints`)
      .then((r) => live && setTurns(r.turns.filter((t) => !t.elsewhere)), () => live && setTurns([]));
    api<NonNullable<typeof asked>>(`/api/sessions/${sid}/prompts`).then((r) => live && setAsked(r), () => {});
    return () => { live = false; };
  }, [sid]);
  // Opened with nothing chosen (a command, Esc twice): the newest prompt, which is where a rewind usually goes.
  const chosen = picked ?? rows.at(-1)?.id ?? null;
  const row = rows.find((r) => r.id === chosen);

  // What the files would do from the chosen prompt on, read again when the choice or the edits outside change.
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setPreview(null);
    setError("");
    api<Preview>(`/api/sessions/${sid}/rewind`, { method: "POST", body: JSON.stringify({ prompt_event: chosen, preview: true }) })
      .then((p) => { if (!live) return; setPreview(p); setOutside(false); }, (e) => { if (live) { setPreview({ files: [], skipped: [], merged: [], removes: [], versions: {}, turn: null, uncaptured: [] }); setError(failed(e, { at: "rewind preview" })); } });
    return () => { live = false; };
  }, [sid, chosen]);
  const changes = !!preview && preview.turn !== null && preview.files.length + preview.skipped.length + preview.merged.length > 0;
  const files = preview ? [...preview.files, ...preview.merged, ...(outside ? preview.skipped : [])] : [];
  // Without files to put back only the chat can go; a choice of files meanwhile falls back to it.
  const way: Mode = preview && !changes ? "chat" : mode;

  useEffect(() => { list.current?.querySelector<HTMLElement>("[aria-checked=true]")?.scrollIntoView({ block: "nearest" }); }, [rows.length, chosen]);

  const go = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = (stop: boolean) => JSON.stringify({
        prompt_event: chosen, mode: way, include_outside: outside, stop_shells: stop || undefined,
        ...(way !== "chat" && preview ? { confirm: { paths: files, versions: preview.versions } } : {}),
      });
      const r = await stoppingShells((stop) => api<Done>(`/api/sessions/${sid}/rewind`, { method: "POST", body: body(stop) }), { verb: "Rewind", where: "this folder" });
      if (!r) { setBusy(false); return; }
      // The prompt is the box's again, with its attachments.
      if (r.chat) seedComposer(r.chat.prompt_text, sid, { blocks: r.chat.prompt_images });
      onClose();
    } catch (e) {
      setBusy(false);
      setError(failed(e, { at: "rewind" }));
    }
  };

  const modes: { value: Mode; title: string; hint: string }[] = [
    { value: "both", title: "Chat and files", hint: `The conversation and ${preview ? plural(files.length, "file") : "the files"} go back to before this prompt. The model is told the files changed.` },
    { value: "chat", title: "Chat only", hint: "The conversation goes back. The files stay as they are, and the model is told which ones the later turns changed." },
    { value: "files", title: "Files only", hint: "The files go back to before this prompt. The conversation stays, and the model is told." },
  ];
  const offered = changes ? modes : modes.filter((m) => m.value === "chat");

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="rewind-dialog" className="k-dialog rounded-xl border border-line bg-raised shadow-3" style={{ "--k-dialog-w": "34rem" } as React.CSSProperties}>
          <Dialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">Rewind to before a prompt</Dialog.Title>
          <div className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] pb-1">
            <Dialog.Description className="text-ui text-muted">The prompt you pick comes back to the message box. What you rewind from stays as a branch; Undo brings it back.</Dialog.Description>
            {rows.length === 0 ? <p className="k-empty py-4" data-testid="rewind-none">No prompt on this branch yet.</p> : (
              <div ref={list} className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-line bg-sunken p-1">
                <Seg
                  rows kind="choice" label="Prompts of this conversation, the newest last" testid="rewind-prompts"
                  value={chosen ?? ""} onChange={setPicked}
                  options={rows.map((r) => ({
                    value: r.id, testid: "rewind-prompt", name: `${r.text}${r.files ? `, ${plural(r.files, "file")} changed` : ""}`,
                    className: "flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-ui hover:bg-hover aria-checked:bg-raised aria-checked:shadow-1 aria-checked:ring-1 aria-checked:ring-line-strong",
                    label: (
                      <>
                        <span className="min-w-0 flex-1 truncate">{r.text}</span>
                        <span className={cn("shrink-0 text-micro tabular-nums", r.files ? "text-muted" : "text-faint")} data-testid="rewind-prompt-files">{r.files ? plural(r.files, "file") : "no files"}</span>
                      </>
                    ),
                  }))}
                />
              </div>
            )}
            {row && (
              <div className="mt-4" data-testid="rewind-modes">
                {!preview && <p className="text-caption text-faint">Reading what the files would do</p>}
                {preview && (
                  <Seg
                    rows kind="choice" label="What goes back" testid="rewind-mode"
                    value={way} onChange={setMode}
                    options={offered.map((m) => ({
                      value: m.value, testid: "rewind-mode-option", name: m.title,
                      className: "flex w-full flex-col items-start gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left hover:bg-hover aria-checked:border-line-strong aria-checked:bg-sunken",
                      label: (
                        <>
                          <span className="text-ui font-medium">{m.title}</span>
                          <span className="text-caption text-muted">{m.value === "chat" && !changes ? "The conversation goes back. No turn from this prompt on changed a file." : m.hint}</span>
                        </>
                      ),
                    }))}
                  />
                )}
                {preview && way !== "chat" && changes && (
                  <ul className="mt-2 flex flex-col gap-1 px-1 font-mono text-caption" data-testid="rewind-files">
                    {[...preview.files, ...preview.merged].slice(0, SHOWN).map((f) => (
                      <li key={f} className="flex items-center gap-2">
                        <FileDiff className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                        <span className="min-w-0 truncate">{f}</span>
                        <span className={cn("ml-auto shrink-0 font-sans text-micro", preview.removes.includes(f) ? "text-danger" : "text-faint")}>{preview.removes.includes(f) ? "deleted: not there before" : "goes back"}</span>
                      </li>
                    ))}
                    {preview.files.length + preview.merged.length > SHOWN && <li className="font-sans text-micro text-faint">and {preview.files.length + preview.merged.length - SHOWN} more</li>}
                  </ul>
                )}
                {preview && way !== "chat" && preview.skipped.length > 0 && (
                  <label className="mt-2 flex items-start gap-2 px-1 text-ui">
                    <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" data-testid="rewind-outside" />
                    <span>
                      Also put back {plural(preview.skipped.length, "file")} changed outside the session
                      <span className="block text-caption text-muted">Kept by default: someone else (you, or another session) edited them since.</span>
                    </span>
                  </label>
                )}
              </div>
            )}
            {preview && (preview.not_undone?.length ?? 0) > 0 && (
              <NotUndoneList items={preview.not_undone!} testid="rewind-not-undone" className="mt-3" />
            )}
            {error && <p className="mt-2 text-caption text-danger" role="alert" data-testid="rewind-error">{error}</p>}
          </div>
          <div className="k-dialog-foot px-[var(--k-dialog-pad)] pb-[var(--k-dialog-pad)] pt-3">
            <Dialog.Close disabled={busy} className="k-btn k-btn-lg">Cancel</Dialog.Close>
            <button type="button" data-testid="rewind-prompt-go" onClick={go} disabled={busy || !row || !preview}
              className={cn("h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg enabled:hover:bg-accent-hover disabled:opacity-50", busy && "opacity-60")}>
              {busy ? "Rewinding" : way === "both" ? "Rewind chat and files" : way === "chat" ? "Rewind the chat" : "Put the files back"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
