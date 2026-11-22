// The last act that can be put back (lib/undo.ts), over the page at its lower
// left corner, where the list's foot is (on a phone a tab that hangs from the
// top edge): it takes no room of its own, so nothing being read moves when it
// comes or goes. Its button and its key do the same.
import { Undo2 } from "lucide-react";
import { runUndo, useUndo } from "../lib/undo.ts";
import { Kbd } from "./Kbd.tsx";

export function UndoToast() {
  const u = useUndo();
  if (!u) return null;
  return (
    <div role="status" data-testid="undo-toast" key={u.n}
      className="fixed bottom-3 left-3 z-50 flex h-9 max-w-[min(26rem,calc(100vw-1.5rem))] items-center gap-3 rounded-md border border-line-strong bg-raised pl-3 pr-1 text-caption shadow-2 animate-in max-md:top-0 max-md:bottom-auto max-md:left-1/2 max-md:-translate-x-1/2 max-md:rounded-t-none max-md:border-t-0">
      <span className="min-w-0 truncate" dir="auto" data-testid="undo-words">{u.words}</span>
      <button type="button" data-testid="undo" onClick={() => runUndo()}
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 font-medium text-accent-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        <Undo2 className="size-3.5" aria-hidden="true" />Undo<Kbd keys="mod+z" />
      </button>
    </div>
  );
}
