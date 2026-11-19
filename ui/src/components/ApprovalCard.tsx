import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, FilePen, MessageSquareShare, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
export function Approvals({ sessionId, asker }: { sessionId: string; asker?: string }) {
  const cards = useSafety((s) => s.approvals[sessionId] ?? EMPTY);
  const list = useRef<HTMLDivElement>(null);
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
          className="mb-2 flex flex-col gap-2 outline-none"
          data-testid="approvals"
        >
          {cards.map((a, i) => <Card key={a.id} a={a} first={i === 0} asker={asker} list={list} />)}
        </div>
      )}
    </>
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

function Card({ a, first, asker, list }: { a: Approval; first: boolean; asker?: string; list: RefObject<HTMLDivElement | null> }) {
  const Icon = a.risk === "high" ? ShieldAlert : ICON[a.kind];
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [closed, setClosed] = useState(false); // the daemon says it can no longer be answered
  const root = useRef<HTMLDivElement>(null);
  const once = useRef<HTMLButtonElement>(null);
  const ids = `approval-${a.id}`;
  // Take focus so Enter answers, unless the owner is busy elsewhere.
  useEffect(() => {
    if (first && mayTakeFocus()) once.current?.focus({ preventScroll: true });
  }, [first]);
  // A card that held focus and goes away hands it to its list's label, never
  // to another card's Allow.
  useLayoutEffect(() => () => {
    if (!root.current?.contains(document.activeElement)) return;
    const to = list.current;
    queueMicrotask(() => { if (to?.isConnected) to.focus({ preventScroll: true }); });
  }, []);

  const answer = async (body: { choice: string; reason?: string; rules?: Suggest[] }) => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  return (
    <div
      ref={root}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-summary`}
      data-testid="approval"
      data-approval-id={a.id}
      data-risk={a.risk}
      className={cn(
        "animate-in overflow-hidden rounded-2xl border bg-raised shadow-2",
        a.risk === "high" ? "border-danger/50" : "border-accent/40",
      )}
      onKeyDown={(e) => {
        if (denying || closed || (e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "Escape") { e.preventDefault(); setDenying(true); }
      }}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <span className={cn("grid size-6 place-items-center rounded-md", a.risk === "high" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}>
          <Icon className="size-3.5" />
        </span>
        <span id={`${ids}-title`} className="text-ui font-medium">
          {asker && <span className="sr-only">{asker}: </span>}
          {TITLE[a.kind]} <span className="font-mono text-caption font-normal text-faint">{a.tool}</span>
        </span>
        {a.call_id.includes("~") && <span className="rounded-full bg-sunken px-1.5 py-px text-micro text-muted" data-testid="approval-from-code">from a program</span>}
        {a.risk === "high" && (
          <span className="ml-auto rounded-full bg-danger-soft px-2 py-0.5 text-micro font-medium text-danger" data-testid="approval-risk">
            {a.why ? `High risk: ${a.why}` : "High risk"}
          </span>
        )}
      </div>
      {a.notice && <p className="mx-4 mt-2 text-caption text-warn" data-testid="approval-notice">{a.notice}</p>}
      <pre id={`${ids}-summary`} className="mx-4 mt-2.5 max-h-48 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all" data-testid="approval-summary">
        {a.kind === "shell" && <span className="select-none text-accent">$ </span>}
        {a.summary}
      </pre>
      {closed ? (
        <div className="flex items-center gap-2 px-4 py-3" data-testid="approval-closed">
          <span className="min-w-0 flex-1 text-caption text-muted">This request is no longer open: {err}</span>
          <button type="button" onClick={() => safety.loadSession(a.session_id).catch(reportError)} className="h-8 shrink-0 rounded-lg border border-line px-3 text-ui hover:bg-hover">
            Refresh
          </button>
        </div>
      ) : denying ? (
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3"
          onSubmit={(e) => { e.preventDefault(); answer({ choice: "deny", reason }); }}
        >
          <input
            autoFocus
            data-testid="deny-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setDenying(false); } }}
            aria-label="Why you deny it (optional)"
            placeholder="Tell the model why, or what to do instead (optional)"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-ui outline-none placeholder:text-faint focus:border-line-strong"
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
        <div className="flex items-center gap-1.5 px-4 py-3">
          <button
            ref={once}
            disabled={busy}
            data-testid="allow-once"
            onClick={() => answer({ choice: "once" })}
            className="h-8 shrink-0 whitespace-nowrap rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-raised"
          >
            Allow once
          </button>
          {a.risk === "low" && a.suggest.length > 0 && <AlwaysButton a={a} busy={busy} onGrant={(rules, session) => answer({ choice: session ? "session" : "always", rules })} />}
          <button
            disabled={busy}
            data-testid="deny"
            onClick={() => setDenying(true)}
            className="h-8 shrink-0 rounded-lg px-3 text-ui text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
          >
            Deny
          </button>
          {err ? <span className="ml-auto min-w-0 truncate text-micro text-danger" role="alert" title={err} data-testid="approval-error">{err}</span> : <span className="ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden">Enter allows once, Esc to deny with a reason</span>}
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
