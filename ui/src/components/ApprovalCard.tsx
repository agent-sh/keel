import { Popover } from "@base-ui/react/popover";
import { Check, CheckCheck, ChevronDown, FilePen, MessageSquareShare, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { batches, batchName, SETTLE_MS, type Batch } from "../lib/approvals.ts";
import { composing } from "../lib/keys.ts";
import { safety, useSafety, type Approval, type Suggest } from "../lib/safety.ts";
import { failed, reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { BlockedCards } from "./BlockedCards.tsx";
import { SecretCards } from "./SecretCards.tsx";
import { TrustCards } from "./TrustCards.tsx";
import { PlanCards } from "./PlanCard.tsx";

const TITLE: Record<Approval["kind"], string> = {
  shell: "Run this command?",
  edit: "Change these files?",
  other: "Use this tool?",
  read: "Read this?",
  drive: "Drive a session?",
  refused: "Refused",
};
const ICON = { shell: SquareTerminal, edit: FilePen, other: Wrench, read: Wrench, drive: MessageSquareShare, refused: X };
const EMPTY: Approval[] = [];

// The open approval cards of a session, docked above the composer. The turn
// waits until each is answered. `asker` names whose cards these are when a
// parent page shows its agents' cards.
//
// Several at once are a list: each a row with its own answers, and over them
// what waits and one action per tool that allows that tool's requests
// together. The action covers this session's rows only (an agent's requests
// have a list and an action of their own under its name), only low-risk ones,
// and only the ones that have been on screen long enough to be read: it names
// their number, and pointing at it marks exactly those rows.
export function Approvals({ sessionId, asker }: { sessionId: string; asker?: string }) {
  const cards = useSafety((s) => s.approvals[sessionId] ?? EMPTY);
  const list = useRef<HTMLDivElement>(null);
  // When each card was first on screen here (a hidden page shows nothing).
  const shown = useRef(new Map<string, number>());
  const [, again] = useState(0);
  const now = Date.now();
  const visible = document.visibilityState === "visible";
  for (const a of cards) if (visible && !shown.current.has(a.id)) shown.current.set(a.id, now);
  for (const id of [...shown.current.keys()]) if (!cards.some((a) => a.id === id)) shown.current.delete(id);
  const groups = batches(cards, shown.current, now);
  useEffect(() => {
    const render = () => again((n) => n + 1);
    // Drawn again when the newest card has been shown long enough, and when the page comes back into view.
    const due = Math.max(0, ...cards.map((a) => (shown.current.get(a.id) ?? 0) + SETTLE_MS - Date.now()));
    const timer = due > 0 ? window.setTimeout(render, due + 10) : 0;
    document.addEventListener("visibilitychange", render);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", render); };
  }, [cards]);

  const [hot, setHot] = useState<string | null>(null); // the tool whose "allow all" is pointed at
  const [sending, setSending] = useState<string[]>([]); // the ids a batch is answering
  const [note, setNote] = useState("");
  const many = cards.length > 1;
  const uniform = many && cards.every((a) => a.tool === cards[0]!.tool);
  const marked = groups.find((g) => g.tool === hot)?.ids;

  // The ids are the ones the button named when it was pressed; a card that
  // arrives while they are sent is not among them.
  const allowAll = async (ids: string[]) => {
    setSending(ids);
    setNote("");
    let done = 0, gone = 0, why = "";
    for (const id of ids) {
      try {
        await safety.answer(sessionId, id, { choice: "once" });
        done++;
      } catch (e) {
        if ((e as { status?: number }).status === 409) { gone++; continue; } // settled meanwhile (a grant, another device, a stop)
        why = failed(e, { at: "approval answer" });
        break; // the rest stay open, each with its own answers
      }
    }
    // The cards are read again when one did not take the answer: what is still open shows as it is.
    if (gone || why) await safety.loadSession(sessionId).catch(reportError);
    setSending([]);
    if (why) setNote(`${done} of ${ids.length} allowed, the rest still wait: ${why}`);
  };

  // Up and Down move between the list's stops: the "allow all" action, then each card's first answer.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    // Not from a field, and not from a popup a card opened (its events come here through React, not the page).
    if (!e.currentTarget.contains(t) || t.tagName === "INPUT") return;
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-stop]:not(:disabled)")];
    const at = stops.findIndex((s) => s === t || (s.dataset.stop === "card" && !!s.closest('[data-testid="approval"]')?.contains(t)));
    const down = e.key === "ArrowDown";
    const to = at >= 0 ? stops[at + (down ? 1 : -1)]
      : down ? stops.find((s) => s.dataset.stop === "card")
      : stops.findLast((s) => s.dataset.stop === "all");
    if (!to) return;
    e.preventDefault();
    to.focus();
  };

  return (
    <>
      <SecretCards sessionId={sessionId} />
      <BlockedCards sessionId={sessionId} />
      <TrustCards sessionId={sessionId} />
      <PlanCards sessionId={sessionId} />
      {cards.length > 0 && (
        <div
          ref={list}
          tabIndex={-1}
          role="region"
          aria-label={`${asker ? `${asker}: ` : ""}${cards.length === 1 ? "1 request waits" : `${cards.length} requests wait`} for your answer`}
          className={cn("group/asks mb-2 flex flex-col outline-none", many ? "gap-1.5" : "gap-2")}
          data-testid="approvals"
          onKeyDown={onKeyDown}
        >
          {many && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-0.5" data-testid="approvals-bar">
              <span className="k-face-state k-ask-count" data-testid="approvals-count">
                {uniform ? batchName(cards[0]!, cards.length) : `${cards.length} requests`} wait
              </span>
              {/* Said where the keyboard is: its room is kept, so nothing moves when the focus comes or goes. */}
              <span className="invisible min-w-0 flex-1 basis-0 truncate text-micro text-faint group-focus-within/asks:visible max-sm:hidden pointer-coarse:hidden">Up and Down choose, Enter answers the framed one</span>
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {groups.map((g) => (
                  <AllowAll
                    key={g.tool}
                    g={g}
                    cards={cards}
                    busy={sending.length > 0}
                    list={list}
                    onHot={(on) => setHot((h) => (on ? g.tool : h === g.tool ? null : h))}
                    onAllow={() => allowAll(g.ids)}
                  />
                ))}
              </span>
              {note && <span className="basis-full text-micro text-danger" role="alert" data-testid="approvals-error">{note}</span>}
            </div>
          )}
          {cards.map((a, i) => (
            <Card
              key={a.id}
              a={a}
              first={i === 0}
              asker={asker}
              list={list}
              many={many}
              plain={uniform}
              hot={!!marked?.includes(a.id)}
              locked={sending.includes(a.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// A control that held the focus and goes away hands it to its list's label,
// never to another card's Allow. The last one takes the list with it: the
// focus goes to the pane's message box (at a desk; on a phone that raises the
// keyboard). (An answer disables the control, and the browser then takes the
// focus off it: `held` remembers that it had it.)
function useHandBack(root: RefObject<HTMLElement | null>, list: RefObject<HTMLDivElement | null>) {
  const held = useRef(false);
  useLayoutEffect(() => () => {
    const a = document.activeElement;
    if (!root.current?.contains(a) && !(held.current && (!a || a === document.body))) return;
    const to = list.current;
    const box = root.current?.closest(".k-session")?.querySelector<HTMLElement>('[data-testid="composer"]');
    queueMicrotask(() => {
      if (to?.isConnected) to.focus({ preventScroll: true });
      else if (matchMedia("(min-width: 768px)").matches) box?.focus({ preventScroll: true });
    });
  }, []);
  return held;
}

// One action for a tool's open requests: it says how many it answers, and
// while the pointer or the keyboard is on it those rows are the marked ones.
function AllowAll({ g, cards, busy, list, onHot, onAllow }: { g: Batch; cards: Approval[]; busy: boolean; list: RefObject<HTMLDivElement | null>; onHot: (on: boolean) => void; onAllow: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  const held = useHandBack(root, list);
  useEffect(() => () => onHot(false), []);
  // Disabled while it answers, the button loses the keyboard: when requests are left for it, it takes it back.
  useEffect(() => {
    if (busy || !held.current) return;
    held.current = false;
    if (document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, [busy]);
  const n = g.ids.length;
  const ready = n > 1;
  const covered = cards.filter((a) => g.ids.includes(a.id));
  const what = ready ? `${n < g.waiting ? "" : "all "}${batchName(g, n)}` : `all ${batchName(g, g.waiting)}`;
  const said = `Allows once, in this order: ${covered.map((a) => a.summary).join("; ")}`;
  return (
    <button
      ref={root}
      type="button"
      data-testid="allow-all"
      data-tool={g.tool}
      data-stop="all"
      disabled={busy || !ready}
      title={ready ? undefined : "The requests have only just arrived: read them first"}
      aria-label={`Allow ${what} once`}
      aria-description={ready ? said : undefined}
      onPointerEnter={() => onHot(true)}
      onPointerLeave={() => onHot(false)}
      onFocus={() => onHot(true)}
      onBlur={() => onHot(false)}
      onClick={() => { held.current = document.activeElement === root.current; onAllow(); }}
      className="k-allow-all inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CheckCheck className="size-3.5 text-st-need" aria-hidden="true" /> Allow {what}
    </button>
  );
}

// Focus may move to a new card's Allow only when nothing else holds it (or
// the composer is empty): never out of a field the owner is typing in, or
// out of another card.
function mayTakeFocus(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  if (el instanceof HTMLTextAreaElement) return el.value.trim() === "" && !el.closest("[data-testid=approval]");
  return false;
}

// `many`: one of several, drawn as a row (the request beside its answers, no
// hint: the list says it once), framed only while it has the keyboard. `plain`: every row is the same tool and the
// list's heading names it, so the row's title is for screen readers only.
// `hot`: the pointed "allow all" covers it. `locked`: that action is answering it.
function Card({ a, first, asker, list, many, plain, hot, locked }: { a: Approval; first: boolean; asker?: string; list: RefObject<HTMLDivElement | null>; many: boolean; plain: boolean; hot: boolean; locked: boolean }) {
  const dense = many && a.risk !== "high"; // a high-risk request keeps its whole card, with why it is one
  const Icon = a.risk === "high" ? ShieldAlert : ICON[a.kind];
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [answering, setAnswering] = useState(false);
  const [err, setErr] = useState("");
  const [closed, setClosed] = useState(false); // the daemon says it can no longer be answered
  const root = useRef<HTMLDivElement>(null);
  const once = useRef<HTMLButtonElement>(null);
  const ids = `approval-${a.id}`;
  const busy = answering || locked;
  // Take focus so Enter answers, unless the owner is busy elsewhere.
  useEffect(() => {
    if (first && mayTakeFocus()) once.current?.focus({ preventScroll: true });
  }, [first]);
  const held = useHandBack(root, list);

  const answer = async (body: { choice: string; reason?: string; rules?: Suggest[] }) => {
    held.current = !!root.current?.contains(document.activeElement);
    setAnswering(true);
    setErr("");
    try {
      await safety.answer(a.session_id, a.id, body);
    } catch (e) {
      const st = (e as { status?: number }).status;
      const was = (e as { body?: { approval?: Approval } }).body?.approval;
      setErr(failed(e, { at: "approval answer" }));
      if (st === 409) {
        // Answered elsewhere, cancelled, or nothing waits on it: say how it ended, offer no decision.
        setClosed(true);
        if (was && was.state !== "pending") window.setTimeout(() => safety.loadSession(a.session_id).catch(reportError), 4000);
      } else if (!st) {
        // The answer may have landed before the reply was lost: read the card again before a retry.
        await safety.loadSession(a.session_id).catch(reportError);
      }
    } finally {
      setAnswering(false);
    }
  };

  const fromCode = a.call_id.includes("~") && <span className="rounded-full bg-sunken px-1.5 py-px text-micro text-muted" data-testid="approval-from-code">from a program</span>;
  const title = (
    <span id={`${ids}-title`} className={cn(dense ? "text-caption font-medium" : "text-ui font-medium", dense && plain && "sr-only")}>
      {asker && <span className="sr-only">{asker}: </span>}
      {TITLE[a.kind]} <span className="font-mono text-caption font-normal text-faint">{a.tool}</span>
    </span>
  );
  const icon = (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", a.risk === "high" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}>
      <Icon className="size-3.5" />
    </span>
  );
  const notice = a.notice && <p className={cn("text-caption text-warn", dense ? "mb-1" : "mx-4 mt-2")} data-testid="approval-notice">{a.notice}</p>;
  const summary = (
    <pre
      id={`${ids}-summary`}
      className={cn(
        "overflow-auto bg-code font-mono text-caption leading-relaxed whitespace-pre-wrap break-all",
        dense ? "max-h-32 rounded-md px-2.5 py-1.5" : "mx-4 mt-2.5 max-h-48 rounded-lg px-3 py-2",
      )}
      data-testid="approval-summary"
    >
      {a.kind === "shell" && <span className="select-none text-accent">$ </span>}
      {a.summary}
    </pre>
  );

  return (
    <div
      ref={root}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-summary`}
      data-testid="approval"
      data-approval-id={a.id}
      data-tool={a.tool}
      data-risk={a.risk}
      data-many={many || undefined}
      data-dense={dense || undefined}
      data-hot={hot || undefined}
      className={cn(
        "k-approval animate-in overflow-hidden rounded-2xl border bg-raised shadow-2",
        a.risk === "high" ? "border-danger/50" : "border-accent/40",
        // A row: the request, then its answers beside it, or under it where the room ends.
        dense && "flex flex-wrap items-start",
      )}
      onKeyDown={(e) => {
        if (denying || closed || (e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "Escape") { e.preventDefault(); setDenying(true); }
      }}
    >
      {dense ? (
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5 py-2 pl-3 pr-1">
          <span className="mt-0.5">{icon}</span>
          <div className="min-w-0 flex-1">
            {(!plain || fromCode) && <div className="mb-1 flex flex-wrap items-center gap-2">{!plain && title}{fromCode}</div>}
            {plain && title}
            {notice}
            {summary}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 px-4 pt-3">
            {icon}
            {title}
            {fromCode}
            {a.risk === "high" && (
              <span className="ml-auto rounded-full bg-danger-soft px-2 py-0.5 text-micro font-medium text-danger" data-testid="approval-risk">
                {a.why ? `High risk: ${a.why}` : "High risk"}
              </span>
            )}
          </div>
          {notice}
          {summary}
        </>
      )}
      {closed ? (
        <div className={cn("flex items-center gap-2", dense ? "basis-full px-3 pb-2" : "px-4 py-3")} data-testid="approval-closed">
          <span className="min-w-0 flex-1 text-caption text-muted">This request is no longer open: {err}</span>
          <button type="button" data-stop="card" onClick={() => safety.loadSession(a.session_id).catch(reportError)} className="h-8 shrink-0 rounded-lg border border-line px-3 text-ui hover:bg-hover">
            Refresh
          </button>
        </div>
      ) : denying ? (
        <form
          className={cn("flex flex-wrap items-center gap-2", dense ? "basis-full px-3 pb-2" : "px-4 py-3")}
          onSubmit={(e) => { e.preventDefault(); answer({ choice: "deny", reason }); }}
        >
          <input
            autoFocus
            data-testid="deny-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && !composing(e)) { e.stopPropagation(); setDenying(false); } }}
            aria-label="Why you deny it (optional)"
            placeholder="Tell the model why, or what to do instead (optional)"
            className="h-8 min-w-[min(100%,14rem)] flex-1 rounded-lg border border-line bg-bg px-3 text-ui outline-none placeholder:text-faint focus:border-line-strong"
          />
          <button type="submit" disabled={busy} data-testid="deny-send" className="h-8 rounded-lg bg-danger px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50">
            Send denial
          </button>
          <button type="button" onClick={() => setDenying(false)} className="h-8 rounded-lg px-2.5 text-ui text-faint hover:bg-hover hover:text-fg" title="Back to the request (Esc)">
            Back
          </button>
          {err && <span className="basis-full text-micro text-danger" role="alert" data-testid="approval-error">{err}</span>}
        </form>
      ) : (
        // The three answers keep their order and wrap when the card is narrow: none is cut, Deny least of all.
        <div className={cn("flex flex-wrap items-center gap-1.5", dense ? "px-3 py-2" : "px-4 py-3")} data-testid="approval-actions">
          <button
            ref={once}
            disabled={busy}
            data-testid="allow-once"
            data-stop="card"
            onClick={() => answer({ choice: "once" })}
            className="k-allow h-8 shrink-0 whitespace-nowrap rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-raised"
          >
            Allow once
          </button>
          {a.risk === "low" && a.suggest.length > 0 && <AlwaysButton a={a} busy={busy} onGrant={(rules, session) => answer({ choice: session ? "session" : "always", rules })} />}
          <button
            disabled={busy}
            data-testid="deny"
            onClick={() => setDenying(true)}
            className="h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
          >
            Deny
          </button>
          {err ? <span className={cn("ml-auto min-w-0 basis-full text-micro text-danger", !dense && "sm:basis-auto sm:truncate")} role="alert" title={err} data-testid="approval-error">{err}</span>
            : !dense && <span className="ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden">Enter allows once, Esc to deny with a reason</span>}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL = { shell: "Commands", edit: "Edits under", tool: "Tool" } as const;

function AlwaysButton({ a, busy, onGrant }: { a: Approval; busy: boolean; onGrant: (rules: Suggest[], session: boolean) => void }) {
  const [rules, setRules] = useState<Suggest[]>(a.suggest);
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={busy}
        data-testid="allow-always"
        className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-line px-3 text-ui hover:bg-hover data-popup-open:bg-hover disabled:opacity-50"
      >
        Always allow <ChevronDown className="size-3.5 text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="w-[min(26rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] rounded-lg border border-line bg-raised p-3 shadow-2 transition-[scale,opacity] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            <Popover.Title className="text-ui font-medium">Grant</Popover.Title>
            <Popover.Description className="mt-0.5 text-caption text-muted">
              {a.kind === "shell" ? "A trailing * covers any arguments. Edit the rule to narrow it." : "Calls this rule covers run without asking."}
            </Popover.Description>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {rules.map((r, i) => (
                <label key={i} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-caption text-faint">{KIND_LABEL[r.kind]}</span>
                  <input
                    data-testid="grant-pattern"
                    value={r.pattern}
                    onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 font-mono text-caption outline-none focus:border-line-strong"
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-1.5">
              <button
                data-testid="grant-always"
                onClick={() => { setOpen(false); onGrant(rules, false); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90"
              >
                <Check className="size-3.5" /> In this workspace
              </button>
              <button
                data-testid="grant-session"
                onClick={() => { setOpen(false); onGrant(rules, true); }}
                className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover"
              >
                This session only
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// A session that waits on the owner's answer, in the session list.
