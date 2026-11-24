import { useState } from "react";
import { auto, useAuto, type AlertSettings as Settings } from "../../lib/automation.ts";
import { reportError } from "../../lib/store.ts";
import { Card, Segmented, SettingRow } from "../Settings.tsx";
import { Tick, Toggle } from "../surfaces/kit.tsx";
import { STATE_WORD } from "../../../../src/core/state-words.ts";
import { ALERT_LABEL, ALERT_STATE, CHANNEL_NAME } from "./bits.tsx";

const KINDS: (keyof Settings["routes"])[] = ["approval", "question", "finished", "failed", "limit", "loop_failed", "agent", "snooze_over", "regression", "refused", "declined", "machine", "outage", "review", "mcp"];

// The four rows at rest: each kind is in the row of its state (what it needs from the owner).
const GROUPS: { id: string; label: string; hint: string; kinds: (keyof Settings["routes"])[] }[] = [
  { id: "need", label: STATE_WORD.need, hint: "An approval, a question, an MCP server change", kinds: KINDS.filter((k) => ALERT_STATE[k] === "need") },
  { id: "done", label: STATE_WORD.done, hint: "A finished turn, a pull request review", kinds: KINDS.filter((k) => ALERT_STATE[k] === "done") },
  { id: "fail", label: STATE_WORD.fail, hint: "A failed turn or loop, a regression, a declined turn", kinds: KINDS.filter((k) => ALERT_STATE[k] === "fail") },
  { id: "other", label: "Everything else", hint: "Agents, limits, snoozes, refused calls, machines, incidents", kinds: KINDS.filter((k) => !["need", "done", "fail"].includes(ALERT_STATE[k])) },
];

// Settings > Alerts: where each kind of alert goes besides the inbox.
export default function AlertSettings() {
  const settings = useAuto((s) => s.settings);
  const channels = useAuto((s) => s.channels);
  const [tested, setTested] = useState("");
  if (!settings) return null;
  // One switch is one change: saved on its own, so two quick clicks keep both.
  const toggle = (kind: (typeof KINDS)[number], ch: string, on: boolean) => auto.setRoute(kind, ch, on).catch(reportError);
  // Says where the test went, or why it stayed in the inbox.
  const test = async () => {
    setTested("Sending…");
    try {
      const r = await auto.test();
      const name = (c: string) => CHANNEL_NAME[c] ?? c;
      const a = r.alert;
      if (!a) return setTested("Not sent: the daemon kept no alert.");
      if (a.channels?.length) return setTested(`Sent to ${a.channels.map(name).join(", ")}, and in the inbox.`);
      const only = a.data?.inbox_only;
      if (only?.not_set_up) return setTested(`Inbox only: ${only.not_set_up.map(name).join(", ")} ${only.not_set_up.length > 1 ? "are" : "is"} not set up.`);
      if (only?.no_route) return setTested("Inbox only: no route is chosen for From the agent.");
      setTested(a.data?.held ? "Inbox only: alerts are snoozed." : "Inbox only: you are watching that session.");
    } catch (e) {
      setTested("The test failed.");
      reportError(e, { at: "alert test" });
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid="alert-routes">
      <Card>
        <SettingRow label="When a turn finishes" hint="Not watching: a finish goes to the inbox, and to the desktop or phone only after a turn of five minutes or more; a session you are watching keeps it in the page. Always: every finish goes out.">
          <Segmented
            label="When a turn finishes"
            value={settings.completion}
            onChange={(v) => auto.saveSettings({ completion: v }).catch(reportError)}
            options={[{ value: "never", label: "Never" }, { value: "background", label: "Long turns" }, { value: "always", label: "Always" }]}
          />
        </SettingRow>
        <SettingRow label="Play a sound" hint="A desktop notification makes the system's alert sound. Off keeps them silent.">
          <Toggle on={settings.sound} label="Play a sound" testid="alert-sound" onChange={(sound) => auto.saveSettings({ sound }).catch(reportError)} />
        </SettingRow>
        <SettingRow label="Test" hint="An alert of the kind From the agent, through its routes.">
          <div className="flex items-center gap-3">
            {tested && <span role="status" data-testid="alert-test-result" className="text-caption text-muted">{tested}</span>}
            <button type="button" data-testid="alert-test" onClick={() => void test()} className="k-btn k-btn-lg shrink-0">
              Send a test alert
            </button>
          </div>
        </SettingRow>
      </Card>
      <Card>
        <div className="py-3">
          <div className="text-base font-medium">Routes</div>
          <div className="mt-0.5 text-ui text-muted">Every alert lands in the inbox. Choose where each group also goes.</div>
        </div>
        <table className="-mx-5 mb-2 w-[calc(100%+2.5rem)] text-ui" data-testid="alert-groups">
          <thead>
            <tr className="border-t border-line text-left text-caption text-faint">
              <th className="px-5 py-2 font-medium max-md:pr-2">Alert</th>
              {channels.map((c) => (
                <th key={c.id} className="px-3 py-2 text-center font-medium max-md:px-1" title={c.label}>
                  {CHANNEL_NAME[c.id] ?? c.id}
                  {!c.available && <span className="block text-micro font-normal">not set up</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => (
              <tr key={g.id} className="border-t border-line/60" data-testid={`route-group-${g.id}`}>
                <td className="px-5 py-2.5 max-md:pr-2">
                  <div>{g.label}</div>
                  <div className="text-caption text-muted">{g.hint}</div>
                </td>
                {channels.map((c) => {
                  const n = g.kinds.filter((k) => settings.routes[k]?.includes(c.id)).length;
                  return (
                    <td key={c.id} className="px-3 py-2.5 text-center max-md:px-1">
                      <Tick
                        testid={`route-group-${g.id}-${c.id}`}
                        on={n === g.kinds.length}
                        mixed={n > 0 && n < g.kinds.length}
                        onChange={(on) => auto.setRoutes(g.kinds, c.id, on).catch(reportError)}
                        label={`${g.label} to ${CHANNEL_NAME[c.id] ?? c.id}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <details className="-mx-5 border-t border-line" data-testid="alert-fine">
          <summary className="cursor-pointer select-none px-5 py-3 text-ui text-muted hover:text-fg" data-testid="alert-fine-toggle">Fine tune: each kind of alert</summary>
          <table className="mb-2 w-full text-ui" data-testid="alert-kinds">
            <thead>
              <tr className="border-t border-line text-left text-caption text-faint">
                <th className="px-5 py-2 font-medium max-md:pr-2">Alert</th>
                {channels.map((c) => (
                  <th key={c.id} className="px-3 py-2 text-center font-medium max-md:px-1" title={c.label}>
                    {CHANNEL_NAME[c.id] ?? c.id}
                    {!c.available && <span className="block text-micro font-normal">not set up</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {KINDS.map((k) => (
                <tr key={k} className="border-t border-line/60">
                  <td className="px-5 py-2.5 max-md:pr-2">{ALERT_LABEL[k]}</td>
                  {channels.map((c) => (
                    <td key={c.id} className="px-3 py-2.5 text-center max-md:px-1">
                      <Tick
                        testid={`route-${k}-${c.id}`}
                        on={settings.routes[k]?.includes(c.id) ?? false}
                        onChange={(on) => toggle(k, c.id, on)}
                        label={`${ALERT_LABEL[k]} to ${CHANNEL_NAME[c.id] ?? c.id}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Card>
    </div>
  );
}
