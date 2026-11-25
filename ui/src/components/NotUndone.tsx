// What a rewind does not take back: the calls of the turns it goes back over that reached past the files it
// restores (another machine or service, git, an MCP tool, a path outside the folder, a file the checkpoint
// never held). Read by the daemon from the calls the session stored (src/safety/not-undone.ts); no model is asked.
// Shown in the rewind dialog's preview, in the Changes panel's revert and under each turn of its by-turn list.
import { cn } from "../lib/utils.ts";

export type NotUndone = { kind: string; line: string; turn: number; n: number; call: string; tool: string };

// What each kind is, in the owner's words: where the change stands that a restore of files leaves alone.
export const KIND_WORD: Record<string, string> = {
  remote: "Left this machine",
  git: "Git",
  mcp: "MCP tool",
  outside: "Outside the folder",
  ignored: "Not in the checkpoint",
  skipped: "Not in the checkpoint",
};

const SHOWN = 8;

export function NotUndoneList({ items, testid = "not-undone", className, bare }: { items: readonly NotUndone[]; testid?: string; className?: string; bare?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={cn(!bare && "rounded-lg border border-line bg-sunken px-3 py-2", className)} data-testid={testid}>
      {!bare && <p className="text-caption font-medium text-warn">Not taken back</p>}
      <ul className={cn("flex flex-col gap-1", !bare && "mt-1")}>
        {items.slice(0, SHOWN).map((i, k) => (
          <li key={`${i.call}:${k}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-caption sm:flex-nowrap" data-testid="not-undone-line" data-kind={i.kind}>
            <span className="shrink-0 text-micro text-muted sm:w-28">{KIND_WORD[i.kind] ?? i.kind}</span>
            {i.n > 0 && <span className="ml-auto shrink-0 text-micro tabular-nums text-faint sm:order-last sm:ml-0">turn {i.n}</span>}
            <span className="line-clamp-2 min-w-0 basis-full break-all font-mono sm:basis-0 sm:flex-1" title={i.line}>{i.line}</span>
          </li>
        ))}
        {items.length > SHOWN && <li className="text-micro text-faint">and {items.length - SHOWN} more</li>}
      </ul>
    </div>
  );
}
