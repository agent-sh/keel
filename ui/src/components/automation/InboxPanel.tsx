import { onInboxView, peekInboxView } from "../../lib/inbox-view.ts";
import { Dialog } from "@base-ui/react/dialog";
import { Bell, CheckCheck, Settings2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { alertTarget, auto, coverPanes, focusApproval, openSession, placeName, useAuto, type Alert, type Target } from "../../lib/automation.ts";
import { useToldStates } from "../../lib/watch.ts";
import { navigate, setUI } from "../../lib/ui.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn, when } from "../../lib/utils.ts";
import { footSheet } from "../ui.tsx";
import { ActivityList } from "./ActivityList.tsx";
import { plainLine } from "../../../../src/core/plain.ts";
import { AwayDigest } from "./AwayDigest.tsx";
import { AlertIcon, alertState, CHANNEL_NAME, Empty } from "./bits.tsx";
import { rootOf } from "../../lib/agent-tree.ts";
import { seeAllAgents } from "../../lib/agent-seen.ts";
import { ALERT_GROUPS, ALERT_GROUP_WORD, ASK_KINDS, COUNTERS, STATE_WORD, TURN_ENDED, alertGroup, alertWord, askAction, type AlertGroup } from "../../../../src/core/state-words.ts";
import { Mark } from "../Mark.tsx";
import { ReadyToLand } from "../ReadyToLand.tsx";
import { GlobalSnoozeButton } from "./Snooze.tsx";
import { Seg, tabId } from "../Seg.tsx";
import { costLine, costs, type WaitNow } from "../../../../src/core/wait-rank.ts";
import { holdOrder, nextLook, waitsOnOwner } from "../../lib/next-look.ts";
import { every } from "../../lib/clock.ts";

const actCls = "flex h-ctl-md items-center gap-1.5 rounded-md px-2.5 text-caption text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring";

// Text a model wrote (a reply's first line, what an agent said, a question) is
// markdown: the row reads it as words. A command or an error is kept as written.
const WRITTEN = new Set<Alert["kind"]>(["finished", "agent", "question"]);
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
// (A turn that ended while a command still runs has its word, Turn ended, beside the line: the line says the rest.)
const lineOf = (a: Alert) => { const t = (WRITTEN.has(a.kind) ? plainLine(a.body) : a.body.split("\n").find((l) => l.trim())?.trim()) || a.body; return a.data?.live && t.startsWith(`${TURN_ENDED}, `) ? t.slice(TURN_ENDED.length + 2) : t; };

const WIDE = matchMedia("(min-width: 640px)");

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// Where alerts go besides this list, said once for all of them: the channels
// some kind is routed to, and the chosen ones that are not set up.
export function routesLine(routes: Record<string, string[]> | undefined, channels: { id: string; label: string; available: boolean }[]): string {
  const chosen = new Set(Object.values(routes ?? {}).flat());
  const name = (c: { id: string; label: string }) => CHANNEL_NAME[c.id] ?? c.label;
  const on = channels.filter((c) => chosen.has(c.id) && c.available).map(name);
  const off = channels.filter((c) => chosen.has(c.id) && !c.available).map(name);
  const head = on.length ? `Alerts also go to ${list(on)}` : "Alerts stay here";
  return off.length ? `${head}. ${list(off)} ${off.length > 1 ? "are" : "is"} not set up.` : on.length ? `${head}.` : `${head}: no route is chosen.`;
}

// Where this one alert went, for the row's tooltip: the list's line covers the
// usual case, a row says it on screen only when a route failed.
function routeOf(a: Alert): string | undefined {
  const name = (c: string) => CHANNEL_NAME[c] ?? c;
  const d = a.delivery;
  const sent = d ? Object.keys(d).filter((c) => d[c]!.state !== "failed") : a.channels ?? [];
  if (sent.length) return `Sent to ${list(sent.map(name))}`;
  const only = a.data?.inbox_only;
  if (only?.no_route) return "Kept here: no route is chosen for this kind";
  if (only?.not_set_up) return `Kept here: ${list(only.not_set_up.map(name))} not set up`;
  if (only?.routine) return "Kept here: a routine finish";
  return undefined;
}

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
  // A phone's drawer is too narrow for a title and its alert on one line.
  const wide = useSyncExternalStore((f) => (WIDE.addEventListener("change", f), () => WIDE.removeEventListener("change", f)), () => WIDE.matches);
  // Three parts, in this order: what waits on the owner, what else is new since they looked, and
  // what they have seen. Nothing that waits is ever below a finish.
  // - What waits is the next-look queue (lib/next-look.ts): every ask whose card still waits (the
  //   daemon's word, read or not) and every failure that stopped a session the owner has not looked
  //   at, the costliest wait first (src/core/wait-rank.ts), each with its session's title and what
  //   its wait costs. It leaves when it is answered, or looked at. While the pointer or the keyboard
  //   is in the list its rows stand still: one that comes meanwhile joins at the end.
  // - Inside the other parts, one session's alerts (or one agent's inside it) stand together under
  //   its title, newest first, the session with the newest alert on top. An alert of no session is
  //   a group of its own.
  const told = useToldStates();
  // The order of what waits as it stood when the pointer or the keyboard came into the list (null: neither is there).
  const [held, setHeld] = useState<string[] | null>(null);
  const needIds = useRef<string[]>([]);
  // A hold that stands (the keyboard came first, then the pointer) is kept: only leaving both ends it.
  const hold = (on: boolean) => setHeld((h) => (on ? h ?? needIds.current : null));
  const parts = useMemo(() => {
    // A turn the model declined is filed as a finish: its row says Declined, as its session does (its newest word only).
    const newest = new Map<string, string>();
    for (const a of alerts) if (a.session_id && !a.data?.child_session && !ASK_KINDS.includes(a.kind) && !newest.has(a.session_id)) newest.set(a.session_id, a.id);
    const declined = (a: Alert) => a.kind === "finished" && !!a.session_id && newest.get(a.session_id) === a.id && told[a.session_id]?.watch === "declined";
    return ALERT_GROUPS.map((part) => {
      const of = shown.filter((a) => (waitsOnOwner(a, told) ? "need" : alertGroup(a)) === part);
      const named = of.map((a) => {
        const child = a.data?.child_session ?? (a.data?.open_session && a.data.open_session !== a.session_id ? a.data.open_session : undefined);
        return { a, child, place: placeName(sessions, a.session_id, child, { title: a.title, child_title: a.data?.child_title }), word: alertWord(a, declined(a)), declined: declined(a) };
      });
      if (part === "need") {
        const ranked = nextLook(named, (r) => r.a);
        needIds.current = ranked.map((r) => r.a.id);
        const rows = holdOrder(ranked, (r) => r.a.id, held).map((r) => ({ ...r, first: true, last: true, alone: wide, fresh: true, asks: true }));
        return { part, n: of.length, rows };
      }
      const groups = new Map<string, typeof named>();
      for (const r of named) {
        const key = r.a.session_id ? `${r.a.session_id}:${r.child ?? ""}` : r.a.id;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
      }
      // `alone`: the session's only alert, which takes one line with its title.
      // `asks`: an unread ask stands in the group (one that expired with its card gone, say): the only titles that carry weight.
      const rows = [...groups.values()].flatMap((g) => g.map((r, i) => ({ ...r, first: i === 0, last: i === g.length - 1, alone: wide && g.length === 1, fresh: g.some((x) => !x.a.read), asks: g.some((x) => !x.a.read && ASK_KINDS.includes(x.a.kind)) })));
      return { part, n: of.length, rows };
    }).filter((p) => p.n);
  }, [alerts, shown, sessions, wide, told, held]);
  // What each wait costs as it stands (the agents that wait now, the cache's life now), read when what
  // waits changes and again on the page's clock: the lines say it, and a cache's time left counts down.
  // (The order's key is the one each wait began with.) Until it comes, what the list said.
  const [live, setLive] = useState<Record<string, WaitNow>>({});
  const needKey = parts.find((p) => p.part === "need")?.rows.map((r) => r.a.id).sort().join(",") ?? "";
  useEffect(() => {
    if (!needKey) return;
    let gone = false;
    const read = () => { auto.waitsNow(needKey.split(",")).then((w) => { if (!gone) setLive(w); }).catch(() => {}); };
    read();
    const stop = every(15_000, read);
    return () => { gone = true; stop(); };
  }, [needKey]);

  const open = async (a: Alert) => {
    note(a.id, null);
    if (!a.read) auto.read({ ids: [a.id] }).catch(reportError);
    // A server's changed tools are looked at where they are accepted.
    if (a.data?.mcp_server) {
      navigate({ name: "customize", section: "mcp" });
      return onClose();
    }
    if (!a.session_id) return;
    let t: Target;
    try {
      t = await alertTarget(a.id);
    } catch (e) {
      reportError(e, { at: "inbox open" });
      return note(a.id, { text: "Could not reach the daemon." });
    }
    // An approval opens on the page that answers it (a coordinator answers the cards of its whole tree), with that card focused; one answered meanwhile says so.
    if (a.kind === "approval" && a.data?.approval_id) {
      if (t.approval !== "pending") return note(a.id, { text: "Already answered." });
      const page = t.parent ?? t.open;
      if (!page) return note(a.id, { text: "This session was deleted." });
      // The session at the top of the agent's tree shows it, whatever its depth.
      openSession(rootOf((id) => sessions[id]?.parent_id, page));
      onClose();
      // As every way to a request: the keyboard lands on the list of requests, on no answer, and
      // the card decides from there (a text that is not read keeps it off its answers).
      focusApproval(a.data.approval_id, "allow");
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
      <AwayDigest onClose={onClose} />
      <div className={bandCls}>
        <Seg
          label="Show"
          value={onlyUnread ? "unread" : "all"}
          onChange={(v) => setOnlyUnread(v === "unread")}
          options={[
            { value: "all", label: "All" },
            { value: "unread", testid: "inbox-unread-filter", label: <>Unread{unread ? <span className="tabular-nums text-faint" title={COUNTERS.unread(unread)}>{unread}</span> : null}</> },
          ]}
        />
        {/* Every unread mark goes: the alerts here, the rows' dots, and the agents that ended since the owner looked. */}
        <button type="button" data-testid="mark-all-read" title="Clear every unread mark" onClick={() => { seeAllAgents(); auto.read().catch(reportError); }} className={cn(actCls, "ml-auto whitespace-nowrap")}>
          <CheckCheck className="size-3.5" /> <span className="max-sm:sr-only">Mark all read</span>
        </button>
      </div>
      <ul
        className="min-h-0 flex-1 overflow-y-auto p-2 max-sm:pt-1.5"
        data-testid="inbox-list"
        data-held={held ? "" : undefined}
        onPointerEnter={(e) => { if (e.pointerType === "mouse") hold(true); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse" && !e.currentTarget.contains(document.activeElement)) hold(false); }}
        onFocus={() => { if (!held) hold(true); }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) hold(false); }}
      >
        {shown.length === 0 && <li><Empty>{onlyUnread ? "Nothing unread." : `Nothing ${STATE_WORD.need.toLowerCase()}.`}</Empty></li>}
        {/* What could land is its own part, after what waits on the owner and counted in neither it nor the unread. */}
        {!parts.some((p) => p.part === "need") && <ReadyToLand inbox />}
        {parts.flatMap(({ part, n, rows }) => [<PartHead key={part} part={part} n={n} />, ...rows.map(({ a, first, last, alone, place, fresh, asks, word, declined }) => {
          // On a phone a row that waits gives its line the width: its mark and its "Review" say what it is, and its age is in the tooltip.
          // A row offers the card that answers it only while that card waits: an ask whose card is gone (answered, or its turn stopped) has nothing to answer.
          const offers = !!a.open;
          const tight = !wide && offers;
          const n = notes[a.id];
          // On a shared line the width goes to what waits on the owner: the title gives way first there.
          const title = <span dir="auto" className={cn("truncate text-left text-ui", asks ? "font-semibold text-fg" : fresh ? "text-fg" : "text-muted", !alone ? "mb-0.5 block" : asks ? "min-w-0 max-w-[30%] shrink" : "min-w-0 max-w-[46%] shrink")} data-testid="inbox-place">{place}</span>;
          return (
            <li
              key={a.id}
              data-testid="inbox-item"
              data-alert={a.id}
              data-unread={!a.read || undefined}
              data-part={part}
              data-watch={declined ? "declined" : alertState(a)}
              data-open={a.open || undefined}
              // A session's group ends with a hairline, so the one-line row after it is not read as its member.
              className={cn("group", first && !alone && "mt-1.5 first:mt-0", last && !alone && wide && "mb-1.5 border-b border-line pb-1.5 last:mb-0 last:border-0 last:pb-0")}
            >
              <div className="flex items-end rounded-md hover:bg-hover">
                <button
                  type="button"
                  data-testid="inbox-open"
                  onClick={() => void open(a)}
                  className="min-w-0 flex-1 rounded-md px-2.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* A session's alerts stand under its title, said once; its only alert shares the title's line. */}
                  {first && !alone ? title : !first ? <span className="sr-only">{place}, </span> : null}
                  <span className="flex min-h-ctl-sm items-center gap-2 text-caption">
                    {/* The mark is the state, in its color while unread: a glyph, no box around it. */}
                    <AlertIcon kind={a.kind} read={a.read && !a.open} declined={declined} live={!!a.data?.live} />
                    {/* The kind stands second in both row forms, so the eye finds it in one place. */}
                    {/* (A column of its own, as wide as the usual words, so the titles after it start at one place.) */}
                    <span className={cn("shrink-0 text-muted", !tight && "min-w-[4.75rem]")} data-testid="inbox-state" title={routeOf(a)}>
                      {/* Said when tight too: the mark is the state's shape, the same for an approval and a plan, so the word tells them apart. */}
                      <span data-testid="inbox-word">{word}</span>
                      <span className="sr-only">, {a.read ? "read" : "unread"}{a.data?.snoozed ? ", snoozed" : a.data?.held ? ", held by the snooze" : ""}: </span>
                    </span>
                    {alone && title}
                    <span dir="auto" className={cn("min-w-[4rem] truncate text-left", "flex-1", a.read && !a.open ? "text-faint" : "text-fg")} data-testid="inbox-line" title={a.body}>{lineOf(a)}</span>
                    {/* What became of an ask that waits no more: allowed once from the page, denied, closed with no answer (on a phone without where it was given: in its tooltip). */}
                    {a.outcome && <span className={cn("text-micro", wide ? "min-w-0 max-w-[50%] truncate" : "shrink-0", /^denied|^closed/.test(a.outcome) ? "text-faint" : "text-muted", tight && "sr-only")} title={a.outcome} data-testid="inbox-outcome">{cap(wide ? a.outcome : a.outcome.split(" from ")[0]!.replace("closed with no answer", "not answered"))}</span>}
                    {(a.data?.snoozed || a.data?.held) && <span className="shrink-0 text-micro text-faint" aria-hidden>{a.data?.snoozed ? "snoozed" : "held by the snooze"}</span>}
                    {/* What waits on the owner is answered on its card: the row says it opens one. */}
                    {offers && <span className="shrink-0 text-micro font-medium text-accent-ink" data-testid="inbox-opens">{askAction(a)}</span>}
                    <span className={cn("shrink-0 text-micro text-faint tabular-nums", tight && "sr-only")} title={when(a.ts)}>{ago(a.ts)}</span>
                  </span>
                  {/* What the wait costs, under what it is: why it stands where it does in the queue. */}
                  {part === "need" && (() => {
                    const now = live[a.id] ?? a.wait_now ?? a.data?.wait;
                    return costs(now) && (
                      <span className="block pb-0.5 pl-6 text-caption leading-snug text-muted sm:truncate" data-testid="inbox-cost" title="What this wait costs now. The wait that cost most as it began is listed first.">
                        {costLine(now, Date.now())}
                      </span>
                    );
                  })()}
                </button>
                <button
                  type="button"
                  data-testid="inbox-toggle-read"
                  aria-label={a.read ? "Mark unread" : "Mark read"}
                  title={a.read ? "Mark unread" : "Mark read"}
                  onClick={() => (a.read ? auto.unreadOne(a.id) : auto.read({ ids: [a.id] })).catch(reportError)}
                  className={cn(
                    "mb-1 mr-1 grid size-ctl-sm shrink-0 place-items-center rounded-md outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring",
                    a.read && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  {a.read ? <span className="size-2 rounded-full border border-line-strong" /> : <span className="size-2 rounded-full bg-fg" data-testid="inbox-dot" />}
                </button>
              </div>
              <Failed a={a} />
              {n && (
                <p role="status" data-testid="inbox-note" className="flex items-center gap-2 px-2.5 pb-2 pl-[2.25rem] text-caption text-muted">
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
        }), ...(part === "need" ? [<ReadyToLand key="ready" inbox />] : [])])}
      </ul>
    </div>
  );
}

// A part's head: its name and how many it holds. What needs the owner carries their mark.
function PartHead({ part, n }: { part: AlertGroup; n: number }) {
  return (
    <li className="flex items-center gap-2 px-2.5 pb-1 pt-3 first:pt-1.5" data-testid="inbox-part" data-part={part} role="presentation">
      {part === "need" && <Mark w="need" className="size-2" />}
      <h3 className={cn("k-label", part === "need" && "text-st-need")}>{ALERT_GROUP_WORD[part]}</h3>
      <span className="k-face-figure text-micro text-faint">{n}</span>
    </li>
  );
}

const bandCls = "flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3 py-2 max-sm:py-1.5";

function Failed({ a }: { a: Alert }) {
  const failed = Object.entries(a.delivery ?? {}).filter(([, d]) => d.state === "failed");
  if (!failed.length) return null;
  return (
    <p className="flex items-center gap-2 px-2.5 pb-1.5 pl-[2.25rem] text-caption text-danger" data-testid="inbox-failed">
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
  const [tab, setTab] = useState(() => peekInboxView()?.tab ?? "inbox");
  // A command asked for one of the views (lib/inbox-view.ts): shown when the panel opens, or in place.
  useEffect(() => {
    const take = () => { const a = peekInboxView(); if (a) setTab(a.tab); };
    if (open) take();
    return onInboxView(take);
  }, [open]);
  const panel = useId();
  const routes = useAuto((s) => s.settings?.routes);
  const channels = useAuto((s) => s.channels);
  useEffect(() => {
    if (open) auto.loadAlerts().catch(reportError);
    // What lies behind the open Inbox is not shown: nothing is read there because its session is on screen.
    coverPanes(open);
    return () => coverPanes(false);
  }, [open]);
  const close = () => onOpenChange(false);
  // The shared surface, as a drawer on the rail's side: its head holds the title and the two
  // views; the list's own band and the delivery line at its foot are the Inbox's.
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="inbox-panel"
          data-float
          className={footSheet()}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="k-surface-head">
              <Bell className="k-surface-icon" />
              <Dialog.Title className="k-surface-title">Inbox</Dialog.Title>
              <Seg kind="tabs" panel={panel} label="Inbox views" value={tab} onChange={setTab} options={[{ value: "inbox", label: "Alerts", testid: "tab-inbox" }, { value: "activity", label: "Activity", testid: "tab-activity" }]} />
              <span className="k-surface-end">
                <Dialog.Close className="k-surface-close" aria-label="Close">
                  <X />
                </Dialog.Close>
              </span>
            </div>
            {tab === "inbox" && <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} className="flex min-h-0 flex-1 flex-col"><Inbox onClose={close} /></div>}
            {tab === "activity" && <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} className="flex min-h-0 flex-1 flex-col"><ActivityList onClose={close} /></div>}
            {/* Delivery, once for the list: where alerts go besides here, and the two controls over it. */}
            <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1 border-t border-line px-3 py-2">
              <p className="min-w-0 flex-1 basis-full px-1 text-caption leading-snug text-faint sm:basis-56" data-testid="inbox-routes">{routesLine(routes, channels)}</p>
              <GlobalSnoozeButton />
              <button type="button" data-testid="alert-routes-link" onClick={() => { close(); navigate({ name: "settings", section: "alerts" }); }} className={actCls}>
                <Settings2 className="size-3.5" /> Routes
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
