// The keel: the rail along the left edge. Folded (the default) it is a column
// of marks, every session's state at a glance, grouped by what it needs
// from you, with a bracket on the ones that have a station. Unfolded (Ctrl B)
// it is the full index: sessions by folder and machine, and the archive. On
// a phone it is a drawer.
import { Archive, ArchiveRestore, Bug, Folder, ListTree, Moon, PanelLeftClose, Pin, Plus, Search, Server, Settings, Sun, SunMoon, Tag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { machineColour, machineName, useFleet } from "../lib/fleet.ts";
import { useSafety } from "../lib/safety.ts";
import { useStations } from "../lib/stations.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { navigate, savePref, setTheme, setUI, useUI } from "../lib/ui.ts";
import { ago, cn, folderNames, when } from "../lib/utils.ts";
import { lastLine, useWatch, useWatches, WATCH_LABEL, type Watch } from "../lib/watch.ts";
import { useAuto } from "../lib/automation.ts";
import { folderOf, Mark, modelOf } from "./Mark.tsx";
import { AutomationFooter, SessionBadges, SessionChildren } from "./automation/SidebarExtras.tsx";
import { Kbd } from "./Kbd.tsx";
import { Logo } from "./Logo.tsx";
import { archive } from "../lib/sessops.ts";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// Sessions grouped by folder (and machine, for another machine's), the folder
// with the newest work first.
function groups(sessions: Session[]) {
  const by = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = `${s.machine ?? ""}\u0000${s.workspace}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  return [...by.entries()]
    .map(([k, list]) => ({ key: k, ws: list[0]!.workspace, machine: list[0]!.machine ?? undefined, list: list.sort((a, b) => b.updated - a.updated) }))
    .sort((a, b) => b.list[0]!.updated - a.list[0]!.updated);
}

function Row({ s, active }: { s: Session; active: boolean }) {
  const restore = s.archived;
  const w = useWatch(s);
  const shown = useStations((x) => x.shown.includes(s.id));
  const unread = useAuto((x) => (x.unread.sessions[s.id] ?? 0) > 0);
  return (
    <div
      role="link"
      tabIndex={0}
      data-testid="session-row"
      data-session={s.id}
      data-shown={shown || undefined}
      data-unread={unread || undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate({ name: "session", id: s.id })}
      onKeyDown={(e) => e.key === "Enter" && navigate({ name: "session", id: s.id })}
      className="k-row group"
    >
      <Mark w={w} />
      <span className="k-row-title">{s.title || "New session"}</span>
      {(s.settings.tags ?? []).slice(0, 1).map((t) => <span key={t} title={(s.settings.tags ?? []).join(", ")} className="k-row-tag max-w-20 shrink truncate rounded-xs bg-sunken px-1 text-micro text-faint" data-testid="row-tag">{t}</span>)}
      <NeedsYou sessionId={s.id} />
      <SessionBadges sessionId={s.id} />
      <span className="k-row-time tabular-nums group-hover:hidden group-focus-within:hidden" title={when(s.updated)}>{ago(s.updated)}</span>
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

// A folder shows its newest sessions; the rest open on request (and the open
// one is always shown, also when it is a subagent's: its parent's row then).
const SHOWN = 6;
function Group({ list, current }: { list: Session[]; current: string | null }) {
  const [all, setAll] = useState(false);
  const root = useStore((x) => {
    let s = current ? x.sessions[current] : undefined;
    for (let n = 0; s?.parent_id && n < 32; n++) s = x.sessions[s.parent_id] ?? undefined;
    return s?.id ?? current;
  });
  const shown = all ? list : list.filter((s, i) => i < SHOWN || s.id === root);
  return (
    <div className="flex flex-col gap-px">
      {shown.map((s) => (
        <div key={s.id}>
          <Row s={s} active={current === s.id} />
          <SessionChildren parentId={s.id} current={current} />
        </div>
      ))}
      {list.length > shown.length && <button type="button" onClick={() => setAll(true)} className="k-more">{list.length - shown.length} more</button>}
      {all && list.length > SHOWN && <button type="button" onClick={() => setAll(false)} className="k-more">Show fewer</button>}
    </div>
  );
}

// A session waiting on an approval.
export function NeedsYou({ sessionId }: { sessionId: string }) {
  const n = useSafety((s) => s.approvals[sessionId]?.length ?? 0);
  if (!n) return null;
  return <span data-testid="needs-you" title={`${n} approval${n === 1 ? "" : "s"} waiting`} className="k-needs">needs you</span>;
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
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id).sort((a, b) => b.updated - a.updated), [sessions]);
  const watches = useWatches(list);
  const shown = useStations((x) => x.shown);
  const unread = useAuto((s) => s.unread.sessions);
  const [card, setCard] = useState<{ id: string; y: number } | null>(null);
  const show = (id: string) => (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    setCard({ id, y: r.top + r.height / 2 });
  };
  const hide = () => setCard(null);
  return (
    <>
      {BANDS.map((b) => {
        const items = list.filter((s) => b.w.includes(watches[s.id]!));
        if (!items.length) return null;
        return (
          <section key={b.label} className="k-marks" data-watch={b.w[0]} aria-label={`${b.label}: ${items.length}`} data-testid="rail-band">
            <h3 className="k-marks-head" aria-hidden="true"><span>{b.short}</span><span className="tabular-nums">{items.length}</span></h3>
            <ol>
              {items.map((s) => (
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
                    aria-label={`${s.title || "New session"}, ${WATCH_LABEL[watches[s.id]!]}, ${ago(s.updated)}`}
                    onPointerEnter={show(s.id)}
                    onPointerLeave={hide}
                    onFocus={show(s.id)}
                    onBlur={hide}
                    onClick={() => { hide(); navigate({ name: "session", id: s.id }); }}
                  >
                    <Mark w={watches[s.id]!} />
                    <span className="sr-only">{s.title || "New session"}</span>
                    <span className="k-tick-badges"><NeedsYou sessionId={s.id} /><SessionBadges sessionId={s.id} /></span>
                  </button>
                  <div className="k-tick-kids"><SessionChildren parentId={s.id} current={current} /></div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
      {card && sessions[card.id] && <RailCard s={sessions[card.id]!} w={watches[card.id] ?? "idle"} y={card.y} unread={unread[card.id] ?? 0} />}
    </>
  );
}

// The card beside a mark: what the session is, where, and what it needs.
function RailCard({ s, w, y, unread }: { s: Session; w: Watch; y: number; unread: number }) {
  const events = useStore((x) => x.events[s.id]);
  const approvals = useSafety((x) => x.approvals[s.id]?.length ?? 0);
  const line = lastLine(events, s.workspace);
  const top = Math.min(Math.max(y, 72), innerHeight - 72);
  return (
    <div className="k-rail-card" data-watch={w} style={{ top }} data-testid="rail-card" aria-hidden="true">
      <div className="k-rail-card-row">
        <Mark w={w} />
        <span className="k-rail-card-word">{WATCH_LABEL[w]}</span>
        <span className="k-rail-card-time">{ago(s.updated)}</span>
      </div>
      <p className="k-rail-card-title">{s.title || "New session"}</p>
      <p className="k-rail-card-meta">{folderOf(s)}<span aria-hidden="true"> / </span>{modelOf(s.model)}</p>
      {approvals > 0 && <p className="k-rail-card-need">{approvals === 1 ? "An approval waits for you" : `${approvals} approvals wait for you`}</p>}
      {line && <p className="k-rail-card-line">{line}</p>}
      {unread > 0 && approvals === 0 && <p className="k-rail-card-new">New since you looked</p>}
    </div>
  );
}

function Index({ current }: { current: string | null }) {
  const sessions = useStore((s) => s.sessions);
  useFleet((s) => s.machines.length); // machine names in the group heads
  const [tab, setTab] = useState<"active" | "archived">(() => { const t = openOn; openOn = "active"; return t; });
  const [archived, setArchived] = useState<Session[]>([]);
  useEffect(() => {
    if (tab === "archived") api<{ sessions: Session[] }>("/api/sessions?archived").then((r) => setArchived(r.sessions)).catch(reportError);
  }, [tab, sessions]);
  // A tag picked above the list narrows it; pinned sessions lead it.
  // Each tab keeps its own tag: one picked in Sessions does not empty Archived.
  const [tags_, setTags] = useState<Record<string, string | null>>({});
  const base_ = useMemo(
    () => (tab === "active" ? Object.values(sessions).filter((s) => !s.archived && !s.parent_id) : archived.map((a) => sessions[a.id] ?? a).filter((s) => s.archived)),
    [sessions, tab, archived],
  );
  const tags = useMemo(() => [...new Set(base_.flatMap((s) => s.settings.tags ?? []))].sort((a, b) => a.localeCompare(b)), [base_]);
  const picked = tags_[tab] ?? null;
  const tag = picked && tags.includes(picked) ? picked : null; // a tag no session has any more filters nothing
  const setTag = (t: string | null) => setTags((m) => ({ ...m, [tab]: t }));
  const listed = tag ? base_.filter((s) => (s.settings.tags ?? []).includes(tag)) : base_;
  const pinned = listed.filter((s) => s.settings.pinned_ms).sort((a, b) => a.settings.pinned_ms! - b.settings.pinned_ms!);
  const grouped = useMemo(() => groups(listed.filter((s) => !s.settings.pinned_ms)), [listed]);
  // Same-named folders read apart (beta/api, alpha/api); a machine's folders are named among its own.
  const heads = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const g of grouped) (by.get(g.machine ?? "") ?? by.set(g.machine ?? "", []).get(g.machine ?? "")!).push(g.ws);
    const out = new Map<string, string>();
    for (const [m, list] of by) for (const [ws, name] of folderNames(list)) out.set(`${m}\u0000${ws}`, name);
    return out;
  }, [grouped]);
  return (
    <>
      <div role="tablist" aria-label="Session list" className="k-tabs">
        {(["active", "archived"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            {t === "active" ? "Sessions" : "Archived"}
          </button>
        ))}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2" role="group" aria-label="Filter by tag" data-testid="tag-filter">
          {tags.map((t) => (
            <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}
              className={cn("inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption", tag === t ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted hover:text-fg")}>
              <Tag className="size-3" />{t}
            </button>
          ))}
        </div>
      )}
      <nav className="k-index" data-testid="session-list" aria-label="Sessions">
        {pinned.length > 0 && (
          <section className="k-group" data-testid="pinned-group">
            <h2 className="k-group-head"><Pin /><span className="truncate">Pinned</span></h2>
            <Group list={pinned} current={current} />
          </section>
        )}
        {grouped.length === 0 && pinned.length === 0 && (
          tag
            ? <p className="k-empty" data-testid="tag-empty">No sessions match the tag {tag}. <button type="button" className="text-accent-ink underline-offset-2 hover:underline" onClick={() => setTag(null)}>Show all</button></p>
            : <p className="k-empty">{tab === "active" ? "Sessions you start show up here, grouped by folder." : "Archived sessions show up here. Restore one to bring it back."}</p>
        )}
        {grouped.map((g) => (
          <section key={g.key} className="k-group" data-machine={g.machine}>
            <h2 className="k-group-head" title={g.machine ? `${g.ws} on ${machineName(g.machine)}` : g.ws}>
              {g.machine ? <Server style={machineColour(g.machine) ? { color: machineColour(g.machine) } : undefined} /> : <Folder />}
              <span className="truncate">{heads.get(`${g.machine ?? ""}\u0000${g.ws}`) ?? base(g.ws)}</span>
              {g.machine && <span className="k-group-machine" data-testid="group-machine">{machineName(g.machine)}</span>}
            </h2>
            <Group list={g.list} current={current} />
          </section>
        ))}
      </nav>
    </>
  );
}

export function Sidebar({ open }: { open: boolean }) {
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts).length);
  const connected = useStore((s) => s.connected);
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const current = route.name === "session" ? route.id : null;
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;

  return (
    <aside className="k-rail" data-open={open || undefined} data-testid="sidebar" aria-label="Sessions">
      <div className="k-rail-brand">
        <span className="k-logo" data-live={connected || undefined} title={connected ? "Connected to the daemon" : "Reconnecting to the daemon"}><Logo /></span>
        <span className="k-brand-name">Keel</span>
        {open && (
          <button type="button" onClick={() => savePref("sidebar", false)} title="Fold the list (Ctrl B)" aria-label="Fold the list" className="k-act k-fold">
            <PanelLeftClose />
          </button>
        )}
      </div>
      <div className="k-rail-acts">
        <button type="button" className="k-act" data-testid="new-session" aria-label="New session" title="New session (Ctrl Shift O)" aria-current={route.name === "new" ? "page" : undefined} onClick={() => navigate({ name: "new" })}>
          <Plus /><span className="k-act-label">New session</span>{open && <Kbd keys="mod+shift+o" className="ml-auto" />}
        </button>
        <button type="button" className="k-act" data-testid="open-palette" aria-label="Search and commands" title="Search and commands (Ctrl K)" onClick={() => setUI({ palette: true })}>
          <Search /><span className="k-act-label">Search and commands</span>{open && <Kbd keys="mod+k" className="ml-auto" />}
        </button>
      </div>
      {open ? <Index current={current} /> : <nav className="k-rail-list" data-testid="session-list" aria-label="Sessions by state"><Marks current={current} /></nav>}
      <div className="k-rail-foot">
        {!open && (
          <button type="button" className="k-act" data-testid="tab-archived" aria-label="Archived sessions" title="Archived sessions" onClick={() => { openOn = "archived"; savePref("sidebar", true); }}>
            <Archive />
          </button>
        )}
        {!open && (
          <button type="button" className="k-act" data-testid="show-sidebar" aria-label="All sessions by folder" title="All sessions by folder (Ctrl B)" onClick={() => savePref("sidebar", true)}>
            <ListTree />
          </button>
        )}
        <button type="button" className="k-act" data-testid="settings-button" aria-label="Settings" title="Settings" aria-current={route.name === "settings" ? "page" : undefined} onClick={() => navigate({ name: "settings", section: "general" })}>
          <Settings /><span className="k-act-label">Settings</span>
        </button>
        <button type="button" className={cn("k-act", errors > 0 && "k-alert")} data-testid="errors-button" aria-label={errors ? `${errors} open failures` : "Errors"} title={errors ? `${errors} open failures` : "No failures recorded"} onClick={() => setUI({ errors: true })}>
          <Bug />{errors > 0 && <span className="k-act-n">{errors}</span>}
        </button>
        <AutomationFooter />
        <button type="button" className="k-act" data-testid="theme-toggle" onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Change`}>
          <ThemeIcon />
        </button>
      </div>
    </aside>
  );
}
