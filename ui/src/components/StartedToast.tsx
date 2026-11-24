// A session started in the background, said at the top edge where the undo offer hangs: its name
// and a way to open it. It takes no room and does not take the keyboard from the start box.
import { dropStarted, useStarted } from "../lib/started.ts";
import { openPlaced } from "../lib/looks.ts";

export function StartedToast() {
  const s = useStarted();
  if (!s) return null;
  return (
    <div role="status" data-testid="started-toast" key={s.n}
      className="fixed left-1/2 top-0 z-50 flex min-h-9 max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-b-md border border-t-0 border-line-strong bg-raised py-1 pl-3 pr-1 text-caption shadow-2 animate-appear">
      <span className="min-w-0 flex-1 truncate" dir="auto" data-testid="started-words" title={s.title}>Started {s.title}</span>
      <button type="button" data-testid="started-open" tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { dropStarted(); openPlaced(s.id); }}
        className="inline-flex h-7 shrink-0 items-center rounded-sm px-2 font-medium text-accent-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        Open
      </button>
    </div>
  );
}
