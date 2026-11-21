import { Menu } from "@base-ui/react/menu";
import { ClipboardPaste, Copy, ExternalLink, Link2, Scissors, TextSelect } from "lucide-react";
import { useEffect, useState } from "react";
import { copyOrSay } from "../lib/copy.ts";
import { inShell } from "../lib/shell.ts";
import { reportError } from "../lib/store.ts";
import { itemClass, popupClass } from "./ui.tsx";

// The right-click menu inside a desktop webview, where the toolkit would draw
// its own (Back, Reload, Inspect Element). Text fields get cut, copy, paste and
// select all; a selection gets copy; a link gets copy and open. Anywhere else
// there is nothing to offer and no menu opens. A browser tab keeps its own menu.
type Field = HTMLInputElement | HTMLTextAreaElement;
type At = { x: number; y: number; field?: Field; start?: number; end?: number; editable?: HTMLElement; range?: Range; picked: string; href?: string };

const isField = (el: Element | null): el is Field =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "file", "range", "color"].includes(el.type));

export function ContextMenuHost() {
  const [at, setAt] = useState<At | null>(null);
  useEffect(() => {
    if (!inShell) return;
    const on = (e: MouseEvent) => {
      // Shift keeps the webview's own menu at hand (Inspect Element).
      if (e.shiftKey) return;
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      const field = isField(target) ? target : undefined;
      const editable = !field ? (target?.closest('[contenteditable=""], [contenteditable="true"]') as HTMLElement | null) ?? undefined : undefined;
      const sel = getSelection();
      const picked = field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : sel?.toString() ?? "";
      const href = target?.closest("a[href]")?.getAttribute("href") ?? undefined;
      if (!field && !editable && !picked && !href) return setAt(null);
      setAt({ x: e.clientX, y: e.clientY, field, start: field?.selectionStart ?? undefined, end: field?.selectionEnd ?? undefined, editable, range: sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : undefined, picked, href });
    };
    document.addEventListener("contextmenu", on);
    return () => document.removeEventListener("contextmenu", on);
  }, []);
  if (!at) return null;

  // The menu took the focus: put it and the selection back, then act on them.
  const back = () => {
    if (at.field) { at.field.focus(); if (at.start !== undefined) at.field.setSelectionRange(at.start, at.end ?? at.start); }
    else if (at.range) { at.editable?.focus(); const s = getSelection(); s?.removeAllRanges(); s?.addRange(at.range); }
  };
  const run = (fn: () => unknown) => () => { setAt(null); requestAnimationFrame(() => { back(); Promise.resolve().then(fn).catch((err) => reportError(err, { at: "context menu" })); }); };
  // Through the shared copy: it works on a page with no async clipboard, and a failure is said.
  const copy = () => copyOrSay(at.picked);
  const cut = async () => { if (await copy()) document.execCommand("delete"); };
  const paste = async () => { const text = await navigator.clipboard.readText(); if (text) document.execCommand("insertText", false, text); };
  const all = () => (at.field ? at.field.select() : document.execCommand("selectAll"));
  const writes = !!(at.field || at.editable) && !at.field?.readOnly && !at.field?.disabled;
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) };

  return (
    <Menu.Root open onOpenChange={(o) => !o && setAt(null)} modal={false}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={2} className="z-[80] outline-none">
          <Menu.Popup className={`${popupClass} min-w-44`} data-testid="context-menu">
            {at.href && <Menu.Item className={itemClass} onClick={run(() => window.open(new URL(at.href!, location.href).href, "_blank", "noopener"))}><ExternalLink />Open link</Menu.Item>}
            {at.href && <Menu.Item className={itemClass} onClick={run(() => copyOrSay(new URL(at.href!, location.href).href))}><Link2 />Copy link</Menu.Item>}
            {writes && <Menu.Item className={itemClass} disabled={!at.picked} onClick={run(cut)}><Scissors />Cut</Menu.Item>}
            {(at.picked || writes) && <Menu.Item className={itemClass} disabled={!at.picked} onClick={run(copy)}><Copy />Copy</Menu.Item>}
            {writes && <Menu.Item className={itemClass} onClick={run(paste)}><ClipboardPaste />Paste</Menu.Item>}
            {(at.field || at.editable) && <Menu.Item className={itemClass} onClick={run(all)}><TextSelect />Select all</Menu.Item>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
