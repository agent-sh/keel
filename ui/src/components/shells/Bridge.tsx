// Bridge: every live session open at once, a station each, side by side
// across the width. The spine on the left holds every session as a mark;
// the station you work in (the helm) is wider and carries the full header.
import { Bug, ListTree, Moon, Plus, Search, Settings, Sun, SunMoon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../../src/core/types.ts";
import { useStore } from "../../lib/store.ts";
import { navigate, savePref, setTheme, setUI, useUI } from "../../lib/ui.ts";
import { lastLine, useWatch, WATCH_LABEL, type Watch } from "../../lib/watch.ts";
import { cn } from "../../lib/utils.ts";
import { Logo } from "../Logo.tsx";
import { SessionHeader } from "../SessionHeader.tsx";
import { Boundary, SessionView } from "../SessionView.tsx";
import { StartBox } from "../StartBox.tsx";
import { elapsed, folderOf, IndexDrawer, Mark, modelOf, useLive, useNow } from "./common.tsx";

const STATION = 600; // narrowest station worth working in, px

function useCapacity() {
  const [w, setW] = useState(innerWidth);
  useEffect(() => {
    const f = () => setW(innerWidth);
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w < 768 ? 1 : Math.max(1, Math.min(6, Math.floor((w - 64) / STATION)));
}

function StationHead({ s, w }: { s: Session; w: Watch }) {
  const events = useStore((x) => x.events[s.id]);
  const start = useMemo(() => [...(events ?? [])].reverse().find((e) => e.kind === "turn_start")?.ts, [events]);
  const now = useNow(w === "work");
  return (
    <header className="k-station-head" data-testid="station-head">
      <div className="flex items-baseline gap-3">
        <span className="k-station-word">{WATCH_LABEL[w]}</span>
        {w === "work" && start && <span className="k-station-clock tabular-nums">{elapsed(now - start)}</span>}
        <span className="k-station-meta ml-auto truncate">{folderOf(s)}  {modelOf(s.model)}</span>
      </div>
      <h2 className="k-station-title truncate" title={s.title}>{s.title || "New session"}</h2>
      <p className="k-station-line truncate">{lastLine(events, s.workspace) || " "}</p>
    </header>
  );
}

function Station({ s, helm }: { s: Session; helm: boolean }) {
  const w = useWatch(s);
  return (
    <section
      className="k-station"
      data-watch={w}
      data-helm={helm || undefined}
      aria-label={`${s.title || "New session"}, ${WATCH_LABEL[w]}`}
      onPointerDownCapture={() => { if (!helm) navigate({ name: "session", id: s.id }); }}
      onFocusCapture={() => { if (!helm) navigate({ name: "session", id: s.id }); }}
    >
      <div className="k-band" aria-hidden="true" />
      <Boundary>
        <SessionView id={s.id} panel={helm} focus={helm} header={helm ? <><StationHead s={s} w={w} /><SessionHeader session={s} /></> : <StationHead s={s} w={w} />} />
      </Boundary>
    </section>
  );
}

function Spine({ sessions, shown, watches, current }: { sessions: Session[]; shown: Set<string>; watches: Record<string, Watch>; current: string | null }) {
  const theme = useUI((s) => s.theme);
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts).length);
  const connected = useStore((s) => s.connected);
  const route = useUI((s) => s.route);
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  return (
    <nav className="k-spine" aria-label="All sessions">
      <div className="k-spine-top">
        <span className="k-spine-logo" title={connected ? "Connected" : "Reconnecting"} data-live={connected || undefined}><Logo /></span>
        <button type="button" className="k-spine-btn" data-testid="new-session" aria-label="New session" title="New session (Ctrl Shift O)" aria-current={route.name === "new" ? "page" : undefined} onClick={() => navigate({ name: "new" })}><Plus /></button>
        <button type="button" className="k-spine-btn" data-testid="open-palette" aria-label="Search and commands" title="Search and commands (Ctrl K)" onClick={() => setUI({ palette: true })}><Search /></button>
      </div>
      <ol className="k-spine-list">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="k-tick"
              data-watch={watches[s.id]}
              data-shown={shown.has(s.id) || undefined}
              aria-current={current === s.id ? "page" : undefined}
              title={`${s.title || "New session"}  ${WATCH_LABEL[watches[s.id]!]}`}
              aria-label={`${s.title || "New session"}, ${WATCH_LABEL[watches[s.id]!]}`}
              onClick={() => navigate({ name: "session", id: s.id })}
            >
              <Mark w={watches[s.id]!} />
            </button>
          </li>
        ))}
      </ol>
      <div className="k-spine-bottom">
        <button type="button" className="k-spine-btn" aria-label="All sessions by folder" title="All sessions by folder (Ctrl B)" data-testid="show-sidebar" onClick={() => savePref("sidebar", true)}><ListTree /></button>
        <button type="button" className="k-spine-btn" data-testid="errors-button" aria-label={errors ? `${errors} open failures` : "Errors"} title={errors ? `${errors} open failures` : "No failures recorded"} data-alert={errors > 0 || undefined} onClick={() => setUI({ errors: true })}><Bug />{errors > 0 && <span className="k-spine-count">{errors}</span>}</button>
        <button type="button" className="k-spine-btn" data-testid="settings-button" aria-label="Settings" title="Settings" onClick={() => navigate({ name: "settings", section: "general" })}><Settings /></button>
        <button type="button" className="k-spine-btn" data-testid="theme-toggle" aria-label={`Theme: ${theme}. Change`} title={`Theme: ${theme}`} onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}><ThemeIcon /></button>
      </div>
    </nav>
  );
}

export function Bridge() {
  const route = useUI((s) => s.route);
  const cap = useCapacity();
  const { ranked, watches, list } = useLive();
  const helm = route.name === "session" ? route.id : null;
  const fresh = route.name === "new";

  // Which sessions get a station: the helm, then by attention. Shown in the
  // order they were started, so a station never jumps when its state changes.
  const stations = useMemo(() => {
    const room = cap - (fresh ? 1 : 0);
    const pick: Session[] = [];
    const h = helm ? list.find((s) => s.id === helm) : undefined;
    if (h) pick.push(h);
    for (const s of ranked) if (pick.length < room && s.id !== helm) pick.push(s);
    return pick.slice(0, Math.max(room, h ? 1 : 0)).sort((a, b) => a.created - b.created);
  }, [ranked, list, helm, cap, fresh]);
  const shown = useMemo(() => new Set(stations.map((s) => s.id)), [stations]);
  const byStart = useMemo(() => [...list].sort((a, b) => a.created - b.created), [list]);

  return (
    <div className="k-bridge" data-testid="bridge">
      <Spine sessions={byStart} shown={shown} watches={watches} current={helm} />
      <main className="k-stations" data-count={stations.length + (fresh ? 1 : 0)}>
        {fresh && (
          <section className="k-station k-station-new" data-helm aria-label="New session">
            <div className="k-band" aria-hidden="true" />
            <StartBox />
          </section>
        )}
        {stations.map((s) => <Station key={s.id} s={s} helm={s.id === helm} />)}
        {!fresh && stations.length === 0 && (
          <section className="k-station k-station-new" data-helm aria-label="New session"><div className="k-band" aria-hidden="true" /><StartBox /></section>
        )}
      </main>
      <IndexDrawer />
    </div>
  );
}
