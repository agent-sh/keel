import { Dialog } from "@base-ui/react/dialog";
import { Keyboard, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { allCommands, commandsVersion, onCommands, QUEUE_KEYS, SEND_KEYS } from "../lib/keys.ts";
import { setUI, useUI } from "../lib/ui.ts";
import { Kbd } from "./Kbd.tsx";

// Keys that are not commands of the registry but work everywhere. Send and
// New line follow the owner's "Send with" setting (SEND_KEYS in keys.ts).
const fixed = (enterSends: boolean): [string, string, string][] => [
  ["Message box", "Send", SEND_KEYS(enterSends).send],
  ["Message box", "New line", SEND_KEYS(enterSends).newline],
  ["Message box", "Queue for after the turn", QUEUE_KEYS],
  ["Message box", "Commands", "/"],
  ["Message box", "Mention a file", "@"],
];

export function ShortcutList() {
  useSyncExternalStore(onCommands, commandsVersion);
  const enterSends = useUI((s) => s.enterSends);
  const rows: [string, string, string][] = [
    ...allCommands().filter((c) => c.keys).map((c) => [c.group ?? "General", c.label, c.keys!] as [string, string, string]),
    ...fixed(enterSends),
  ];
  const groups = [...new Set(rows.map((r) => r[0]))];
  return (
    <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      {groups.map((g) => (
        <section key={g}>
          <h3 className="mb-1.5 text-caption font-medium text-faint">{g}</h3>
          {rows.filter((r) => r[0] === g).map(([, label, keys]) => (
            <div key={label} data-testid="shortcut-row" className="flex min-h-8 items-center justify-between gap-4 border-b border-line/70 py-1 text-ui last:border-0">
              <span className="min-w-0">{label}</span>
              <Kbd keys={keys} className="shrink-0" />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function ShortcutSheet() {
  const open = useUI((s) => s.shortcuts);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => setUI({ shortcuts: o })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="shortcuts"
          data-float
          className="k-surface fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-3rem)] w-[min(46rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 transition-[opacity,scale] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
        >
          <div className="k-surface-head">
            <Keyboard className="k-surface-icon" />
            <Dialog.Title className="k-surface-title">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close aria-label="Close" className="k-surface-close">
              <X />
            </Dialog.Close>
          </div>
          <div className="k-scroll-more min-h-0 flex-1 px-6 pt-5 pb-6" data-testid="shortcuts-body">
            <ShortcutList />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
