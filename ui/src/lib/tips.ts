// Tooltips. A `title` attribute is drawn by the browser or, in a desktop
// webview, by the toolkit; neither follows the theme. While the pointer or the
// keyboard is on an element, its title moves to data-tip and one styled tip
// shows it; the title is put back when the pointer leaves, so the markup (and
// what a screen reader reads) stays as written.
let tip: HTMLDivElement | null = null;
let host: Element | null = null;
let timer = 0;
let watch: MutationObserver | null = null;
// A tip shown by tipNow stays through a scroll (it follows its control): the
// transcript scrolls by itself while a reply is written.
let pinned = false;

function place() {
  if (!tip || !host) return;
  const r = host.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 6;
  const below = r.bottom + gap + t.height <= innerHeight - 4;
  const top = below ? r.bottom + gap : Math.max(4, r.top - gap - t.height);
  const left = Math.min(Math.max(4, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 4);
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function take(el: Element): string {
  const text = el.getAttribute("title");
  if (text) { el.setAttribute("data-tip", text); el.removeAttribute("title"); }
  return el.getAttribute("data-tip") ?? "";
}

function show(el: Element, delay: number) {
  if (host === el) return;
  hide();
  host = el;
  const text = take(el);
  // A title the app sets while the tip is up (a counter, a state) moves over too.
  watch = new MutationObserver(() => { if (el.hasAttribute("title")) { const t = take(el); if (tip) { tip.textContent = t; place(); } } });
  watch.observe(el, { attributes: true, attributeFilter: ["title"] });
  if (!text.trim()) return;
  timer = window.setTimeout(() => {
    if (host !== el || !el.isConnected) return;
    tip ??= Object.assign(document.createElement("div"), { className: "k-tip" });
    tip.setAttribute("role", "tooltip");
    tip.textContent = el.getAttribute("data-tip");
    document.body.append(tip);
    place();
    tip.dataset.open = "";
  }, delay);
}

function hide() {
  clearTimeout(timer);
  watch?.disconnect();
  watch = null;
  if (host) {
    const text = host.getAttribute("data-tip");
    if (text !== null && !host.hasAttribute("title")) host.setAttribute("title", text);
    host.removeAttribute("data-tip");
  }
  host = null;
  pinned = false;
  if (tip) { delete tip.dataset.open; tip.remove(); }
}

// A control whose state changed under the hand that used it (a copy that
// failed) says so at once, in words, on touch too, and for `ms` only.
export function tipNow(el: Element, ms: number) {
  hide();
  show(el, 0);
  pinned = true;
  setTimeout(() => { if (host === el && pinned) hide(); }, ms);
}

const titled = (t: EventTarget | null) => (t instanceof Element ? t.closest("[title], [data-tip]") : null);

// Touch has no hover: a long press there keeps what the browser does.
if (matchMedia("(hover: hover)").matches) {
  document.addEventListener("mouseover", (e) => { const el = titled(e.target); if (el) show(el, 450); else hide(); }, true);
  document.addEventListener("mouseleave", hide);
  document.addEventListener("focusin", (e) => { const el = titled(e.target); if (el && el === e.target && el.matches(":focus-visible")) show(el, 150); });
  document.addEventListener("focusout", hide);
  for (const ev of ["mousedown", "keydown", "wheel", "scroll"] as const) window.addEventListener(ev, () => { if (pinned && (ev === "scroll" || ev === "wheel")) place(); else if (tip?.isConnected) { clearTimeout(timer); delete tip.dataset.open; tip.remove(); } else clearTimeout(timer); }, { capture: true, passive: true });
}
