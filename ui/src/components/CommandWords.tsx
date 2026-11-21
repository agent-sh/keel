// A command shown as it will run: its arguments in mono, in a sunken box. A
// line breaks between arguments, never inside a flag or a name (a browser
// would break "--scope" after its first dash); only an argument longer than
// the box breaks inside itself.
import { cn } from "../lib/utils.ts";

export function CommandWords({ words, className, testid }: { words: string[]; className?: string; testid?: string }) {
  return (
    <code data-testid={testid} className={cn("block font-mono text-caption text-fg", className)}>
      {words.map((w, i) => <span key={i} className="inline-block max-w-full whitespace-pre-wrap align-top [overflow-wrap:anywhere]">{w}{i < words.length - 1 ? " " : ""}</span>)}
    </code>
  );
}
