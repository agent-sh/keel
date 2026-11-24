import { choose, select, useSwitcher } from "../lib/switcher.ts";
import { useSessionStates } from "../lib/watch.ts";
import { useStore } from "../lib/store.ts";
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { cn, folderNames } from "../lib/utils.ts";
import { Kbd } from "./Kbd.tsx";
import { Mark } from "./Mark.tsx";

// The sessions this page showed last, most recent first, with their state marks (lib/switcher.ts). It takes no
// focus: the keys are the page's own while Ctrl is held, and the message box keeps the caret.
export function Switcher() {
  const s = useSwitcher();
  const sessions = useStore((x) => x.sessions);
  const list = (s?.ids ?? []).map((id) => sessions[id]).filter((x): x is NonNullable<typeof x> => !!x);
  const states = useSessionStates(list);
  if (!s) return null;
  const shown = new Set(list.map((x) => x.id));
  const folders = folderNames(list.map((x) => x.workspace));
  return (
    <div className="fixed left-1/2 top-[14vh] z-50 w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-raised shadow-3" role="dialog" aria-label="Recent sessions" data-testid="switcher">
      <ul role="listbox" aria-label="Recent sessions, most recent first" className="m-0 flex list-none flex-col gap-0.5 p-1.5" aria-activedescendant={`switch-${s.ids[s.at]}`}>
        {s.ids.map((id, i) => ({ id, i })).filter((x) => shown.has(x.id)).map(({ id, i }) => {
          const x = sessions[id]!;
          const w = states[id]?.watch ?? "idle";
          return (
            <li key={id} id={`switch-${id}`} role="option" aria-selected={i === s.at} data-testid="switcher-row" data-session={id} data-selected={i === s.at || undefined}
              onMouseEnter={() => select(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}
              className={cn("flex h-9 min-w-0 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-ui text-muted", i === s.at && "bg-hover text-fg")}>
              <Mark w={w} />
              <span className="min-w-0 flex-1 truncate" data-testid="switcher-title">{x.title || "New session"}</span>
              {folders.size > 1 && <span className="max-w-[30%] shrink-0 truncate text-micro text-faint">{folders.get(x.workspace) ?? ""}</span>}
              <span className="shrink-0 text-micro text-faint" data-testid="switcher-state">{STATE_WORD[w]}</span>
            </li>
          );
        })}
      </ul>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line px-3 py-1.5 text-micro text-faint">
        {s.hold === "Alt" ? (<>
          <span className="flex items-center gap-1"><Kbd keys="alt+`" /> next</span>
          <span className="flex items-center gap-1"><Kbd keys="alt+shift+`" /> back</span>
        </>) : s.hold === "Control" ? (<>
          <span className="flex items-center gap-1"><Kbd keys="ctrl+tab" /> next</span>
          <span className="flex items-center gap-1"><Kbd keys="ctrl+shift+tab" /> back</span>
        </>) : (<>
          <span className="flex items-center gap-1"><Kbd keys="arrowdown" /> <Kbd keys="arrowup" /> move</span>
          <span className="flex items-center gap-1"><Kbd keys="enter" /> open</span>
        </>)}
        <span className="flex items-center gap-1"><Kbd keys="escape" /> cancel</span>
      </p>
    </div>
  );
}
