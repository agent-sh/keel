// The keel: the rail along the left edge. It is the list whenever there is
// room: sessions by folder and machine, each with its title, state and time,
// and the archive. Folded (Ctrl B, or no room beside the stations asked for)
// it is a column of marks, each a session's state and a short code of its
// title, banded by what it needs from you. A card beside the entry under the
// pointer or the focus says the rest. On a phone the list is a drawer.
import { Archive, ArchiveRestore, Bug, Columns2, Folder, Moon, PanelLeftClose, PanelLeftOpen, Pin, Plus, Search, Settings, Sparkles, Sun, SunMoon, Tag } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { machineName, useFleet } from "../lib/fleet.ts";
import { useSafety } from "../lib/safety.ts";
import { useUnsent, useWaitingSend } from "../lib/send-drafts.ts";
import { stations, useStations } from "../lib/stations.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { callsigns, listBounds, listWidth, panesMax, toggleList, useRail } from "../lib/rail.ts";
import { navigate, phone, savePref, setTheme, setUI, useUI } from "../lib/ui.ts";
import { ago, cn, folderNames, when } from "../lib/utils.ts";
import { lastLine, useAgentCount, useAgentCounts, useWatch, useWatches, watchLabel, type Watch } from "../lib/watch.ts";
import { MachineSep, machineRuns, WherePip, whereWords } from "./Where.tsx";
import { finished, ListFind, matches, order, setArrange, useArrange } from "./ListArrange.tsx";
import { useAuto } from "../lib/automation.ts";
import { folderOf, Mark, modelOf } from "./Mark.tsx";
import { AutomationFooter, SessionBadges, SessionChildren } from "./automation/SidebarExtras.tsx";
import { dragSession, PaneCount } from "./Panes.tsx";
import { Grip } from "./Grip.tsx";
import { Kbd } from "./Kbd.tsx";
import { Logo } from "./Logo.tsx";
import { archive } from "../lib/sessops.ts";
import { ProjectGroups } from "./SidebarProjects.tsx";
import { FolderGroups } from "./SidebarFolders.tsx";
import { openHelper } from "../lib/helper.ts";
import { Seg } from "./Seg.tsx";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// Sessions grouped by folder (and machine, for another machine's), each in
// the list's order; the folders in the order of their first session (by
// name: the folder's name).
function groups(sessions: Session[], cmp: (a: Session, b: Session) => number, byName: boolean) {
  const by = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = `${s.machine ?? ""}\u0000${s.workspace}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  return [...by.entries()]
    .map(([k, list]) => ({ key: k, ws: list[0]!.workspace, machine: list[0]!.machine ?? undefined, list: list.sort(cmp) }))
    .sort((a, b) => (byName ? base(a.ws).localeCompare(base(b.ws)) : 0) || cmp(a.list[0]!, b.list[0]!));
}

// The card beside an entry: shown at once for a mark (it has no words of its
// own), after a pause for a list row (its title is already there), and at
// once for either on keyboard focus.
type Card = { s: Session; y: number; left: number };
const CardCtx = createContext<(s: Session, wait: number) => Record<string, (e: { currentTarget: HTMLElement }) => void>>(() => ({}));
function useCard() {
  const [card, setCard] = useState<Card | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = () => { clearTimeout(timer.current); setCard(null); };
  const bind = (s: Session, wait: number) => {
    const show = (ms: number) => (e: { currentTarget: HTMLElement }) => {
      const r = e.currentTarget.getBoundingClientRect();
      const edge = e.currentTarget.closest(".k-rail")?.getBoundingClientRect().right ?? r.right;
      clearTimeout(timer.current);
      const set = () => setCard({ s, y: r.top + r.height / 2, left: edge + 8 });
      if (ms) timer.current = setTimeout(set, ms); else set();
    };
    return { onPointerEnter: show(wait), onPointerLeave: hide, onFocus: show(0), onBlur: hide, onClick: hide, onDragStart: hide };
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { card, bind, hide };
}

// Up and Down step through the entries, Home and End reach the ends.
function stepRows(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="session-row"]')];
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  (e.key === "Home" ? rows[0] : e.key === "End" ? rows.at(-1) : rows[i + (e.key === "ArrowDown" ? 1 : -1)])?.focus();
}

// States a row spells out; a finished or untouched session is its mark alone.
const SPELLED: Watch[] = ["need", "work", "fail", "resume", "stop"];

// Opens a session in a new pane beside the one worked in (Ctrl or middle click, the row's button).
export function openBeside(id: string) {
  if (phone()) return navigate({ name: "session", id });
  stations.beside(id, panesMax());
  navigate({ name: "session", id });
}

function Row({ s, active, where }: { s: Session; active: boolean; where?: boolean }) {
  const restore = s.archived;
  const w = useWatch(s);
  const agents = useAgentCount(s.id);
  const card = useContext(CardCtx)(s, 450);
  const shown = useStations((x) => x.shown.includes(s.id));
  const unread = useAuto((x) => (x.unread.sessions[s.id] ?? 0) > 0);
  return (
    <div
      role="link"
      tabIndex={0}
      data-testid="session-row"
      data-session={s.id}
      data-watch={w}
      data-shown={shown || undefined}
      data-unread={unread || undefined}
      aria-current={active ? "page" : undefined}
      {...card}
      draggable
      onDragStart={(e) => { card.onDragStart?.(e); dragSession(s.id)(e); }}
      onClick={(e) => { card.onClick?.(e); if (e.ctrlKey || e.metaKey) openBeside(s.id); else navigate({ name: "session", id: s.id }); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openBeside(s.id); } }}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && ((e.ctrlKey || e.metaKey) ? openBeside(s.id) : navigate({ name: "session", id: s.id }))}
      className="k-row group"
    >
      <Mark w={w} />
      <span className="k-row-main">
        <span className="k-row-title">{s.title || "New session"}</span>
        {SPELLED.includes(w) && (
          <span className="k-row-sub">
            <span className="k-row-state" data-testid="row-state">{watchLabel(w, agents)}</span>
          </span>
        )}
        {where && <span className="k-row-in" data-testid="row-folder">{folderOf(s)}</span>}
      </span>
      {(s.settings.tags ?? []).slice(0, 1).map((t) => <span key={t} title={(s.settings.tags ?? []).join(", ")} className="k-row-tag max-w-20 shrink truncate rounded-xs bg-sunken px-1 text-micro text-faint" data-testid="row-tag">{t}</span>)}
      <NeedsYou sessionId={s.id} />
      <SessionBadges sessionId={s.id} />
      <span className="k-row-time tabular-nums group-hover:hidden group-focus-within:hidden" title={when(s.updated)}>{ago(s.updated)}</span>
      {!restore && !shown && !phone() && (
        <button type="button" title="Open beside, in a new pane (Ctrl click)" aria-label="Open beside" data-testid="row-beside" onClick={(e) => { e.stopPropagation(); openBeside(s.id); }} className="k-row-act hidden group-hover:grid group-focus-within:grid">
          <Columns2 />
        </button>
      )}
      <button
        type="button"
        title={restore ? "Restore" : "Archive"}
        aria-label={restore ? "Restore session" : "Archive session"}
        onClick={(e) => {
          e.stopPropagation();
          archive(s, !restore).catch(reportError);
        }}
        className="k-row-act hidden group-hover:grid group-focus-within:grid"
      >
        {restore ? <ArchiveRestore /> : <Archive />}
      </button>
    </div>
  );
}

// An agent's route belongs to its root's group in the index.
function rootSessionId(sessions: Record<string, Session>, current: string | null) {
  let s = current ? sessions[current] : undefined;
  for (let n = 0; s?.parent_id && n < 32; n++) s = sessions[s.parent_id] ?? undefined;
  return s?.id ?? current;
}

// A folder shows its newest sessions; the rest open on request (and the open
// one is always shown, also when it is a subagent's: its parent's row then).
const SHOWN = 6;
export function Group({ list, current, every, where }: { list: Session[]; current: string | null; every?: boolean; where?: boolean }) {
  const [more, setAll] = useState(false);
  const all = more || !!every;
  const root = useStore((x) => rootSessionId(x.sessions, current));
  const shown = all ? list : list.filter((s, i) => i < SHOWN || s.id === root);
  return (
    <div className="flex flex-col gap-px">
      {shown.map((s) => (
        <div key={s.id}>
          <Row s={s} active={current === s.id} where={where} />
          <SessionChildren parentId={s.id} current={current} />
        </div>
      ))}
      {list.length > shown.length && <button type="button" onClick={() => setAll(true)} className="k-more">{list.length - shown.length} more</button>}
      {more && list.length > SHOWN && <button type="button" onClick={() => setAll(false)} className="k-more">Show fewer</button>}
    </div>
  );
}

// What a kept message of the session says where its row or card names it.
const UNSENT = {
  refused: { word: "not sent", line: "A message was not sent", title: "A message here was not sent. Open the session to send it again or discard it." },
  unconfirmed: { word: "unconfirmed", line: "A message's delivery is unconfirmed", title: "Nobody confirmed that a message here arrived. Open the session to check." },
} as const;

// A session waiting on an approval, or holding a message that did not go.
export function NeedsYou({ sessionId }: { sessionId: string }) {
  const n = useSafety((s) => s.approvals[sessionId]?.length ?? 0);
  const unsent = useUnsent(sessionId);
  const waiting = useWaitingSend(sessionId);
  return (
    <>
      {n > 0 && <span data-testid="needs-you" title={`${n} approval${n === 1 ? "" : "s"} waiting`} className="k-needs">needs you</span>}
      {unsent && <span data-testid="unsent-mark" title={UNSENT[unsent].title} className="k-needs">{UNSENT[unsent].word}</span>}
      {waiting && !unsent && <span data-testid="waiting-send-mark" title="A message here waits for Keel and goes out by itself when it is back." className="shrink-0 rounded-md bg-brass-soft px-1.5 text-micro font-medium text-brass">waits to send</span>}
    </>
  );
}

// The tab the index opens on (the folded rail's archive button asks for "archived").
let openOn: "active" | "archived" = "active";

// Folded: one mark per session, banded by what each needs from you, each band
// headed by its word and count. Within a band the newest work is on top. A
// finished session you have not looked at keeps a full mark; one you have
// seen goes quiet. Hovering or focusing a mark shows its card.
const BANDS: { w: Watch[]; label: string; short: string }[] = [
  { w: ["need"], label: "Needs you", short: "Need" },
  { w: ["work"], label: "Working", short: "Work" },
  { w: ["fail"], label: "Failed", short: "Fail" },
  { w: ["resume", "stop"], label: "Stopped", short: "Stop" },
  { w: ["done", "idle"], label: "Done", short: "Done" },
];
function Marks({ current }: { current: string | null }) {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id && !s.settings.helper).sort((a, b) => b.updated - a.updated), [sessions]);
  const codes = useMemo(() => callsigns(list), [list]);
  const watches = useWatches(list);
  const agents = useAgentCounts();
  const shown = useStations((x) => x.shown);
  const unread = useAuto((s) => s.unread.sessions);
  const bind = useContext(CardCtx);
  return (
    <>
      {BANDS.map((b) => {
        const items = list.filter((s) => b.w.includes(watches[s.id]!));
        if (!items.length) return null;
        return (
          <section key={b.label} className="k-marks" data-watch={b.w[0]} aria-label={`${b.label}: ${items.length}`} data-testid="rail-band">
            <h3 className="k-marks-head" aria-hidden="true"><span>{b.short}</span><span className="tabular-nums">{items.length}</span></h3>
            <ol>
              {items.map((s) => {
                const card = bind(s, 0);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="k-tick"
                      data-testid="session-row"
                      data-session={s.id}
                      data-watch={watches[s.id]}
                      data-shown={shown.includes(s.id) || undefined}
                      data-unread={unread[s.id] ? true : undefined}
                      aria-current={current === s.id ? "page" : undefined}
                      aria-label={`${s.title || "New session"}, ${watchLabel(watches[s.id]!, agents[s.id])}, ${folderOf(s)}${whereWords(s)}, ${ago(s.updated)}`}
                      {...card}
                      draggable
                      onDragStart={(e) => { card.onDragStart?.(e); dragSession(s.id)(e); }}
                      onClick={(e) => { card.onClick?.(e); navigate({ name: "session", id: s.id }); }}
                    >
                      <Mark w={watches[s.id]!} />
                      <span className="k-tick-code" data-testid="rail-code" aria-hidden="true">{codes[s.id]}</span>
                      <WherePip s={s} />
                      <span className="sr-only">{s.title || "New session"}</span>
                      <span className="k-tick-badges"><NeedsYou sessionId={s.id} /><SessionBadges sessionId={s.id} /></span>
                    </button>
                    <div className="k-tick-kids"><SessionChildren parentId={s.id} current={current} /></div>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </>
  );
}

// The card beside an entry: what the session is, where, and what it last did.
const home = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, "~");
function RailCard({ s: given, y, left }: { s: Session; y: number; left: number }) {
  const s = useStore((x) => x.sessions[given.id]) ?? given;
  const w = useWatch(s);
  const agents = useAgentCount(s.id);
  const unread = useAuto((x) => x.unread.sessions[s.id] ?? 0);
  const events = useStore((x) => x.events[s.id]);
  const approvals = useSafety((x) => x.approvals[s.id]?.length ?? 0);
  const unsent = useUnsent(s.id);
  const line = lastLine(events, s.workspace);
  const top = Math.min(Math.max(y, 96), innerHeight - 96);
  return (
    <div className="k-rail-card" data-watch={w} style={{ top, left }} data-testid="rail-card" aria-hidden="true">
      <div className="k-rail-card-row">
        <Mark w={w} />
        <span className="k-rail-card-word">{watchLabel(w, agents)}</span>
        <span className="k-rail-card-time" title={when(s.updated)}>{ago(s.updated) === "now" ? "just now" : `${ago(s.updated)} ago`}</span>
      </div>
      <p className="k-rail-card-title">{s.title || "New session"}</p>
      {approvals > 0 && <p className="k-rail-card-need">{approvals === 1 ? "An approval waits for you" : `${approvals} approvals wait for you`}</p>}
      {unsent && <p className="k-rail-card-need" data-testid="rail-card-unsent">{UNSENT[unsent].line}</p>}
      {line && <p className="k-rail-card-line">{line}</p>}
      {unread > 0 && approvals === 0 && <p className="k-rail-card-new">New since you looked</p>}
      <dl className="k-rail-card-meta">
        <dt>Folder</dt><dd title={s.workspace}><b>{folderOf(s)}</b>{s.machine ? ` on ${machineName(s.machine)}` : ""} in {home(s.workspace.replace(/\/[^/]*\/?$/, "")) || "/"}</dd>
        <dt>Model</dt><dd>{modelOf(s.model)}</dd>
        <dt>Active</dt><dd>{when(s.updated)}</dd>
      </dl>
    </div>
  );
}

function Index({ current }: { current: string | null }) {
  const sessions = useStore((s) => s.sessions);
  useFleet((s) => s.machines.length); // machine names in the group heads
  const [tab, setTab] = useState<"active" | "archived">(() => { const t = openOn; openOn = "active"; return t; });
  const [archived, setArchived] = useState<Session[]>([]);
  // The archive is asked for when its tab opens and when what it lists moved:
  // a session was archived or restored, or one is gone. A status or a title
  // of a session is no reason (the list shows the store's row of each). The
  // answer of a request that a newer one overtook is dropped. A page that was
  // cut off reads it again when it is back: what was archived or deleted
  // meanwhile reached it by no frame.
  const inArchive = useStore((s) => Object.values(s.sessions).filter((x) => x.archived).map((x) => x.id).sort().join(" "));
  const gone = useStore((s) => s.gone);
  const connected = useStore((s) => s.connected);
  const asked = useRef(0);
  useEffect(() => {
    if (tab !== "archived" || !connected) return;
    const n = ++asked.current;
    api<{ sessions: Session[] }>("/api/sessions?archived").then((r) => { if (n === asked.current) setArchived(r.sessions); }).catch(reportError);
  }, [tab, inArchive, gone, connected]);
  // A tag picked above the list narrows it; pinned sessions lead it.
  // Each tab keeps its own tag: one picked in Sessions does not empty Archived.
  const [tags_, setTags] = useState<Record<string, string | null>>({});
  const base_ = useMemo(
    () => (tab === "active" ? Object.values(sessions).filter((s) => !s.archived && !s.parent_id && !s.settings.helper) : archived.map((a) => sessions[a.id] ?? a).filter((s) => s.archived && !gone[s.id])),
    [sessions, tab, archived, gone],
  );
  const tags = useMemo(() => [...new Set(base_.flatMap((s) => s.settings.tags ?? []))].sort((a, b) => a.localeCompare(b)), [base_]);
  const picked = tags_[tab] ?? null;
  const tag = picked && tags.includes(picked) ? picked : null; // a tag no session has any more filters nothing
  const setTag = (t: string | null) => setTags((m) => ({ ...m, [tab]: t }));
  // The filter words and the arrangement (ListArrange.tsx): pinned sessions stay in view unless the words leave them out.
  const [q, setQ] = useState("");
  const arr = useArrange();
  const watches = useWatches(base_);
  const listed = base_.filter((s) => (!tag || (s.settings.tags ?? []).includes(tag)) && (!q || matches(s, q)));
  const pinned = listed.filter((s) => s.settings.pinned_ms).sort((a, b) => a.settings.pinned_ms! - b.settings.pinned_ms!);
  // Keep the open branch in the list even when its root finishes.
  const root = rootSessionId(sessions, current);
  const rest = listed.filter((s) => !s.settings.pinned_ms && !(arr.hideDone && finished(watches[s.id]) && s.id !== current && s.id !== root));
  const hidden = listed.length - pinned.length - rest.length;
  const cmp = order(arr, watches);
  const grouped = arr.group === "folder" ? groups(rest, cmp, arr.sort === "name") : [];
  // By project or by their folders, the archive is one list (a project's archived sessions are on its page).
  const flat = arr.group === "flat" || ((arr.group === "project" || arr.group === "mine") && tab !== "active") ? [...rest].sort(cmp) : [];
  // Same-named folders read apart (beta/api, alpha/api); a machine's folders are named among its own.
  const heads = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const g of grouped) (by.get(g.machine ?? "") ?? by.set(g.machine ?? "", []).get(g.machine ?? "")!).push(g.ws);
    const out = new Map<string, string>();
    for (const [m, list] of by) for (const [ws, name] of folderNames(list)) out.set(`${m}\u0000${ws}`, name);
    return out;
  }, [grouped]);
  const sections = useMemo(() => machineRuns(rest), [rest]);
  return (
    <>
      <Seg kind="tabs" fill className="mx-2.5 mb-1" label="Session list" value={tab} onChange={setTab} options={[{ value: "active", label: "Sessions", testid: "tab-active" }, { value: "archived", label: "Archived", testid: "tab-archived" }]} />
      <ListFind q={q} setQ={setQ} />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2" role="group" aria-label="Filter by tag" data-testid="tag-filter">
          {tags.map((t) => (
            <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}
              className={cn("inline-flex h-ctl-sm items-center gap-1 rounded-xs px-1.5 text-caption", tag === t ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted hover:text-fg")}>
              <Tag className="size-3" />{t}
            </button>
          ))}
        </div>
      )}
      <nav className="k-index" data-testid="session-list" aria-label="Sessions" onKeyDown={stepRows}>
        {pinned.length > 0 && (
          <section className="k-group" data-testid="pinned-group">
            <h2 className="k-group-head"><Pin /><span className="truncate">Pinned</span></h2>
            <Group list={pinned} current={current} every={!!q} where />
          </section>
        )}
        {(arr.group === "folder" || arr.group === "flat" || tab !== "active") && grouped.length === 0 && flat.length === 0 && pinned.length === 0 && (
          q
            ? <p className="k-empty" data-testid="filter-empty">No sessions match {q}. <button type="button" className="text-accent-ink underline-offset-2 hover:underline" onClick={() => setQ("")}>Clear the filter</button></p>
            : hidden > 0
            ? <p className="k-empty">All {hidden} sessions here are finished and hidden. <button type="button" className="text-accent-ink underline-offset-2 hover:underline" onClick={() => setArrange({ hideDone: false })}>Show them</button></p>
            : tag
            ? <p className="k-empty" data-testid="tag-empty">No sessions match the tag {tag}. <button type="button" className="text-accent-ink underline-offset-2 hover:underline" onClick={() => setTag(null)}>Show all</button></p>
            : <p className="k-empty">{tab === "active" ? "Sessions you start show up here, grouped by folder." : "Archived sessions show up here. Restore one to bring it back."}</p>
        )}
        {sections.map((sec) => {
          const own = sec.machine === undefined ? grouped.filter((g) => !g.machine) : grouped.filter((g) => g.machine === sec.machine);
          const ownFlat = flat.filter((s) => (s.machine ?? undefined) === sec.machine);
          return (
            <Fragment key={sec.machine ?? "local"}>
              {sections.length > 1 && <MachineSep machine={sec.machine} count={sec.list.length} />}
              {arr.group === "project" && tab === "active" && <ProjectGroups list={sec.list} cmp={cmp} current={current} every={!!q} />}
              {arr.group === "mine" && tab === "active" && <FolderGroups list={sec.list} cmp={cmp} current={current} every={!!q} />}
              {own.map((g) => (
                <section key={g.key} className="k-group" data-machine={g.machine}>
                  <h2 className="k-group-head" title={g.machine ? `${g.ws} on ${machineName(g.machine)}` : g.ws}>
                    <Folder />
                    <span className="truncate">{heads.get(`${g.machine ?? ""}\u0000${g.ws}`) ?? base(g.ws)}</span>
                  </h2>
                  <Group list={g.list} current={current} every={!!q} />
                </section>
              ))}
              {ownFlat.length > 0 && (
                <section className="k-group" data-testid="flat-group">
                  <Group list={ownFlat} current={current} every={!!q} where />
                </section>
              )}
            </Fragment>
          );
        })}
        {hidden > 0 && (grouped.length > 0 || flat.length > 0) && (
          <button type="button" className="k-more" data-testid="hidden-done" onClick={() => setArrange({ hideDone: false })}>{hidden} finished hidden</button>
        )}
      </nav>
    </>
  );
}

export function Sidebar({ open }: { open: boolean }) {
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts && !e.read_ts).length);
  const connected = useStore((s) => s.connected);
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const rail = useRail();
  const current = route.name === "session" ? route.id : null;
  const onHelper = useStore((s) => (current ? !!s.sessions[current]?.settings.helper : false));
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  const { card, bind, hide } = useCard();
  const grip = useRef<{ from: number; to: number | null }>({ from: 0, to: null });
  const aside = useRef<HTMLElement>(null);
  useUI((s) => s.listW);
  useEffect(hide, [open, current]);
  // The one control that shows the list or folds it, in the same corner either way.
  const Toggle = open ? PanelLeftClose : PanelLeftOpen;
  const toggle = (
    <button
      type="button"
      className="k-act k-fold"
      data-testid="rail-toggle"
      aria-expanded={open}
      aria-controls="k-sessions"
      aria-label={open ? "Fold the session list" : "Show the session list"}
      title={open ? "Fold the session list (Ctrl B)" : rail.tight ? "Show the session list over the stations (Ctrl B)" : "Show the session list (Ctrl B)"}
      onClick={() => toggleList()}
    >
      <Toggle />
    </button>
  );

  return (
    <aside ref={aside} className="k-rail" data-open={open || undefined} data-over={rail.over || undefined} data-testid="sidebar" aria-label="Sessions" style={open && !phone() ? { width: listWidth() } : undefined}>
      <div className="k-rail-brand">
        <span className="k-logo" data-live={connected || undefined} title={connected ? "Connected to the daemon" : "Reconnecting to the daemon"}><Logo /></span>
        <span className="k-brand-name">Keel</span>
        {open && !phone() && <PaneCount />}
        {open && toggle}
      </div>
      {open && !rail.over && !phone() && (
        <Grip
          className="k-rail-grip"
          testid="list-grip"
          label="Width of the session list"
          now={(100 * (listWidth() - listBounds().min)) / Math.max(1, listBounds().max - listBounds().min)}
          onStart={() => { grip.current = { from: listWidth(), to: null }; }}
          onMove={(dx) => {
            // The list follows the pointer on the page itself; the width is kept when the drag ends.
            const to = Math.round(Math.min(listBounds().max, Math.max(listBounds().min, grip.current.from + dx)));
            grip.current.to = to;
            if (aside.current) aside.current.style.width = `${to}px`;
          }}
          onEnd={() => { if (grip.current.to !== null) savePref("listW", grip.current.to); }}
          onReset={() => savePref("listW", null)}
        />
      )}
      <div className="k-rail-acts">
        {!open && toggle}
        {!open && <PaneCount />}
        <button type="button" className="k-new-session k-act" data-testid="new-session" aria-label="New session" title="New session (Ctrl Shift O)" aria-current={route.name === "new" ? "page" : undefined} onClick={() => navigate({ name: "new" })}>
          <Plus /><span className="k-act-label">New session</span>{open && <Kbd keys="mod+shift+o" className="ml-auto" />}
        </button>
        <button type="button" className="k-act" data-testid="open-palette" aria-label="Search and commands" title="Search and commands (Ctrl K)" onClick={() => setUI({ palette: true })}>
          <Search /><span className="k-act-label">Search and commands</span>{open && <Kbd keys="mod+k" className="ml-auto" />}
        </button>
        {/* The helper: one conversation kept above the sessions (src/helper/). */}
        <button type="button" className="k-act" data-testid="open-helper" aria-label="Helper" title="Helper (Ctrl J)" aria-current={onHelper ? "page" : undefined} onClick={() => void openHelper().catch(reportError)}>
          <Sparkles /><span className="k-act-label">Helper</span>{open && <Kbd keys="mod+j" className="ml-auto" />}
        </button>
      </div>
      <CardCtx.Provider value={bind}>
        <div id="k-sessions" className="k-rail-body">
          {open ? <Index current={current} /> : <nav className="k-rail-list" data-testid="session-list" aria-label="Sessions by state" onKeyDown={stepRows}><Marks current={current} /></nav>}
        </div>
      </CardCtx.Provider>
      {card && <RailCard s={card.s} y={card.y} left={card.left} />}
      <div className="k-rail-foot">
        {!open && (
          <button type="button" className="k-act" data-testid="tab-archived" aria-label="Archived sessions" title="Archived sessions" onClick={() => { openOn = "archived"; toggleList(true); }}>
            <Archive />
          </button>
        )}
        <button type="button" className="k-act" data-testid="settings-button" aria-label="Settings" title="Settings" aria-current={route.name === "settings" ? "page" : undefined} onClick={() => navigate({ name: "settings", section: "general" })}>
          <Settings /><span className="k-act-label">Settings</span>
        </button>
        <button type="button" className={cn("k-act", errors > 0 && "k-alert")} data-testid="errors-button" aria-label={errors ? `${errors} unread failures` : "Errors"} title={errors ? `${errors} unread failures` : "No unread failures"} onClick={() => setUI({ errors: true })}>
          <Bug />{errors > 0 && <span className="k-act-n">{errors}</span>}
        </button>
        <AutomationFooter />
        <button type="button" className="k-theme-toggle k-act" data-testid="theme-toggle" onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Change`}>
          <ThemeIcon />
        </button>
      </div>
    </aside>
  );
}
