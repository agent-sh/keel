// The width a scroll bar takes on this page (styles.css: `scrollbar-width: thin`), measured once
// as the page starts and kept as --k-gutter on the root. A column that pads itself by the width
// of its conversation's scroll bar (SessionView's message box column) uses it until the
// conversation is drawn and measured: the cards above the message box then stand where they
// will stay from their first frame (an approval's Allow acts once it stood still).
export function measureGutter(): number {
  if (typeof document === "undefined" || !document.body) return 0;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;top:0;left:0;width:6.25rem;height:3rem;overflow-y:scroll;scrollbar-gutter:stable";
  document.body.append(probe);
  const w = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  document.documentElement.style.setProperty("--k-gutter", `${w}px`);
  return w;
}
measureGutter();
// (Again once the page's stylesheets are surely in: a measure made before them reads the browser's default bar.)
if (typeof window !== "undefined" && document.readyState !== "complete") addEventListener("load", () => void measureGutter(), { once: true });
