import { Dialog } from "@base-ui/react/dialog";
import { Keyboard, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { commandsVersion, everyCommand, keyLabel, onCommands, BACKGROUND_KEYS, QUEUE_KEYS, SEND_KEYS } from "../lib/keys.ts";
import { shortcutLines, type ShortcutRow } from "../lib/shortcut-lines.ts";
import { setUI, useUI } from "../lib/ui.ts";
import { Kbd } from "./Kbd.tsx";

// Keys that are not commands of the registry but work everywhere. Send and
// New line follow the owner's "Send with" setting (SEND_KEYS in keys.ts).
const fixed = (enterSends: boolean): [string, string, string, string?][] => [
  // A card that waits above the message box (an approval, a question, a plan): its own keys.
  ["Answering", "From the card to its answers", "tab"],
  ["Answering", "Next answer of the card", "arrowdown"],
  ["Answering", "Previous answer of the card", "arrowup"],
  ["Answering", "Allow once, send the answer, approve the plan", "enter"],
  ["Answering", "Choose an option of a question (1 to 9)", "1"],
  ["Answering", "Deny an approval with a reason", "escape", "on its card"],
  // A row of the session list is one Tab stop: its actions are reached from it.
  ["Sessions", "Switch between the last six sessions (hold Alt, ` for the next)", "alt+`"],
  ["Sessions", "Up the switcher", "alt+shift+`"],
  // A browser tab keeps Ctrl Tab for its own tabs: it reaches the page in the desktop app.
  ["Sessions", "The same with Ctrl, Tab", "ctrl+tab", "in the desktop app"],
  ["Sessions", "To a list row's actions", "arrowright"],
  ["Sessions", "Back to the row", "arrowleft"],
  ["Message box", "Send", SEND_KEYS(enterSends).send],
  ["Message box", "New line", SEND_KEYS(enterSends).newline],
  ["Message box", "Queue for after the turn", QUEUE_KEYS],
  ["Start box", "Start in the background", BACKGROUND_KEYS],
  ["Message box", "Commands", "/"],
  ["Message box", "Mention a file", "@"],
  // An empty box has no caret to move: the page keys (and End) scroll the conversation from it (Composer.tsx).
  ["Message box", "Conversation up a page, from an empty box", "pageup"],
  ["Message box", "Conversation down a page, from an empty box", "pagedown"],
  // Before the reply starts or after the turn ends (lib/edit-last.ts); Enter sends it as a new version.
  ["Message box", "Edit the last prompt, from an empty box", "arrowup"],
  // Twice in a row, with no turn running (components/Composer.tsx); the same as /rewind.
  ["Message box", "Rewind to before a prompt, Escape twice in an empty box", "escape"],
];

export function ShortcutList() {
  useSyncExternalStore(onCommands, commandsVersion);
  const enterSends = useUI((s) => s.enterSends);
  const commands: ShortcutRow[] = everyCommand().filter((c) => c.keys).map((c) => ({ group: c.group ?? "General", label: c.label, keys: c.keys!, where: c.where }));
  const lines = shortcutLines(commands, fixed(enterSends).map(([group, label, keys, where]) => ({ group, label, keys, where })));
  const groups = [...new Set(lines.map((l) => l.group))];
  const said = (c: { label: string; where?: string }) => <>{c.label}{c.where && <span className="text-muted">, {c.where}</span>}</>;
  return (
    <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      {groups.map((g) => (
        <section key={g}>
          <h3 className="mb-1.5 k-label">{g}</h3>
          {lines.filter((l) => l.group === g).map((l) => l.cases.length === 1 ? (
            <div key={`${l.cases[0]!.label}\u0000${l.keys}`} data-testid="shortcut-row" data-keys={l.keys} className="flex min-h-8 items-center justify-between gap-4 border-b border-line/70 py-1 text-ui last:border-0">
              <span className="min-w-0">{said(l.cases[0]!)}</span>
              <Kbd keys={l.keys} className="shrink-0" />
            </div>
          ) : (
            // A key of several acts: the key once, what it does where under it, in the order it is asked.
            <div key={l.keys} data-testid="shortcut-row" data-keys={l.keys} className="flex min-h-8 items-start justify-between gap-4 border-b border-line/70 py-1.5 text-ui last:border-0">
              <ul className="grid min-w-0 gap-1" aria-label={`What ${keyLabel(l.keys).join(" ")} does`}>
                {l.cases.map((c) => <li key={`${c.label}\u0000${c.where ?? ""}`} data-testid="shortcut-case">{said(c)}</li>)}
              </ul>
              <Kbd keys={l.keys} className="mt-0.5 shrink-0" />
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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="shortcuts"
          data-float
 className="k-surface fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-3rem)] w-[min(46rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 transition-[opacity,scale] data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
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
