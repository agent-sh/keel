// Point: the page as a picker. The owner clicks an element and the message box gets what it is:
// its test ids, the component and file it comes from, its tokens, its size, and a picture of it.
// This module is loaded at the first use, with the table of where test ids and classes are written
// (lib/point-table.macro.ts, made when the page is bundled).
//
// While picking, a clear sheet lies over the page: nothing under the pointer is lit by it, so an
// element is read and pictured as it rests. The sheet takes every press; Escape leaves.
import { pointTableText } from "./point-table.macro.ts" with { type: "macro" };
import type { PointTable } from "./point-table.macro.ts";
import { faces, instrument } from "./fonts.ts";
import { MAX_EDGE } from "./images.ts";
import { shell } from "./shell.ts";
import type { Point } from "./point-note.ts";

const TABLE = JSON.parse(pointTableText()) as PointTable;
// Past this many elements a picture is not made: the element is a whole view, and its name says which.
const PICTURE_MAX = 2500;

type Where = { file: string; line: number; component: string };
let exact: Map<string, Where[]> | null = null;
const patterns: [RegExp, Where][] = [];
function index() {
  if (exact) return exact;
  exact = new Map();
  for (const [file, f] of Object.entries(TABLE.files)) {
    for (const [id, line] of f.t) {
      const component = f.c.filter(([at]) => at <= line).at(-1)?.[1] ?? "";
      const w = { file: `ui/src/${file}`, line, component };
      if (id.includes("*")) patterns.push([new RegExp(`^${id.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`), w]);
      else exact.set(id, [...(exact.get(id) ?? []), w]);
    }
  }
  return exact;
}
// Where a test id is written: each place when the same id is written in several.
export function sourceOf(id: string): Where[] {
  const hit = index().get(id);
  if (hit) return hit;
  return patterns.filter(([re]) => re.test(id)).map(([, w]) => w);
}

const OURS = "k-point";
const ours = (el: Element) => typeof el.className === "string" && el.className.startsWith(OURS);
const testid = (el: Element) => el.getAttribute("data-testid") || "";

// The element under a point of the window: the topmost one that is drawn (one with no ink of its own,
// shown only under the pointer, is not there for a press). Inside an icon, the icon.
export function under(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (ours(el) || el === document.documentElement || el === document.body) continue;
    let seen = true;
    for (let a: Element | null = el; a && seen; a = a.parentElement) if (getComputedStyle(a).opacity === "0") seen = false;
    if (!seen) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    return el instanceof SVGElement && el.ownerSVGElement ? el.ownerSVGElement : el;
  }
  return null;
}

// An icon that is all a control shows is the control: a press on it means the button. (Down goes to the icon.)
export function meant(el: Element): Element {
  if (!(el instanceof SVGElement) && !(el instanceof HTMLImageElement)) return el;
  const control = el.closest('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]');
  return control && !(control.textContent ?? "").trim() ? control : el;
}

// The element's short name: its test id, else the nearest one above it and what it is under that.
const plain = (el: Element) => {
  const k = [...el.classList].find((c) => c.startsWith("k-"));
  return el.tagName.toLowerCase() + (k ? `.${k}` : "");
};
export function nameOf(el: Element): string {
  const own = testid(el);
  if (own) return own;
  const up = el.parentElement?.closest("[data-testid]");
  return up ? `${testid(up)} > ${plain(el)}` : plain(el);
}

