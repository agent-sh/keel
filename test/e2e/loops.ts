import type { Page } from "@playwright/test";

// Every window error and uncaught exception of the page, with (for an observer loop) the elements whose size
// was changed after their observer last heard of it: the ones the browser did not deliver.
const watched = new WeakMap<Page, string[]>();
export async function watchWindowErrors(page: Page) {
  const had = watched.get(page);
  if (had) return had;
  const seen: string[] = [];
  watched.set(page, seen);
  await page.exposeFunction("__windowError", (m: string) => seen.push(m));
  await page.addInitScript(() => {
    const Real = window.ResizeObserver;
    const told = new Map<Element, string>();
    const marks = new Map<ResizeObserver, Set<Element>>();
    // The calls of the last moments: which observer's callback ran, and for what, so a loop names its writer.
    const ran: { at: number; src: string; targets: string }[] = [];
    const label = (el: Element) => el.nodeType !== 1 ? "#text" : `${el.tagName.toLowerCase()}${(el as HTMLElement).dataset?.testid ? `[${(el as HTMLElement).dataset.testid}]` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`;
    const box = (el: Element) => { const b = el.getBoundingClientRect(); return `${Math.round(b.width * 100)}x${Math.round(b.height * 100)}`; };
    // What an observer's call wrote to the page itself, in the call: the page must write a frame later (a write
    // here changes the size of what the observers watch, and the browser cannot tell them in the same pass).
    // Read at the end with `observerWrites`.
    const writes: string[] = [];
    (window as any).__observerWrites = writes;
    const changes = new MutationObserver(() => {});
    changes.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    window.ResizeObserver = class extends Real {
      constructor(cb: ResizeObserverCallback) {
        super((entries, o) => {
          for (const e of entries) told.set(e.target, `${Math.round(e.contentRect.width * 100)}x${Math.round(e.contentRect.height * 100)}`);
          ran.push({ at: performance.now(), src: cb.toString().replace(/\s+/g, " ").slice(0, 110), targets: entries.slice(0, 3).map((e) => label(e.target)).join(" | ") });
          if (ran.length > 40) ran.shift();
          changes.takeRecords();
          cb(entries, o);
          const made = changes.takeRecords().filter((r) => r.type !== "attributes" || (r.target as Element).isConnected);
          if (made.length) writes.push(`${cb.toString().replace(/\s+/g, " ").slice(0, 110)} wrote ${made.slice(0, 3).map((r) => `${r.type === "attributes" ? `@${r.attributeName}` : r.type} of ${label(r.target as Element)}`).join(", ")}`);
        });
        marks.set(this, new Set());
      }
      override observe(el: Element, options?: ResizeObserverOptions) { marks.get(this)!.add(el); super.observe(el, options); }
    } as typeof ResizeObserver;
    addEventListener("error", (e: ErrorEvent) => {
      let late = "";
      if (/ResizeObserver loop/.test(e.message)) {
        const out: string[] = [];
        for (const els of marks.values()) for (const el of els) if (el.isConnected && told.get(el) !== undefined && told.get(el) !== box(el)) out.push(label(el));
        const now = performance.now();
        late = ` (changed after it was told: ${[...new Set(out)].slice(0, 8).join(" | ") || "nothing found"}; callbacks just before: ${ran.filter((r) => now - r.at < 40).map((r) => `${r.src} on ${r.targets}`).join(" ;; ")})`;
      }
      (window as any).__windowError(`${e.message}${late}`);
    });
  });
  page.on("pageerror", (e) => seen.push(`uncaught: ${e.message}`));
  return seen;
}


// What observers' calls wrote to the page in the call (see the init script above), each once.
export const observerWrites = async (page: Page): Promise<string[]> => [...new Set(await page.evaluate(() => (window as any).__observerWrites as string[] ?? []))];
