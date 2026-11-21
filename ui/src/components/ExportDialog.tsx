// Export a session: a file to read or to import into another keel-bun, or a new
// transcript in Claude Code's or Codex's store with the command that resumes it.
// An imported session also shows where it came from, and takes what its source
// gained since.
import { copyText } from "../lib/copy.ts";
import { Dialog } from "@base-ui/react/dialog";
import { Check, Copy, FileDown, FileJson, History, Terminal, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { reportError, failed, useStore } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

let current: Session | null = null;
const subs = new Set<() => void>();
export function openExport(s: Session | null) { current = s; subs.forEach((f) => f()); }
export function ExportOverlay() {
  const s = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  return <ExportDialog session={s} onClose={() => openExport(null)} />;
}

type Origin = { origin: null | { label: string; harness: string; source_id: string; source_path: string; imported_ms: number; synced_ms: number }; source?: { exists: boolean; grew: boolean } };
type Written = { format: string; target_id: string; path: string; cwd: string; resume_command: string; notes?: string[] };

// What an export leaves under the options is brought into view: on a short window the list scrolls.
const intoView = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest" });

const optionClass = "flex w-full items-start gap-3 rounded-lg border border-line bg-raised px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-hover disabled:opacity-50";
function Option({ icon, title, hint, onClick, href, testid, busy }: { icon: React.ReactNode; title: string; hint: string; onClick?: () => void; href?: string; testid: string; busy?: boolean }) {
  const body = (
    <>
      <span className="mt-0.5 text-muted [&>svg]:size-4">{icon}</span>
      <span>
        <span className="block text-ui font-medium">{title}</span>
        <span className="block text-caption text-faint">{hint}</span>
      </span>
    </>
  );
  return href ? (
    <a href={href} download data-testid={testid} className={optionClass}>{body}</a>
  ) : (
    <button type="button" disabled={busy} data-testid={testid} onClick={onClick} className={optionClass}>{body}</button>
  );
}

function ExportDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [written, setWritten] = useState<Written | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // What the Keel file leaves behind: other branches, and messages still waiting to run.
  const all = useStore((st) => (session ? st.events[session.id] : undefined));
  const pending = useStore((st) => (session ? st.queues[session.id]?.queue.length ?? 0 : 0));
  const branches = all ? Math.max(0, all.filter((e) => !all.some((x) => x.parent === e.id)).length - 1) : 0;
  const stays = [
    branches ? `${branches} other branch${branches === 1 ? "" : "es"}` : "",
    pending ? `${pending} pending message${pending === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  useEffect(() => {
    setWritten(null);
    setErr("");
    setOrigin(null);
    if (session) fetch(`/api/sessions/${session.id}/origin`).then((r) => r.json()).then(setOrigin).catch(reportError);
  }, [session?.id]);
  if (!session) return null;
  const base = `/api/sessions/${session.id}`;
  const to = async (format: "claude_code" | "codex") => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`${base}/export-to`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      setWritten(b);
    } catch (e) {
      setErr(failed(e, { at: "ExportDialog" }));
    } finally {
      setBusy(false);
    }
  };
  const update = async () => {
    if (!origin?.origin) return;
    setBusy(true);
    try {
      const r = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: origin.origin.harness, id: origin.origin.source_id, mode: "update" }) });
      if (!r.ok) throw new Error((await r.json()).error);
      setOrigin(await (await fetch(`${base}/origin`)).json());
    } catch (e) {
      setErr(failed(e, { at: "ExportDialog" }));
    } finally {
      setBusy(false);
    }
  };
  const command = written ? `cd ${written.cwd} && ${written.resume_command}` : "";
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="export-dialog" data-anchor="top" style={{ "--k-dialog-w": "34rem", "--k-dialog-bg": "var(--bg)" } as React.CSSProperties} className="k-dialog rounded-xl border border-line bg-bg shadow-3 transition-[scale,opacity] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Dialog.Title className="min-w-0 flex-1 truncate font-semibold">Export “{session.title || "Session"}”</Dialog.Title>
            <Dialog.Close aria-label="Close" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="k-dialog-body space-y-2 p-4">
            {origin?.origin && (
              <div className="mb-3 flex items-center gap-2.5 rounded-lg bg-panel px-3 py-2.5 text-caption" data-testid="export-origin">
                <History className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  Imported from {origin.origin.label} {ago(origin.origin.imported_ms)}
                  {origin.source && !origin.source.exists ? ", its file is gone." : origin.source?.grew ? "; the original has gone on since." : "."}
                </span>
                {origin.source?.grew && <button type="button" disabled={busy} onClick={update} className="shrink-0 rounded-md px-2 py-0.5 text-accent hover:bg-accent-soft">Update</button>}
              </div>
            )}
            <Option href={`${base}/export?format=md&include=tools`} icon={<FileDown />} title="Markdown" hint="To read or share: the current branch with its tool calls and results; images and files named, not included; secrets taken out." testid="export-md" />
            <Option href={`${base}/export?format=jsonl`} icon={<FileJson />} title="Keel file" hint="To continue in another Keel: the current branch whole, thinking and tool data included; secrets taken out, ids of calls kept, so it is not anonymous." testid="export-jsonl" />
            {stays && <p className="px-1 text-caption text-faint" data-testid="export-stays">{stays} stay{branches + pending === 1 ? "s" : ""} in this session.</p>}
            <div className="pt-2 text-caption font-medium uppercase tracking-wide text-faint">Continue in another harness</div>
            <div className="grid grid-cols-2 gap-2">
              <Option icon={<Terminal />} title="Claude Code" hint="A new transcript in its store" onClick={() => to("claude_code")} testid="export-claude" busy={busy} />
              <Option icon={<Terminal />} title="Codex" hint="A new rollout in its store" onClick={() => to("codex")} testid="export-codex" busy={busy} />
            </div>
            {err && <p ref={intoView} className="rounded-md bg-danger-soft px-3 py-2 text-caption text-danger">{err}</p>}
            {written && (
              <div ref={intoView} className="scroll-mb-4 rounded-lg border border-line bg-raised p-3" data-testid="export-written">
                <p className="text-caption text-muted">Written as a new session. Resume it with:</p>
                <div className="mt-2 flex items-center gap-2 rounded-md bg-sunken px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-caption" data-testid="export-command" title={command}>{command}</code>
                  <button type="button" aria-label="Copy the command" onClick={() => copyText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} className={cn("grid size-6 place-items-center rounded-sm text-faint hover:text-fg", copied && "text-ok")}>
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  </button>
                </div>
                <p className="mt-1.5 truncate font-mono text-micro text-faint" title={written.path} data-testid="export-path">{written.path}</p>
                {written.notes?.map((n) => <p key={n} className="mt-1.5 text-caption text-warn" data-testid="export-note">{n}</p>)}
              </div>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
