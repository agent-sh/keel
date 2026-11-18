import { Dialog } from "@base-ui/react/dialog";
import { CheckCheck, Dot, Settings2, X } from "lucide-react";
import { useEffect } from "react";
import { auto, openSession, useAuto } from "../../lib/automation.ts";
import { navigate } from "../../lib/ui.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn } from "../../lib/utils.ts";
import { ALERT_LABEL, AlertIcon, Empty } from "./bits.tsx";


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
            onClick={() => {
              if (a.session_id) {
                auto.read({ session_id: a.session_id }).catch(reportError);
                openSession(a.data?.open_session ?? a.session_id);
                onClose();
              } else auto.read({ ids: [a.id] }).catch(reportError);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
            className="group flex cursor-default gap-3 rounded-lg px-2.5 py-2 outline-none hover:bg-hover"
          >
            <AlertIcon kind={a.kind} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={cn("min-w-0 flex-1 truncate text-ui", !a.read ? "font-semibold" : "text-muted")}>
                  {a.session_id ? (sessions[a.session_id]?.title || a.title) : a.title}
                </span>
                <span className="shrink-0 text-micro text-faint tabular-nums">{ago(a.ts)}</span>
              </div>
              <div className="flex items-center gap-1 text-caption text-faint">
                <span>{ALERT_LABEL[a.kind]}</span>
                {a.channels?.length ? <><Dot className="size-3" /><span>sent to {a.channels.join(", ")}</span></> : null}
              </div>
              <p className={cn("mt-0.5 line-clamp-2 text-caption leading-snug", a.read ? "text-faint" : "text-muted")}>{a.body}</p>
            </div>
            {!a.read ? (
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
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
          <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
            <Dialog.Title className="pl-1 font-semibold">Inbox</Dialog.Title>
            <button
              type="button"
              data-testid="alert-routes-link"
              onClick={() => { onOpenChange(false); navigate({ name: "settings", section: "alerts" }); }}
              className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg"
            >
              <Settings2 className="size-3.5" /> Routes
            </button>
            <Dialog.Close className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Inbox onClose={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
