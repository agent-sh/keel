// How the session list is arranged: one compact control above it. A filter
// box (title or folder words), and one menu for the rest: grouped by project,
// by the owner's own folders, by working folder or one flat list, sorted by recent work, name or state, finished sessions
// shown or hidden. The arrangement is kept; the filter words are not.
import { Menu } from "@base-ui/react/menu";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { WATCH_RANK, type Watch } from "../lib/watch.ts";
import { cn } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";

export type Arrange = { group: "project" | "mine" | "folder" | "flat"; sort: "recent" | "name" | "state"; hideDone: boolean };
const DEFAULT: Arrange = { group: "folder", sort: "recent", hideDone: false };
const KEY = "keel.listArrange";

let arrange: Arrange = (() => {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return DEFAULT; }
})();
const subs = new Set<() => void>();
export function setArrange(patch: Partial<Arrange>) {
  arrange = { ...arrange, ...patch };
  localStorage.setItem(KEY, JSON.stringify(arrange));
  subs.forEach((f) => f());
}
export const useArrange = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => arrange);

// Every word of the filter is in the title or the folder path.
export const matches = (s: Session, q: string) => {
  const hay = `${s.title || "New session"} ${s.workspace}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};
export const finished = (w: Watch | undefined) => w === "done" || w === "idle";

// The order within a list (and of folders, by their first session).
export function order(a: Arrange, watches: Record<string, Watch>) {
  const name = (s: Session) => s.title || "New session";
  if (a.sort === "name") return (x: Session, y: Session) => name(x).localeCompare(name(y)) || y.updated - x.updated;
  if (a.sort === "state") return (x: Session, y: Session) => WATCH_RANK[watches[x.id] ?? "idle"] - WATCH_RANK[watches[y.id] ?? "idle"] || y.updated - x.updated;
  return (x: Session, y: Session) => y.updated - x.updated;
}

const GROUPS: [Arrange["group"], string][] = [["project", "By project"], ["mine", "By my folders"], ["folder", "By working folder"], ["flat", "One list"]];
const SORTS: { v: Arrange["sort"]; label: string }[] = [
  { v: "recent", label: "Recent activity" },
  { v: "state", label: "State (needs you first)" },
  { v: "name", label: "Name" },
];
const label = "px-2.5 pt-1.5 pb-1 text-micro font-medium uppercase tracking-wide text-faint";

export function ListFind({ q, setQ }: { q: string; setQ: (q: string) => void }) {
  const a = useArrange();
  const changed = a.group !== DEFAULT.group || a.sort !== DEFAULT.sort || a.hideDone !== DEFAULT.hideDone;
  const radio = (on: boolean) => <span className="grid w-3.5 shrink-0 place-items-center">{on && <Check className="size-3.5 text-accent" />}</span>;
  return (
    <div className="k-find" data-testid="list-find">
      <Search aria-hidden="true" className="k-find-icon" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }}
        placeholder="Filter sessions"
        aria-label="Filter sessions by title or folder"
        data-testid="list-filter"
        spellCheck={false}
      />
      {q && <button type="button" className="k-find-btn" aria-label="Clear the filter" onClick={() => setQ("")}><X /></button>}
      <Menu.Root>
        <Menu.Trigger className={cn("k-find-btn", changed && "k-find-on")} data-testid="list-arrange" aria-label="Arrange the list" title="Group, sort and show">
          <SlidersHorizontal />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
            <Menu.Popup className={cn(popupClass, "w-60")} data-testid="arrange-menu">
              <div className={label}>Group</div>
              {GROUPS.map(([g, name]) => (
                <Menu.Item key={g} closeOnClick={false} className={itemClass} data-testid={`arrange-group-${g}`} aria-checked={a.group === g} role="menuitemradio" onClick={() => setArrange({ group: g })}>
                  {radio(a.group === g)}{name}
                </Menu.Item>
              ))}
              <div className={label}>Sort</div>
              {SORTS.map((s) => (
                <Menu.Item key={s.v} closeOnClick={false} className={itemClass} data-testid={`arrange-sort-${s.v}`} aria-checked={a.sort === s.v} role="menuitemradio" onClick={() => setArrange({ sort: s.v })}>
                  {radio(a.sort === s.v)}{s.label}
                </Menu.Item>
              ))}
              <div className="my-1 h-px bg-line" />
              <Menu.Item closeOnClick={false} className={itemClass} data-testid="arrange-hide-done" aria-checked={a.hideDone} role="menuitemcheckbox" onClick={() => setArrange({ hideDone: !a.hideDone })}>
                {radio(a.hideDone)}Hide finished sessions
              </Menu.Item>
              {changed && (
                <Menu.Item className={cn(itemClass, "text-muted")} data-testid="arrange-reset" onClick={() => setArrange(DEFAULT)}>
                  <span className="w-3.5 shrink-0" />Back to the default
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
