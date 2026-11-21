import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
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
            <div key={label} className="flex h-8 items-center justify-between gap-4 border-b border-line/70 text-ui last:border-0">
              <span>{label}</span>
              <Kbd keys={keys} />
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
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(46rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-raised p-6 shadow-3 transition-[opacity,scale] duration-150 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <div className="mb-5 flex items-center">
            <Dialog.Title className="text-[1.1562rem] font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close aria-label="Close" className="ml-auto grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <ShortcutList />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
