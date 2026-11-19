import { AtSign, ChevronLeft, File as FileIcon, Folder, Search } from "lucide-react";
import { IMAGE, OpenInEditor, rawFile } from "./OpenInEditor.tsx";
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, reportError } from "../lib/store.ts";
import { seedComposer } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

type Hit = { path: string; dir: boolean };
type Opened = { path: string; size: number; text?: string; binary?: boolean; truncated?: boolean };

const LANG: Record<string, string> = {
  py: "python", rs: "rust", md: "markdown", yml: "yaml", sh: "shell", bash: "shell", zsh: "shell", mjs: "js", cjs: "js",
  h: "c", hpp: "cpp", cc: "cpp", kt: "kotlin", rb: "ruby", jsonc: "json", lock: "plaintext",
};
const langOf = (p: string) => {
  const name = p.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return LANG[ext] ?? ext;
};

function CodeView({ file }: { file: Opened }) {
  const [html, setHtml] = useState<string | null>(null);
  const lines = useMemo(() => (file.text ?? "").split("\n"), [file.text]);
  useEffect(() => {
    setHtml(null);
    if (!file.text || file.text.length > 200_000) return;
    import("../lib/highlight.ts").then((m) => setHtml(m.highlightHtml(file.text!, langOf(file.path)))).catch(reportError);
  }, [file]);
  return (
    <div className="flex min-h-full w-max min-w-full font-mono text-[12.5px] leading-[1.65]">
      <div aria-hidden="true" className="sticky left-0 select-none border-r border-line bg-panel px-3 py-3 text-right text-faint tabular-nums">
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      {html ? (
        <pre className="flex-1 px-4 py-3" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="flex-1 px-4 py-3">{file.text}</pre>
      )}
    </div>
  );
}

// The session's folder: find a file, read it, mention it in the message box.
export function FilesPanel({ session }: { session: Session }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Opened | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/fs/files?path=${encodeURIComponent(session.workspace)}&q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((r) => { setHits(r.hits ?? []); setTotal(r.total ?? 0); })
        .catch((e) => e.name !== "AbortError" && reportError(e, { kind: "files-panel" }));
    }, 80);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, session.workspace]);

  const show = (h: Hit) => {
    if (h.dir) return setQ(h.path);
    api<Opened>(`/api/fs/file?root=${encodeURIComponent(session.workspace)}&path=${encodeURIComponent(h.path)}`).then(setOpen).catch(reportError);
  };
  const mention = (path: string) => {
    const draft = localStorage.getItem(`keel.draft.${session.id}`) ?? "";
    seedComposer(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@${path} `, session.id);
  };

  if (open) {
    return (
      <div className="flex h-full flex-col" data-testid="file-view">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-raised px-2">
          <button type="button" onClick={() => setOpen(null)} aria-label="Back to the file list" className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={open.path}>{open.path}</span>
          <button type="button" onClick={() => mention(open.path)} className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-caption text-muted hover:bg-hover hover:text-fg">
            <AtSign className="size-3.5" /> Mention
          </button>
          {!session.machine && <OpenInEditor sessionId={session.id} path={open.path} />}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-raised">
          {open.binary && IMAGE.test(open.path) && !session.machine
            ? <img src={rawFile(session.id, open.path)} alt={open.path} data-testid="file-image" className="m-4 max-w-[calc(100%-2rem)] rounded-md border border-line" />
            : open.binary ? <p className="p-6 text-ui text-faint">A binary file, {Math.round(open.size / 1024)} KB.</p> : <CodeView file={open} />}
          {open.truncated && <p className="border-t border-line p-3 text-caption text-faint">Showing the first 512 KB of {Math.round(open.size / 1024)} KB.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="files-panel">
      <div className="p-2">
        <label className="flex h-9 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-ui focus-within:border-line-strong">
          <Search className="size-4 text-faint" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a file in ${session.workspace.split("/").pop()}`} className="w-full bg-transparent outline-none placeholder:text-faint" data-testid="files-search" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {hits.map((h) => (
          <div key={h.path} className="group flex h-8 items-center gap-2 rounded-md px-2 text-ui hover:bg-hover">
            <button type="button" onClick={() => show(h)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              {h.dir ? <Folder className="size-4 shrink-0 text-faint" /> : <FileIcon className="size-4 shrink-0 text-faint" />}
              <span className={cn("truncate font-mono text-caption", h.dir ? "text-muted" : "text-fg")}>{h.path}</span>
            </button>
            {!h.dir && (
              <button type="button" title="Mention in the message box" aria-label={`Mention ${h.path}`} onClick={() => mention(h.path)} className="hidden size-6 place-items-center rounded-sm text-faint hover:text-fg group-hover:grid">
                <AtSign className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {hits.length === 0 && <p className="px-2 py-6 text-center text-ui text-faint">No file matches.</p>}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-micro text-faint">{total.toLocaleString()} files</div>
    </div>
  );
}

