import { Dialog } from "@base-ui/react/dialog";
import { Bot, CornerDownLeft, Search, TextSearch, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { allCommands, commandsVersion, fuzzy, onCommands } from "../lib/keys.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { switchSession } from "../lib/switch.ts";
import { navigate, setUI, useUI } from "../lib/ui.ts";
import { ago, cn } from "../lib/utils.ts";
import { useWatches, WATCH_LABEL } from "../lib/watch.ts";
import { Kbd } from "./Kbd.tsx";
import { Mark } from "./Mark.tsx";

type Hit = { session_id: string; session_title: string; event_id?: string; kind: string; snippet: string };
type Entry = { key: string; group: string; label: ReactNode; detail?: string; keys?: string; icon: ReactNode; score: number; run: () => void };

// A search snippet: \u0001 and \u0002 mark the matched words.
function Snippet({ text }: { text: string }) {
  let t = text.replace(/\s+/g, " ");
  const at = t.indexOf("\u0001");
  if (at > 36) t = "…" + t.slice(at - 28).replace(/^\S*\s/, ""); // keep the match in view
  const parts = t.split(/(\u0001[^\u0002]*\u0002)/);
  return <>{parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i} className="rounded-xs bg-brass-soft px-0.5 text-fg">{p.slice(1, -1)}</mark> : p))}</>;
}

