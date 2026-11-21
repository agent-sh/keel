// Side panels in the Bridge. A station's header keeps the few panels you use
// most at hand (ranked by use, or kept there on purpose); every panel, grouped
// and searchable, is one click away in the Panels picker, and each is a
// command in the palette. The panel beside the helm is remembered per station.
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, PanelRight, Pin, PinOff, Search, X } from "lucide-react";
import { Suspense, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { panels, type Panel } from "../lib/extend.ts";
import { composing, registerCommand } from "../lib/keys.ts";
import { usePanelBeside } from "../lib/rail.ts";
import { getUI, phone, savePref, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

const visible = (s: Session) => panels.all().filter((p) => !p.when || p.when(s)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

// Groups by what a panel is for. A panel may name its own group; others fall in by id.
const GROUP_OF: Record<string, string> = {
  changes: "Work", files: "Work", review: "Work", tree: "Work", preview: "Work", tasks: "Work", checkpoints: "Work",
  side: "Context", usage: "Context", profile: "Context", trust: "Context", memory: "Context",
  elsewhere: "Reach", fleet: "Reach", mcp: "Reach", loops: "Reach", machines: "Reach", inbox: "Reach", phone: "Reach",
};
const GROUPS = ["Work", "Context", "Reach", "More"];
const groupOf = (p: Panel) => (p as Panel & { group?: string }).group ?? GROUP_OF[p.id] ?? "More";

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

const AT_HAND = 3;
// Kept ones first, then by use, then the registry's order; the open panel is always there.
function atHand(list: Panel[], open: string | null): Panel[] {
  const rank = (p: Panel) => (kept.includes(p.id) ? 1e6 : 0) + (use[p.id] ?? 0);
  const top = [...list].sort((a, b) => rank(b) - rank(a) || (a.order ?? 50) - (b.order ?? 50)).slice(0, Math.max(AT_HAND, kept.length));
  const cur = list.find((p) => p.id === open);
  if (cur && !top.includes(cur)) top.push(cur);
  return list.filter((p) => top.includes(p));
}

// Every panel is a palette command.
let registered = "";
function registerPanelCommands() {
  const all = panels.all();
  const key = all.map((p) => p.id).join();
  if (key === registered) return;
  registered = key;
  registerCommand(...all.map((p) => ({ id: `panel.${p.id}`, label: `Open the ${p.label} panel`, group: "Panels", words: `panel ${groupOf(p)}`, run: () => openPanel(p.id), when: () => getUI().route.name === "session" })));
}
panels.subscribe(registerPanelCommands);
registerPanelCommands();

function Picker({ list, open, label, testid = "panel-menu" }: { list: Panel[]; open: string | null; label?: boolean; testid?: string }) {
  usePrefs();
  const [show, setShow] = useState(false);
  const [q, setQ] = useState("");
  // The matches as the list shows them, group by group: Enter takes the one at the top.
  const shown = useMemo(() => {
    const w = q.trim().toLowerCase();
    const hits = list.filter((p) => !w || `${p.label} ${groupOf(p)} ${p.id}`.toLowerCase().includes(w));
    const place = (p: Panel) => (GROUPS.includes(groupOf(p)) ? groupOf(p) : "More"); // a group the picker does not know is listed under More
    return GROUPS.map((g) => ({ g, items: hits.filter((p) => place(p) === g) })).filter((x) => x.items.length);
  }, [list, q]);
  // Picking shows the panel; it never closes one (the X and the header toggles do).
  const pick = (id: string) => { openPanel(id); setShow(false); setQ(""); };
  return (
    <Popover.Root open={show} onOpenChange={(o) => { setShow(o); if (!o) setQ(""); }}>
      <Popover.Trigger className="k-hand" data-words={label || undefined} aria-label="Panels" title="Every panel" data-testid={testid}>
        <PanelRight /><span className="k-hand-word">Panels</span><ChevronDown className="k-hand-more" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50 outline-none">
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
                  <section key={g}>
                    <h3 className="k-picker-group">{g}</h3>
                    {items.map((p) => (
                      <div key={p.id} className="k-picker-row" aria-current={open === p.id ? "true" : undefined}>
                        <button type="button" className="k-picker-pick" data-testid={`panel-pick-${p.id}`} onClick={() => pick(p.id)}>
                          {p.icon}<span>{p.label}</span>
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

// The header's shortcuts: the panels at hand. They show while the row has room
// for them; the chooser below holds every panel either way.
export function PanelHand({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  usePrefs();
  const open = useUI((s) => s.panel);
  if (phone()) return null;
  return (
    <>
      {atHand(visible(session), open).map((p) => (
        <button
          key={p.id}
          type="button"
          title={p.label}
          aria-label={p.label}
          aria-pressed={open === p.id}
          data-testid={`panel-toggle-${p.id}`}
          onClick={() => openPanel(open === p.id ? null : p.id)}
          className="k-hand"
        >
          {p.icon}<span className="k-hand-word">{p.label}</span>
        </button>
      ))}
    </>
  );
}

// The Panels chooser, with all of them: it never leaves the header.
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

// The panel of the helm. The bridge says which form it takes (rail.ts decides
// from the room the pane has): beside the conversation, or a sheet over the
// pane. The same element either way, so what it shows outlives a resize.
export function SidePanel({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const list = visible(session);
  const cur = list.find((p) => p.id === open);
  const beside = usePanelBeside();
  if (!cur) return null;
  const Body = cur.component;
  // Escape in one of the sheet's own one-line fields (a search box) leaves the
  // sheet, as it does from its buttons (builtins.ts). A field in a popup, or a
  // text area with a draft in it, keeps its Escape.
  const leave = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (beside || e.key !== "Escape" || e.defaultPrevented || t.tagName !== "INPUT" || !e.currentTarget.contains(t)) return;
    e.preventDefault();
    openPanel(null);
  };
  return (
    <aside data-testid="side-panel" data-panel={cur.id} data-mode={beside ? "beside" : "sheet"} onKeyDown={leave} className="k-side k-surface animate-in">
      <div className="k-surface-head">
        <span className="k-surface-icon">{cur.icon}</span>
        <h2 className="k-surface-title">{cur.label}</h2>
        <span className="k-surface-end">
          <Picker list={list} open={open} label testid="panel-switch" />
          <button type="button" aria-label="Close the panel" title="Close the panel (Ctrl \)" onClick={() => openPanel(null)} className="k-surface-close">
            <X />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <Body session={session} />
        </Suspense>
      </div>
    </aside>
  );
}
