// The desktop shell (desktop/): the same page in a window of its own. The
// shell puts one small object on the window before the page's scripts run;
// a page in a browser tab has none, and nothing here changes for it. The page
// is never told by its user agent.
export type Shell = {
  name: string;
  version: string;
  engine: string;
  platform: string;
  // "main": the app's window. "session": one session in a window of its own.
  window: "main" | "session";
  can: { titlebar: boolean; windows: boolean; links: boolean; notifications: boolean; tray: boolean };
  // To the shell: { t: "look", ... }, { t: "window", path }, { t: "paste" }, { t: "start" }.
  post(message: unknown): void;
};

declare global {
  interface Window { keelShell?: Shell }
}

export const shell: Shell | undefined = typeof window === "undefined" ? undefined : window.keelShell;
// True inside a desktop shell's web view. There the toolkit would draw the
// right-click menu, so the page draws its own (components/ContextMenu.tsx);
// in a browser tab the browser's menu stays. A shell says so itself: Keel's
// with its object, another host with the marker it puts on the window.
export const inShell = !!shell || (typeof window !== "undefined" && "__electrobunWebviewId" in window);
if (inShell) document.documentElement.dataset.shell = shell?.window ?? "";
// One session in a window of its own: it shows that session alone and leaves the main window's layout as it is.
export const soloWindow = shell?.window === "session";

// The owner was brought to the page from outside it: the desktop app opened
// on a link, a second launch or its tray, or raised its window for one. Where
// the keyboard is then was not their choice, and a key already on its way
// (a Return meant for another window) must answer nothing. So for a while no
// card takes the keyboard on an answer by itself: it rests on the list of
// requests, as for an arrival that asked for "card" (lib/automation.ts).
export const BROUGHT_MS = 60_000;
let brought = -Infinity;
export const broughtHere = (now = Date.now()) => { brought = now; };
export const wasBrought = (now = Date.now()) => now - brought < BROUGHT_MS;

// A color of the page as the shell's toolkit reads it: #rrggbb, drawn through a canvas so any CSS color works.
export function hexOf(color: string, ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "clearRect" | "getImageData"> | null): string | undefined {
  if (!ctx || !color.trim()) return undefined;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = color.trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

// What the shell tells the page (a `keel-shell` event on the window):
//   open: a path to show, without a reload. `from: "click"` when the owner
//     clicked the notification of that very place; anything else (a link, a
//     second launch, the tray) brought them here without choosing where the
//     keyboard is.
//   daemon: "up" (join it now) or "away" (the title bar says so).
//   scale: the text size keys, which drive the page's own setting.
export type ShellTold = { open?: string; from?: string; daemon?: "up" | "away"; scale?: "up" | "down" | "reset" };

// A path the shell asked the page to show, as the parts the page acts on.
export function pathParts(path: string): { pathname: string; event: string | null; approval: string | null; inbox: boolean } {
  const u = new URL(path, "http://keel.invalid");
  return { pathname: u.pathname, event: u.searchParams.get("e"), approval: u.searchParams.get("approval"), inbox: u.searchParams.has("inbox") };
}
