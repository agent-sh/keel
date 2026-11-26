import { useCallback, useEffect, useState } from "react";
import { auto, useAuto, useReachLine, type AlertSettings as Settings } from "../../lib/automation.ts";
import { every } from "../../lib/clock.ts";
import { api, onFeature, reportError } from "../../lib/store.ts";
import { composing } from "../../lib/keys.ts";
import { navigate } from "../../lib/ui.ts";
import { clock } from "../../lib/utils.ts";
import { Card, Segmented, SettingRow } from "../Settings.tsx";
import { Group } from "../settings/kit.tsx";
import { Tick, Toggle } from "../surfaces/kit.tsx";
import { STATE_WORD } from "../../../../src/core/state-words.ts";
import { ALERT_LABEL, ALERT_STATE, CHANNEL_NAME } from "./bits.tsx";
import type { BudgetStatus } from "../../../../src/integrations/mobile/budget.ts";

const KINDS: (keyof Settings["routes"])[] = ["approval", "question", "finished", "failed", "limit", "loop_failed", "agent", "snooze_over", "regression", "refused", "declined", "machine", "outage", "review", "mcp"];

// The four rows at rest: each kind is in the row of its state (what it needs from the owner).
const GROUPS: { id: string; label: string; hint: string; kinds: (keyof Settings["routes"])[] }[] = [
  { id: "need", label: STATE_WORD.need, hint: "An approval, a question, an MCP server change", kinds: KINDS.filter((k) => ALERT_STATE[k] === "need") },
  { id: "done", label: STATE_WORD.done, hint: "A finished turn, a pull request review", kinds: KINDS.filter((k) => ALERT_STATE[k] === "done") },
  { id: "fail", label: STATE_WORD.fail, hint: "A failed turn or loop, a regression, a declined turn", kinds: KINDS.filter((k) => ALERT_STATE[k] === "fail") },
  { id: "other", label: "Everything else", hint: "Agents, limits, snoozes, refused calls, machines, incidents", kinds: KINDS.filter((k) => !["need", "done", "fail"].includes(ALERT_STATE[k])) },
];

// How a channel is set up, for the ones Settings has no section for (the phone's is Settings > Phone).
const SETUP: Record<string, string> = {
  desktop: "Shown by the Keel desktop app while it is open, or by this machine's notification service when the daemon runs in a desktop session.",
  command: "Set KEEL_NOTIFY_COMMAND for the daemon to a program. It gets each alert as JSON in its last argument.",
};

