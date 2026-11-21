// Copying text. The async clipboard needs a secure page (https or localhost)
// and the permission; a page reached over plain http on a LAN or tailnet
// address has no navigator.clipboard at all. Then (or when it refuses) the
// text is copied through a hidden text field, the way browsers always allowed
// from a click. A copy that fails both ways throws: the caller reports it.
import { announce } from "./announce.ts";
import { reportError } from "./store.ts";
import { tipSay } from "./tips.ts";

export const COPY_FAILED = "Copy failed";
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { return await navigator.clipboard.writeText(text); } catch { /* the field below */ }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const back = document.activeElement as HTMLElement | null;
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } finally { field.remove(); back?.focus?.({ preventScroll: true }); }
  if (!ok) throw new Error("The browser refused to copy to the clipboard");
}

// A copy from a control with no failed state of its own (a link button, a
// menu item, a row's tool) or from a command with no control at all. True
// when the text is on the clipboard, so the caller shows its Copied. A
// failure, getting the text included, is shown and said here, once: the
// words at the control that was used (under the top of the page when none is
// left), the same to assistive technology, and one record.
export async function copyOrSay(text: string | (() => string | Promise<string>), at?: Element | null): Promise<boolean> {
  const failed = (err: unknown, why: string) => {
    tipSay(at, COPY_FAILED, 2600);
    announce(`${COPY_FAILED}: ${why}`, "alert");
    reportError(err, { kind: "clipboard" });
    return false;
  };
  let value: string;
  try { value = typeof text === "function" ? await text() : text; } catch (err) { return failed(err, err instanceof Error ? err.message : String(err)); }
  try { await copyText(value); } catch (err) { return failed(err, "the browser refused the clipboard."); }
  return true;
}
