// Settings > Daemon: the process serving this page, keeping the machine awake
// while turns run, a restart that lets running turns finish, and the problem
// report.
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { adoptAllBuilds } from "../lib/builtins.ts";
import { composing } from "../lib/keys.ts";
import { actions, api, onFeature, reportError, scope, useStore, type BuildPins } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, fmtTokens, when } from "../lib/utils.ts";
import { type Restart, restartSummary, restartTurnLine } from "../../../src/admin/life-rows.ts";
import type { CauseKind } from "../../../src/admin/stall-cause.ts";
import { CAUSE_LABEL, ownDoing, secs } from "../../../src/admin/stall-rows.ts";
import { askRestart, turnsOf } from "../lib/restart.ts";
import { countName, STATE_WORD } from "../../../src/core/state-words.ts";
import { Card, Segmented, SettingRow } from "./Settings.tsx";
import { useSettings } from "./StoragePanel.tsx";
import { useAppSays } from "./Stale.tsx";

type Stall = { ts_ms: number; ms: number; what: string; kind: string; error_id?: string };
type Status = { pid: number; started_ms: number; uptime_ms: number; state_dir: string; bun: string; systemd: boolean; running: string[]; waiting?: string[]; draining: { since_ms: number; restart: boolean; deadline_ms: number; backup_since_ms?: number } | null; restart_failed?: { ts_ms: number; error: string } | null; last_start?: Restart | null; stalls?: Stall[]; earlier_starts?: { start: Restart; stalls: Stall[]; down_ms?: number }[] };
const ENDED: Record<NonNullable<Restart["before"]>["how"] | "unknown", string> = { killed: "Went down", crash: "Failed", restart: "Restarted", stop: "Stopped", signal: "Stopped by a signal", unknown: "Not known" };
const BECAME: Record<Restart["turns"][number]["state"], string> = { continued: "Resumed", held: "Held", moved: "Went on", left: "Left as cut", pending: "Deciding" };
type Awake = { available: boolean; held: boolean; locked: boolean; mode: string; on_battery: boolean; since_ms?: number; reason?: string; refused?: string; until_ms?: number };

const btn = "k-btn k-btn-lg shrink-0";
// How long the daemon has been up, never more than it was: the panel is read again every ten seconds,
// so under a minute is said as such (a daemon a second old is not "up 1 min").
const dur = (ms: number) => (ms < 60_000 ? "under a minute" : ms < 3600_000 ? `${Math.floor(ms / 60_000)} min` : ms < 86_400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);

// A number of hours, or no limit when empty or 0.
function HoursField({ value, onSave }: { value: number; onSave: (v: number) => Promise<unknown> }) {
  const [text, setText] = useState(value ? String(value) : "");
  const [bad, setBad] = useState(false);
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const save = () => {
    const v = text.trim() === "" ? 0 : Number(text.trim());
    if (!Number.isFinite(v) || v < 0) return setBad(true);
    setBad(false);
    if (v !== value) onSave(v).catch((e) => { setBad(true); reportError(e); });
  };
  return (
    <label className={cn("flex h-8 items-center gap-2 rounded-md border bg-raised px-2.5 text-ui", bad ? "border-danger" : "border-line-strong")}>
      <input
        aria-label="Hours a session may stay behind"
        data-testid="build-pin-hours"
        inputMode="numeric"
        value={text}
        placeholder="No limit"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && (e.currentTarget as HTMLInputElement).blur()}
        className="w-16 bg-transparent text-right tabular-nums outline-none placeholder:text-faint"
      />
      <span className="text-muted">hours</span>
    </label>
  );
}

