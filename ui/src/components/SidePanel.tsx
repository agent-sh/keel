// Side panels in the Bridge. A station's header keeps the few panels you use
// most at hand (ranked by use, or kept there on purpose); every panel, grouped
// and searchable, is one click away in the Panels picker, and each is a
// command in the palette. The panel beside the helm is remembered per station.
import { Popover } from "@base-ui/react/popover";
import { LayoutPanelLeft, Pin, PinOff, Search, X } from "lucide-react";
import { Suspense, useMemo, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { panels, type Panel } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { usePanelSide } from "../lib/rail.ts";
import { getUI, phone, savePref, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { iconButton } from "./ui.tsx";

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
  const hits = useMemo(() => {
    const w = q.trim().toLowerCase();
    return list.filter((p) => !w || `${p.label} ${groupOf(p)} ${p.id}`.toLowerCase().includes(w));
  }, [list, q]);
  // Picking shows the panel; it never closes one (the X and the header toggles do).
  const pick = (id: string) => { openPanel(id); setShow(false); setQ(""); };
  return (
    <Popover.Root open={show} onOpenChange={(o) => { setShow(o); if (!o) setQ(""); }}>
      <Popover.Trigger className={cn(iconButton, "k-panels-btn", label && "w-auto gap-1.5 px-2")} aria-label="Panels" title="Panels" data-testid={testid}>
        <LayoutPanelLeft className="size-4" />{label && <span>Panels</span>}
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
                onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) pick(hits[0].id); }}
              />
            </label>
            <div className="k-picker-list">
              {GROUPS.map((g) => {
                const items = hits.filter((p) => groupOf(p) === g);
                if (!items.length) return null;
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
              {!hits.length && <p className="k-picker-empty">No panel matches.</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The header: the panels at hand, then the picker with all of them.
export function PanelToggles({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  usePrefs();
  const open = useUI((s) => s.panel);
  const list = visible(session);
  if (!list.length) return null;
  const hand = phone() ? [] : atHand(list, open);
  return (
    <>
      {hand.map((p) => (
        <button
          key={p.id}
          type="button"
          title={p.label}
          aria-label={p.label}
          aria-pressed={open === p.id}
          data-testid={`panel-toggle-${p.id}`}
          onClick={() => openPanel(open === p.id ? null : p.id)}
          className={cn(iconButton, open === p.id && "bg-hover text-fg")}
        >
          {p.icon}
        </button>
      ))}
      <Picker list={list} open={open} />
    </>
  );
}

// The panel of the helm. The bridge says which form it takes (rail.ts decides
// from the room the pane has): beside the conversation, or a sheet over the
// pane. The same element either way, so what it shows outlives a resize.
export function SidePanel({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const list = visible(session);
  const cur = list.find((p) => p.id === open);
  const { beside } = usePanelSide();
  if (!cur) return null;
  const Body = cur.component;
  return (
    <aside data-testid="side-panel" data-panel={cur.id} data-mode={beside ? "beside" : "sheet"} className="k-side flex min-h-0 flex-col bg-panel animate-in">
      <div className="k-side-head">
        <span className="k-side-icon">{cur.icon}</span>
        <h2 className="k-side-title">{cur.label}</h2>
        <span className="ml-auto" />
        <Picker list={list} open={open} label testid="panel-switch" />
        <button type="button" aria-label="Close the panel" title="Close the panel (Ctrl \)" onClick={() => openPanel(null)} className={iconButton}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <Body session={session} />
        </Suspense>
      </div>
    </aside>
  );
}
