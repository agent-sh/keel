import { keyLabel } from "../lib/keys.ts";
import { cn } from "../lib/utils.ts";

// A shortcut: its keys as one quiet chord (styles.css, .k-keys), each key its own kbd.
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cn("k-keys pointer-coarse:hidden", className)}>
      {keyLabel(keys).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}
