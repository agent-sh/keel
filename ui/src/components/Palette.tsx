import { Dialog } from "@base-ui/react/dialog";
import { Archive, Bot, CornerDownLeft, History, Search, SquareTerminal, TextSearch, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { allCommands, commandsVersion, composing, fuzzy, onCommands } from "../lib/keys.ts";
import { actions, reportError, useStore, useModels } from "../lib/store.ts";
import { switchSession } from "../lib/switch.ts";
import { navigate, setUI, useUI } from "../lib/ui.ts";
import { openWaiting } from "./HomeWatch.tsx";
import { modalOpen } from "../lib/overlay.ts";

// Opens a session as the home screen does: the keyboard goes to what the session asks, on its
// card and on no answer. The session opens at once; the keyboard is brought to the card when the
// palette itself is out of the way (a card takes none under a dialog).
function openSession(id: string) {
  navigate({ name: "session", id });
  let frames = 0;
  const go = () => { if (modalOpen() && ++frames < 60) requestAnimationFrame(go); else openWaiting(id); };
  requestAnimationFrame(go);
}
import { ago, clock, cn, folderNames } from "../lib/utils.ts";
import { useStateLabel, useWatches } from "../lib/watch.ts";
import { machineName } from "../lib/fleet.ts";
import { openImport } from "../lib/integrations-ui.ts";
import { Kbd } from "./Kbd.tsx";
import { Mark } from "./Mark.tsx";

type Hit = { session_id: string; session_title: string; event_id?: string; kind: string; snippet: string; cwd: string; archived: boolean; ts: number; ref?: string; partial?: boolean };
// A session of another harness on this machine (Claude Code, Codex...) that the search found, not imported yet.
type Elsewhere = { harness: string; id: string; path: string; title: string; cwd?: string; updated_ms: number; in_text?: true; imported?: unknown };
// `stay`: picking it keeps the palette open (it adds rows to it).
type Entry = { key: string; group: string; label: ReactNode; detail?: string; keys?: string; icon: ReactNode; score: number; run: () => void; stay?: true };

// A search snippet: \u0001 and \u0002 mark the matched words.
function Snippet({ text }: { text: string }) {
  let t = text.replace(/\s+/g, " ");
  const at = t.indexOf("\u0001");
  if (at > 36) t = "…" + t.slice(at - 28).replace(/^\S*\s/, ""); // keep the match in view
  const parts = t.split(/(\u0001[^\u0002]*\u0002)/);
  return <>{parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i} className="rounded-xs bg-brass-soft px-0.5 text-fg">{p.slice(1, -1)}</mark> : p))}</>;
}

// A hit in an archived session says so before it is opened (opening it reads, it does not restore).
const Archived = () => <span className="ml-2 rounded-xs bg-sunken px-1 py-px text-micro font-medium text-muted" data-testid="hit-archived">Archived</span>;