// After an upgrade: how long a session may keep an earlier build's tools and
// prompt, and taking the running build's in every session at once.
function BuildPinCard({ hours, onHours }: { hours: number; onHours: (v: number) => Promise<unknown> }) {
  const [pins, setPins] = useState<BuildPins | null>(null);
  const load = () => actions.buildPins().then(setPins).catch((e) => reportError(e, { at: "daemon panel" }));
  useEffect(() => { load(); }, []);
  const n = pins?.sessions.length ?? 0;
  return (
    <Card>
      <SettingRow
        label="A session behind takes a new build's tools and prompt after"
        hint="Across an upgrade a session keeps the tools and system prompt it was last sent, so its cached context is not written again, and takes the new build's when that cache is cold anyway. One that stays warm takes them after this long at the latest, at one rewrite of its context."
      >
        <HoursField value={hours} onSave={onHours} />
      </SettingRow>
      <SettingRow
        label="Sessions on an earlier build"
        hint={!pins ? "Counting." : n || pins.unknown
          ? `${n} open session${n === 1 ? "" : "s"}${pins.unknown ? `, and ${pins.unknown} not compared yet` : ""}. Taking this build's now rewrites about ${fmtTokens(pins.tokens)} tokens of cached context at their next requests.`
          : pins.asked ? `${pins.asked} session${pins.asked === 1 ? " takes" : "s take"} this build's tools and prompt at the next request.`
            : "None: every open session uses this build's tools and prompt."}
      >
        <button type="button" className={btn} disabled={!pins || (!n && !pins.unknown)} data-testid="build-adopt-all" onClick={() => adoptAllBuilds().then(load).catch(reportError)}>
          Use this build's in all
        </button>
      </SettingRow>
    </Card>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" | "danger" }) {
  return <span className={cn("size-2 shrink-0 rounded-full", { ok: "bg-ok", warn: "bg-warn", off: "bg-line-strong", danger: "bg-danger" }[tone])} />;
}

// One stall: how long, what kind of cause, what took the time, and when.
function StallLine({ s }: { s: Stall }) {
  return (
    <li data-testid="daemon-stall" data-kind={s.kind} className="flex items-baseline gap-3 py-1.5">
      <span className="w-12 shrink-0 text-ui font-medium tabular-nums">{secs(s.ms)}</span>
      <span className={cn("w-28 shrink-0 text-caption font-medium", ownDoing(s.kind) ? "text-warn" : "text-muted")}>{CAUSE_LABEL[s.kind as CauseKind] ?? CAUSE_LABEL.unknown}</span>
      <span className="min-w-0 flex-1 break-words text-ui text-muted">{s.what}</span>
      <span className="shrink-0 text-caption tabular-nums text-faint" title={when(s.ts_ms)}>{ago(s.ts_ms)}</span>
    </li>
  );
}

// The starts before this one, the newest first: how each began, what it cut, and the stalls of its life.
function EarlierStarts({ starts }: { starts: NonNullable<Status["earlier_starts"]> }) {
  return (
    <Card>
      <SettingRow label="Earlier starts" hint="The starts before this one, the newest first, with how the daemon before each ended, what that cut, and the times each answered nothing.">
        <span className="text-ui tabular-nums text-muted" data-testid="daemon-earlier-count">{starts.length}</span>
      </SettingRow>
      <ol className="flex flex-col" data-testid="daemon-earlier-starts">
        {starts.map(({ start: r, stalls }) => (
          <li key={r.id} data-testid="daemon-earlier-start" data-how={r.before?.how ?? "unknown"} className="flex flex-col gap-1 border-b border-line py-3 last:border-0">
            <span className="flex items-baseline gap-3">
              <span className="flex w-24 shrink-0 items-center gap-2 text-caption text-fg">
                <Dot tone={r.before?.how === "killed" || r.before?.how === "crash" ? "danger" : "off"} />
                {ENDED[r.before?.how ?? "unknown"]}
              </span>
              <span className="min-w-0 flex-1 text-ui text-muted" data-testid="daemon-earlier-summary">{restartSummary(r)}</span>
              <span className="shrink-0 text-caption tabular-nums text-faint" title={when(r.up_ms)}>{ago(r.up_ms)}</span>
            </span>
            {stalls.length > 0 && (
              <ul className="ml-[6.75rem] flex flex-col" data-testid="daemon-earlier-stalls">
                {stalls.map((s) => <StallLine key={`${s.ts_ms}-${s.ms}`} s={s} />)}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function DaemonPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [aw, setAw] = useState<Awake | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [settings, patch] = useSettings();
  const connected = useStore((s) => s.connected);
  const appSays = useAppSays();
  const sessions = useStore((s) => s.sessions);

  useEffect(() => {
    const load = () => {
      api<Status>("/api/daemon").then(setSt).catch((e) => reportError(e, { at: "daemon panel" }));
      api<Awake>("/api/awake").then(setAw).catch((e) => reportError(e, { at: "daemon panel" }));
    };
    load();
    const off = onFeature({
      frame: (f) => { if (f.name === "daemon") setSt(f.data); if (f.name === "awake") setAw(f.data); },
      reconnect: load,
    });
    const iv = setInterval(load, 10_000);
    const heard = scope.feed("awake"); // what keeps the machine awake is sent while this panel is up (lib/scope.ts)
    return () => { off(); clearInterval(iv); heard(); };
  }, []);

  const restart = () => askRestart(st ?? { running: [] }, "asked from Settings, Daemon");

  if (!st) return <div className="text-ui text-faint">Asking the daemon.</div>;
  const draining = st.draining;
  const { working, waiting } = turnsOf(st);
  const titles = (ids: string[]) => ids.map((id) => sessions[id]?.title || "a session").join(", ");
  return (
    <div className="flex flex-col gap-4" data-testid="daemon-panel">
      <Card>
        <SettingRow label="Daemon" hint={<span className="font-mono text-caption">{st.state_dir}</span>}>
          <span className="flex items-center gap-2 text-ui text-muted" data-testid="daemon-status">
            <Dot tone={!connected ? "danger" : draining ? "warn" : "ok"} />
            {!connected ? (appSays ?? "Reconnecting") : draining ? (draining.restart ? "Restarting" : "Stopping") : `pid ${st.pid}, up ${dur(Date.now() - st.started_ms)}`}
          </span>
        </SettingRow>
        {/* The turns that work, apart from those that only wait on the owner: a restart waits for the first, not the second. */}
        <SettingRow label="Working turns" hint={working.length || waiting.length ? [working.length ? titles(working) : "", waiting.length ? `${STATE_WORD.need}: ${titles(waiting)}` : ""].filter(Boolean).join(". ") : "None right now."}>
          <span className="text-ui tabular-nums text-muted" data-testid="daemon-running">{working.length}{waiting.length > 0 && <span className="text-faint" data-testid="daemon-waiting">{`, ${waiting.length} ${countName("need", waiting.length)}`}</span>}</span>
        </SettingRow>
        <SettingRow
          label="Restart"
          hint={draining ? `${draining.backup_since_ms ? `Making the backup since ${when(draining.backup_since_ms)}` : `Waiting for running turns since ${when(draining.since_ms)}`}; new work is held until the daemon is back.` : (
            <>
              New work waits, running turns finish, and the daemon starts again{st.systemd ? " under systemd" : " from its own binary"}. A backup is made first{settings?.backup.before_restart === false ? " when that is on in Storage" : ""}.
              {st.restart_failed && (
                <span role="alert" data-testid="daemon-restart-failed" className="mt-2 flex items-start gap-2 text-danger">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">The restart of {when(st.restart_failed.ts_ms)} was called off, and Keel takes work as before. {st.restart_failed.error}</span>
                </span>
              )}
            </>
          )}
        >
          <button type="button" className={btn} disabled={!!draining || !connected} onClick={() => restart().catch(reportError)} data-testid="daemon-restart">
            {draining ? "Restarting" : "Restart"}
          </button>
        </SettingRow>
      </Card>

      {st.last_start && (st.last_start.before || st.last_start.turns.length > 0) && (
        <Card>
          {/* The start that made this daemon: when the one before it went down, how, and each turn that cut. */}
          <SettingRow label="Last start" hint={<span data-testid="daemon-last-start">{restartSummary(st.last_start)}</span>}>
            <span className="flex items-center gap-2 text-ui text-muted" data-testid="daemon-last-how">
              <Dot tone={st.last_start.before?.how === "killed" || st.last_start.before?.how === "crash" ? "danger" : "off"} />
              {ENDED[st.last_start.before?.how ?? "unknown"]}
            </span>
          </SettingRow>
          {st.last_start.turns.length > 0 && (
            <ul className="flex flex-col border-b border-line py-2 last:border-0" data-testid="daemon-cut-turns">
              {st.last_start.turns.map((t) => (
                <li key={t.end_event}>
                  <button
                    type="button"
                    data-testid="daemon-cut-turn"
                    data-state={t.state}
                    onClick={() => navigate({ name: "session", id: t.session_id })}
                    title={t.state === "held" ? t.why : undefined}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 text-ui text-muted">
                      {restartTurnLine(t).replace(/: [^:]*$/, "")}
                      {t.state === "held" && t.why && <span className="mt-0.5 block text-caption text-faint">{t.why}</span>}
                    </span>
                    <span className={cn("shrink-0 text-caption font-medium", t.state === "held" ? "text-warn" : t.state === "pending" ? "text-faint" : "text-muted")}>{BECAME[t.state]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {!!st.stalls?.length && (
        <Card>
          {/* Each time since this start that the daemon answered nothing, with what the watcher saw take the time. */}
          <SettingRow label="Unresponsive since this start" hint="Times the daemon answered nothing for two seconds or more, and what took the time: its own doing, or a machine that did not run it. Errors holds one row per cause.">
            <span className="text-ui tabular-nums text-muted" data-testid="daemon-stall-count">{st.stalls.length}</span>
          </SettingRow>
          <ul className="flex flex-col py-2" data-testid="daemon-stalls">
            {st.stalls.map((s) => <StallLine key={`${s.ts_ms}-${s.ms}`} s={s} />)}
          </ul>
        </Card>
      )}

      {!!st.earlier_starts?.length && <EarlierStarts starts={st.earlier_starts} />}

      {settings && aw && (
        <Card>
          <SettingRow label="Keep the machine awake" hint="Holds off sleep and idle suspend while a turn runs or a loop is due within 15 minutes, through logind. The lock ends with the daemon, however it stops.">
            <Segmented label="Keep awake" value={settings.keep_awake.mode} onChange={(v) => patch({ keep_awake: { mode: v } }).catch(reportError)} options={[{ value: "turns", label: "While turns run" }, { value: "never", label: "Never" }]} />
          </SettingRow>
          <SettingRow
            label="Now"
            hint={!aw.available ? (aw.refused ? `logind refused: ${aw.refused}` : "This machine has no logind to ask.") : aw.held ? `${aw.reason}${aw.since_ms ? `, since ${when(aw.since_ms)}` : ""}${aw.on_battery ? ". On battery." : ""}` : `Not held.${aw.on_battery ? " On battery." : ""}`}
          >
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-2 text-ui text-muted" data-testid="awake-state">
                <Dot tone={aw.held ? (aw.locked ? "ok" : "warn") : aw.available ? "off" : "danger"} />
                {aw.held ? (aw.locked ? "Held" : "Asking") : "Not held"}
              </span>
              {aw.until_ms ? (
                <button type="button" className={btn} onClick={() => api<Awake>("/api/awake", { method: "POST", body: JSON.stringify({ until_ms: null }) }).then(setAw).catch(reportError)}>End hold</button>
              ) : (
                <button type="button" className={btn} disabled={!aw.available && !aw.refused} data-testid="awake-hold" onClick={() => api<Awake>("/api/awake", { method: "POST", body: JSON.stringify({ until_ms: Date.now() + 3600_000 }) }).then(setAw).catch(reportError)}>Hold for an hour</button>
              )}
            </span>
          </SettingRow>
        </Card>
      )}

      {settings && <BuildPinCard hours={Number(settings.build_pin?.max_age_hours ?? 0)} onHours={(v) => patch({ build_pin: { max_age_hours: v } })} />}

      <Card>
        <SettingRow label="Problem report" hint={report ?? "A redacted bundle (no keys or tokens) of the errors since the start, the providers' state, the settings and what Keel's processes cost, written under the state folder."}>
          <button
            type="button"
            className={btn}
            data-testid="report-write"
            onClick={() => api<{ path: string; summary: string }>("/api/report", { method: "POST", body: "{}" }).then((r) => setReport(`${r.summary}. Written to ${r.path}`)).catch(reportError)}
          >
            Write a report
          </button>
        </SettingRow>
      </Card>
    </div>
  );
}
