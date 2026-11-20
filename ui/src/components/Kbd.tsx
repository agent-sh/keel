import { keyLabel } from "../lib/keys.ts";
import { cn } from "../lib/utils.ts";

export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 pointer-coarse:hidden", className)}>
      {keyLabel(keys).map((k, i) => (
        <kbd key={i} className="inline-grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-xs border border-line bg-raised px-1 text-micro font-medium text-faint shadow-1">
          {k}
        </kbd>
      ))}
    </span>
  );
}
