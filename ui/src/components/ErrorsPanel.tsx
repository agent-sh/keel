import { Dialog } from "@base-ui/react/dialog";
import { Check, CornerDownRight, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { ErrorRecord } from "../../../src/core/types.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";

// One row per kind of failure (the daemon folds repeats into a count), with
// where it last happened and a way to mark it fixed. A resolved kind that
// happens again comes back to Open.
function Row({ e }: { e: ErrorRecord }) {
  const session = useStore((s) => (e.session_id ? s.sessions[e.session_id] : undefined));
  const n = e.count ?? 1;
  const open = () => {
    if (e.turn_event) setUI({ focusEvent: e.turn_event });
    setUI({ errors: false });
    navigate({ name: "session", id: e.session_id! });
  };
  return (
    <details className="group rounded-md px-3 py-2 hover:bg-hover" data-testid="error-row">
      <summary className="flex cursor-default list-none items-baseline gap-2.5 text-ui">
        <span className="rounded-xs bg-danger-soft px-1.5 py-px text-micro font-medium text-danger">{e.source}</span>
        <span className="min-w-0 flex-1 truncate">{e.message}</span>
        {n > 1 && (
          <span className="rounded-xs bg-sunken px-1.5 text-micro tabular-nums text-muted" data-testid="error-count" title={`${n} times since ${when(e.first_ts ?? e.ts)}`}>
            {n}x
          </span>
        )}
        <span className="text-micro text-faint tabular-nums" title={when(e.ts)}>{ago(e.ts)}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
          <span>First <span className="tabular-nums text-fg">{when(e.first_ts ?? e.ts)}</span></span>
          {n > 1 && <span>Last <span className="tabular-nums text-fg">{when(e.ts)}</span></span>}
          {e.resolved_ts && <span>Resolved <span className="tabular-nums text-fg">{when(e.resolved_ts)}</span></span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {e.session_id && (
            <button type="button" onClick={open} className="flex h-7 max-w-80 items-center gap-1.5 rounded-md border border-line px-2 text-caption text-muted hover:bg-hover hover:text-fg" data-testid="error-session">
              <CornerDownRight className="size-3.5 shrink-0" />
              <span className="truncate">{session?.title || "Open the session"}</span>
              {e.turn_event && <span className="shrink-0 text-faint">at its turn</span>}
            </button>
          )}
          <button
            type="button"
            onClick={() => actions.resolveError(e.id, !e.resolved_ts).catch(reportError)}
            className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-caption font-medium hover:bg-hover"
            data-testid="error-resolve"
          >
            {e.resolved_ts ? <><RotateCcw className="size-3.5" /> Open again</> : <><Check className="size-3.5 text-ok" /> Resolve</>}
          </button>
        </div>
        {(e.stack || e.context) && (
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-micro text-muted whitespace-pre-wrap break-all">
            {e.context ? JSON.stringify(e.context, null, 2) + "\n\n" : ""}{e.stack}
          </pre>
        )}
      </div>
    </details>
  );
}

export function ErrorsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const errors = useStore((s) => s.errors);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const openList = errors.filter((e) => !e.resolved_ts);
  const resolved = errors.filter((e) => e.resolved_ts);
  const list = tab === "open" ? openList : resolved;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="errors-panel"
          className={cn(
            "fixed right-3 top-3 bottom-3 z-50 flex w-[min(36rem,calc(100vw-1.5rem))] flex-col rounded-xl border border-line bg-raised shadow-3",
            "transition-[transform,opacity] duration-200 data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0",
          )}
        >
          <div className="flex items-center border-b border-line px-4 py-3">
            <Dialog.Title className="font-semibold">Errors</Dialog.Title>
            <span className="ml-2 text-caption text-faint">from the daemon, the page, providers and tools</span>
            <Dialog.Close className="ml-auto grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <div role="tablist" aria-label="Which errors" className="inline-flex rounded-md border border-line bg-sunken p-0.5">
              {([["open", "Open", openList.length], ["resolved", "Resolved", resolved.length]] as const).map(([id, label, n]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cn("flex h-7 items-center gap-1.5 rounded-sm px-3 text-ui text-muted", tab === id ? "bg-raised text-fg shadow-1" : "hover:text-fg")}
                >
                  {label}<span className="text-micro tabular-nums text-faint">{n}</span>
                </button>
              ))}
            </div>
            {tab === "open" && openList.length > 1 && (
              <button type="button" onClick={() => actions.resolveAllErrors().catch(reportError)} className="ml-auto h-7 rounded-md px-2.5 text-caption text-muted hover:bg-hover hover:text-fg">
                Resolve all
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {list.length === 0 && <p className="px-3 py-10 text-center text-ui text-faint">{tab === "open" ? "Nothing open has failed." : "Nothing is marked resolved."}</p>}
            {list.map((e) => <Row key={e.id} e={e} />)}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
