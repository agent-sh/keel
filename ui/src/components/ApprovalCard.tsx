import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, FilePen, MessageSquareShare, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { safety, useSafety, type Approval, type Suggest } from "../lib/safety.ts";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

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
// waits until each is answered.
export function Approvals({ sessionId }: { sessionId: string }) {
  const cards = useSafety((s) => s.approvals[sessionId] ?? EMPTY);
  if (!cards.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-2" data-testid="approvals">
      {cards.map((a, i) => <Card key={a.id} a={a} first={i === 0} />)}
    </div>
  );
}

function Card({ a, first }: { a: Approval; first: boolean }) {
  const Icon = a.risk === "high" ? ShieldAlert : ICON[a.kind];
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const once = useRef<HTMLButtonElement>(null);
  // Take focus so Enter answers, unless the owner is typing a message.
  useEffect(() => {
    const el = document.activeElement;
    const typing = el instanceof HTMLTextAreaElement && el.value.trim() !== "";
    if (first && !typing) once.current?.focus({ preventScroll: true });
  }, [first]);

  const answer = async (body: { choice: string; reason?: string; rules?: Suggest[] }) => {
    setBusy(true);
    setErr("");
    try {
      await safety.answer(a.session_id, a.id, body);
    } catch (e) {
      setErr((e as Error).message);
      reportError(e, { at: "approval answer" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={root}
      data-testid="approval"
      data-risk={a.risk}
      className={cn(
        "animate-in overflow-hidden rounded-2xl border bg-raised shadow-2",
        a.risk === "high" ? "border-danger/50" : "border-accent/40",
      )}
      onKeyDown={(e) => {
        if (denying || (e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "Escape") { e.preventDefault(); setDenying(true); }
      }}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <span className={cn("grid size-6 place-items-center rounded-md", a.risk === "high" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}>
          <Icon className="size-3.5" />
        </span>
        <span className="text-ui font-medium">{TITLE[a.kind]}</span>
        <span className="font-mono text-caption text-faint">{a.tool}</span>
        {a.risk === "high" && (
          <span className="ml-auto rounded-full bg-danger-soft px-2 py-0.5 text-micro font-medium text-danger" data-testid="approval-risk">
            {a.why ? `High risk: ${a.why}` : "High risk"}
          </span>
        )}
      </div>
      <pre className="mx-4 mt-2.5 max-h-48 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all" data-testid="approval-summary">
        {a.kind === "shell" && <span className="select-none text-accent">$ </span>}
        {a.summary}
      </pre>
      {denying ? (
        <form
          className="flex items-center gap-2 px-4 py-3"
          onSubmit={(e) => { e.preventDefault(); answer({ choice: "deny", reason }); }}
        >
          <input
            autoFocus
            data-testid="deny-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setDenying(false); } }}
            placeholder="Tell the model why, or what to do instead (optional)"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-ui outline-none placeholder:text-faint focus:border-line-strong"
          />
          <button type="submit" disabled={busy} data-testid="deny-send" className="h-8 rounded-lg bg-danger px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50">
            Deny
          </button>
          <button type="button" onClick={() => setDenying(false)} className="grid size-8 place-items-center rounded-lg text-faint hover:bg-hover hover:text-fg" title="Back">
            <X className="size-4" />
          </button>
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
          {err ? <span className="ml-auto min-w-0 truncate text-micro text-danger" title={err}>{err}</span> : <span className="ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden">Enter allows once, Esc denies</span>}
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
export function NeedsYou({ sessionId }: { sessionId: string }) {
  const n = useSafety((s) => s.approvals[sessionId]?.length ?? 0);
  if (!n) return null;
  return (
    <span data-testid="needs-you" title={`${n} approval${n === 1 ? "" : "s"} waiting`} className="shrink-0 rounded-full bg-accent-soft px-1.5 text-micro font-medium text-accent-ink">
      needs you
    </span>
  );
}
