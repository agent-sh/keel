import { Switch } from "@base-ui/react/switch";
import { auto, useAuto, type AlertSettings as Settings } from "../../lib/automation.ts";
import { reportError } from "../../lib/store.ts";
import { Card, Segmented, SettingRow } from "../Settings.tsx";
import { ALERT_LABEL } from "./bits.tsx";

const KINDS: (keyof Settings["routes"])[] = ["approval", "question", "finished", "failed", "limit", "loop_failed", "agent"];
const CHANNEL_NAME: Record<string, string> = { desktop: "Desktop", command: "Command hook", push: "Phone" };

// Settings > Alerts: where each kind of alert goes besides the inbox.
export default function AlertSettings() {
  const settings = useAuto((s) => s.settings);
  const channels = useAuto((s) => s.channels);
  if (!settings) return null;
  const toggle = (kind: (typeof KINDS)[number], ch: string, on: boolean) => {
    const cur = settings.routes[kind] ?? [];
    auto.saveSettings({ routes: { ...settings.routes, [kind]: on ? [...new Set([...cur, ch])] : cur.filter((c) => c !== ch) } }).catch(reportError);
  };
  return (
    <div className="flex flex-col gap-4" data-testid="alert-routes">
      <Card>
        <SettingRow label="When a turn finishes" hint="Finished turns of a session you are watching stay in the page.">
          <Segmented
            label="When a turn finishes"
            value={settings.completion}
            onChange={(v) => auto.saveSettings({ completion: v }).catch(reportError)}
            options={[{ value: "never", label: "Never" }, { value: "background", label: "Not watching" }, { value: "always", label: "Always" }]}
          />
        </SettingRow>
        <SettingRow label="Test" hint="An alert of the kind From the agent, through its routes.">
          <button type="button" onClick={() => auto.test().catch(reportError)} className="h-8 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover">
            Send a test alert
          </button>
        </SettingRow>
      </Card>
      <Card>
        <div className="py-3">
          <div className="text-base font-medium">Routes</div>
          <div className="mt-0.5 text-ui text-muted">Every alert lands in the inbox. Choose where each kind also goes.</div>
        </div>
        <table className="-mx-5 mb-2 w-[calc(100%+2.5rem)] text-ui">
          <thead>
            <tr className="border-t border-line text-left text-caption text-faint">
              <th className="px-5 py-2 font-medium">Alert</th>
              {channels.map((c) => (
                <th key={c.id} className="px-3 py-2 text-center font-medium" title={c.label}>
                  {CHANNEL_NAME[c.id] ?? c.id}
                  {!c.available && <span className="block text-micro font-normal">not set up</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {KINDS.map((k) => (
              <tr key={k} className="border-t border-line/60">
                <td className="px-5 py-2.5">{ALERT_LABEL[k]}</td>
                {channels.map((c) => (
                  <td key={c.id} className="px-3 py-2.5 text-center">
                    <Switch.Root
                      data-testid={`route-${k}-${c.id}`}
                      checked={settings.routes[k]?.includes(c.id) ?? false}
                      onCheckedChange={(on) => toggle(k, c.id, on)}
                      aria-label={`${ALERT_LABEL[k]} to ${CHANNEL_NAME[c.id] ?? c.id}`}
                      className="relative inline-flex h-[18px] w-[30px] shrink-0 rounded-full bg-line-strong p-px outline-none transition-colors data-[checked]:bg-accent"
                    >
                      <Switch.Thumb className="size-4 rounded-full bg-raised shadow-1 transition-transform duration-150 ease-[var(--ease-out)] data-[checked]:translate-x-3 dark:bg-fg" />
                    </Switch.Root>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