// The theme's tokens as the page has them now: each colour's computed form, each type step in px.
type Tokens = { colors: [string, string][]; sizes: [string, number][] };
function tokens(): Tokens {
  const names: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule && /(^|,)\s*(:root|html|\.dark)(?![\w-])/.test(r.selectorText)) for (const p of r.style) if (p.startsWith("--") && !names.includes(p)) names.push(p);
      const inner = (r as CSSGroupingRule).cssRules;
      if (inner?.length) walk(inner);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* another origin's sheet */ } }
  // (The page's own tokens before the stylesheet toolkit's.)
  names.sort((a, b) => Number(/^--(color|tw)-/.test(a)) - Number(/^--(color|tw)-/.test(b)));
  const root = getComputedStyle(document.documentElement), rem = parseFloat(root.fontSize);
  const probe = document.createElement("span");
  probe.className = `${OURS}-probe`;
  document.body.append(probe);
  const out: Tokens = { colors: [], sizes: [] };
  for (const n of names) {
    const v = root.getPropertyValue(n).trim();
    if (!v) continue;
    // (The page's own type steps: the stylesheet toolkit's sizes, xs to 9xl, are not its scale.)
    if (/^--text-[a-z]+$/.test(n) && !/^--text-(xs|sm|lg|xl)$/.test(n) && /^[\d.]+(rem|px)$/.test(v)) out.sizes.push([n, parseFloat(v) * (v.endsWith("rem") ? rem : 1)]);
    else if (!/^[\d.-]/.test(v) && CSS.supports("color", v)) { probe.style.color = v; out.colors.push([n, getComputedStyle(probe).color]); }
  }
  probe.remove();
  return out;
}
const clear = (c: string) => c === "transparent" || /^rgba?\(0, 0, 0, 0\)$/.test(c) || /\/ 0\)$/.test(c);
function colorName(t: Tokens, value: string): string {
  // (A stylesheet toolkit's alias of a token is not another name for it.)
  const all = t.colors.filter(([, v]) => v === value).map(([n]) => n), own = all.filter((n) => !/^--(color|tw)-/.test(n));
  const same = own.length ? own : all;
  if (!same.length) return value;
  return same.length === 1 ? same[0]! : `${same[0]} (also ${same.length > 3 ? `${same[1]} and ${same.length - 2} more` : same.slice(1).join(", ")})`;
}
const px = (n: number) => `${Math.round(n * 10) / 10}`;

