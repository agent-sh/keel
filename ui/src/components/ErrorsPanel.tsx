import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ErrorRecord } from "../../../src/core/types.ts";
import { useStore } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";

// The same failure repeated back to back reads as one row with a count.
function runs(list: ErrorRecord[]) {
  const out: { e: ErrorRecord; n: number }[] = [];
  for (const e of list) {
    const last = out[out.length - 1];
    if (last && last.e.source === e.source && last.e.message === e.message) last.n++;
    else out.push({ e, n: 1 });
  }
  return out;
}

export function ErrorsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const errors = useStore((s) => s.errors);
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
          <div className="flex-1 overflow-y-auto p-2">
            {errors.length === 0 && <p className="px-3 py-10 text-center text-ui text-faint">Nothing has failed.</p>}
            {runs(errors).map(({ e, n }) => (
              <details key={e.id} className="group rounded-md px-3 py-2 hover:bg-hover">
                <summary className="flex cursor-default list-none items-baseline gap-2.5 text-ui">
                  <span className="rounded-xs bg-danger-soft px-1.5 py-px text-micro font-medium text-danger">{e.source}</span>
                  <span className="min-w-0 flex-1 truncate">{e.message}</span>
                  {n > 1 && <span className="rounded-xs bg-sunken px-1.5 text-micro tabular-nums text-muted" title={`${n} times in a row`}>{n}x</span>}
                  <span className="text-micro text-faint tabular-nums" title={when(e.ts)}>{ago(e.ts)}</span>
                </summary>
                {(e.stack || e.context) && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-micro text-muted whitespace-pre-wrap break-all">
                    {e.context ? JSON.stringify(e.context, null, 2) + "\n\n" : ""}{e.stack}
                  </pre>
                )}
              </details>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
