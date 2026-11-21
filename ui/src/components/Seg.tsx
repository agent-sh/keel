// A choice of a few: the one control for a set of tabs, a segmented choice, a
// filter (on a track) and a list of choices with a line about each (rows),
// with one keyboard on every surface. It is one Tab stop, on the chosen
// option (the first when none is chosen). The arrow keys move to the next
// option and choose it, wrapping at the ends; Home and End choose the first
// and the last. Tabs lie in a row, so they take Left and Right; rows take Up
// and Down; a choice on a track takes both pairs, as a radio group does.
// Where choosing does something that must be meant (it loosens a
// permission, loads over the network, drops what was typed), the control is
// manual: the arrows, Home and End move the focus only and stop at the ends,
// and Space, Enter or a click chooses. A click on the option already chosen
// does nothing. A value set from
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

export function Seg<T extends string | number>({ value, options, onChange, label, kind = "choice", rows, manual, again, panel, fill, wrap, className, testid, title }: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  // What is being chosen, for a screen reader.
  label: string;
  // Tabs switch what is shown below them; a choice sets a value.
  kind?: "tabs" | "choice";
  // A list of rows, one under the other, instead of a track: each option brings its own look.
  rows?: boolean;
  // The arrows only move the focus; Space, Enter or a click chooses.
  manual?: boolean;
  // A click on the chosen option sets it again (the pane count, while only the helm shows).
  again?: boolean;
  // The id of the panel the tabs switch: each tab names it, and it names its tab with tabId().
  panel?: string;
  // The options share the track's width in equal parts.
  fill?: boolean;
  // Too many options for one line go on to the next instead of scrolling sideways (a filter with a count on each).
  wrap?: boolean;
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
    // Tabs lie in a row and rows stand in a column; a choice on a track is a radio group and takes both.
    const across = !rows, down = rows || !tabs;
    const step = (across && e.key === "ArrowRight") || (down && e.key === "ArrowDown") ? 1 : (across && e.key === "ArrowLeft") || (down && e.key === "ArrowUp") ? -1 : 0;
    const next = manual ? Math.min(open.length - 1, Math.max(0, from + step)) : (from + step + open.length) % open.length;
    const to = step ? open[next] : e.key === "Home" ? open[0] : e.key === "End" ? open[open.length - 1] : undefined;
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    button(to)?.focus();
    if (!manual && options[to]!.value !== value) onChange(options[to]!.value);
  };

  const tabs = kind === "tabs";
  return (
    <div ref={track} role={tabs ? "tablist" : "radiogroup"} aria-label={label} aria-orientation={rows ? "vertical" : tabs ? "horizontal" : undefined} title={title} data-testid={testid} data-fill={fill || undefined} data-wrap={wrap || undefined} className={cn(rows ? "flex flex-col" : "k-seg", className)} onKeyDown={keys}>
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
          onClick={() => { if (again || o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
