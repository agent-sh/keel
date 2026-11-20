import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useSyncExternalStore } from "react";
import { cn } from "../lib/utils.ts";

// A confirmation for actions that cannot be undone: `await confirmAction({...})`.
type Ask = { title: string; body?: string; action: string; danger?: boolean };
let current: (Ask & { resolve: (ok: boolean) => void }) | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function confirmAction(ask: Ask): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...ask, resolve };
    emit();
  });
}

function close(ok: boolean) {
  current?.resolve(ok);
  current = null;
  emit();
}

export function ConfirmHost() {
  const ask = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  return (
    <AlertDialog.Root open={!!ask} onOpenChange={(o) => !o && close(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <AlertDialog.Popup
          data-testid="confirm"
          className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-raised p-5 shadow-3 transition-[opacity,scale] duration-150 data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <AlertDialog.Title className="text-[1.0938rem] font-semibold">{ask?.title}</AlertDialog.Title>
          {ask?.body && <AlertDialog.Description className="mt-1.5 text-ui text-muted">{ask.body}</AlertDialog.Description>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className="h-8 rounded-md border border-line-strong px-3 text-ui font-medium hover:bg-hover">Cancel</AlertDialog.Close>
            <button
              type="button"
              autoFocus
              onClick={() => close(true)}
              className={cn("h-8 rounded-md px-3 text-ui font-medium", ask?.danger ? "bg-danger text-accent-fg hover:opacity-90" : "bg-accent text-accent-fg hover:bg-accent-hover")}
            >
              {ask?.action}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
