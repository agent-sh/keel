import { Menu } from "@base-ui/react/menu";
import { BellOff, Moon, Sun } from "lucide-react";
import { auto, snoozeText, useAuto } from "../../lib/automation.ts";
import { reportError } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { iconButton, itemClass, popupClass } from "../ui.tsx";

type Choice = { label: string; until_ms?: number; until_needed?: boolean };

function tomorrowAt(h: number) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
}

const timeChoices = (): Choice[] => [
  { label: "For 1 hour", until_ms: Date.now() + 3600_000 },
  { label: "For 3 hours", until_ms: Date.now() + 3 * 3600_000 },
  { label: "Until tomorrow 09:00", until_ms: tomorrowAt(9) },
];

const label = "flex h-7 items-center px-2.5 text-micro font-semibold uppercase tracking-[0.06em] text-faint";

// In the session header: put the session aside. It keeps working; its routine
// alerts go to the inbox read, and only what it needs you for comes through.
export function SessionSnoozeButton({ sessionId }: { sessionId: string }) {
  const s = useAuto((st) => st.snoozes[sessionId]);
  const blocked = useAuto((st) => st.alerts.some((a) => a.session_id === sessionId && !a.read && (a.kind === "approval" || a.kind === "question")));
  const act = (p: Promise<unknown>) => p.catch(reportError);
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={s ? `Snoozed ${snoozeText(s)}` : "Snooze"} title={s ? `Snoozed ${snoozeText(s)}` : "Snooze"} data-testid="snooze-button" className={cn(iconButton, s && !s.suspended && "text-accent")}>
        <Moon className={cn("size-4", s && !s.suspended && "fill-current")} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Menu.Popup className={cn(popupClass, "min-w-60")} data-testid="snooze-menu">
            {s ? (
              <>
                <div className="px-2.5 py-1.5 text-caption text-muted" data-testid="snooze-state">Snoozed {snoozeText(s)}</div>
                <Menu.Item className={itemClass} data-testid="snooze-end" onClick={() => act(auto.unsnooze(sessionId))}><Sun /> End snooze</Menu.Item>
              </>
            ) : (
              <>
                <div className={label}>Snooze this session</div>
                {blocked && <div className="px-2.5 pb-1 text-caption text-warn">It waits for your answer first.</div>}
                {timeChoices().map((c) => (
                  <Menu.Item key={c.label} disabled={blocked} className={itemClass} onClick={() => act(auto.snooze(sessionId, { until_ms: c.until_ms }))}>{c.label}</Menu.Item>
                ))}
                <Menu.Item disabled={blocked} className={itemClass} data-testid="snooze-until-needed" onClick={() => act(auto.snooze(sessionId, { until_needed: true }))}>Until it needs you</Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// In the inbox header: hold every channel for a while. Alerts still land here.
export function GlobalSnoozeButton() {
  const g = useAuto((st) => st.snoozes["*"]);
  const act = (p: Promise<unknown>) => p.catch(reportError);
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="snooze-all"
        className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-caption hover:bg-hover hover:text-fg data-popup-open:bg-hover", g ? "text-accent" : "text-muted")}
      >
        <BellOff className="size-3.5" /> {g?.until_ms ? `Snoozed until ${new Date(g.until_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Snooze"}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-[60] outline-none">
          <Menu.Popup className={cn(popupClass, "min-w-60")}>
            {g ? (
              <Menu.Item className={itemClass} data-testid="snooze-all-end" onClick={() => act(auto.unsnoozeAll())}><Sun /> Resume alerts now</Menu.Item>
            ) : (
              <>
                <div className={label}>Hold every alert</div>
                {timeChoices().map((c) => (
                  <Menu.Item key={c.label} className={itemClass} onClick={() => act(auto.snoozeAll(c.until_ms!))}>{c.label}</Menu.Item>
                ))}
                <p className="max-w-60 px-2.5 py-1.5 text-micro text-faint">Alerts still land in the inbox; none reaches the desktop, the command or the phone until then.</p>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
