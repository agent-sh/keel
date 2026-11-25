// Side panels in the Bridge. The Panels picker in a station's header holds
// every panel, grouped and searchable, with the few you use most at hand at
// its top (ranked by use, or kept there on purpose), each named; each panel is
// also a command in the palette. The panel beside the helm is remembered per station.
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ExternalLink, PanelRight, Pin, PinOff, Search, X } from "lucide-react";
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { panels, type Panel } from "../lib/extend.ts";
import { composing, hasCommand, registerCommand } from "../lib/keys.ts";
import { anyNews, useNews } from "../lib/news.ts";
import { canPopOut, dockBack, isPopped, popOut, recover, usePopped } from "../lib/popout.ts";
import { usePanelBeside } from "../lib/rail.ts";
import { getUI, phone, savePref, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

const visible = (s: Session) => panels.all().filter((p) => !p.when || p.when(s)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

// Groups by what the owner is after: the work itself, what happened, how the
// session is set up, and what runs beside it. A panel may name its own group
// and hint; the ones this file knows fall in by id.
const GROUP_OF: Record<string, string> = {
  files: "Work", artifacts: "Work", changes: "Work", review: "Work", terminal: "Work", preview: "Work", tasks: "Work", checkpoints: "Work",
  timeline: "History", tree: "History", traces: "History", usage: "History",
  session: "Setup", profile: "Setup", trust: "Setup", memory: "Setup",
  side: "Beside", helper: "Beside", elsewhere: "Beside", fleet: "Beside", mcp: "Beside", loops: "Beside", machines: "Beside", inbox: "Beside", phone: "Beside",
};
const GROUPS = ["Work", "History", "Setup", "Beside", "More"];
// What each panel is, in a few words beside its name: a one-word name is
// found by what it does. The search matches these words too.
const HINT_OF: Record<string, string> = {
  files: "the folder's files", artifacts: "what this session made", changes: "its edits, turn by turn", review: "the branch's diff, with comments",
  terminal: "a shell in its folder", preview: "the dev servers it runs", tasks: "its task list and goal", checkpoints: "states to go back to",
  timeline: "what it did, newest first", tree: "forks of this conversation", traces: "each turn's requests and calls", usage: "what it cost and why",
  session: "pin, tags, step budget", profile: "model, speed, tools, instructions", trust: "project files it may load", memory: "what it remembers",
  side: "ask without adding to it", helper: "what the helper keeps", elsewhere: "sessions in other agent tools",
};
const groupOf = (p: Panel) => p.group ?? GROUP_OF[p.id] ?? "More";
const hintOf = (p: Panel) => p.hint ?? HINT_OF[p.id] ?? "";

// Use counts and the ones kept at hand on purpose; both stay in this browser.
const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
let use: Record<string, number> = read("keel.panelUse", {});
let kept: string[] = read("keel.panelKept", []);
const subs = new Set<() => void>();
let ver = 0;
const bump = () => { ver++; subs.forEach((f) => f()); };
const usePrefs = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => ver);
function counted(id: string) {
  use = { ...use, [id]: (use[id] ?? 0) + 1 };
  localStorage.setItem("keel.panelUse", JSON.stringify(use));
  bump();
}
function toggleKept(id: string) {
  kept = kept.includes(id) ? kept.filter((k) => k !== id) : [...kept, id];
  localStorage.setItem("keel.panelKept", JSON.stringify(kept));
  bump();
}

export function openPanel(id: string | null) {
  if (id) counted(id);
  savePref("panel", id);
}

// The five panels most sessions need, in the order they start at hand; use and keeping move others in.
const HAND_FIRST = ["review", "board", "changes", "files", "terminal"];
const AT_HAND = HAND_FIRST.length;
// The panels at hand: the kept ones first, then by use, then the five a new owner starts with; the open
// panel is always there. Every other panel is under More.
function atHand(list: Panel[], open: string | null): Panel[] {
  const rank = (p: Panel) => (kept.includes(p.id) ? 1e6 : 0) + (use[p.id] ?? 0) + (HAND_FIRST.includes(p.id) ? (AT_HAND - HAND_FIRST.indexOf(p.id)) / 100 : 0);
  const top = list.filter((p) => rank(p) > 0).sort((a, b) => rank(b) - rank(a) || (a.order ?? 50) - (b.order ?? 50)).slice(0, Math.max(AT_HAND, kept.length));
  const cur = list.find((p) => p.id === open);
  if (cur && !top.includes(cur)) top.push(cur);
  return top;
}

// Every panel is one palette row: this one, unless the panel's own feature registered a `panel-<id>` command
// (its own words, a key), which is then its row (a panel found twice read as two places).
let registered = "";
function registerPanelCommands() {
  const all = panels.all();
  const key = all.map((p) => `${p.id}:${p.label}`).join();
  if (key === registered) return;
  registered = key;
  registerCommand(...all.map((p) => ({ id: `panel.${p.id}`, label: `Open the ${p.label} panel`, group: "Panels", words: `panel ${groupOf(p)} ${hintOf(p)}`, run: () => openPanel(p.id), when: () => getUI().route.name === "session" && !hasCommand(`panel-${p.id}`) })));
}
panels.subscribe(registerPanelCommands);
registerPanelCommands();

// The open panel in a window of its own (the header's button, for the keyboard).
const poppable = () => {
  const { route, panel } = getUI();
  return route.name === "session" && panel && canPopOut && !phone() && !isPopped(route.id, panel) ? { session: route.id, panel } : null;
};
registerCommand({ id: "panel-popout", label: "Pop the side panel out into its own window", group: "View", words: "detach separate dock undock", when: () => !!poppable(), run: () => { const p = poppable(); if (p) popOut(p.session, p.panel); } });

// `title`: the chooser is the open panel's own name in its head (the head says what it is and
// switches it in one place); else the header's Panels button.
function Picker({ list, open, label, testid = "panel-menu", title }: { list: Panel[]; open: string | null; label?: boolean; testid?: string; title?: string }) {
  usePrefs();
  const route = useUI((s) => s.route);
  const sid = route.name === "session" ? route.id : undefined;
  const hasNews = useNews(sid);
  const mark = anyNews(sid, open);
  const [show, setShow] = useState(false);
  const [q, setQ] = useState("");
  // The matches as the list shows them, group by group: Enter takes the one at the top.
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    // A name, group or id matches from its first letters typed; what a panel does matches from three.
    const hits = list.filter((p) => !w || `${p.label} ${groupOf(p)} ${p.id}`.toLowerCase().includes(w) || (w.length >= 3 && hintOf(p).toLowerCase().includes(w)));
    const place = (p: Panel) => (GROUPS.includes(groupOf(p)) ? groupOf(p) : "More"); // a group the picker does not know is listed under More
    // Before a search, the panels at hand head the list, each once.
    const hand = w ? [] : atHand(list, open);
    // A search lists its matches by group; at rest the rest of the panels are one list under More, in their groups' order.
    if (w) return [{ g: "At hand", items: [] as Panel[] }, ...GROUPS.map((g) => ({ g, items: hits.filter((p) => place(p) === g) }))].filter((x) => x.items.length);
    const rest = GROUPS.flatMap((g) => hits.filter((p) => place(p) === g && !hand.includes(p)));
    return [{ g: "At hand", items: hand }, { g: "More", items: rest }].filter((x) => x.items.length);
  }, [list, q, open, ver]);
  // Picking shows the panel; it never closes one (the X and the header toggles do).
  const pick = (id: string) => { openPanel(id); setShow(false); setQ(""); };
  return (
    <Popover.Root open={show} onOpenChange={(o) => { setShow(o); if (!o) setQ(""); }}>
      {title ? (
        <Popover.Trigger className="k-surface-switch" title="Switch to another panel" data-testid={testid}>
          {title}{mark && <span className="k-sum-dot" data-testid="panel-news" title="A panel has news" />}<ChevronDown className="k-surface-switch-more" />
        </Popover.Trigger>
      ) : (
        <Popover.Trigger className="k-hand" data-words={label || undefined} aria-label="Panels" title="Every panel" data-testid={testid}>
          <PanelRight /><span className="k-hand-word">Panels</span>{mark && <span className="k-sum-dot" data-testid="panel-news" title="A panel has news" />}<ChevronDown className="k-hand-more" />
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align={title ? "start" : "end"} className="z-50 outline-none">
          <Popover.Popup className="k-picker" data-testid="panel-picker">
            <label className="k-picker-search">
              <Search className="size-4" />
              <input
                autoFocus
                value={q}
                placeholder="Find a panel"
                aria-label="Find a panel"
                data-testid="panel-search"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { const top = shown[0]?.items[0]; if (e.key === "Enter" && !composing(e) && top) pick(top.id); }}
              />
            </label>
            <div className="k-picker-list k-scroll-more">
              {shown.map(({ g, items }) => {
                return (
                  <section key={g} data-testid={g === "At hand" ? "panels-at-hand" : undefined}>
                    <h3 className="k-picker-group k-label">{g}</h3>
                    {items.map((p) => (
                      <div key={p.id} className={open === p.id ? "k-picker-row k-picked" : "k-picker-row"} aria-current={open === p.id ? "true" : undefined}>
                        <button type="button" className="k-picker-pick" data-testid={`panel-pick-${p.id}`} onClick={() => pick(p.id)}>
                          {p.icon}<span>{p.label}</span>{open !== p.id && hasNews(p.id) && <span className="k-sum-dot" data-testid="panel-news-row" />}<span className="k-picker-hint" data-testid="panel-hint">{hintOf(p)}</span>
                        </button>
                        <button
                          type="button"
                          className="k-picker-keep"
                          aria-pressed={kept.includes(p.id)}
                          aria-label={kept.includes(p.id) ? `Stop keeping ${p.label} at hand` : `Keep ${p.label} at hand`}
                          title={kept.includes(p.id) ? "Kept at hand" : "Keep at hand"}
                          onClick={() => toggleKept(p.id)}
                        >
                          {kept.includes(p.id) ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                        </button>
                      </div>
                    ))}
                  </section>
                );
              })}
              {!shown.length && <p className="k-empty px-2.5 py-3">No panel matches.</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The panels at hand and the rest, for a menu that lists them all.
export function usePanelRows(session: Session): { hand: Panel[]; rest: Panel[] } {
  usePrefs();
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const all = visible(session);
  const hand = atHand(all, open);
  return { hand, rest: all.filter((p) => !hand.includes(p)) };
}

// The Panels chooser, with all of them: it never leaves the header (where the bar has the room for it).
export function PanelsButton({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const list = visible(session);
  return list.length ? <Picker list={list} open={open} /> : null;
}

// Whether the session's panel lies over its conversation now: the conversation
// is then out of reach (SessionView makes it inert) until the sheet is closed.
export function usePanelSheet(session: Session | undefined, on: boolean): boolean {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const beside = usePanelBeside();
  return on && !beside && !!session && visible(session).some((p) => p.id === open);
}

// Whether the session's panel stands beside its conversation now (the pane is then wider).
export function usePanelBesideShown(session: Session | undefined, on: boolean): boolean {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const beside = usePanelBeside();
  return on && beside && !!session && visible(session).some((p) => p.id === open);
}

// The panel of the helm. The bridge says which form it takes (rail.ts decides
// from the room the pane has): beside the conversation, or a sheet over the
// pane. The same element either way, so what it shows outlives a resize.
export function SidePanel({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const list = visible(session);
  const cur = list.find((p) => p.id === open);
  const beside = usePanelBeside();
  // A panel of this session popped out into a window of its own is shown there; its pane says so.
  const popped = usePopped(session.id, open ?? "");
  useEffect(() => { void recover(session.id); }, [session.id]);
  if (!cur) return null;
  const Body = cur.component;
  // Escape in one of the sheet's own one-line fields (a search box) leaves the
  // sheet, as it does from its buttons (builtins.ts). A field in a popup, or a
  // text area with a draft in it, keeps its Escape.
  const leave = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    // An input method's Escape drops the word being composed: it is not the sheet's.
    if (beside || e.key !== "Escape" || composing(e) || e.defaultPrevented || t.tagName !== "INPUT" || !e.currentTarget.contains(t)) return;
    e.preventDefault();
    openPanel(null);
  };
  return (
    <aside data-testid="side-panel" data-panel={cur.id} data-mode={beside ? "beside" : "sheet"} onKeyDown={leave} className="k-side k-surface animate-in">
      <div className="k-surface-head">
        <span className="k-surface-icon">{cur.icon}</span>
        <h2 className="k-surface-title"><Picker list={list} open={open} testid="panel-switch" title={cur.label} /></h2>
        <span className="k-surface-end">
          {canPopOut && !popped && !phone() && (
            <button type="button" aria-label="Pop out the panel" title="Pop out into a window of its own" data-testid="panel-popout" onClick={() => popOut(session.id, cur.id)} className="k-surface-close">
              <ExternalLink />
            </button>
          )}
          <button type="button" aria-label="Close the panel" title="Close the panel (Ctrl \)" onClick={() => openPanel(null)} className="k-surface-close">
            <X />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {popped ? (
          <div className="flex items-center gap-3 px-4 py-3" data-testid="panel-popped">
            <p className="k-empty">In its own window</p>
            <button type="button" className="k-btn" data-testid="panel-dock" onClick={() => dockBack(session.id, cur.id)}>Dock back</button>
          </div>
        ) : (
          <Suspense fallback={null}>
            <Body session={session} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}
