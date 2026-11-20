// Copying text. The async clipboard needs a secure page (https or localhost)
// and the permission; a page reached over plain http on a LAN or tailnet
// address has no navigator.clipboard at all. Then (or when it refuses) the
// text is copied through a hidden text field, the way browsers always allowed
// from a click. A copy that fails both ways throws: the caller reports it.
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
