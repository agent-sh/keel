// A file of the Files panel, shown by its kind (the daemon says which, src/server/file-preview.ts):
// Markdown rendered like a reply, CSV and TSV as a table, JSON folded, an image, a page in a frame
// that runs no script and reaches no network, a ZIP or tar listed by name and size. Anything else is
// code, or (a binary file) named with its size and kind. Each has its source, a raw view (the file
// as the daemon serves it) and a copy. A file is read in ranges: the page holds one part at a time.
import { ChevronDown, ChevronRight, ChevronLeft, Copy, ExternalLink, Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { copyOrSay } from "../lib/copy.ts";
import { parseTable } from "../lib/csv.ts";
import { langOf } from "../lib/lang.ts";
import { api, reportError } from "../lib/store.ts";
import { cn, fmtSize } from "../lib/utils.ts";
import { ContentFrame } from "./ContentFrame.tsx";
import { Markdown } from "./Markdown.tsx";
import { Seg } from "./Seg.tsx";

type Entry = { name: string; size: number; dir?: boolean };
export type Opened = {
  path: string;
  size: number;
  kind?: "markdown" | "csv" | "tsv" | "json" | "html" | "image" | "archive" | "text" | "binary";
  what?: string;
  text?: string;
  binary?: boolean;
  truncated?: boolean;
  from?: number;
  to?: number;
  rows?: number;
  rows_exact?: boolean;
  framed?: boolean;
  image?: { mime: string; w?: number; h?: number; shown: boolean; why?: string };
  archive?: { entries: Entry[]; total: number; partial: boolean };
};

const ROWS = 1000;
const button = "k-btn shrink-0";
const view = (kind: string) => { try { return localStorage.getItem(`keel.files.view.${kind}`) === "source" ? "source" : "preview"; } catch { return "preview"; } };
const query = (root: string, path: string) => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

export function CodeView({ file, line, end }: { file: Opened; line?: number; end?: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const band = useRef<HTMLDivElement>(null);
  // A linked line is shown near the top of the view, its lines marked.
  useEffect(() => {
    const el = band.current;
    const sc = el?.closest<HTMLElement>("[data-file-scroll]");
    if (el && sc) sc.scrollTop = Math.max(0, el.offsetTop - 96);
  }, [line, file]);
  const lines = useMemo(() => (file.text ?? "").split("\n"), [file.text]);
  // The numbers are the file's own only in its first part.
  const numbers = !file.from;
  useEffect(() => {
    setHtml(null);
    if (!file.text || file.text.length > 200_000) return;
    import("../lib/highlight.ts").then((m) => setHtml(m.highlightHtml(file.text!, langOf(file.path)))).catch(reportError);
  }, [file]);
  return (
    <div className="relative flex min-h-full w-max min-w-full font-mono text-caption leading-[1.65]">
      {numbers && line && line <= lines.length && (
        <div ref={band} data-testid="file-line" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bg-accent-soft"
          style={{ top: `calc(12px + ${line - 1} * 1.65em)`, height: `calc(${Math.max(1, Math.min(end ?? line, lines.length) - line + 1)} * 1.65em)` }} />
      )}
      {numbers && (
        <div aria-hidden="true" className="sticky left-0 select-none border-r border-line bg-sunken px-3 py-3 text-right text-faint tabular-nums">
          {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
        </div>
      )}
      {html ? (
        <pre className="relative flex-1 px-4 py-3" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="relative flex-1 px-4 py-3">{file.text}</pre>
      )}
    </div>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => <p data-testid="file-note" className="p-6 text-ui text-faint">{children}</p>;

function Table({ file, delimiter }: { file: Opened; delimiter: string }) {
  const header = !file.from;
  const all = useMemo(() => parseTable(file.text ?? "", delimiter, Infinity), [file.text, delimiter]);
  const head = header ? all[0] ?? [] : null;
  const data = (header ? all.slice(1) : all).slice(0, ROWS);
  const parsed = all.length - (header ? 1 : 0);
  const cols = Math.max(head?.length ?? 0, ...data.map((r) => r.length));
  // The daemon counts the lines of the whole file; a later part is counted only as far as it is read.
  const total = file.rows !== undefined ? Math.max(file.rows - (header ? 1 : 0), parsed) : parsed;
  const more = total - data.length;
  return (
    <div data-testid="file-table">
      <table className="w-max min-w-full border-collapse text-caption">
        {head && (
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 border-b border-line bg-sunken px-3 py-1.5" />
              {Array.from({ length: cols }, (_, i) => <th key={i} scope="col" className="sticky top-0 border-b border-line bg-sunken px-3 py-1.5 text-left font-medium text-muted">{head[i]}</th>)}
            </tr>
          </thead>
        )}
        <tbody>
          {data.map((r, n) => (
            <tr key={n} className="hover:bg-hover">
              <td className="border-b border-line px-3 py-1 text-right text-faint tabular-nums">{n + 1}</td>
              {Array.from({ length: cols }, (_, i) => <td key={i} title={r[i]} className="max-w-[24rem] truncate border-b border-line px-3 py-1 font-mono">{r[i]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p data-testid="file-rows" className="p-3 text-caption text-faint">
        {more > 0
          ? `${data.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}${file.rows !== undefined && file.rows_exact === false ? "+" : ""} rows shown, ${more.toLocaleString("en-US")} more not shown.`
          : `${data.length.toLocaleString("en-US")} ${data.length === 1 ? "row" : "rows"}.`}
        {file.truncated && file.rows === undefined ? " This part of the file only." : ""}
      </p>
    </div>
  );
}

function Json({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(100);
  const key = name !== undefined ? <span className="text-muted">{name}: </span> : null;
  if (value === null || typeof value !== "object") {
    const cls = typeof value === "string" ? "th-string" : typeof value === "number" ? "th-number" : "th-literal";
    const text = typeof value === "string" ? JSON.stringify(value.length > 2000 ? `${value.slice(0, 2000)}…` : value) : String(value);
    return <div className="break-all py-px">{key}<span className={cls}>{text}</span></div>;
  }
  const array = Array.isArray(value);
  const entries: [string, unknown][] = array ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const brace = array ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="-ml-4 flex items-center gap-1 rounded-sm py-px text-left hover:bg-hover">
        {open ? <ChevronDown className="size-3 text-faint" /> : <ChevronRight className="size-3 text-faint" />}
        {key}
        <span className="text-faint">{brace[0]}{open ? "" : ` ${entries.length.toLocaleString("en-US")} ${array ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"} ${brace[1]}`}</span>
      </button>
      {open && (
        <div className="pl-4">
          {entries.slice(0, shown).map(([k, v]) => <Json key={k} name={array ? undefined : k} value={v} depth={depth + 1} />)}
          {entries.length > shown && <button type="button" onClick={() => setShown(shown + 500)} className="py-px text-faint hover:text-fg">{(entries.length - shown).toLocaleString("en-US")} more…</button>}
          <div className="-ml-4 pl-4 text-faint">{brace[1]}</div>
        </div>
      )}
    </div>
  );
}

function JsonView({ text }: { text: string }) {
  const parsed = useMemo(() => { try { return { value: JSON.parse(text) as unknown }; } catch (e) { return { error: (e as Error).message }; } }, [text]);
  if ("error" in parsed) return <Note>Not valid JSON, so it is not folded: {parsed.error}</Note>;
  return <div data-testid="file-json" className="p-4 pl-8 font-mono text-caption leading-[1.65]"><Json value={parsed.value} depth={0} /></div>;
}

function Archive({ file }: { file: Opened }) {
  const a = file.archive!;
  return (
    <div data-testid="file-archive">
      <p className="px-4 pb-1 pt-3 text-caption text-faint">
        {a.total.toLocaleString("en-US")} {a.total === 1 ? "entry" : "entries"} in {file.what ?? "archive"}, {fmtSize(file.size)}. Listed by name; nothing is extracted.
      </p>
      <table className="w-full border-collapse text-caption">
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 border-b border-line bg-sunken px-4 py-1.5 text-left font-medium text-muted">Name</th>
            <th scope="col" className="sticky top-0 border-b border-line bg-sunken px-4 py-1.5 text-right font-medium text-muted">Size</th>
          </tr>
        </thead>
        <tbody>
          {a.entries.map((e, i) => (
            <tr key={i} className="hover:bg-hover">
              <td className="border-b border-line px-4 py-1 font-mono"><span className="flex items-center gap-2 break-all">{e.dir && <Folder className="size-3.5 shrink-0 text-faint" />}{e.name}</span></td>
              <td className="whitespace-nowrap border-b border-line px-4 py-1 text-right text-muted tabular-nums">{e.dir ? "" : fmtSize(e.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(a.partial || a.total > a.entries.length) && <p data-testid="file-archive-more" className="p-3 text-caption text-faint">Showing the first {a.entries.length.toLocaleString("en-US")}{a.partial && a.total === a.entries.length ? "; the rest of the archive is not read" : `; ${(a.total - a.entries.length).toLocaleString("en-US")} more not shown`}.</p>}
    </div>
  );
}

// `first` is the file as the daemon gave it when it was opened; a later part is read from the daemon.
export function FileBody({ session, first, line, end }: { session: Session; first: Opened; line?: number; end?: number }) {
  const [file, setFile] = useState(first);
  const [starts, setStarts] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setFile(first); setStarts([]); }, [first]);
  const kind = file.kind ?? (file.binary ? "binary" : "text");
  const local = !session.machine;
  const q = query(session.workspace, file.path);
  const hasPreview = kind === "markdown" || kind === "csv" || kind === "tsv" || kind === "json" || (kind === "html" && !!file.framed && local) || (kind === "image" && !!file.image?.shown && local);
  const [chosen, setChosen] = useState(() => view(kind));
  useEffect(() => setChosen(view(kind)), [kind]);
  // A line a reply linked is shown in the source.
  const show = hasPreview && !line ? chosen : "source";
  const choose = (v: string) => { setChosen(v); try { localStorage.setItem(`keel.files.view.${kind}`, v); } catch { /* not remembered */ } };

  const go = (offset: number, stack: number[]) => {
    setBusy(true);
    api<Opened>(`/api/fs/file?${q}&offset=${offset}`)
      .then((f) => { setFile(f); setStarts(stack); box.current?.closest<HTMLElement>("[data-file-scroll]")?.scrollTo({ top: 0 }); })
      .catch(reportError)
      .finally(() => setBusy(false));
  };
  const more = file.truncated && file.to !== undefined && file.to < file.size;
  const from = file.from ?? 0;

  let body: React.ReactNode;
  if (file.archive) body = <Archive file={file} />;
  else if (kind === "image") {
    const im = file.image;
    body = im?.shown && local && show === "preview"
      ? <div className="p-4"><img src={`/api/fs/raw?${q}`} alt={file.path} data-testid="file-image" className="max-w-full rounded-md border border-line" />{im.w && im.h && <p className="pt-2 text-caption text-faint">{im.w} x {im.h} px</p>}</div>
      : <Note>{im?.shown ? "An image." : `An image of ${fmtSize(file.size)}${im?.w && im.h ? `, ${im.w} x ${im.h} px` : ""}, ${im?.why ?? "not shown"}: it is not drawn here.`} Open it raw to see it.</Note>;
  } else if (file.binary) body = <Note>A {file.what ?? "binary file"}, {fmtSize(file.size)}. It is not read into the page.</Note>;
  else if (show === "preview" && kind === "markdown") body = <div className="px-5 py-4" data-testid="file-markdown"><Markdown text={file.text ?? ""} sessionId={local ? session.id : undefined} /></div>;
  else if (show === "preview" && (kind === "csv" || kind === "tsv")) body = <Table file={file} delimiter={kind === "tsv" ? "\t" : ","} />;
  else if (show === "preview" && kind === "json" && !file.truncated) body = <JsonView text={file.text ?? ""} />;
  else if (show === "preview" && kind === "json") body = <Note>This JSON is larger than one part ({fmtSize(file.size)}), so it is not folded. Open its source to read it in parts.</Note>;
  else if (show === "preview" && kind === "html") {
    // No script, no network, no storage: the frame's own sandbox and the page's policy (src/server/routes/workspace.ts).
    body = <ContentFrame what="page" title={file.path} src={`/api/fs/raw?${q}`} sandbox="" referrerPolicy="no-referrer" className="block h-full min-h-[12rem] w-full bg-white" data-testid="file-frame" />;
  } else body = <CodeView file={file} line={line} end={end} />;

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col" data-testid="file-body" data-kind={kind}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-raised px-3 py-2" data-testid="file-toolbar">
        {hasPreview && <Seg kind="tabs" label="View" value={show} onChange={choose} options={[{ value: "preview", label: "Preview", testid: "file-view-preview" }, ...(kind === "image" ? [] : [{ value: "source", label: "Source", testid: "file-view-source" }])]} />}
        <span className="min-w-0 truncate text-caption text-faint" data-testid="file-kind">{file.what ?? "file"}, {fmtSize(file.size)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {local && <a className={button} href={`/api/fs/raw?${q}&as=text`} target="_blank" rel="noreferrer" data-testid="file-raw"><ExternalLink className="size-3.5" />Raw</a>}
          <button type="button" className={button} data-testid="file-copy" title={file.text !== undefined ? (more || from > 0 ? "Copy this part of the file" : "Copy the file") : "Copy the path"}
            onClick={(e) => copyOrSay(file.text ?? file.path, e.currentTarget).then((ok) => { if (ok) { setSaid("Copied"); setTimeout(() => setSaid(""), 1400); } })}>
            <Copy className="size-3.5" />{said || (file.text !== undefined ? "Copy" : "Copy path")}
          </button>
        </div>
      </div>
      <div className={cn("min-h-0 flex-1 overflow-auto bg-raised", busy && "opacity-60")} data-file-scroll>{body}</div>
      {file.text !== undefined && (more || from > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-raised px-3 py-1.5 text-caption text-faint" data-testid="file-range">
          <button type="button" className={button} aria-label="Previous part" disabled={busy || starts.length === 0} onClick={() => go(starts.at(-1)!, starts.slice(0, -1))}><ChevronLeft className="size-3.5" /></button>
          <button type="button" className={button} aria-label="Next part" disabled={busy || !more} onClick={() => go(file.to!, [...starts, from])}><ChevronRight className="size-3.5" /></button>
          <span className="tabular-nums">Bytes {from.toLocaleString("en-US")} to {(file.to ?? 0).toLocaleString("en-US")} of {file.size.toLocaleString("en-US")} ({fmtSize(file.size)}), one part at a time.</span>
        </div>
      )}
    </div>
  );
}
