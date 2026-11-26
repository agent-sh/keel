// Settings > Sessions elsewhere: the sessions Claude Code and Codex run on this
// machine, in Keel's list while they run (src/integrations/outside/). Whether
// Keel watches for them at all, the folders whose sessions are never shown,
// how far back a folder counts, and when a silent session shows as stale. The
// section is the server's (src/integrations/outside/settings.ts): a change is
// a merge patch of it, refused whole when a value is not one it takes.
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { OutsideSettings as Values } from "../../../src/integrations/outside/settings.ts";
import type { OutsideStatus } from "../../../src/integrations/outside/service.ts";
import { composing } from "../lib/keys.ts";
import { api, failed, reportError } from "../lib/store.ts";
import { Card, SettingRow } from "./Settings.tsx";
import { Toggle, tail } from "./surfaces/kit.tsx";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function OutsideSettings() {
  const [v, setV] = useState<Values | null>(null);
  const [st, setSt] = useState<OutsideStatus | null>(null);
  const [err, setErr] = useState("");
  const [folder, setFolder] = useState("");
  const status = () => api<OutsideStatus>("/api/outside").then(setSt, reportError);
  useEffect(() => {
    api<{ settings: { outside: Values } }>("/api/settings").then((x) => setV(x.settings.outside), reportError);
    void status();
  }, []);
  const save = async (patch: Partial<Values>) => {
    setErr("");
    try {
      const x = await api<{ settings: { outside: Values } }>("/api/settings", { method: "PATCH", body: JSON.stringify({ outside: patch }) });
      setV(x.settings.outside);
      void status();
      return true;
    } catch (e) {
      setErr(failed(e, { at: "OutsideSettings" }));
      return false;
    }
  };
  if (!v) return null;
  const add = async () => {
    const p = folder.trim().replace(/\/+$/, "");
    if (!p || v.exclude.includes(p)) return setFolder("");
    if (await save({ exclude: [...v.exclude, p] })) setFolder("");
  };
  return (
    <section className="flex flex-col gap-2" data-testid="outside-settings">
      <h3 className="text-base font-medium">In your session list</h3>
      <p className="text-ui text-muted">
        A Claude Code or Codex session whose transcript grows shows in your list as its own session, read-only: its state, what it spent, the files it changed. Keel only reads their folders and never writes to them.
      </p>
      <Card>
        <SettingRow label="Show live sessions of other harnesses" hint={st && v.enabled ? <span data-testid="outside-watching">Watching {plural(st.watches, "folder")}; {plural(st.sessions, "session")} shown so far.</span> : "Off: no folder of theirs is watched."}>
          <Toggle on={v.enabled} label="Show live sessions of other harnesses" testid="outside-enabled" onChange={(on) => void save({ enabled: on })} />
        </SettingRow>
        <SettingRow label="Folders watched" hint="Only folders that held a session in this many days. A session that starts in an older folder is still found from the harness's own records.">
          <Num value={v.days} unit="days" testid="outside-days" whole onSave={(n) => save({ days: n })} />
        </SettingRow>
        <SettingRow label="Stale after" hint="A session that works or waits and writes nothing for this long, with no running process to vouch for it, shows as stale and leaves the working and waiting counts.">
          <Num value={v.stale_minutes} unit="minutes" testid="outside-stale" onSave={(n) => save({ stale_minutes: n })} />
        </SettingRow>
        <div className="k-setting flex flex-col gap-3 border-b border-line py-4 last:border-0">
          <div>
            <div className="text-base font-medium">Folders never shown</div>
            <div className="mt-0.5 text-ui text-muted">A session in one of these folders, or under one, stays out of your list.</div>
          </div>
          {v.exclude.length > 0 && (
            <ul className="flex flex-col gap-1" data-testid="outside-excluded">
              {v.exclude.map((p) => (
                <li key={p} className="flex h-8 items-center gap-2 rounded-md bg-sunken pl-3 pr-1 font-mono text-caption">
                  <span className="min-w-0 flex-1 truncate" title={p}>{tail(p, 72)}</span>
                  <button type="button" className="k-btn" data-quiet="" aria-label={`Show sessions in ${p} again`} onClick={() => void save({ exclude: v.exclude.filter((x) => x !== p) })}><X aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/path/to/folder" aria-label="A folder whose sessions are never shown" data-testid="outside-exclude-input" className="k-field min-w-0 flex-1 font-mono" />
            <button type="submit" className="k-btn k-btn-lg" data-testid="outside-exclude-add" disabled={!folder.trim()}>Leave out</button>
          </form>
        </div>
      </Card>
      {err && <p className="text-ui text-danger" data-testid="outside-settings-error">{err}</p>}
      <TerminalSettings />
    </section>
  );
}

// The terminal a session opens in when it moves to Claude Code or Codex (src/integrations/terminal-open.ts).
type Term = { command: string; tmux: boolean };
function TerminalSettings() {
  const [v, setV] = useState<Term | null>(null);
  const [found, setFound] = useState<{ terminal?: string; from?: string; tmux?: string } | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const look = () => api<typeof found>("/api/terminal").then(setFound, reportError);
  useEffect(() => {
    api<{ settings: { terminal: Term } }>("/api/settings").then((x) => { setV(x.settings.terminal); setText(x.settings.terminal.command); }, reportError);
    void look();
  }, []);
  const save = async (patch: Partial<Term>) => {
    setErr("");
    try {
      const x = await api<{ settings: { terminal: Term } }>("/api/settings", { method: "PATCH", body: JSON.stringify({ terminal: patch }) });
      setV(x.settings.terminal);
      void look();
    } catch (e) {
      setErr(failed(e, { at: "TerminalSettings" }));
    }
  };
  if (!v) return null;
  const said = !found?.terminal ? "None found: name one here." : found.from === "settings" ? `Uses ${found.terminal}.` : `Empty: uses ${found.terminal}, ${found.from === "TERMINAL" ? "from $TERMINAL" : "found on your PATH"}.`;
  return (
    <>
      <h3 className="mt-4 text-base font-medium">Moving a session out</h3>
      <p className="text-ui text-muted">Resume in Claude Code or Codex, in a session's menu, writes it in that harness's own format and opens it in a terminal here.</p>
      <Card>
        <SettingRow label="Terminal" hint={<span data-testid="terminal-found">The words that open a window on the command after them, as "kitty" or "gnome-terminal --". {said}</span>}>
          <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text.trim() !== v.command) void save({ command: text.trim() }); }} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) (e.target as HTMLInputElement).blur(); }}
            placeholder={found?.terminal ?? "kitty"} aria-label="Terminal command" data-testid="terminal-command" className="k-field w-64 font-mono" />
        </SettingRow>
        <SettingRow label="Keep it in tmux" hint={found?.tmux || !v.tmux ? "The harness runs in a tmux session named for it: a window closed by mistake loses nothing, tmux attach brings it back." : "No tmux on your PATH: the harness runs in the window itself."}>
          <Toggle on={v.tmux} label="Keep it in tmux" testid="terminal-tmux" onChange={(on) => void save({ tmux: on })} />
        </SettingRow>
      </Card>
      {err && <p className="text-ui text-danger" data-testid="terminal-settings-error">{err}</p>}
    </>
  );
}

// A number saved when it is left or Enter is pressed; a value the server refuses is put back.
function Num({ value, unit, testid, whole, onSave }: { value: number; unit: string; testid: string; whole?: boolean; onSave: (n: number) => Promise<boolean> }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = async () => {
    const n = Number(text);
    if (text.trim() === "" || n === value) return setText(String(value));
    if (!(await onSave(n))) setText(String(value));
  };
  return (
    <label className="flex items-center gap-2 text-ui text-muted">
      <input type="number" min={whole ? 1 : 0} step={whole ? 1 : "any"} inputMode={whole ? "numeric" : "decimal"} value={text} data-testid={testid}
        onChange={(e) => setText(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) (e.target as HTMLInputElement).blur(); }}
        className="k-field w-20 text-right tabular-nums" />
      {unit}
    </label>
  );
}
