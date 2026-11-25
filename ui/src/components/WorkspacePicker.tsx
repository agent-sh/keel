import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ChevronLeft, CircleAlert, Folder, FolderGit2, History, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type FolderHit, rankFolders, typedPath } from "../../../src/core/folder-match.ts";
import { api, reportError, failed, workspaces } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { popupClass } from "./ui.tsx";

type Dir = { name: string; path: string; is_git: boolean };
type Recent = Dir & { last: number };

const tilde = (p: string, home: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

// The folder a new session works in: recent folders first, then browsing.
export function WorkspacePicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ default: string; home: string; recent: Recent[] } | null>(null);
  const [browse, setBrowse] = useState<{ path: string; parent: string | null; dirs: Dir[]; is_git: boolean } | null>(null);
  const [typed, setTyped] = useState("");
  // Why the last path or name did not open, shown above the field.
  const [error, setError] = useState("");

  useEffect(() => { workspaces<NonNullable<typeof info>>().then(setInfo).catch(reportError); }, [open]);
  // The repositories under the repo roots and of past sessions (GET /api/fs/repos).
  const [repos, setRepos] = useState<{ name: string; path: string; linked_worktree: boolean }[]>([]);
  useEffect(() => { if (open) api<{ repos: typeof repos }>("/api/fs/repos").then((r) => setRepos(r.repos)).catch(reportError); }, [open]);
  const recentPaths = new Set(info?.recent.map((r) => r.path));
  const q = typed.trim();
  // A name is found among the folders (GET /api/fs/find) as it is typed; a path is opened.
  const naming = !!q && !typedPath(q);
  const [found, setFound] = useState<{ q: string; hits: FolderHit[] } | null>(null);
  const asked = useRef<{ q: string; job: Promise<FolderHit[]> } | null>(null);
  const find = (name: string): Promise<FolderHit[]> => {
    if (asked.current?.q === name) return asked.current.job;
    const job = api<{ hits: FolderHit[] }>(`/api/fs/find?q=${encodeURIComponent(name)}`).then((r) => r.hits);
    asked.current = { q: name, job };
    job.then((hits) => setFound((f) => (asked.current?.q === name ? { q: name, hits } : f)), (e) => { if (asked.current?.q === name) asked.current = null; reportError(e); });
    return job;
  };
  useEffect(() => {
    if (!open || !naming) return;
    const t = setTimeout(() => find(q), 120);
    return () => clearTimeout(t);
  }, [open, naming, q]);
  const recentHits = (info?.recent ?? []).map((r): FolderHit => ({ name: r.name, path: r.path, is_git: r.is_git, used: true }));
  const matchesOf = (name: string, hits: FolderHit[]) => rankFolders(name, [...recentHits, ...hits], 20);
  const matches = naming ? matchesOf(q, found?.q === q ? found.hits : []) : [];
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [q]);
  const repoList = repos.filter((r) => !recentPaths.has(r.path));
  const shown = value || info?.default || "";
  const home = info?.home ?? "";

  const go = (path: string) => api(`/api/fs/dirs?path=${encodeURIComponent(path)}`).then((b) => { setError(""); setBrowse(b); }).catch((e) => setError(failed(e, { at: "WorkspacePicker" })));
  const pick = (path: string) => { onChange(path); setOpen(false); setBrowse(null); setTyped(""); setError(""); };
  // Enter: a path opens; a name takes the chosen match, the top one when the
  // list is still on its way, or says that nothing has that name.
  const submit = async () => {
    if (!q) return;
    if (!naming) return go(q);
    const now = found?.q === q ? matches : matchesOf(q, await find(q).catch(() => []));
    const top = now[Math.min(sel, now.length - 1)];
    if (top) pick(top.path);
    else setError(`No folder named \u201c${q}\u201d in your home folder or beside the folders you used. Type its path to open it.`);
  };

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setBrowse(null); setError(""); } }}>
      <Popover.Trigger
        data-testid="workspace-picker"
        className="k-chip-pick"
        title={shown}
      >
        <Folder />
        <span className="k-chip-pick-name">{shown.split("/").pop() || "Folder"}</span>
        {/* Its name; where it is, in the tooltip and the picker's list. */}
        <ChevronDown className="k-chip-pick-more" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-[min(26rem,calc(100vw-1.5rem))] p-0")} data-testid="workspace-popup">
            {!browse && naming ? (
              <div className="p-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 k-label"><Search className="size-3" /> Matching folders</div>
                <div className="max-h-[min(22rem,60vh)] overflow-y-auto" data-testid="folder-matches" role="listbox" aria-label="Matching folders">
                  {matches.map((r, i) => (
                    <button
                      key={r.path}
                      type="button"
                      role="option"
                      aria-selected={i === sel}
                      data-testid="folder-match"
                      onClick={() => pick(r.path)}
                      onMouseMove={() => setSel(i)}
                      className={cn("flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover", i === sel && "bg-hover")}
                    >
                      {r.is_git ? <FolderGit2 className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-faint" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui font-medium">{r.name}</span>
                        <span className="block truncate text-micro text-faint">{tilde(r.path, home)}</span>
                      </span>
                      {r.used ? <span className="shrink-0 text-micro text-faint">used</span> : r.linked_worktree ? <span className="shrink-0 text-micro text-faint">worktree</span> : null}
                    </button>
                  ))}
                  {matches.length === 0 && <p className="k-empty px-3 py-3" data-testid="folder-none">{found?.q === q ? "No folder has that name." : "Looking\u2026"}</p>}
                </div>
              </div>
            ) : !browse ? (
              <div className="p-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 k-label"><History className="size-3" /> Recent folders</div>
                {(info?.recent.length ? info.recent : info ? [{ name: info.default.split("/").pop()!, path: info.default, is_git: false, last: 0 }] : []).map((r) => (
                  <button key={r.path} type="button" onClick={() => pick(r.path)} className={cn("flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover", r.path === shown && "bg-hover")}>
                    {r.is_git ? <FolderGit2 className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-faint" />}
                    <span className="min-w-0">
                      <span className="block truncate text-ui font-medium">{r.name}</span>
                      <span className="block truncate text-micro text-faint">{tilde(r.path, home)}</span>
                    </span>
                  </button>
                ))}
                {repoList.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 k-label"><FolderGit2 className="size-3" /> Repositories</div>
                    <div className="max-h-56 overflow-y-auto" data-testid="repo-list">
                      {repoList.map((r) => (
                        <button key={r.path} type="button" onClick={() => pick(r.path)} className={cn("flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover", r.path === shown && "bg-hover")}>
                          <FolderGit2 className="size-4 shrink-0 text-faint" />
                          <span className="truncate text-ui">{r.name}</span>
                          <span className="ml-auto truncate text-micro text-faint">{r.linked_worktree ? "worktree " : ""}{tilde(r.path.slice(0, r.path.lastIndexOf("/")), home)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="my-1 h-px bg-line" />
                <button type="button" data-testid="browse-folders" onClick={() => go(shown || home)} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-ui text-muted hover:bg-hover hover:text-fg">
                  <Folder className="size-4 text-faint" /> Browse folders
                </button>
              </div>
            ) : (
              <div className="flex max-h-[min(26rem,70vh)] flex-col">
                <div className="flex items-center gap-1 border-b border-line p-1.5">
                  <button type="button" aria-label="Up one folder" disabled={!browse.parent} onClick={() => browse.parent && go(browse.parent)} className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg disabled:opacity-30">
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={browse.path}>{tilde(browse.path, home)}</span>
                  <button type="button" data-testid="use-folder" onClick={() => pick(browse.path)} className="h-7 shrink-0 rounded-sm bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover">
                    Use this folder
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {browse.dirs.length === 0 && <p className="k-empty px-3 py-4">No folders inside.</p>}
                  {browse.dirs.map((d) => (
                    <button key={d.path} type="button" onClick={() => go(d.path)} onDoubleClick={() => pick(d.path)} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui hover:bg-hover">
                      {d.is_git ? <FolderGit2 className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-faint" />}
                      <span className="truncate">{d.name}</span>
                      {d.is_git && <span className="ml-auto text-micro text-faint">git</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {error && (
              <p role="alert" data-testid="folder-error" className="flex items-start gap-1.5 border-t border-line bg-danger-soft px-2.5 py-1.5 text-caption text-danger">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">{error}</span>
              </p>
            )}
            <form
              className="border-t border-line p-1.5"
              onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void submit(); }}
            >
              <input
                value={typed}
                data-testid="folder-find"
                aria-label="Find a folder by name, or type a path"
                onChange={(e) => { const v = e.target.value; setTyped(v); setError(""); if (v.trim() && !typedPath(v)) setBrowse(null); }}
                onKeyDown={(e) => {
                  if (!naming || !matches.length) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, matches.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
                }}
                placeholder={matchMedia("(pointer: coarse)").matches ? "Find a folder by name, or type a path" : "Find a folder by name, or type a path; Enter opens it"}
                className="h-8 w-full rounded-sm bg-sunken px-2.5 font-mono text-caption outline-none placeholder:font-sans placeholder:text-faint"
              />
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
