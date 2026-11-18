// Wake: time is the main axis. The chart across the top draws every session
// as a lane over the last hours: turns as bars, tool calls as ticks, failures
// as notches, a waiting approval as a flag at the now line. Below it the open
// session reads like a logbook, prose in one column and the work beside it.
import { Bug, ListTree, Moon, Plus, Search, Settings, Sun, SunMoon } from "lucide-react";
import { useMemo } from "react";
import type { Session } from "../../../../src/core/types.ts";
import { useStore } from "../../lib/store.ts";
import { navigate, savePref, setTheme, setUI, useUI } from "../../lib/ui.ts";
import { lastLine, timeline, useLoadEvents, WATCH_LABEL, type Watch } from "../../lib/watch.ts";
import { Logo } from "../Logo.tsx";
import { Boundary, SessionView } from "../SessionView.tsx";
import { StartBox } from "../StartBox.tsx";
import { folderOf, IndexDrawer, Mark, useLive, useNow } from "./common.tsx";

const LANES = 12;
const MIN = 60_000;
const STEPS = [5, 10, 15, 30, 60, 120, 180, 360].map((m) => m * MIN);

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function Lane({ s, w, from, to, current }: { s: Session; w: Watch; from: number; to: number; current: boolean }) {
  const events = useStore((x) => x.events[s.id]);
  const t = useMemo(() => timeline(events, s.phase === "working"), [events, s.phase]);
  const x = (ts: number) => `${(100 * (Math.max(from, ts) - from)) / (to - from)}%`;
  const wd = (a: number, b: number) => `${Math.max(0.15, (100 * (Math.min(to, b) - Math.max(from, a))) / (to - from))}%`;
  return (
    <li className="k-lane" data-watch={w} aria-current={current ? "page" : undefined}>
      <button type="button" className="k-lane-label" data-testid="session-row" data-session={s.id} onClick={() => navigate({ name: "session", id: s.id })}>
        <Mark w={w} />
        <span className="k-lane-title">{s.title || "New session"}</span>
        <span className="k-lane-sub">{w === "done" ? folderOf(s) : WATCH_LABEL[w]}</span>
      </button>
      <div className="k-lane-track" aria-hidden="true">
        {t.spans.filter((sp) => (sp.end ?? to) >= from).map((sp, i) => (
          <span key={i} className="k-span" data-live={sp.end === null || undefined} data-reason={sp.reason} style={{ left: x(sp.start), width: wd(sp.start, sp.end ?? to) }} />
        ))}
        {t.ticks.filter((k) => k.ts >= from).map((k, i) => <span key={i} className="k-tickmark" data-kind={k.kind} data-error={k.error || undefined} style={{ left: x(k.ts) }} />)}
        {t.errors.filter((e) => e >= from).map((e, i) => <span key={i} className="k-notch" style={{ left: x(e) }} />)}
        {w === "need" && <span className="k-flag" />}
      </div>
      <span className="k-lane-line" title={lastLine(events, s.workspace)}>{lastLine(events, s.workspace)}</span>
    </li>
  );
}

function Chart() {
  const { ranked, watches } = useLive();
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts).length);
  const lanes = useMemo(() => {
    // Attention first, but the open session always has its lane.
    const top = ranked.slice(0, LANES);
    const cur = route.name === "session" ? ranked.find((s) => s.id === route.id) : undefined;
    return cur && !top.includes(cur) ? [...top.slice(0, LANES - 1), cur] : top;
  }, [ranked, route]);
  useLoadEvents(lanes.map((s) => s.id));
  const working = lanes.some((s) => watches[s.id] === "work");
  const now = useNow(true, working ? 2000 : 30_000);
  const allEvents = useStore((x) => x.events);
  // The window: from the oldest turn on the chart (within six hours) to now,
  // rounded up to a readable step, with the now line near the right edge.
  const first = Math.min(...lanes.flatMap((s) => (allEvents[s.id] ?? []).filter((e) => e.kind === "turn_start").map((e) => e.ts)), now - 5 * MIN);
  const span = STEPS.find((st) => st >= (now - first) * 1.08) ?? STEPS[STEPS.length - 1]!;
  const to = now + span * 0.04;
  const from = to - span;
  const grid = span / 6;
  const marks = Array.from({ length: 6 }, (_, i) => Math.ceil(from / grid) * grid + i * grid).filter((m) => m < now);
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  const counts = { need: 0, work: 0, fail: 0 };
  for (const s of ranked) { const w = watches[s.id]; if (w === "need" || w === "work" || w === "fail") counts[w]++; }

  return (
    <section className="k-chart" aria-label="Sessions over time" data-testid="wake-chart">
      <header className="k-chart-bar">
        <span className="k-brand"><Logo /> Keel</span>
        <p className="k-chart-sum" aria-live="polite">
          {counts.need > 0 && <span data-watch="need">{counts.need} need you</span>}
          {counts.work > 0 && <span data-watch="work">{counts.work} working</span>}
          {counts.fail > 0 && <span data-watch="fail">{counts.fail} failed</span>}
          {counts.need + counts.work + counts.fail === 0 && <span>All quiet</span>}
        </p>
        <nav className="k-chart-tools" aria-label="Keel">
          <button type="button" data-testid="new-session" onClick={() => navigate({ name: "new" })} aria-current={route.name === "new" ? "page" : undefined}><Plus /> New session</button>
          <button type="button" data-testid="open-palette" onClick={() => setUI({ palette: true })} aria-label="Search and commands" title="Search and commands (Ctrl K)"><Search /></button>
          <button type="button" data-testid="show-sidebar" onClick={() => savePref("sidebar", true)} aria-label="All sessions by folder" title="All sessions by folder (Ctrl B)"><ListTree /></button>
          <button type="button" data-testid="errors-button" onClick={() => setUI({ errors: true })} aria-label="Errors" title={errors ? `${errors} open failures` : "No failures recorded"} data-alert={errors > 0 || undefined}><Bug />{errors > 0 ? errors : null}</button>
          <button type="button" data-testid="settings-button" onClick={() => navigate({ name: "settings", section: "general" })} aria-label="Settings" title="Settings"><Settings /></button>
          <button type="button" data-testid="theme-toggle" onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} aria-label={`Theme: ${theme}. Change`} title={`Theme: ${theme}`}><ThemeIcon /></button>
        </nav>
      </header>
      <div className="k-chart-body">
        <div className="k-axis" aria-hidden="true" style={{ ["--nowf" as string]: String((now - from) / span) }}>
          {marks.map((m) => <span key={m} style={{ ["--x" as string]: String((m - from) / span) }}>{hhmm(m)}</span>)}
          <span className="k-now-label">now</span>
        </div>
        <ol className="k-lanes" style={{ ["--nowf" as string]: String((now - from) / span) }}>
          {lanes.map((s) => <Lane key={s.id} s={s} w={watches[s.id]!} from={from} to={to} current={route.name === "session" && route.id === s.id} />)}
          {lanes.length === 0 && <li className="k-lane-empty">Sessions you start draw their wake here.</li>}
        </ol>
      </div>
    </section>
  );
}

export function Wake() {
  const route = useUI((s) => s.route);
  return (
    <div className="k-wake" data-testid="wake">
      <Chart />
      <main className="k-log">
        {route.name === "session" ? <Boundary><SessionView key={route.id} id={route.id} /></Boundary> : <StartBox />}
      </main>
      <IndexDrawer />
    </div>
  );
}