// What the element is, as the lines of its note.
export function describe(el: Element): Pick<Point, "name" | "facts"> {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect(), t = tokens();
  const facts: [string, string][] = [];
  const chain: string[] = [];
  for (let a: Element | null = el; a; a = a.parentElement) if (testid(a)) chain.unshift(testid(a));
  if (!testid(el)) chain.push(plain(el));
  facts.push(["where", chain.slice(-6).join(" > ")]);
  const attrs = ["role", "aria-label", "title", "placeholder", "type", "data-state", "aria-current", "aria-pressed", "aria-expanded"].flatMap((a) => (el.hasAttribute(a) ? [` ${a}="${(el.getAttribute(a) ?? "").slice(0, 80)}"`] : []));
  const cls = (typeof el.className === "string" ? el.className : el.getAttribute("class") ?? "").trim().replace(/\s+/g, " ");
  const words = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  facts.push(["element", `<${el.tagName.toLowerCase()}${cls ? ` class="${cls.length > 220 ? `${cls.slice(0, 220)}...` : cls}"` : ""}${attrs.join("")}>${words ? ` saying "${words.length > 90 ? `${words.slice(0, 90)}...` : words}"` : ""}`]);
  // The nearest test id the source writes: the element's own, else the first above it.
  for (let a: Element | null = el; a; a = a.parentElement) {
    const id = testid(a), at = id ? sourceOf(id) : [];
    if (!at.length) continue;
    facts.push(["source", `${at.slice(0, 3).map((w) => `${w.file}:${w.line}${w.component ? ` (${w.component})` : ""}`).join(", ")}${a === el ? "" : `, where ${id} is written`}`]);
    break;
  }
  const rules = [...el.classList].flatMap((c) => (TABLE.css[c] ? [`.${c} at ui/src/${TABLE.css[c]![0]}:${TABLE.css[c]![1]}`] : []));
  if (rules.length) facts.push(["class", rules.slice(0, 4).join(", ")]);
  facts.push(["box", `${px(r.width)} x ${px(r.height)} px at ${Math.round(r.left)}, ${Math.round(r.top)}`]);
  const size = parseFloat(cs.fontSize), steps = t.sizes.filter(([, v]) => Math.abs(v - size) < 0.05).map(([n]) => n);
  facts.push(["type", `${px(size)}px${cs.lineHeight.endsWith("px") ? ` on ${px(parseFloat(cs.lineHeight))}px lines` : ""}, weight ${cs.fontWeight}${steps.length ? `, ${steps.join(" / ")}` : ""}, ${cs.fontFamily.split(",")[0]!.replace(/"/g, "")}`]);
  facts.push(["color", `${colorName(t, cs.color)}${cs.opacity !== "1" ? `, opacity ${cs.opacity}` : ""}`]);
  let ground = "";
  if (!clear(cs.backgroundColor)) ground = colorName(t, cs.backgroundColor);
  else for (let a = el.parentElement; a; a = a.parentElement) {
    const c = getComputedStyle(a).backgroundColor;
    if (!clear(c)) { ground = `none of its own, over ${colorName(t, c)}`; break; }
  }
  if (cs.backgroundImage !== "none") ground += `${ground ? ", " : ""}with an image or a gradient`;
  if (ground) facts.push(["ground", ground]);
  const sides = (["Top", "Right", "Bottom", "Left"] as const).flatMap((s) => {
    const w = parseFloat(cs[`border${s}Width`]);
    return w > 0 && cs[`border${s}Style`] !== "none" ? [`${s.toLowerCase()} ${px(w)}px ${colorName(t, cs[`border${s}Color`])}`] : [];
  });
  const all = sides.length === 4 && new Set(sides.map((s) => s.replace(/^\w+ /, ""))).size === 1;
  const corner = parseFloat(cs.borderTopLeftRadius) > 0 ? `corner ${px(parseFloat(cs.borderTopLeftRadius))}px` : "";
  const edge = [all ? sides[0]!.replace(/^\w+ /, "") : sides.join(", "), corner, cs.boxShadow !== "none" ? "a shadow" : ""].filter(Boolean).join("; ");
  if (edge) facts.push(["edge", edge]);
  const scale = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim() || "1";
  const path = location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, ":id");
  facts.push(["page", `${path}, ${document.documentElement.classList.contains("dark") ? "dark" : "light"} theme, window ${innerWidth} x ${innerHeight}, text scale ${scale}, ${shell ? "the desktop app" : "a browser tab"}, at rest (no pointer over it)`]);
  return { name: nameOf(el), facts };
}

// ---- The picture: the element drawn again from its computed styles, with no stylesheet.

// A property a child takes from its parent when it has none of its own: one equal to the parent's is not written.
const INHERITED = new Set(["color", "cursor", "direction", "font-family", "font-feature-settings", "font-kerning", "font-optical-sizing", "font-size", "font-stretch", "font-style", "font-variant-caps", "font-variant-ligatures", "font-variant-numeric", "font-variation-settings", "font-weight", "letter-spacing", "line-height", "list-style-type", "overflow-wrap", "pointer-events", "tab-size", "text-align", "text-indent", "text-rendering", "text-transform", "text-wrap-mode", "text-wrap-style", "visibility", "white-space-collapse", "word-break", "word-spacing", "-webkit-font-smoothing", "-webkit-text-fill-color", "-webkit-text-stroke-color", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "caret-color", "text-shadow", "user-select", "writing-mode", "quotes", "border-collapse", "text-anchor", "fill-opacity", "stroke-opacity", "color-scheme", "font-synthesis-weight", "font-synthesis-style", "font-palette", "hyphens", "line-break", "text-underline-position", "text-decoration-skip-ink", "accent-color"]);
const STILL = /^(transition|animation|scroll-|view-|will-change|contain|content-visibility|interactivity|cursor)/;
const WIDTHS = /^(border|outline|column-rule).*-width$/;
const SVG = "http://www.w3.org/2000/svg";

