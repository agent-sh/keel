// How the session list is arranged: one compact control above it. A filter
// box (title or folder words), and one menu for the rest: grouped by project,
// by the owner's own folders, by working folder or one flat list; sorted by
// when a session was made (the default: a row keeps its place), by name, by
// recent work or by state; a row of one line or of two; finished sessions
// shown or hidden. Above them, how many panes are open (a desk only). The
// arrangement is kept; the filter words are not. The order itself is
// lib/list-order.ts.
import { Menu } from "@base-ui/react/menu";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { DEFAULT, keep, readArrange, type Arrange } from "../lib/list-order.ts";
import type { Watch } from "../lib/watch.ts";
import { cn } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";
import { PaneChoices } from "./Panes.tsx";
import { phone } from "../lib/ui.ts";

export { order, type Arrange } from "../lib/list-order.ts";
const KEY = "keel.listArrange";

// The arrangement the browser keeps, on this version's defaults. A browser
// that ran Keel before is told once, in the menu, that the default changed.
const used = () => { for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)!.startsWith("keel.")) return true; return false; };
let kept = readArrange(localStorage.getItem(KEY), used());
let arrange: Arrange = kept.arrange;
const subs = new Set<() => void>();
// The note is a hint for one load: once it was on screen it is kept as read, and this load still shows it
// (it goes when dismissed, when the menu that says it too was opened, or with the next load).
let seen = false;
const write = (next: typeof kept) => {
  kept = next;
  arrange = next.arrange;
  localStorage.setItem(KEY, keep(seen ? { ...next, note: false } : next));
  subs.forEach((f) => f());
};
// A first visit is on this version from the start: nothing changed for it, so no later load says so.
if (localStorage.getItem(KEY) === null && !kept.note) localStorage.setItem(KEY, keep(kept));
export const setArrange = (patch: Partial<Arrange>) => write({ ...kept, arrange: { ...arrange, ...patch } });
const sub = (f: () => void) => (subs.add(f), () => subs.delete(f));
export const useArrange = () => useSyncExternalStore(sub, () => arrange);
// The note that the default order changed: shown under the counts line and in the menu until it was read.
export const useNote = () => useSyncExternalStore(sub, () => kept.note);
export const readNote = () => { if (kept.note) write({ ...kept, note: false }); };
export const sawNote = () => { if (kept.note && !seen) { seen = true; localStorage.setItem(KEY, keep({ ...kept, note: false })); } };

// Every word of the filter is in the title or the folder path.
export const matches = (s: Session, q: string) => {
  const hay = `${s.title || "New session"} ${s.workspace}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};
export const finished = (w: Watch | undefined) => w === "done" || w === "idle";

const GROUPS: [Arrange["group"], string][] = [["project", "By project"], ["mine", "By my folders"], ["folder", "By working folder"], ["flat", "One list"]];
// The first two keep a row where it is; the last two move it as its session works.
const SORTS: { v: Arrange["sort"]; label: string }[] = [
  { v: "created", label: "Newest first (rows stay put)" },
  { v: "name", label: "Name" },
  { v: "recent", label: "Recent activity" },
  { v: "state", label: "State (needs you first)" },
];
const LINES: { v: Arrange["lines"]; label: string }[] = [
  { v: "one", label: "One line" },
  { v: "two", label: "Two lines, with the reason" },
];
const label = "k-label px-2.5 pt-1.5 pb-1";

export function ListFind({ q, setQ, narrow }: { q: string; setQ: (q: string) => void; narrow?: boolean }) {
  const a = useArrange();
  const note = useNote();
  // The menu opens by its button, and from the note under the counts line.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    addEventListener("keel:arrange", show);
    return () => removeEventListener("keel:arrange", show);
  }, []);
  const changed = a.group !== DEFAULT.group || a.sort !== DEFAULT.sort || a.hideDone !== DEFAULT.hideDone || a.lines !== DEFAULT.lines;
  const radio = (on: boolean) => <span className="grid w-3.5 shrink-0 place-items-center">{on && <Check className="size-3.5 text-accent" />}</span>;
  return (
    <div className="k-find" data-testid="list-find" data-on={q ? "" : undefined}>
      <Search aria-hidden="true" className="k-find-icon" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }}
        placeholder={narrow ? "Filter" : "Filter sessions"}
        aria-label="Filter sessions by title or folder"
        data-testid="list-filter"
        spellCheck={false}
      />
      {q && <button type="button" className="k-find-btn" aria-label="Clear the filter" onClick={() => setQ("")}><X /></button>}
      {/* The note about the changed default is read once: it is gone when the menu that showed it closes. */}
      <Menu.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) readNote(); }}>
        <Menu.Trigger className={cn("k-find-btn", changed && "k-find-on")} data-testid="list-arrange" aria-label="Arrange the panes and the list" title="Panes, group, sort and show">
          <SlidersHorizontal />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
            <Menu.Popup className={cn(popupClass, "w-60")} data-testid="arrange-menu">
              {note && <p className="k-arrange-note" data-testid="arrange-note">Rows now keep their place.</p>}
              {!phone() && <PaneChoices />}
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
              <div className={label}>Rows</div>
              {LINES.map((l) => (
                <Menu.Item key={l.v} closeOnClick={false} className={itemClass} data-testid={`arrange-lines-${l.v}`} aria-checked={a.lines === l.v} role="menuitemradio" onClick={() => setArrange({ lines: l.v })}>
                  {radio(a.lines === l.v)}{l.label}
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
