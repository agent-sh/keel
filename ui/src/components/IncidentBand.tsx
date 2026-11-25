// What just broke, across sessions: one row at the top of the page for each
// cause the daemon counts as an incident (src/automation/incident-book.ts),
// with what it touched and what Keel does about it, and a way to the details:
// every session and agent it touched, what the owner can do, the last words
// of the failure. It is gone when the incident clears; for a minute after,
// the row says it cleared, so a look at the page tells it is over.
import { Popover } from "@base-ui/react/popover";
import { CircleCheck, ExternalLink, Gauge, HardDrive, KeyRound, RotateCw, ShieldAlert, Unplug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { doingOf, radiusOf, titleOf, youOf, type Incident } from "../../../src/automation/incident-book.ts";
import { every } from "../lib/clock.ts";
import { useIncidents } from "../lib/incidents.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { clock, cn } from "../lib/utils.ts";

// A cleared incident stays on the row this long, in the words that it is over.
const CLEARED_SHOWN_MS = 60_000;

type Tone = "wait" | "warn" | "fail" | "ok";
const toneOf = (i: Incident): Tone =>
  i.cleared ? "ok" : i.cause === "provider" && !i.failed ? "wait" : i.cause === "judge" || i.cause === "stall" ? "warn" : "fail";
const TONE: Record<Tone, { row: string; icon: string }> = {
  wait: { row: "border-st-wait/35 bg-raised", icon: "text-st-wait" },
  warn: { row: "border-warn/40 bg-brass-soft", icon: "text-warn" },
  fail: { row: "border-danger/40 bg-danger-soft", icon: "text-danger" },
  ok: { row: "border-line bg-raised", icon: "text-ok" },
};
function Icon({ i, className }: { i: Incident; className?: string }) {
  const C = i.cleared ? CircleCheck : { provider: Unplug, account: KeyRound, judge: ShieldAlert, stall: Gauge, restarts: RotateCw, disk: HardDrive }[i.cause];
  return <C className={cn("size-3.5 shrink-0", TONE[toneOf(i)].icon, className)} aria-hidden="true" />;
}
const STATE: Record<string, string> = { failed: "failed", waiting: "waits", went_on: "went on", cut: "cut by the stop" };

// One incident whole, as the details list it.
// `head`: its own title line (a list that names it already leaves it out).
function Details({ i, head = true }: { i: Incident; head?: boolean }) {
  const open = (id: string) => { navigate({ name: "session", id }); };
  return (
    <section className="flex flex-col gap-2 px-3 py-2.5" data-testid="incident-details" data-key={i.key}>
      {head && <div className="flex items-baseline gap-2">
        <Icon i={i} className="self-center" />
        <h3 className="min-w-0 flex-1 break-words text-ui font-medium text-fg" data-testid="incident-head">{titleOf(i)}</h3>
        <span className="shrink-0 tabular-nums text-caption text-faint">{i.cleared ? (clock(i.since) === clock(i.cleared) ? clock(i.since) : `${clock(i.since)} to ${clock(i.cleared)}`) : `since ${clock(i.since)}`}</span>
      </div>}
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-caption">
        {/* In the Errors list the row above it already says what it touched, whole: said once. */}
        {head && radiusOf(i) && <><dt className="text-faint">Touched</dt><dd className="text-fg" data-testid="incident-radius">{radiusOf(i)}</dd></>}
        <dt className="text-faint">{i.cleared ? "Cleared" : "Keel"}</dt><dd className="text-muted" data-testid="incident-doing">{i.cleared ? i.cleared_how : doingOf(i)}</dd>
        {!i.cleared && <><dt className="text-faint">You</dt><dd className="text-muted" data-testid="incident-you">{youOf(i)}</dd></>}
      </dl>
      {i.touched.length > 0 && (
        <ul className="-mx-1 flex max-h-[14rem] flex-col overflow-y-auto" data-testid="incident-touched">
          {i.touched.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => open(t.id)} data-testid="incident-session" data-session={t.id} data-state={t.state}
                className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-caption outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
                <span className={cn("size-1.5 shrink-0 rounded-full", t.state === "failed" ? "bg-st-fail" : t.state === "waiting" ? "bg-st-wait" : t.state === "cut" ? "bg-warn" : "bg-st-done")} />
                <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
                <span className="shrink-0 text-faint">{t.parent ? "agent" : "session"} · {t.state === "failed" && t.n > 1 ? `failed ${t.n} times` : STATE[t.state]}</span>
                <ExternalLink className="size-3 shrink-0 text-faint" />
              </button>
            </li>
          ))}
          {i.more > 0 && <li className="px-1 py-1 text-caption text-faint">and {i.more} more</li>}
        </ul>
      )}
      {i.sample && <p className="line-clamp-2 break-words font-mono text-micro text-faint" data-testid="incident-sample" title={i.sample}>{i.sample}</p>}
    </section>
  );
}

