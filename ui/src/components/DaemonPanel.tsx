// Settings > Daemon: the process serving this page, keeping the machine awake
// while turns run, a restart that lets running turns finish, and the problem
// report.
import { useEffect, useState } from "react";
import { api, onFeature, reportError, useStore } from "../lib/store.ts";
import { cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { Card, Segmented, SettingRow } from "./Settings.tsx";
import { useSettings } from "./StoragePanel.tsx";

type Status = { pid: number; started_ms: number; uptime_ms: number; state_dir: string; bun: string; systemd: boolean; running: string[]; draining: { since_ms: number; restart: boolean; deadline_ms: number } | null };
type Awake = { available: boolean; held: boolean; locked: boolean; mode: string; on_battery: boolean; since_ms?: number; reason?: string; refused?: string; until_ms?: number };

const btn = "h-8 shrink-0 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50";
const dur = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86_400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);

function Dot({ tone }: { tone: "ok" | "warn" | "off" | "danger" }) {
  return <span className={cn("size-2 shrink-0 rounded-full", { ok: "bg-ok", warn: "bg-warn", off: "bg-line-strong", danger: "bg-danger" }[tone])} />;
}

export function DaemonPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [aw, setAw] = useState<Awake | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [settings, patch] = useSettings();
  const connected = useStore((s) => s.connected);
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
    return () => { off(); clearInterval(iv); };
  }, []);

  const restart = async () => {
    const n = st?.running.length ?? 0;
    const ok = await confirmAction({
      title: "Restart Keel?",
      body: n ? `${n} turn${n > 1 ? "s are" : " is"} running. New work waits; running turns get two minutes to finish, and any still running then continue after the restart.` : "No turn is running. The page reconnects by itself.",
      action: "Restart",
    });
    if (ok) await api("/api/drain", { method: "POST", body: JSON.stringify({ restart: true }) });
  };

  if (!st) return <div className="text-ui text-faint">Asking the daemon.</div>;
  const draining = st.draining;
  return (
    <div className="flex flex-col gap-4" data-testid="daemon-panel">
      <Card>
        <SettingRow label="Daemon" hint={<span className="font-mono text-caption">{st.state_dir}</span>}>
          <span className="flex items-center gap-2 text-ui text-muted" data-testid="daemon-status">
            <Dot tone={!connected ? "danger" : draining ? "warn" : "ok"} />
            {!connected ? "Reconnecting" : draining ? (draining.restart ? "Restarting" : "Stopping") : `pid ${st.pid}, up ${dur(Date.now() - st.started_ms)}`}
          </span>
        </SettingRow>
        <SettingRow label="Running turns" hint={st.running.length ? st.running.map((id) => sessions[id]?.title || "a session").join(", ") : "None right now."}>
          <span className="text-ui tabular-nums text-muted" data-testid="daemon-running">{st.running.length}</span>
        </SettingRow>
        <SettingRow
          label="Restart"
          hint={draining ? `Waiting for running turns since ${when(draining.since_ms)}; new work is held until the daemon is back.` : `New work waits, running turns finish, and the daemon starts again${st.systemd ? " under systemd" : " from its own binary"}. A backup is made first${settings?.backup.before_restart === false ? " when that is on in Storage" : ""}.`}
        >
          <button type="button" className={btn} disabled={!!draining || !connected} onClick={() => restart().catch(reportError)} data-testid="daemon-restart">
            {draining ? "Restarting" : "Restart"}
          </button>
        </SettingRow>
      </Card>

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