// The phone's budget of interruptions: how many pushes an hour, and where the hour stands.
function PushBudgetRow({ limit }: { limit: number }) {
  const [b, setB] = useState<BudgetStatus | null>(null);
  const [text, setText] = useState(String(limit));
  useEffect(() => setText(String(limit)), [limit]);
  const load = useCallback(() => void api<BudgetStatus>("/api/mobile/budget").then(setB, reportError), []);
  useEffect(() => {
    load();
    const stop = every(15_000, load);
    const off = onFeature({ frame: (f) => f.name === "mobile" && load(), reconnect: load });
    return () => { stop(); off(); };
  }, [load, limit]);
  const save = async () => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isInteger(n) || n < 0 || n === limit) return setText(String(limit));
    await auto.saveSettings({ push_per_hour: n }).catch((e) => { reportError(e); setText(String(limit)); });
    load();
  };
  const line = !b ? "" : [
    b.limit > 0 ? `${b.sent} of ${b.limit} pushes in the last hour` : `${b.sent} pushes in the last hour, no limit`,
    b.over ? `${b.over} past the budget for what needs you` : "",
    b.held ? `${b.held} held${b.held_need ? `, ${b.held_need} of them need${b.held_need === 1 ? "s" : ""} you` : ""}${b.next_slot ? `, told at ${clock(b.next_slot)}` : ""}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <SettingRow label="Pushes an hour" hint="The phone gets at most this many pushes an hour: what needs you first, then failures, reports and finished work. The rest come in one push, such as 4 more: 2 done, 1 failed, 1 report. Nothing that needs you is dropped or held more than 10 minutes: when the hour is spent it comes in one push of its own, past this number. 0 is no limit.">
      <div className="flex items-center gap-3">
        {line && <span role="status" data-testid="push-budget-state" data-sent={b?.sent} data-held={b?.held} className="text-caption text-muted">{line}</span>}
        <input
          type="number" min={0} step={1} inputMode="numeric" value={text} data-testid="push-per-hour" aria-label="Pushes an hour"
          onChange={(e) => setText(e.target.value)} onBlur={() => void save()}
          onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) (e.target as HTMLInputElement).blur(); }}
          className="k-field w-20 text-right tabular-nums"
        />
      </div>
    </SettingRow>
  );
}

// Settings > Alerts: where each kind of alert goes besides the inbox.
export default function AlertSettings() {
  const settings = useAuto((s) => s.settings);
  const channels = useAuto((s) => s.channels);
  const reach = useReachLine();
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
    <div className="k-set-page k-set-column" data-testid="alert-routes">
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
        <PushBudgetRow limit={settings.push_per_hour} />
        <SettingRow label="Reminders" hint="A request that still waits for you while you are away is told again after 15 minutes, 1 hour and 4 hours away, then every 4 hours: one notification a session that takes the place of the one before. It stops when you answer or come back.">
          <span role="status" data-testid="reach-line-settings" className="text-caption text-muted">{reach ?? "Reminders reach this desktop and your phone"}</span>
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
      {/* The routes are a group of the page, named as every group is: its name over its box, not a head of another face inside it. */}
      <Group title="Routes" hint="Every alert lands in the inbox. Choose where each group also goes.">
        <table className="-mx-5 mb-2 w-[calc(100%+2.5rem)] text-ui" data-testid="alert-groups">
          <thead>
            <tr className="text-left text-caption text-faint">
              <th className="px-5 py-2 font-medium max-md:pr-2">Alert</th>
              {channels.map((c) => (
                <th key={c.id} className="px-3 py-2 text-center font-medium max-md:px-1" title={c.label}>
                  {CHANNEL_NAME[c.id] ?? c.id}
                  {!c.available && (
                    <span className="block text-micro font-normal">
                      <button
                        type="button"
                        data-testid={`route-setup-${c.id}`}
                        title={`${CHANNEL_NAME[c.id] ?? c.id} is not set up`}
                        className="k-link text-accent underline"
                        onClick={() => (c.id === "push" ? navigate({ name: "settings", section: "phone" }) : document.querySelector(`[data-testid="route-setup-note-${c.id}"]`)?.scrollIntoView({ block: "nearest" }))}
                      >
                        Set up
                      </button>
                    </span>
                  )}
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
                        // A channel that is not set up sends nothing: its mark is off and out of reach (what was chosen is kept for when it is).
                        on={c.available && n === g.kinds.length}
                        mixed={c.available && n > 0 && n < g.kinds.length}
                        disabled={!c.available}
                        title={c.available ? undefined : `${CHANNEL_NAME[c.id] ?? c.id} is not set up`}
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
                        on={c.available && (settings.routes[k]?.includes(c.id) ?? false)}
                        disabled={!c.available}
                        title={c.available ? undefined : `${CHANNEL_NAME[c.id] ?? c.id} is not set up`}
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
        {channels.some((c) => !c.available && SETUP[c.id]) && (
          <div className="border-t border-line py-3 text-ui text-muted">
            {channels.filter((c) => !c.available && SETUP[c.id]).map((c) => (
              <p key={c.id} data-testid={`route-setup-note-${c.id}`} className="py-1"><span className="text-fg">{CHANNEL_NAME[c.id] ?? c.id}.</span> {SETUP[c.id]}</p>
            ))}
          </div>
        )}
      </Group>
    </div>
  );
}