export function IncidentBand() {
  const { open, cleared } = useIncidents();
  const [now, setNow] = useState(Date.now());
  const [gone, setGone] = useState<string[]>([]);
  const fresh = cleared.filter((c) => (c.cleared ?? 0) > now - CLEARED_SHOWN_MS && !gone.includes(c.id));
  // The clock runs only while a cleared row is up: it takes the row away when its minute is over.
  useEffect(() => {
    setNow(Date.now());
    if (!cleared.some((c) => (c.cleared ?? 0) > Date.now() - CLEARED_SHOWN_MS)) return;
    return every(15_000, () => setNow(Date.now()));
  }, [cleared]);
  const shown = open.length ? open : fresh.slice(0, 1);
  const first = shown[0];
  if (!first) return null;
  const rest = shown.length - 1;
  const tone = toneOf(first);
  return (
    <div role={first.cleared ? "status" : "alert"} data-testid="incident-band" data-key={first.key} data-cleared={first.cleared ? "" : undefined} data-count={open.length}
      className={cn("flex min-h-9 shrink-0 items-center gap-3 border-b px-4 py-1 text-ui animate-in max-md:gap-2 max-md:px-3", TONE[tone].row)}>
      <Icon i={first} />
      <span className="flex min-w-0 flex-1 items-baseline gap-3 max-md:flex-col max-md:gap-0">
        <span className="shrink-0 truncate font-medium text-fg max-md:max-w-full max-md:whitespace-normal max-md:break-words" data-testid="incident-title">
          {titleOf(first)}{first.cleared ? `: cleared at ${clock(first.cleared)}` : <span className="font-normal text-muted max-md:hidden"> since {clock(first.since)}</span>}
        </span>
        <span className="min-w-0 truncate text-caption text-muted max-md:max-w-full" data-testid="incident-line">
          {!first.cleared && <span className="tabular-nums md:hidden">Since {clock(first.since)} · </span>}
          {first.cleared || !radiusOf(first) ? radiusOf(first) || doingOf(first) : <>{radiusOf(first)}<span className="max-md:hidden">. {doingOf(first)}</span></>}
        </span>
      </span>
      {rest > 0 && <span className="shrink-0 text-caption text-muted" data-testid="incident-more">+{rest} more</span>}
      <Popover.Root>
        <Popover.Trigger data-testid="incident-open" className="k-btn shrink-0">Details</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={6} align="end" collisionPadding={8}>
            <Popover.Popup data-testid="incident-popup"
              className={cn(
                "w-[min(30rem,calc(100vw-1rem))] max-h-[min(36rem,80vh)] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-raised shadow-3 outline-none",
                "origin-[var(--transform-origin)] transition-[scale,opacity] data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0",
              )}>
              {shown.map((i) => <Details key={i.id} i={i} />)}
              <div className="flex justify-end px-3 py-2">
                <button type="button" className="k-btn" onClick={() => setUI({ errors: true })} data-testid="incident-errors">Errors</button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {first.cleared && (
        <button type="button" className="k-line-act shrink-0" aria-label="Dismiss" onClick={() => setGone((g) => [...g, first.id])} data-testid="incident-dismiss"><X className="size-3.5" /></button>
      )}
    </div>
  );
}

// The Errors panel's own list: what is open and what cleared in the last day, one line each, opened in place.
export function IncidentList() {
  const { open, cleared } = useIncidents();
  const [shown, setShown] = useState<string | null>(null);
  const all = [...open, ...cleared];
  if (!all.length) return null;
  return (
    <div className="border-b border-line px-3 py-2" data-testid="errors-incidents">
      <div className="k-label pb-1">Incidents</div>
      <ul className="flex flex-col">
        {all.map((i) => (
          <li key={i.id} data-testid="errors-incident" data-key={i.key} data-cleared={i.cleared ? "" : undefined}>
            <button type="button" aria-expanded={shown === i.id} onClick={() => setShown(shown === i.id ? null : i.id)}
              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-caption outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring max-md:items-start">
              <Icon i={i} className="max-md:mt-0.5" />
              <span className="flex min-w-0 flex-1 items-baseline gap-1 max-md:flex-col max-md:gap-0">
                <span className="min-w-0 truncate text-fg md:max-w-full md:shrink-0 max-md:max-w-full max-md:whitespace-normal max-md:break-words" data-testid="incident-row-title">{titleOf(i)}</span>
                <span className="min-w-0 truncate text-muted max-md:max-w-full max-md:whitespace-normal max-md:break-words" data-testid="incident-row-radius"><span className="max-md:hidden">· </span>{radiusOf(i)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-faint">{i.cleared ? (clock(i.since) === clock(i.cleared) ? clock(i.since) : `${clock(i.since)} to ${clock(i.cleared)}`) : `since ${clock(i.since)}`}</span>
            </button>
            {shown === i.id && <div className="-mx-3"><Details i={i} head={false} /></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
