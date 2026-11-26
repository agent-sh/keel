// What a page looks like on the owner's screen: the view it shows, its text size, its theme, its window
// size and what draws it. The page says it on its socket (op "look", ui/src/lib/look.ts) when it opens
// and when one of these changes; the daemon keeps the newest of each kind of client
// (src/server/looks.ts), so the pictures of a change (src/pictures/run.ts) and the e2e shots
// (test/e2e/shots.ts, KEEL_LOOK) can be taken as the owner sees the page. Only what a screenshot
// needs: no name of the machine, no user agent, no session. Pure.

export type LookView = "workbench" | "focus";
export type LookEngine = "webkit" | "qt" | "browser";
export type Look = {
  view: LookView;
  scale: number;          // the text scale (ui/src/lib/ui.ts SCALES)
  theme: "light" | "dark";
  width: number;          // the window's inner size, CSS pixels
  height: number;
  engine: LookEngine;     // the desktop app's web view, or a browser
  phone: boolean;         // the page's phone layout
};
// Kept with the time it was said.
export type KeptLook = Look & { kind: string; at_ms: number };

const ENGINES: readonly LookEngine[] = ["webkit", "qt", "browser"];

// A look as a page sent it, checked; undefined when it is not one.
export function readLook(v: unknown): Look | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const n = (x: unknown, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined);
  const view = o.view === "workbench" || o.view === "focus" ? o.view : undefined;
  const theme = o.theme === "light" || o.theme === "dark" ? o.theme : undefined;
  const engine = ENGINES.includes(o.engine as LookEngine) ? (o.engine as LookEngine) : undefined;
  const scale = n(o.scale, 0.5, 3), width = n(o.width, 100, 10_000), height = n(o.height, 100, 10_000);
  if (!view || !theme || !engine || scale === undefined || width === undefined || height === undefined) return undefined;
  return { view, scale: Math.round(scale * 100) / 100, theme, width: Math.round(width), height: Math.round(height), engine, phone: o.phone === true };
}

// The kind of client a look is of: the desktop app by its engine, a browser on a desk, a phone.
export const lookKind = (l: Look): string => (l.phone ? "phone" : l.engine === "browser" ? "browser" : `desktop-${l.engine}`);

// The owner's look: the newest of a desk (a phone has its own size in every pictures run), else the newest.
export function ownerLook(kept: readonly KeptLook[]): KeptLook | undefined {
  const newest = (xs: readonly KeptLook[]) => xs.reduce<KeptLook | undefined>((a, b) => (!a || b.at_ms > a.at_ms ? b : a), undefined);
  return newest(kept.filter((k) => !k.phone)) ?? newest(kept);
}

// How a picture at a look is named: its size, view and text scale, and its theme.
export const lookWord = (l: Pick<Look, "width" | "height" | "view" | "scale">) => `${l.width}x${l.height}-${l.view}-${l.scale}`;
