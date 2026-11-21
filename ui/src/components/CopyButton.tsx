// The one copy button: the raw text (markdown as written, a command, an
// output, a path), a clear Copied state, and a failure that is said (the
// button turns to "Copy failed", in view and to assistive technology) and
// reported once, never shown as Copied.
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { announce } from "../lib/announce.ts";
import { COPY_FAILED, copyText } from "../lib/copy.ts";
import { reportError } from "../lib/store.ts";
import { tipNow } from "../lib/tips.ts";
import { cn } from "../lib/utils.ts";

export function CopyButton({ text, label = "Copy", testid = "copy", className }: { text: string | (() => string); label?: string; testid?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (s: "done" | "failed", ms: number) => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ms);
  };
  const copy = (button: Element) => copyText(typeof text === "function" ? text() : text).then(
    () => { show("done", 1400); announce("Copied"); },
    (err) => {
      show("failed", 2600);
      tipNow(button, 2600);
      announce(`${COPY_FAILED}: the browser refused the clipboard.`, "alert");
      reportError(err, { kind: "clipboard" });
    },
  );
  const name = state === "done" ? "Copied" : state === "failed" ? COPY_FAILED : label;
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      data-testid={testid}
      data-copied={state === "done" || undefined}
      data-failed={state === "failed" || undefined}
      onClick={(e) => { e.stopPropagation(); void copy(e.currentTarget); }}
      className={cn("k-copy", className)}
    >
      {state === "done" ? <Check /> : state === "failed" ? <X /> : <Copy />}
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
