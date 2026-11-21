import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ChevronLeft, Folder, FolderGit2, History } from "lucide-react";
import { useEffect, useState } from "react";
import { api, reportError, failed } from "../lib/store.ts";
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

  useEffect(() => { api("/api/workspaces").then(setInfo).catch(reportError); }, [open]);
  // The repositories under the repo roots and of past sessions (GET /api/fs/repos).
  const [repos, setRepos] = useState<{ name: string; path: string; linked_worktree: boolean }[]>([]);
  useEffect(() => { if (open) api<{ repos: typeof repos }>("/api/fs/repos").then((r) => setRepos(r.repos)).catch(reportError); }, [open]);
  const recentPaths = new Set(info?.recent.map((r) => r.path));
  const q = typed.trim().toLowerCase();
  const repoList = repos.filter((r) => !recentPaths.has(r.path) && (!q || r.path.toLowerCase().includes(q)));
  const shown = value || info?.default || "";
  const home = info?.home ?? "";

  const go = (path: string) => api(`/api/fs/dirs?path=${encodeURIComponent(path)}`).then(setBrowse).catch((e) => setTyped(`${path}: ${failed(e, { at: "WorkspacePicker" })}`));
  const pick = (path: string) => { onChange(path); setOpen(false); setBrowse(null); };

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setBrowse(null); }}>
      <Popover.Trigger
        data-testid="workspace-picker"
        className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 text-ui text-muted shadow-1 hover:text-fg data-popup-open:text-fg"
        title={shown}
      >
        <Folder className="size-3.5 shrink-0 text-accent" />
        <span className="truncate font-medium text-fg">{shown.split("/").pop() || "Folder"}</span>
        <span className="hidden truncate text-faint sm:inline">{tilde(shown.slice(0, shown.lastIndexOf("/")), home)}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className={cn(popupClass, "w-[min(26rem,calc(100vw-1.5rem))] p-0")} data-testid="workspace-popup">
            {!browse ? (
              <div className="p-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-micro font-medium text-faint"><History className="size-3" /> Recent folders</div>
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
                    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-micro font-medium text-faint"><FolderGit2 className="size-3" /> Repositories</div>
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
            <form
              className="border-t border-line p-1.5"
              onSubmit={(e) => { e.preventDefault(); if (typed.trim()) go(typed.trim()); }}
            >
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Type a path, Enter to open it; filters the repositories"
                className="h-8 w-full rounded-sm bg-sunken px-2.5 font-mono text-caption outline-none placeholder:font-sans placeholder:text-faint"
              />
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