export function Palette() {
  const open = useUI((s) => s.palette);
  // Where the keyboard was when the palette opened. Closed with no pick (Escape, a press beside
  // it) the keyboard goes back there, if that is still on the page. Left to the dialog, it went
  // to the button of whatever menu or panel was opened last, however long ago that had closed.
  // After a pick the command says where the keyboard goes: nothing is put back.
  const from = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  const picked = useRef(false);
  if (open && !wasOpen.current) { from.current = document.activeElement; picked.current = false; }
  wasOpen.current = open;
  const route = useUI((s) => s.route);
  const sessions = useStore((s) => s.sessions);
  const models = useModels();
  const live = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const watches = useWatches(live);
  const label = useStateLabel();
  useSyncExternalStore(onCommands, commandsVersion);
  const [q, setQ] = useState("");
  // The highlighted row by its key: rows that arrive later (a search answer)
  // never move the highlight to another result.
  const [selKey, setSelKey] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = route.name === "session" ? sessions[route.id] : undefined;

  // The daemon's answer for one query: rows of an older query are never shown
  // or opened under a newer one.
  // `limits`: what the daemon limited the search to, in words (in:commands, since:yesterday, state:failed in the query).
  // `refused`: a limit in the query was not understood; the daemon's words say what its name takes.
  const [search, setSearch] = useState<{ q: string; hits: Hit[]; failed?: string; refused?: string; limits?: string[] }>({ q: "", hits: [] });
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
          // A limit that is half typed or misspelled is a hint to the person typing, not a failure.
          if (r.status === 400 && body.limit) return setSearch({ q, hits: [], refused: String(body.error ?? "") });
          if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body });
          setSearch({ q, hits: body.hits ?? [], limits: body.limits });
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
  const searchRefused = wantsSearch && search.q === q ? search.refused : undefined;
  const limits = wantsSearch && search.q === q ? search.limits : undefined;

  // This daemon's own rows: its sessions, what was said in them, its actions and models.
  const local = useMemo(() => {
    const out: Entry[] = [];
    const recent = Object.values(sessions).filter((s) => !s.archived).sort((a, b) => b.updated - a.updated);
    const w = watches;
    const listed = q ? recent : recent.slice(0, 6);
    // Folders read apart where their last parts are the same (alpha/api, beta/api).
    const names = folderNames([...listed.map((s) => s.workspace), ...hits.map((h) => h.cwd)]);
    const seen = new Set<string>();
    for (const s of listed) {
      const score = fuzzy(q, `${s.title} ${s.workspace}`);
      if (score > 0) {
        seen.add(s.id);
        out.push({
          key: `s:${s.id}`, group: s.machine ? `Sessions on ${machineName(s.machine) ?? s.machine}` : "Sessions", label: s.title || "New session", detail: `${names.get(s.workspace)}  ${ago(s.updated)}`,
          icon: <span className="grid size-4 place-items-center" title={label(s.id, w[s.id] ?? "idle")}><Mark w={w[s.id] ?? "idle"} className="size-2" /></span>, score: score + 5,
          run: () => openSession(s.id),
        });
      }
    }
    // A title or folder the daemon matched that is not listed here (archived, not loaded): opened to read, not restored.
    for (const [i, h] of hits.entries()) {
      if (h.kind !== "title" || seen.has(h.session_id)) continue;
      seen.add(h.session_id);
      out.push({
        key: `t:${h.session_id}`, group: "Sessions", label: <>{h.session_title || "New session"}{h.archived && <Archived />}</>, detail: `${names.get(h.cwd)}  ${ago(h.ts)}`,
        icon: h.archived ? <Archive className="size-4" /> : <TextSearch className="size-4" />, score: 40 - i, run: () => navigate({ name: "session", id: h.session_id }),
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
    // A row's key is its own: a command and its output are two hits of one event and one call.
    // Two rows with one key would leave the first on the page under every later query.
    const keyed = new Set<string>();
    for (const [i, h] of hits.entries()) {
      if (!h.event_id) continue;
      const tool = h.kind === "tool_use" || h.kind === "tool_result";
      const where = `${h.session_title || "New session"} · ${names.get(h.cwd)}`;
      const key = `h:${h.event_id}:${h.kind}:${h.ref ?? ""}`;
      if (keyed.has(key)) continue;
      keyed.add(key);
      out.push({
        key, group: "In conversations",
        // When it happened first: a hit is a moment of a session.
        detail: `${clock(h.ts, { date: true })} · ${h.archived ? "Archived · " : ""}${tool ? (h.kind === "tool_use" ? "Command · " : "Tool output · ") : h.kind === "summary" ? "Summary · " : ""}${where}${h.partial ? " · first part searched" : ""}`,
        label: <><Snippet text={h.snippet} />{h.archived && <Archived />}</>, icon: tool ? <SquareTerminal className="size-4" /> : <TextSearch className="size-4" />, score: 50 - i,
        // Read it where it is: another branch is previewed, the session's own branch stays; a tool hit opens its card.
        run: () => { setUI({ focusEvent: h.event_id!, focusCall: tool ? h.ref ?? null : null, preview: { session: h.session_id, event: h.event_id! } }); navigate({ name: "session", id: h.session_id }); },
      });
    }
    return out;
  }, [q, sessions, models, current, hits, watches]);

  // The same words in other harnesses' sessions on this machine, in what they say too (a read of their
  // transcripts, once the typing pauses). `not`: the harnesses whose conversations could not be read.
  const [elsewhere, setElsewhere] = useState<{ q: string; rows: Elsewhere[]; labels: Record<string, string>; not: string[]; failed?: string }>({ q: "", rows: [], labels: {}, not: [] });
  // That read goes through every transcript of every other harness here (gigabytes, in a process of
  // its own): it is made when the owner asks for it (`asked`: the query of the row that offers it), or
  // when nothing of this daemon matches once its own search has answered; never for every query typed.
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => { if (open) setAsked(null); }, [open]);
  const mayElsewhere = q.trim().length >= 3 && !/\b\w+:\S/.test(q);
  // (A command is a hit too: typing one to run it starts no search of other harnesses.)
  const localHit = local.some((e) => e.group.startsWith("Sessions") || e.group === "In conversations" || e.group === "Actions");
  const wantsElsewhere = mayElsewhere && (asked === q || (!searching && !searchFailed && !localHit));
  useEffect(() => {
    if (!wantsElsewhere) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/import/sessions?q=${encodeURIComponent(q.trim())}&inside=1&limit=6`, { signal: ctl.signal })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
          const stores = (body.harnesses ?? []) as { harness: string; label: string; installed: boolean }[];
          const labels = Object.fromEntries(stores.map((h) => [h.harness, h.label]));
          // (Only a store this machine has: a harness never installed here holds nothing to miss.)
          const not = ((body.inside?.not ?? []) as string[]).filter((h) => stores.find((x) => x.harness === h)?.installed);
          setElsewhere({ q, rows: ((body.sessions ?? []) as Elsewhere[]).filter((x) => !x.imported), labels, not });
        })
        .catch((e) => { if (e.name !== "AbortError") setElsewhere({ q, rows: [], labels: {}, not: [], failed: e.message }); });
    }, 400);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, wantsElsewhere]);
  const others = wantsElsewhere && elsewhere.q === q ? elsewhere.rows : [];
  const seekingElsewhere = wantsElsewhere && elsewhere.q !== q;
  const elsewhereFailed = wantsElsewhere && elsewhere.q === q ? elsewhere.failed : undefined;

  const entries = useMemo(() => {
    const out = [...local];
    // Sessions of other harnesses: opened in the import sheet, picked, with the words that found them.
    for (const [i, x] of others.entries()) {
      out.push({
        key: `x:${x.harness}:${x.path}`, group: "Other harnesses", label: x.title || "Session",
        detail: `${elsewhere.labels[x.harness] ?? x.harness} · ${x.in_text ? "in the conversation · " : ""}${folderNames([x.cwd ?? ""]).get(x.cwd ?? "") || ""}  ${ago(x.updated_ms)}`,
        icon: <History className="size-4" />, score: 30 - i,
        run: () => void openImport({ q: q.trim(), harness: x.harness as never, id: x.id, path: x.path }),
      });
    }
    const order = ["Sessions", "Actions", "In conversations", "Other harnesses", "Models"];
    if (q) out.sort((a, b) => b.score - a.score);
    // Keep groups together, ordered by their best hit.
    const best = new Map<string, number>();
    out.forEach((e, i) => best.has(e.group) || best.set(e.group, i));
    const rows = out.sort((a, b) => (q ? best.get(a.group)! - best.get(b.group)! : order.indexOf(a.group) - order.indexOf(b.group))).slice(0, 60);
    // Not searched there yet: the last row asks for it (it keeps the palette open, and the rows come in its place).
    if (mayElsewhere && !wantsElsewhere) rows.push({
      key: "x:ask", group: "Other harnesses", label: "Search other harnesses' sessions", detail: "Claude Code, Codex and others here",
      icon: <History className="size-4" />, score: 0, stay: true, run: () => setAsked(q),
    });
    return rows;
  }, [q, local, others, mayElsewhere, wantsElsewhere]);

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
    if (e.stay) return e.run();
    picked.current = true;
    setUI({ palette: false });
    e.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => setUI({ palette: o })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="palette"
          finalFocus={() => {
            const el = from.current;
            from.current = null;
            // The keyboard goes back to where it was only while it is still the palette's, or nowhere. This runs
            // when the palette has finished closing: a person who put the keyboard somewhere else meanwhile
            // (the message box, a button) keeps it there.
            const now = document.activeElement;
            const moved = now instanceof HTMLElement && now !== document.body && !now.closest('[data-testid="palette"]');
            return !picked.current && !moved && el instanceof HTMLElement && el !== document.body && el.isConnected && el.getClientRects().length > 0 ? el : false;
          }}
          aria-label="Search and commands"
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 flex max-h-[min(34rem,76vh)] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden",
            "rounded-xl border border-line bg-raised shadow-3 outline-none",
            "transition-[opacity,scale] data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:opacity-0",
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
              className="h-13 w-full bg-transparent text-read outline-none placeholder:text-faint"
              onKeyDown={(e) => {
                if (composing(e)) return; // the arrows and Enter are the input method's while a word is composed
                if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
                if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
                if (e.key === "Enter") { e.preventDefault(); pick(active); }
              }}
            />
          </div>
          <div ref={list} id="palette-list" className="flex-1 overflow-y-auto overscroll-contain p-1.5" role="listbox" aria-label="Results" aria-busy={searching || undefined}>
            {searchRefused && <p className="px-3 py-3 text-ui text-muted" role="status" data-testid="palette-refused">{searchRefused}</p>}
            {entries.length === 0 && !searching && !seekingElsewhere && !searchFailed && !searchRefused && (
              <p className="k-empty px-3 py-4" data-testid="palette-empty">
                Nothing matches "{q}"{limits?.length ? ` (${limits.join(", ")})` : ""}{wantsElsewhere && !elsewhereFailed ? ", here or in other harnesses' sessions" : ""}.
              </p>
            )}
            {entries.map((e, i) => (
              <div key={e.key}>
                {(i === 0 || entries[i - 1]!.group !== e.group) && (
                  <div className="px-2.5 pb-1 pt-2.5 k-label first:pt-1">{e.group}</div>
                )}
                <div
                  role="option"
                  id={optId(e)}
                  data-i={i}
                  aria-selected={i === sel}
                  onMouseMove={() => sel !== i && setSelKey(e.key)}
                  onClick={() => pick(e)}
                  className={cn("flex h-9 items-center gap-3 rounded-md px-2.5 text-ui", i === sel ? "bg-hover text-fg" : "text-muted")}
                >
                  <span className={i === sel ? "text-accent" : "text-faint"}>{e.icon}</span>
                  {/* The label and its detail share the row by what each needs: a short label leaves its room to the detail. */}
                  <span className="min-w-0 flex-[0_1_auto] truncate text-fg">{e.label}</span>
                  {e.detail && <span className="min-w-[6rem] flex-[0_1_auto] truncate text-caption text-faint">{e.detail}</span>}
                  <span className="ml-auto flex shrink-0 items-center">
                    {e.keys ? <Kbd keys={e.keys} /> : i === sel ? <CornerDownLeft className="size-3.5 text-faint" /> : null}
                  </span>
                </div>
              </div>
            ))}
            {(searching || seekingElsewhere) && (
              <p className="flex items-center gap-2 px-2.5 py-2.5 text-caption text-faint" data-testid="palette-searching">
                <TextSearch className="size-3.5 animate-pulse-dot" /> {searching ? "Searching conversations" : "Searching other harnesses' sessions"}
              </p>
            )}
            {/* Other harnesses' sessions that could not be searched are named: no answer is not "nothing there". */}
            {wantsElsewhere && !seekingElsewhere && (elsewhereFailed || (entries.length === 0 && !searching && elsewhere.not.length > 0)) && (
              <p className="px-2.5 py-1.5 text-micro text-faint" role="status" data-testid="palette-elsewhere-note">
                {elsewhereFailed ? `Other harnesses' sessions were not searched: ${elsewhereFailed}` : `Titles and prompts only for ${elsewhere.not.map((h) => elsewhere.labels[h] ?? h).join(", ")}: their conversations are not searched`}
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
          {/* What the search was limited to, in full: a time with its zone is not cut for the key hints. */}
          {wantsSearch && !!limits?.length && (
            <p className="border-t border-line px-4 py-1.5 text-micro text-faint" data-testid="palette-limits">Limited to <span className="text-muted">{limits.join(", ")}</span></p>
          )}
          <div className="hidden items-center gap-4 border-t border-line px-4 py-2 text-micro text-faint sm:flex">
            <span className="flex items-center gap-1.5"><Kbd keys="↑" /><Kbd keys="↓" /> move</span>
            <span className="flex items-center gap-1.5"><Kbd keys="enter" /> open</span>
            <span className="flex items-center gap-1.5"><Kbd keys="escape" /> close</span>
            {/* What a search can be limited to, said where a search is typed; once it is, what it was limited to. */}
            {wantsSearch && !limits?.length && (
              <span className="ml-auto min-w-0 truncate" data-testid="palette-limit-hint">Limit a search: <span className="font-mono">in:commands on:yesterday state:failed</span></span>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
