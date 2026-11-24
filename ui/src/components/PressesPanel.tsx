// Settings > Telemetry: what you press. The controls of the page, the desktop
// app and the page on a phone, most used first in each view, and the controls
// that were drawn but not pressed. Read from the record this machine keeps
// (src/admin/presses.ts); nothing of it leaves the machine, and the page says so.
import { useCallback, useEffect, useState } from "react";
import type { PressReport } from "../../../src/admin/presses.ts";
import { every } from "../lib/clock.ts";
import { batcher, setRecording } from "../lib/presses.ts";
import { api, reportError } from "../lib/store.ts";
import { clock, cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { Segmented } from "./Settings.tsx";
import { Stat, Stats } from "./Stat.tsx";

type Report = PressReport & { record: boolean };
const NEVER_SHOWN = 12;
type Days = "7" | "30" | "90";

const VIEW: Record<string, string> = { new: "Start page", session: "A session", project: "A project" };
export const viewName = (v: string) => VIEW[v] ?? (v.startsWith("settings/") ? `Settings: ${v.slice(9)}` : v);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const SURFACE: Record<string, string> = { page: "browser", desktop: "desktop app", phone: "phone" };

export default function PressesPanel() {
  const [r, setR] = useState<Report | null>(null);
  const [days, setDays] = useState<Days>("30");
  const [all, setAll] = useState(false);
  const load = useCallback(async () => {
    await batcher.flush();
    const x = await api<Report>(`/api/presses?days=${days}`);
    setRecording(x.record);
    setR(x);
  }, [days]);
  useEffect(() => {
    load().catch(reportError);
    return every(10_000, () => void load().catch(reportError));
  }, [load]);

  const record = async (on: boolean) => {
    await api("/api/settings", { method: "PATCH", body: JSON.stringify({ presses: { record: on } }) }).catch(reportError);
    setRecording(on);
    setR((p) => (p ? { ...p, record: on } : p));
  };
  const forget = async () => {
    const ok = await confirmAction({ title: "Forget what you pressed?", body: "Every recorded press and every control the page drew is removed from this machine. Recording goes on if it is on.", action: "Forget", danger: true });
    if (!ok) return;
    await api("/api/presses", { method: "DELETE" }).catch(reportError);
    await load().catch(reportError);
  };

  if (!r) return <div className="text-ui text-faint">Reading what you pressed.</div>;
  const top = Math.max(1, ...r.views.flatMap((v) => v.controls.map((c) => c.presses)));
  return (
    <div className="flex flex-col gap-4" data-testid="telemetry-panel">
      <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="press-disclosure">
        <h3 className="mb-1 text-base font-medium">What this records</h3>
        <p className="text-ui text-muted">
          Keel notes which control you press: its name, the view, the session in view and the time. Never a word you type and never a value. It is the same in the browser, the desktop app and the page on a phone.
          It stays in this machine's own database. It is not sent to Keel's makers, a model provider or anyone else, and it is not part of the OTLP export. It is kept {r.kept_days} days, at most {r.row_cap.toLocaleString()} presses.
          What you press most tells which controls earn their place.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented<"on" | "off"> label="Record what I press" value={r.record ? "on" : "off"} onChange={(v) => void record(v === "on")} options={[{ value: "on", label: "Record" }, { value: "off", label: "Do not record" }]} />
          <button type="button" className="k-btn k-btn-lg" data-testid="press-forget" disabled={!r.rows} onClick={() => void forget()}>Forget it all</button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Days> label="Range" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
        {r.first_ms && <span className="text-caption text-faint">Recording since {when(r.first_ms)}</span>}
      </div>

      <Stats>
        <Stat testid="press-total" label="Presses" value={r.presses.toLocaleString()} sub={`last ${r.days} days`} />
        <Stat label="Views" value={r.views.length.toLocaleString()} />
        <Stat label="Never pressed" value={r.never.length.toLocaleString()} sub="drawn, not pressed" />
      </Stats>

      {!r.views.length ? <p className="k-empty" data-testid="press-empty">{r.record ? "Nothing pressed yet in this range." : "Recording is off."}</p> : r.views.map((v) => (
        <section key={v.view} className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="press-view" data-view={v.view}>
          <h3 className="mb-3 flex items-baseline gap-2 text-base font-medium">{viewName(v.view)} <span className="text-caption font-normal text-faint">{plural(v.presses, "press", "presses")}</span></h3>
          <ul className="flex flex-col">
            {v.controls.map((c) => (
              <li key={c.control} className="relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 border-b border-line/60 py-1 text-ui last:border-0" data-testid="press-row" data-control={c.control}>
                <span className="absolute inset-y-0.5 left-0 rounded-xs bg-accent-soft" style={{ width: `${(100 * c.presses) / top}%` }} aria-hidden />
                <span className="relative truncate pl-1 font-mono text-caption">{c.control}</span>
                <span className="relative tabular-nums" data-testid="press-count">{c.presses.toLocaleString()}</span>
                <span className={cn("relative w-20 text-right text-caption text-faint")} title={c.surfaces.split(",").map((s) => SURFACE[s] ?? s).join(", ")}>{clock(c.last_ms)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="press-never">
        <h3 className="mb-1 text-base font-medium">Never pressed in {r.days} days</h3>
        <p className="mb-3 text-caption text-faint">Controls the page drew in this range that you did not press once, with the views they were drawn in.</p>
        {!r.never.length ? <p className="k-empty">{r.first_ms || r.views.length ? "Every control drawn was pressed." : "No control has been seen yet."}</p> : (
          <ul className="flex flex-col">
            {(all ? r.never : r.never.slice(0, NEVER_SHOWN)).map((n) => (
              <li key={n.control} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-line/60 py-1 text-ui last:border-0 max-sm:grid-cols-[minmax(0,1fr)_auto]" data-testid="press-never-row" data-control={n.control}>
                <span className="truncate font-mono text-caption">{n.control}</span>
                <span className="truncate text-caption text-muted max-sm:hidden">{n.views.split(",").map(viewName).join(", ")}</span>
                <span className="text-right text-caption text-faint">seen since {when(n.seen_since_ms)}</span>
              </li>
            ))}
          </ul>
        )}
        {r.never.length > NEVER_SHOWN && <button type="button" className="k-btn mt-3" data-testid="press-never-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${r.never.length}`}</button>}
      </section>
    </div>
  );
}
