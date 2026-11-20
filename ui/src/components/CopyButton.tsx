// The one copy button: the raw text (markdown as written, a command, an
// output, a path), a clear Copied state, and a failure reported, never lost.
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyText } from "../lib/copy.ts";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

export function CopyButton({ text, label = "Copy", testid = "copy", className }: { text: string | (() => string); label?: string; testid?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => copyText(typeof text === "function" ? text() : text).then(
    () => { setDone(true); setTimeout(() => setDone(false), 1400); },
    (err) => reportError(err, { kind: "clipboard" }),
  );
  return (
    <button
      type="button"
      title={done ? "Copied" : label}
      aria-label={done ? "Copied" : label}
      data-testid={testid}
      data-copied={done || undefined}
      onClick={(e) => { e.stopPropagation(); void copy(); }}
      className={cn("k-copy", className)}
    >
      {done ? <Check /> : <Copy />}
      <span className="sr-only" aria-live="polite">{done ? "Copied" : ""}</span>
    </button>
  );
}

// A block with its copy button in the corner: shown on hover or focus, always on touch.
export function Copyable({ text, label, testid, className, children }: { text: string | (() => string); label?: string; testid?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("k-copyable", className)}>
      {children}
      <CopyButton text={text} label={label} testid={testid} className="k-copy-corner" />
    </div>
  );
}
