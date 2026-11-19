import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { CheckCheck, Dot, Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { auto, openSession, useAuto } from "../../lib/automation.ts";
import { navigate } from "../../lib/ui.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn } from "../../lib/utils.ts";
import { ActivityList } from "./ActivityList.tsx";
import { ALERT_LABEL, ALERT_STATE, AlertIcon, Empty } from "./bits.tsx";
import { GlobalSnoozeButton } from "./Snooze.tsx";

const tabCls = "h-7 rounded-md px-2.5 text-caption text-muted outline-none hover:text-fg data-[active]:bg-raised data-[active]:text-fg data-[active]:shadow-2 focus-visible:ring-2 focus-visible:ring-accent/30";


function Inbox({ onClose }: { onClose: () => void }) {
  const alerts = useAuto((s) => s.alerts);
  const unread = useAuto((s) => s.unread.total);
  const sessions = useStore((s) => s.sessions);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center px-4 py-2 text-caption text-faint">
        {unread ? `${unread} unread` : "All read"}
        <button
          type="button"
          data-testid="mark-all-read"
          onClick={() => auto.read().catch(reportError)}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg"
        >
          <CheckCheck className="size-3.5" /> Mark all read
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="inbox-list">
        {alerts.length === 0 && <Empty>Nothing needs you.</Empty>}
        {alerts.map((a) => (
          <div
            key={a.id}
            role="button"
            tabIndex={0}
            data-testid="inbox-item"
            data-unread={!a.read || undefined}
            data-watch={ALERT_STATE[a.kind]}
            onClick={() => {
              if (a.session_id) {
                auto.read({ session_id: a.session_id }).catch(reportError);
                openSession(a.data?.open_session ?? a.session_id);
                onClose();
              } else auto.read({ ids: [a.id] }).catch(reportError);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
            className="k-alert group flex cursor-default gap-3 rounded-lg px-2.5 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AlertIcon kind={a.kind} read={a.read} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={cn("min-w-0 flex-1 truncate text-ui", !a.read ? "font-semibold" : "text-muted")}>
                  {a.session_id ? (sessions[a.session_id]?.title || a.title) : a.title}
                </span>
                <span className="shrink-0 text-micro text-faint tabular-nums">{ago(a.ts)}</span>
              </div>
              <div className="flex items-center gap-1 text-caption text-faint">
                <span className="k-alert-word">{ALERT_LABEL[a.kind]}</span>
                {a.data?.snoozed ? <><Dot className="size-3" /><span>snoozed</span></> : null}
                {a.data?.held ? <><Dot className="size-3" /><span>held by the snooze</span></> : null}
                {a.channels?.length ? <><Dot className="size-3" /><span>sent to {a.channels.join(", ")}</span></> : null}
              </div>
              <p className={cn("mt-0.5 line-clamp-2 text-caption leading-snug", a.read ? "text-faint" : "text-muted")}>{a.body}</p>
            </div>
            {!a.read ? (
              <span className="k-alert-dot" aria-label="Unread" />
            ) : (
              <button
                type="button"
                title="Mark unread"
                onClick={(e) => { e.stopPropagation(); auto.unreadOne(a.id).catch(reportError); }}
                className="mt-1 hidden size-3 shrink-0 rounded-full border border-line-strong group-hover:block"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function InboxPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [tab, setTab] = useState("inbox");
  useEffect(() => {
    if (open) auto.loadAlerts().catch(reportError);
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="inbox-panel"
          className={cn(
            "fixed left-[17rem] top-4 bottom-4 z-50 flex w-[min(30rem,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-raised shadow-3 outline-none",
            "transition-[transform,opacity] duration-200 data-starting-style:-translate-x-3 data-starting-style:opacity-0 data-ending-style:-translate-x-3 data-ending-style:opacity-0",
          )}
        >
          <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
            <Dialog.Title className="sr-only">Inbox</Dialog.Title>
            <Tabs.List className="flex gap-0.5 rounded-lg bg-panel p-0.5">
              <Tabs.Tab value="inbox" className={tabCls} data-testid="tab-inbox">Inbox</Tabs.Tab>
              <Tabs.Tab value="activity" className={tabCls} data-testid="tab-activity">Activity</Tabs.Tab>
            </Tabs.List>
            <span className="ml-auto" />
            <GlobalSnoozeButton />
            <button
              type="button"
              data-testid="alert-routes-link"
              onClick={() => { onOpenChange(false); navigate({ name: "settings", section: "alerts" }); }}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg"
            >
              <Settings2 className="size-3.5" /> Routes
            </button>
            <Dialog.Close className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Tabs.Panel value="inbox" className="flex min-h-0 flex-1 flex-col"><Inbox onClose={() => onOpenChange(false)} /></Tabs.Panel>
          <Tabs.Panel value="activity" className="flex min-h-0 flex-1 flex-col"><ActivityList onClose={() => onOpenChange(false)} /></Tabs.Panel>
          </Tabs.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