export function Palette() {
  const open = useUI((s) => s.palette);
  const route = useUI((s) => s.route);
  const sessions = useStore((s) => s.sessions);
  const models = useStore((s) => s.models);
  const live = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const watches = useWatches(live);
  useSyncExternalStore(onCommands, commandsVersion);
  const [q, setQ] = useState("");
  // The highlighted row by its key: rows that arrive later (a search answer)
  // never move the highlight to another result.
  const [selKey, setSelKey] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = route.name === "session" ? sessions[route.id] : undefined;

  // The daemon's answer for one query: rows of an older query are never shown
  // or opened under a newer one.
  const [search, setSearch] = useState<{ q: string; hits: Hit[]; failed?: string }>({ q: "", hits: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (open) { setQ(""); setSelKey(null); setSearch({ q: "", hits: [] }); } }, [open]);
  const wantsSearch = q.trim().length >= 2;
  // What was said in any session, from the daemon's index.
  useEffect(() => {
    if (!wantsSearch) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`, { signal: ctl.signal })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body });
          setSearch({ q, hits: (body.hits ?? []).filter((h: Hit) => h.event_id) });
        })
        .catch((e) => {
          if (e.name === "AbortError") return;
          reportError(e, { kind: "search" });
          setSearch({ q, hits: [], failed: e.message });
        });
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, wantsSearch, attempt]);
  const searching = wantsSearch && search.q !== q;
  const hits = search.q === q ? search.hits : [];
  const searchFailed = wantsSearch && search.q === q ? search.failed : undefined;

  const entries = useMemo(() => {
    const out: Entry[] = [];
    const recent = Object.values(sessions).filter((s) => !s.archived).sort((a, b) => b.updated - a.updated);
    const w = watches;
    for (const s of q ? recent : recent.slice(0, 6)) {
      const score = fuzzy(q, `${s.title} ${s.workspace}`);
      if (score > 0) out.push({
        key: `s:${s.id}`, group: "Sessions", label: s.title || "New session", detail: `${s.workspace.split("/").pop()}  ${ago(s.updated)}`,
        icon: <span className="grid size-4 place-items-center" title={WATCH_LABEL[w[s.id] ?? "idle"]}><Mark w={w[s.id] ?? "idle"} className="size-2" /></span>, score: score + 5, run: () => navigate({ name: "session", id: s.id }),
      });
    }
    for (const c of allCommands()) {
      if (c.id === "palette") continue;
      const score = fuzzy(q, `${c.label} ${c.words ?? ""} ${c.group ?? ""}`);
      if (score > 0) out.push({ key: `c:${c.id}`, group: "Actions", label: c.label, keys: c.keys, icon: c.icon ?? <Zap className="size-4" />, score, run: c.run });
    }
    if (q) {
      for (const m of models) {
        const score = fuzzy(q, `${m.name} ${m.id}`);
        if (score > 0) out.push({
          key: `m:${m.id}`, group: "Models", label: current ? `Switch to ${m.name}` : `Start with ${m.name}`, detail: m.provider,
          icon: <Bot className="size-4" />, score: score - 1,
          run: () => (current ? switchSession(current.id, { model: m.id }).catch(reportError) : setUI({ newModel: m.id })),
        });
      }
    }
    for (const [i, h] of hits.entries()) {
      out.push({
        key: `h:${h.event_id}`, group: "In conversations", detail: h.session_title || "New session",
        label: <Snippet text={h.snippet} />, icon: <TextSearch className="size-4" />, score: 50 - i,
        // Read it where it is: another branch is previewed, the session's own branch stays.
        run: () => { setUI({ focusEvent: h.event_id!, preview: { session: h.session_id, event: h.event_id! } }); navigate({ name: "session", id: h.session_id }); },
      });
    }
    const order = ["Sessions", "Actions", "In conversations", "Models"];
    if (q) out.sort((a, b) => b.score - a.score);
    // Keep groups together, ordered by their best hit.
    const best = new Map<string, number>();
    out.forEach((e, i) => best.has(e.group) || best.set(e.group, i));
    return out.sort((a, b) => (q ? best.get(a.group)! - best.get(b.group)! : order.indexOf(a.group) - order.indexOf(b.group))).slice(0, 60);
  }, [q, sessions, models, current, hits, watches]);

  useEffect(() => setSelKey(null), [q]);
  // The highlight stays on its row while it is listed, else it is the first row.
  const found = selKey ? entries.findIndex((e) => e.key === selKey) : -1;
  const sel = found >= 0 ? found : entries.length ? 0 : -1;
  const active = sel >= 0 ? entries[sel] : undefined;
  const optId = (e: Entry) => `palette-opt-${e.key.replace(/[^\w-]/g, "_")}`;
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const move = (by: number) => {
    if (!entries.length) return;
    setSelKey(entries[Math.max(0, Math.min(entries.length - 1, (sel < 0 ? 0 : sel) + by))]!.key);
  };

  const pick = (e?: Entry) => {
    if (!e) return;
    setUI({ palette: false });
    e.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => setUI({ palette: o })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="palette"
          aria-label="Search and commands"
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 flex max-h-[min(34rem,76vh)] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden",
            "rounded-xl border border-line bg-raised shadow-3 outline-none",
            "transition-[opacity,scale] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:opacity-0",
          )}
        >
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-faint" />
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-autocomplete="list"
              aria-activedescendant={active ? optId(active) : undefined}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search sessions, actions and models"
              data-testid="palette-input"
              className="h-13 w-full bg-transparent text-[15px] outline-none placeholder:text-faint"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
                if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
                if (e.key === "Enter") { e.preventDefault(); pick(active); }
              }}
            />
          </div>
          <div ref={list} id="palette-list" className="flex-1 overflow-y-auto overscroll-contain p-1.5" role="listbox" aria-label="Results" aria-busy={searching || undefined}>
            {entries.length === 0 && !searching && !searchFailed && <p className="px-3 py-8 text-center text-ui text-faint">Nothing matches "{q}".</p>}
            {entries.map((e, i) => (
              <div key={e.key}>
                {(i === 0 || entries[i - 1]!.group !== e.group) && (
                  <div className="px-2.5 pb-1 pt-2.5 text-micro font-medium text-faint first:pt-1">{e.group}</div>
                )}
                <div
                  role="option"
                  id={optId(e)}
                  data-i={i}
                  aria-selected={i === sel}
                  onMouseMove={() => sel !== i && setSelKey(e.key)}
                  onClick={() => pick(e)}
                  className={cn("flex h-9 items-center gap-3 rounded-md px-2.5 text-[13.5px]", i === sel ? "bg-hover text-fg" : "text-muted")}
                >
                  <span className={i === sel ? "text-accent" : "text-faint"}>{e.icon}</span>
                  <span className="min-w-0 truncate text-fg">{e.label}</span>
                  {e.detail && <span className="min-w-0 max-w-[40%] shrink-0 truncate text-caption text-faint">{e.detail}</span>}
                  <span className="ml-auto flex shrink-0 items-center">
                    {e.keys ? <Kbd keys={e.keys} /> : i === sel ? <CornerDownLeft className="size-3.5 text-faint" /> : null}
                  </span>
                </div>
              </div>
            ))}
            {searching && (
              <p className="flex items-center gap-2 px-2.5 py-2.5 text-caption text-faint" data-testid="palette-searching">
                <TextSearch className="size-3.5 animate-pulse-dot" /> Searching conversations
              </p>
            )}
            {searchFailed && (
              <div className="mx-1 mt-1.5 flex items-center gap-2.5 rounded-md border border-warn/40 px-2.5 py-2 text-caption" role="status" data-testid="palette-search-failed">
                <span className="min-w-0 flex-1 text-muted">Conversation search is unavailable: <span className="text-fg">{searchFailed}</span></span>
                <button type="button" data-testid="palette-search-retry" onClick={() => { setSearch({ q: "", hits: [] }); setAttempt((n) => n + 1); }}
                  className="h-7 shrink-0 rounded-md px-2.5 font-medium text-accent-ink hover:bg-accent-soft">Retry</button>
              </div>
            )}
          </div>
          <div className="hidden items-center gap-4 border-t border-line px-4 py-2 text-micro text-faint sm:flex">
            <span className="flex items-center gap-1.5"><Kbd keys="↑" /><Kbd keys="↓" /> move</span>
            <span className="flex items-center gap-1.5"><Kbd keys="enter" /> open</span>
            <span className="flex items-center gap-1.5"><Kbd keys="escape" /> close</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
