import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { CheckCheck, Dot, Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { alertTarget, auto, focusApproval, openSession, placeName, useAuto, type Alert, type Target } from "../../lib/automation.ts";
import { navigate, setUI } from "../../lib/ui.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn } from "../../lib/utils.ts";
import { ActivityList } from "./ActivityList.tsx";
import { ALERT_LABEL, ALERT_STATE, AlertIcon, CHANNEL_NAME, Empty } from "./bits.tsx";
import { GlobalSnoozeButton } from "./Snooze.tsx";

const tabCls = "h-7 rounded-md px-2.5 text-caption text-muted outline-none hover:text-fg data-[active]:bg-raised data-[active]:text-fg data-[active]:shadow-2 focus-visible:ring-2 focus-visible:ring-accent/30";


type Note = { text: string; parent?: string | null };

// Who a row is from and what it is, read or not: the open action names the
// session (and the agent inside it), the kind and its state in words; the
// read toggle sits beside it as its own button, reachable by keyboard.
function Inbox({ onClose }: { onClose: () => void }) {
  const alerts = useAuto((s) => s.alerts);
  const unread = useAuto((s) => s.unread.total);
  const sessions = useStore((s) => s.sessions);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const note = (id: string, n: Note | null) => setNotes((cur) => {
    const { [id]: _, ...rest } = cur;
    return n ? { ...rest, [id]: n } : rest;
  });
  const shown = onlyUnread ? alerts.filter((a) => !a.read) : alerts;

  const open = async (a: Alert) => {
    note(a.id, null);
    if (!a.read) auto.read({ ids: [a.id] }).catch(reportError);
    if (!a.session_id) return;
    let t: Target;
    try {
      t = await alertTarget(a.id);
    } catch (e) {
      reportError(e, { at: "inbox open" });
      return note(a.id, { text: "Could not reach the daemon." });
    }
    // An approval opens on the page that answers it (a parent answers its
    // agents' cards), with that card focused; one answered meanwhile says so.
    if (a.kind === "approval" && a.data?.approval_id) {
      if (t.approval !== "pending") return note(a.id, { text: "Already answered." });
      const page = t.parent ?? t.open;
      if (!page) return note(a.id, { text: "This session was deleted." });
      openSession(page);
      onClose();
      focusApproval(a.data.approval_id);
      return;
    }
    if (t.child_deleted) return note(a.id, { text: "This agent was deleted.", parent: t.parent });
    if (!t.open) return note(a.id, { text: "This session was deleted." });
    if (a.data?.event_id) setUI({ focusEvent: a.data.event_id });
    openSession(t.open);
    onClose();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 py-2 text-caption">
        <div className="flex gap-0.5 rounded-lg bg-panel p-0.5" role="group" aria-label="Show">
          <button type="button" aria-pressed={!onlyUnread} onClick={() => setOnlyUnread(false)} className={cn(filterCls, !onlyUnread && filterOn)}>All</button>
          <button type="button" data-testid="inbox-unread-filter" aria-pressed={onlyUnread} onClick={() => setOnlyUnread(true)} className={cn(filterCls, onlyUnread && filterOn)}>
            Unread{unread ? <span className="ml-1 tabular-nums text-faint">{unread}</span> : null}
          </button>
        </div>
        <button
          type="button"
          data-testid="mark-all-read"
          onClick={() => auto.read().catch(reportError)}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring outline-none"
        >
          <CheckCheck className="size-3.5" /> Mark all read
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="inbox-list">
        {shown.length === 0 && <li><Empty>{onlyUnread ? "Nothing unread." : "Nothing needs you."}</Empty></li>}
        {shown.map((a) => {
          const child = a.data?.child_session ?? (a.data?.open_session && a.data.open_session !== a.session_id ? a.data.open_session : undefined);
          const place = placeName(sessions, a.session_id, child, { title: a.title, child_title: a.data?.child_title });
          const n = notes[a.id];
          return (
            <li
              key={a.id}
              data-testid="inbox-item"
              data-alert={a.id}
              data-unread={!a.read || undefined}
              data-watch={ALERT_STATE[a.kind]}
              className="k-alert group rounded-lg hover:bg-hover"
            >
              <div className="flex items-start">
                <button
                  type="button"
                  data-testid="inbox-open"
                  onClick={() => void open(a)}
                  className="flex min-w-0 flex-1 gap-3 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AlertIcon kind={a.kind} read={a.read} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cn("min-w-0 flex-1 truncate text-ui", !a.read ? "font-semibold" : "text-muted")} data-testid="inbox-place">{place}</span>
                      <span className="shrink-0 text-micro text-faint tabular-nums">{ago(a.ts)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-1 text-caption text-faint" data-testid="inbox-state">
                      <span className="k-alert-word">{ALERT_LABEL[a.kind]}</span>
                      {/* The state in words for a reader; the eye has the bar and the dot. */}
                      <span className="sr-only">, {a.read ? "read" : "unread"}</span>
                      {a.data?.snoozed ? <><Dot className="size-3" aria-hidden /><span>snoozed</span></> : null}
                      {a.data?.held ? <><Dot className="size-3" aria-hidden /><span>held by the snooze</span></> : null}
                      <Route a={a} />
                    </span>
                    <span className={cn("mt-0.5 line-clamp-2 block text-caption leading-snug", a.read ? "text-faint" : "text-muted")}>{a.body}</span>
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="inbox-toggle-read"
                  aria-label={a.read ? "Mark unread" : "Mark read"}
                  title={a.read ? "Mark unread" : "Mark read"}
                  onClick={() => (a.read ? auto.unreadOne(a.id) : auto.read({ ids: [a.id] })).catch(reportError)}
                  className={cn(
                    "mr-1 mt-1.5 grid size-6 shrink-0 place-items-center rounded-md outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring",
                    a.read && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  {a.read ? <span className="size-2 rounded-full border border-line-strong" /> : <span className="k-alert-dot !mt-0" />}
                </button>
              </div>
              <Failed a={a} />
              {n && (
                <p role="status" data-testid="inbox-note" className="flex items-center gap-2 px-2.5 pb-2 pl-[3.25rem] text-caption text-muted">
                  {n.text}
                  {n.parent && (
                    <button type="button" data-testid="inbox-open-parent" onClick={() => { openSession(n.parent!); onClose(); }} className="rounded-md px-1.5 py-0.5 text-accent hover:bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Open parent
                    </button>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const filterCls = "h-6 rounded-md px-2 text-caption text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring";
const filterOn = "bg-raised text-fg shadow-2";

// Where the alert went besides the inbox, channel by channel: handed over,
// still on its way, or failed. Inbox only says why.
function Route({ a }: { a: Alert }) {
  const d = a.delivery;
  const name = (c: string) => CHANNEL_NAME[c] ?? c;
  const parts: string[] = [];
  if (d) {
    const sent = Object.keys(d).filter((c) => d[c]!.state === "sent");
    const pending = Object.keys(d).filter((c) => d[c]!.state === "pending");
    if (sent.length) parts.push(`sent to ${sent.map(name).join(", ")}`);
    if (pending.length) parts.push(`sending to ${pending.map(name).join(", ")}`);
  } else if (a.channels?.length) parts.push(`sent to ${a.channels.map(name).join(", ")}`);
  const only = a.data?.inbox_only;
  if (only?.no_route) parts.push("inbox only, no route chosen");
  else if (only?.not_set_up) parts.push(`inbox only, ${only.not_set_up.map(name).join(", ")} not set up`);
  else if (only?.routine) parts.push("inbox only, a routine finish");
  return <>{parts.map((p) => <span key={p} className="contents"><Dot className="size-3" aria-hidden /><span>{p}</span></span>)}</>;
}

function Failed({ a }: { a: Alert }) {
  const failed = Object.entries(a.delivery ?? {}).filter(([, d]) => d.state === "failed");
  if (!failed.length) return null;
  return (
    <p className="flex items-center gap-2 px-2.5 pb-2 pl-[3.25rem] text-caption text-danger" data-testid="inbox-failed">
      <span className="min-w-0 truncate" title={failed.map(([c, d]) => `${CHANNEL_NAME[c] ?? c}: ${d.error ?? "failed"}`).join("\n")}>
        {failed.map(([c]) => CHANNEL_NAME[c] ?? c).join(", ")} failed
      </span>
      <button type="button" data-testid="inbox-retry" onClick={() => auto.retry(a.id).catch(reportError)} className="rounded-md px-1.5 py-0.5 text-muted hover:bg-raised hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Retry
      </button>
    </p>
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
