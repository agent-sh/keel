// A choice of a few on one track: the one control for a set of tabs, a
// segmented choice and a filter, with one keyboard on every surface. The
// track is one Tab stop, on the chosen option (the first when none is
// chosen). The arrow keys move to the next option and choose it, wrapping at
// the ends; Home and End choose the first and the last. A value set from
// elsewhere (a command, a shortcut, another control) moves the Tab stop with
// it, and the focus too when the focus is inside the track. A track wider
// than its place scrolls sideways inside itself and keeps the chosen option
// in view. Its look is k-seg in styles.css.
import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export type SegOption<T> = {
  value: T;
  label: ReactNode;
  // The accessible name, when the label is not words (a glyph, a sample).
  name?: string;
  title?: string;
  testid?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
};

// The id of a tab, for the panel it shows to name it (aria-labelledby).
export const tabId = (panel: string, value: string | number) => `${panel}-tab-${value}`;

export function Seg<T extends string | number>({ value, options, onChange, label, kind = "choice", panel, fill, className, testid, title }: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  // What is being chosen, for a screen reader.
  label: string;
  // Tabs switch what is shown below them; a choice sets a value.
  kind?: "tabs" | "choice";
  // The id of the panel the tabs switch: each tab names it, and it names its tab with tabId().
  panel?: string;
  // The options share the track's width in equal parts.
  fill?: boolean;
  className?: string;
  testid?: string;
  title?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const at = options.findIndex((o) => o.value === value);
  // The one Tab stop: the chosen option, else the first that can be chosen.
  const stop = at >= 0 && !options[at]!.disabled ? at : options.findIndex((o) => !o.disabled);
  const button = (i: number) => track.current?.children[i] as HTMLElement | undefined;

  const first = useRef(true);
  useLayoutEffect(() => {
    const el = track.current, chosen = at >= 0 ? button(at) : undefined;
    if (!el || !chosen) return;
    // Set from elsewhere while the keyboard is in the track: the focus goes with the value.
    if (!first.current && el.contains(document.activeElement) && document.activeElement !== chosen) chosen.focus();
    first.current = false;
    if (el.scrollWidth <= el.clientWidth) return;
    const box = el.getBoundingClientRect(), c = chosen.getBoundingClientRect();
    if (c.left < box.left) el.scrollLeft -= box.left - c.left;
    else if (c.right > box.right) el.scrollLeft += c.right - box.right;
  }, [value, at]);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const open = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!open.length) return;
    const from = open.indexOf((e.target as HTMLElement).closest("[data-seg]") ? [...track.current!.children].indexOf((e.target as HTMLElement).closest("[data-seg]")!) : stop);
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? open[(from + 1) % open.length]
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? open[(from - 1 + open.length) % open.length]
      : e.key === "Home" ? open[0]
      : e.key === "End" ? open[open.length - 1]
      : undefined;
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    button(to)?.focus();
    if (options[to]!.value !== value) onChange(options[to]!.value);
  };

  const tabs = kind === "tabs";
  return (
    <div ref={track} role={tabs ? "tablist" : "radiogroup"} aria-label={label} title={title} data-testid={testid} data-fill={fill || undefined} className={cn("k-seg", className)} onKeyDown={keys}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          data-seg=""
          role={tabs ? "tab" : "radio"}
          {...(tabs ? { "aria-selected": i === at, ...(panel ? { id: tabId(panel, o.value), "aria-controls": panel } : {}) } : { "aria-checked": i === at })}
          aria-label={o.name}
          title={o.title}
          data-testid={o.testid}
          disabled={o.disabled}
          tabIndex={i === stop ? 0 : -1}
          className={o.className}
          style={o.style}
          // The option shown again still sets it (one pane while only the helm shows).
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
