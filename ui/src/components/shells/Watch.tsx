// Night watch: triage first. The board sorts every session by what it needs
// from you: needs you, working, failed, done. A waiting approval is answered
// on the board itself. The open session is a sheet beside the board, set as
// a ledger. Dark only: low light for long nights, one bright thing at a time.
import { ArrowLeft, Bug, ListTree, Plus, Search, Settings } from "lucide-react";
import { useMemo } from "react";
import type { Session } from "../../../../src/core/types.ts";
import { useStore } from "../../lib/store.ts";
import { navigate, savePref, setUI, useUI } from "../../lib/ui.ts";
import { lastLine, useLoadEvents, WATCH_LABEL, type Watch as W } from "../../lib/watch.ts";
import { ago } from "../../lib/utils.ts";
import { Approvals } from "../ApprovalCard.tsx";
import { Logo } from "../Logo.tsx";
import { Boundary, SessionView } from "../SessionView.tsx";
import { StartBox } from "../StartBox.tsx";
import { elapsed, folderOf, IndexDrawer, Mark, useLive, useNow } from "./common.tsx";

const COLUMNS: { w: W[]; name: string; empty: string }[] = [
  { w: ["need"], name: "Needs you", empty: "Nothing is waiting on you." },
  { w: ["work"], name: "Working", empty: "No session is working." },
  { w: ["fail"], name: "Failed", empty: "No failures." },
  { w: ["done", "idle"], name: "Done", empty: "Finished sessions land here." },
];

function Card({ s, w, current, now }: { s: Session; w: W; current: boolean; now: number }) {
  const events = useStore((x) => x.events[s.id]);
  const start = useMemo(() => [...(events ?? [])].reverse().find((e) => e.kind === "turn_start")?.ts, [events]);
  const line = lastLine(events, s.workspace);
  return (
    <li className="k-card" data-watch={w} aria-current={current ? "page" : undefined}>
      <button type="button" className="k-card-open" data-testid="session-row" data-session={s.id} onClick={() => navigate({ name: "session", id: s.id })}>
        <span className="k-card-head">
          <Mark w={w} />
          <span className="k-card-title">{s.title || "New session"}</span>
          <span className="k-card-time tabular-nums">{w === "work" && start ? elapsed(now - start) : ago(s.updated)}</span>
        </span>
        <span className="k-card-folder">{folderOf(s)}</span>
        {line && <span className="k-card-line">{line}</span>}
      </button>
      {w === "need" && <div className="k-card-act"><Approvals sessionId={s.id} /></div>}
    </li>
  );
}

function Board({ compact }: { compact: boolean }) {
  const { ranked, watches } = useLive();
  const route = useUI((s) => s.route);
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts).length);
  useLoadEvents(ranked.slice(0, 24).map((s) => s.id));
  const working = ranked.some((s) => watches[s.id] === "work");
  const now = useNow(working);
  const current = route.name === "session" ? route.id : null;
  return (
    <section className="k-board" data-compact={compact || undefined} aria-label="Sessions by what they need">
      <header className="k-board-bar">
        <span className="k-brand"><Logo /> Keel</span>
        <nav className="k-board-tools" aria-label="Keel">
          <button type="button" data-testid="new-session" onClick={() => navigate({ name: "new" })} aria-current={route.name === "new" ? "page" : undefined}><Plus /> New</button>
          <button type="button" data-testid="open-palette" onClick={() => setUI({ palette: true })} aria-label="Search and commands" title="Search and commands (Ctrl K)"><Search /></button>
          <button type="button" data-testid="show-sidebar" onClick={() => savePref("sidebar", true)} aria-label="All sessions by folder" title="All sessions by folder (Ctrl B)"><ListTree /></button>
          <button type="button" data-testid="errors-button" onClick={() => setUI({ errors: true })} aria-label="Errors" title={errors ? `${errors} open failures` : "No failures recorded"} data-alert={errors > 0 || undefined}><Bug />{errors > 0 ? errors : null}</button>
          <button type="button" data-testid="settings-button" onClick={() => navigate({ name: "settings", section: "general" })} aria-label="Settings" title="Settings"><Settings /></button>
        </nav>
      </header>
      <div className="k-columns">
        {COLUMNS.map((c) => {
          const list = ranked.filter((s) => c.w.includes(watches[s.id]!));
          return (
            <section key={c.name} className="k-column" data-watch={c.w[0]} data-empty={list.length === 0 || undefined}>
              <h2 className="k-column-name">{c.name}<span className="k-column-n tabular-nums">{list.length || ""}</span></h2>
              {list.length === 0 ? <p className="k-column-empty">{c.empty}</p> : (
                <ol className="k-cards">{list.map((s) => <Card key={s.id} s={s} w={watches[s.id]!} current={current === s.id} now={now} />)}</ol>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function Watch() {
  const route = useUI((s) => s.route);
  const open = route.name === "session" || route.name === "new";
  const opened = route.name === "session";
  return (
    <div className="k-watch" data-open={opened || undefined} data-testid="watch">
      <Board compact={open} />
      <main className="k-sheet">
        {opened && <button type="button" className="k-back" onClick={() => navigate({ name: "new" })}><ArrowLeft /> Board</button>}
        {route.name === "session" ? <Boundary><SessionView key={route.id} id={route.id} /></Boundary> : <StartBox />}
      </main>
      <IndexDrawer />
    </div>
  );
}
