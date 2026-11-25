// Settings > Telemetry: what you press. The controls of the page, the desktop
// app and the page on a phone, most used first in each view, and the controls
// that were drawn but not pressed. Read from the record this machine keeps
// (src/admin/presses.ts); nothing of it leaves the machine, and the page says so.
import { useCallback, useEffect, useState } from "react";
import type { PressReport } from "../../../src/admin/presses.ts";
import { every } from "../lib/clock.ts";
import { batcher, setRecording } from "../lib/presses.ts";
import { api, reportError } from "../lib/store.ts";
import { clock, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { Segmented } from "./Settings.tsx";
import { Disclosure, Empty, Group, Item, List, More, Page, SettingRow } from "./settings/kit.tsx";
import { Stat, Stats } from "./Stat.tsx";

type Report = PressReport & { record: boolean };
const NEVER_SHOWN = 12;
type Days = "7" | "30" | "90";

const VIEW: Record<string, string> = { new: "Start page", session: "A session", project: "A project" };
export const viewName = (v: string) => VIEW[v] ?? (v.startsWith("settings/") ? `Settings: ${v.slice(9)}` : v.startsWith("customize/") ? `Customize: ${v.slice(10)}` : v);
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

  if (!r) return <Empty>Reading what you pressed.</Empty>;
  const top = Math.max(1, ...r.views.flatMap((v) => v.controls.map((c) => c.presses)));
  return (
    <Page testid="telemetry-panel">
      <Group testid="press-disclosure" title="What this records" hint={<>
        <p>Keel notes which control you press: its name, the view, the session in view and the time. Never a word you type and never a value.</p>
        <p>It stays in this machine's own database. It is not sent to Keel's makers, a model provider or anyone else.</p>
        <Disclosure summary="How it is counted">
          <p>A command run by its shortcut is counted as key:name, and the keys that send as key:send or key:queue; other plain keys are not counted. A press on a session's row, or on one of its actions, is counted for that row's session. It is the same in the browser, the desktop app and the page on a phone.</p>
          <p>It is not part of the OTLP export. It is kept {r.kept_days} days, at most {r.row_cap.toLocaleString()} presses.</p>
          <p>What you press most tells which controls earn their place.</p>
        </Disclosure>
      </>}>
        <SettingRow label="Recording" hint="Off: nothing new is noted. What was recorded stays until it ages out or you forget it.">
          <Segmented<"on" | "off"> label="Record what I press" value={r.record ? "on" : "off"} onChange={(v) => void record(v === "on")} options={[{ value: "on", label: "Record" }, { value: "off", label: "Do not record" }]} />
        </SettingRow>
        <SettingRow label="Forget it all" hint="Every recorded press and every control the page drew is removed from this machine.">
          <button type="button" className="k-btn k-btn-lg" data-testid="press-forget" disabled={!r.rows} onClick={() => void forget()}>Forget it all</button>
        </SettingRow>
      </Group>

      <Group title="What you pressed" hint={r.first_ms ? `Recording since ${when(r.first_ms)}.` : undefined} bare
        actions={<Segmented<Days> label="Range" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />}>
        <Stats>
          <Stat testid="press-total" label="Presses" value={r.presses.toLocaleString()} sub={`last ${r.days} days`} />
          <Stat label="Views" value={r.views.length.toLocaleString()} />
          <Stat testid="press-surfaces" label="Where" value={r.surfaces[0] ? `${r.surfaces[0].presses.toLocaleString()} ${SURFACE[r.surfaces[0].surface] ?? r.surfaces[0].surface}` : "none yet"} sub={r.surfaces.length > 1 ? r.surfaces.slice(1).map((x) => `${x.presses.toLocaleString()} ${SURFACE[x.surface] ?? x.surface}`).join(", ") : "no other surface"} />
          <Stat label="Never pressed" value={r.never.length.toLocaleString()} sub="drawn, not pressed" />
        </Stats>
      </Group>

      {!r.views.length ? <Group><Empty testid="press-empty">{r.record ? "Nothing pressed yet in this range." : "Recording is off."}</Empty></Group> : r.views.map((v) => (
        <Group key={v.view} testid="press-view" data-view={v.view} title={viewName(v.view)} count={plural(v.presses, "press", "presses")}>
          <List label={viewName(v.view)} dense>
            {v.controls.map((c) => (
              <Item key={c.control} testid="press-row" data-control={c.control} mono name={c.control}
                sub={<span className="k-set-bar" aria-hidden><span style={{ width: `${(100 * c.presses) / top}%` }} /></span>}
                meta={<>
                  <span className="text-ui text-fg" data-testid="press-count">{c.presses.toLocaleString()}</span>
                  <span className="w-12 text-right text-faint" title={c.surfaces.split(",").map((x) => SURFACE[x] ?? x).join(", ")}>{clock(c.last_ms)}</span>
                </>} />
            ))}
          </List>
        </Group>
      ))}

      <Group testid="press-never" title={`Never pressed in ${r.days} days`} count={r.never.length ? r.never.length.toLocaleString() : undefined} hint="Controls the page drew in this range that you did not press once, with the views they were drawn in.">
        {!r.never.length ? <Empty>{r.first_ms || r.views.length ? "Every control drawn was pressed." : "No control has been seen yet."}</Empty> : (
          <List label="Never pressed" dense>
            {(all ? r.never : r.never.slice(0, NEVER_SHOWN)).map((n) => (
              <Item key={n.control} testid="press-never-row" data-control={n.control} mono name={n.control}
                sub={n.views.split(",").map(viewName).join(", ")} clip
                meta={<span className="text-faint">seen since {when(n.seen_since_ms)}</span>} />
            ))}
            {r.never.length > NEVER_SHOWN && <More><button type="button" className="k-btn" data-testid="press-never-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${r.never.length}`}</button></More>}
          </List>
        )}
      </Group>
    </Page>
  );
}
