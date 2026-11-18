import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useStore } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

export function ErrorsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const errors = useStore((s) => s.errors);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="errors-panel"
          className={cn(
            "fixed right-4 top-4 bottom-4 z-50 flex w-[min(36rem,calc(100vw-2rem))] flex-col rounded-2xl border border-line bg-raised shadow-soft",
            "transition-[transform,opacity] duration-200 data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0",
          )}
        >
          <div className="flex items-center border-b border-line px-4 py-3">
            <Dialog.Title className="font-semibold">Errors</Dialog.Title>
            <span className="ml-2 text-[12.5px] text-faint">server, browser, provider and tool failures</span>
            <Dialog.Close className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:text-fg hover:bg-panel">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {errors.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-faint">Nothing has failed.</p>}
            {errors.map((e) => (
              <details key={e.id} className="group rounded-lg px-3 py-2 hover:bg-panel">
                <summary className="flex cursor-pointer list-none items-baseline gap-2 text-[13px]">
                  <span className="rounded bg-danger-soft px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-danger">{e.source}</span>
                  <span className="min-w-0 flex-1 truncate">{e.message}</span>
                  <span className="text-[11.5px] text-faint tabular-nums">{ago(e.ts)}</span>
                </summary>
                {(e.stack || e.context) && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-code p-2 font-mono text-[11.5px] text-muted whitespace-pre-wrap break-all">
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