// The declarations an element needs to look the same with no stylesheet: what differs from the bare element of its
// kind (`base`), and of what a child takes from its parent, what differs from the parent's. A kind the browser gives
// a value of its own (a button's font) does not take its parent's: `plain` is the bare element that has none.
function styles(cs: CSSStyleDeclaration, base: Map<string, string>, plain: Map<string, string>, parent: CSSStyleDeclaration | null): string {
  let out = "";
  for (const p of cs) {
    if (p.startsWith("--") || STILL.test(p)) continue;
    const v = cs.getPropertyValue(p);
    const taken = !!parent && INHERITED.has(p) && base.get(p) === plain.get(p);
    // (A line's width reads 0 while its style is none: the bare element's 0 is not what a line that is drawn would get.)
    if (v === (taken ? parent.getPropertyValue(p) : base.get(p)) && !WIDTHS.test(p)) continue;
    out += `${p}:${v};`;
  }
  return out;
}

async function dataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.onerror = () => fail(r.error); r.readAsDataURL(blob); });
}

export async function picture(el: Element): Promise<Blob | null> {
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1 || el.querySelectorAll("*").length > PICTURE_MAX) return null;
  // What each kind of element looks like with no style at all: read in an empty frame, where the page's
  // stylesheets do not reach and nothing is inherited. The picture has no stylesheet either.
  const frame = document.createElement("iframe");
  frame.className = `${OURS}-probe`;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  document.body.append(frame);
  const blank = frame.contentDocument, view = frame.contentWindow;
  if (!blank || !view) { frame.remove(); return null; }
  const bench = blank.createElement("div");
  bench.style.all = "initial";
  const benchSvg = blank.createElementNS(SVG, "svg");
  blank.body.append(bench);
  bench.append(benchSvg);
  const bases = new Map<string, Map<string, string>>();
  const baseOf = (src: Element): Map<string, string> => {
    const svg = src.namespaceURI === SVG, key = `${svg ? "svg:" : ""}${src.tagName}`;
    let b = bases.get(key);
    if (b) return b;
    const one = svg ? blank.createElementNS(SVG, src.tagName) : blank.createElement(src.tagName);
    (svg && src.tagName.toLowerCase() !== "svg" ? benchSvg : bench).append(one);
    const cs = view.getComputedStyle(one);
    b = new Map();
    for (const p of cs) b.set(p, cs.getPropertyValue(p));
    one.remove();
    bases.set(key, b);
    return b;
  };
  const plain = baseOf(blank.createElement("span"));
  const families = new Set<string>();
  let wide = false, rules = "", n = 0;
  const waits: Promise<unknown>[] = [];
  const copy = (src: Element, parent: CSSStyleDeclaration | null): Element | null => {
    const cs = getComputedStyle(src);
    if (cs.display === "none" || /^(SCRIPT|STYLE|LINK|TEMPLATE|IFRAME|VIDEO|AUDIO|OBJECT)$/.test(src.tagName)) return null;
    const c = src instanceof HTMLCanvasElement ? document.createElement("img") : (src.cloneNode(false) as Element);
    for (const a of [...c.attributes]) if (a.name === "class" || a.name === "id" || a.name === "style" || a.name.startsWith("on") || a.name.startsWith("data-") || a.name === "srcset" || a.name === "loading") c.removeAttribute(a.name);
    let style = styles(cs, baseOf(src), plain, parent);
    if (!parent) {
      // The element itself stands alone: where it was in its parent's layout is not its picture's.
      style += `box-sizing:border-box;width:${rect.width}px;height:${rect.height}px;margin:0;transform:none;float:none;inset:auto;flex:none;max-width:none;max-height:none;min-width:0;min-height:0;`;
      if (cs.position === "absolute" || cs.position === "fixed" || cs.position === "sticky") style += "position:relative;";
      if (cs.display === "inline") style += "display:inline-block;";
    }
    c.setAttribute("style", style);
    families.add(cs.fontFamily.split(",")[0]!.trim().replace(/^["']|["']$/g, ""));
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(src, pseudo);
      if (!ps.content || ps.content === "none" || ps.content === "normal") continue;
      const name = `p${++n}`;
      rules += `.${name}${pseudo}{${styles(ps, plain, plain, cs)}content:${ps.content};}`;
      c.classList.add(name);
    }
    if (src instanceof HTMLImageElement && src.currentSrc && !src.currentSrc.startsWith("data:")) waits.push(dataUrl(src.currentSrc).then((u) => c.setAttribute("src", u)).catch(() => c.removeAttribute("src")));
    else if (src instanceof HTMLCanvasElement) { try { c.setAttribute("src", src.toDataURL()); } catch { /* a canvas the page may not read */ } }
    else if (src instanceof HTMLInputElement) { if (src.type === "checkbox" || src.type === "radio") { if (src.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); } else c.setAttribute("value", src.value); }
    else if (src instanceof HTMLTextAreaElement) { c.textContent = src.value; return c; }
    for (const k of src.childNodes) {
      if (k.nodeType === Node.TEXT_NODE) { if (/[^\u0000-\u00ff]/.test(k.nodeValue ?? "")) wide = true; c.append(document.createTextNode((k.nodeValue ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ""))); }
      else if (k.nodeType === Node.ELEMENT_NODE) { const kid = copy(k as Element, cs); if (kid) c.append(kid); }
    }
    return c;
  };
  let root: Element | null;
  try { root = copy(el, null); } finally { frame.remove(); }
  if (!root) return null;
  await Promise.all(waits);
  // The families the element draws, as the files the page loaded them from (the text draws in them, or the lines wrap elsewhere).
  const fonts = await Promise.all([...faces, instrument].filter(([family, , range]) => families.has(family) && (wide || range.startsWith("U+0000"))).map(async ([family, url, range, weight]) =>
    `@font-face{font-family:"${family}";src:url(${await dataUrl(url)}) format("woff2");font-weight:${weight};${family === instrument[0] ? "font-stretch:75% 112.5%;" : ""}unicode-range:${range};}`).map((p) => p.catch(() => "")));
  // What the element lies on, when it has no ground of its own.
  let ground = "transparent";
  for (let a: Element | null = el; a; a = a.parentElement) {
    const c = getComputedStyle(a).backgroundColor;
    if (!clear(c)) { ground = c; break; }
  }
  const page = document.createElement("div");
  page.setAttribute("style", `all:initial;display:block;width:${rect.width}px;height:${rect.height}px;overflow:hidden;background:${ground};`);
  const sheet = document.createElement("style");
  sheet.textContent = fonts.join("") + rules;
  page.append(sheet, root);
  const scale = Math.min(MAX_EDGE / Math.max(rect.width, rect.height), Math.max(2, devicePixelRatio));
  const w = Math.max(1, Math.round(rect.width * scale)), h = Math.max(1, Math.round(rect.height * scale));
  // The drawing is at the element's own size and is made larger as it is put on the canvas: a drawing that
  // scales itself (a viewBox) leaves what has a layer of its own, an icon in a button, unscaled in WebKit.
  const svg = `<svg xmlns="${SVG}" width="${rect.width}" height="${rect.height}"><foreignObject x="0" y="0" width="${rect.width}" height="${rect.height}">${new XMLSerializer().serializeToString(page)}</foreignObject></svg>`;
  const img = new Image();
  await new Promise((done, fail) => { img.onload = done; img.onerror = () => fail(new Error("the picture did not load")); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return new Promise((done) => { try { canvas.toBlob((b) => done(b), "image/png"); } catch { done(null); } });
}

// ---- The picker.

export type Picked = { point: Pick<Point, "name" | "facts">; crop: File | null };
let picking: (() => void) | null = null;
// One picker at a time: asked again while it is open, it leaves.
export function pick(): Promise<Picked | null> {
  if (picking) { picking(); return Promise.resolve(null); }
  return new Promise((done) => {
    const sheet = document.createElement("div"), box = document.createElement("div"), tag = document.createElement("div"), hint = document.createElement("div");
    sheet.className = `${OURS}-sheet`;
    box.className = `${OURS}-box`;
    tag.className = `${OURS}-tag`;
    hint.className = `${OURS}-hint`;
    hint.setAttribute("role", "status");
    hint.dataset.testid = "point-hint";
    hint.textContent = "Click what you mean. Up takes what is around it, Esc leaves.";
    sheet.dataset.testid = "point-sheet";
    box.hidden = tag.hidden = true;
    document.body.append(sheet, box, tag, hint);
    let at: Element | null = null, frame = 0, last = { x: -1, y: -1 };
    const down: Element[] = [];
    const show = (el: Element | null) => {
      at = el;
      box.hidden = tag.hidden = !el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      const size = document.createElement("span");
      size.textContent = `${px(r.width)} x ${px(r.height)}`;
      tag.replaceChildren(nameOf(el), size);
      tag.dataset.name = nameOf(el);
      const th = tag.offsetHeight, tw = tag.offsetWidth;
      tag.style.left = `${Math.max(4, Math.min(r.left, innerWidth - tw - 4))}px`;
      tag.style.top = `${r.top - th - 6 >= 4 ? r.top - th - 6 : Math.min(r.bottom + 6, innerHeight - th - 4)}px`;
    };
    const look = () => {
      frame = 0;
      if (last.x < 0) return;
      const raw = under(last.x, last.y), el = raw && meant(raw);
      down.length = 0;
      if (raw && el !== raw) down.push(raw);
      show(el);
    };
    // (The page hears nothing of the pointer while it is a picker: a tip or a row's tools would answer it.)
    const move = (e: PointerEvent) => { e.stopImmediatePropagation(); last = { x: e.clientX, y: e.clientY }; frame ||= requestAnimationFrame(look); };
    const eat = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const leave = (got: Picked | null) => {
      picking = null;
      cancelAnimationFrame(frame);
      for (const [name, f] of taps) removeEventListener(name, f, true);
      sheet.remove(); box.remove(); tag.remove(); hint.remove();
      done(got);
    };
    // The element is read where it stands; a picture that cannot be made leaves the words.
    let taking = false;
    const take = async (el: Element) => {
      if (taking) return;
      taking = true;
      const point = describe(el);
      let crop: File | null = null;
      try {
        const blob = await picture(el);
        if (blob) crop = new File([blob], `${point.name.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "element"}.png`, { type: "image/png" });
      } catch { /* the words go without a picture */ }
      leave({ point, crop });
    };
    const click = (e: Event) => {
      eat(e);
      const m = e as MouseEvent;
      const raw = at ? null : under(m.clientX, m.clientY), el = at ?? (raw && meant(raw));
      if (el) void take(el);
    };
    const key = (e: Event) => {
      const k = e as KeyboardEvent;
      eat(e);
      if (taking) return;
      if (k.key === "Escape" || (k.altKey && k.code === "Period")) leave(null);
      else if (k.key === "ArrowUp" && at?.parentElement && at.parentElement !== document.body) { down.push(at); show(at.parentElement); }
      else if (k.key === "ArrowDown" && down.length) show(down.pop()!);
      else if (k.key === "Enter" && at && !k.repeat) void take(at);
    };
    // The wheel moves what is under the pointer, as it does with no sheet over it.
    const wheel = (e: Event) => {
      const w = e as WheelEvent;
      for (let a = under(w.clientX, w.clientY); a; a = a.parentElement) {
        const o = getComputedStyle(a).overflowY;
        if ((o === "auto" || o === "scroll") && a.scrollHeight > a.clientHeight + 1) { a.scrollBy({ top: w.deltaY, left: w.deltaX }); break; }
      }
      last = { x: w.clientX, y: w.clientY };
      frame ||= requestAnimationFrame(look);
    };
    const taps: [string, (e: Event) => void][] = [
      ["pointermove", move as (e: Event) => void], ["click", click], ["keydown", key], ["wheel", wheel],
      ...["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick", "touchstart", "touchend", "keyup", "keypress"].map((n) => [n, eat] as [string, (e: Event) => void]),
    ];
    for (const [name, f] of taps) addEventListener(name, f, { capture: true, passive: false });
    picking = () => leave(null);
  });
}
