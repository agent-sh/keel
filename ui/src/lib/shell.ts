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
  // (`saving`: the app answers a file the page announces; one from before that keeps files by its own rule.
  //  `shortcuts`: the desktop has global shortcuts for apps, and the app can ask for its own.)
  can: { titlebar: boolean; windows: boolean; links: boolean; notifications: boolean; tray: boolean; saving?: boolean; shortcuts?: boolean };
  // To the shell: { t: "look", ... }, { t: "window", path }, { t: "start" }, and the
  // clipboard, which the page reaches only through the app there:
  // { t: "paste", id }, { t: "copying" }, { t: "copy", id, text };
  // { t: "can", paste, saving }: what this page does with the app (below), said as it loads;
  // { t: "paste-through" }: the paste the app handed over is the engine's to make;
  // { t: "saving", id, url }: a file the page is about to offer;
  // { t: "shortcuts" }: the owner asked for the app's global shortcuts (the desktop shows its dialog).
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
//   pasted, copied: the app's answers to a paste and a copy the page asked for, by number.
//   paste: the owner pressed the paste keys, which the app took from the engine (lib/paste-key.ts).
//   saving: the app's answer to a file the page announced: kept or not.
// (`failed`: the clipboard held a picture the app could not make ready.)
export type Pasted = { id: number; text?: string | null; images: { type: string; data: string }[]; refused?: boolean; failed?: boolean };
export type ShellTold = { open?: string; from?: string; daemon?: "up" | "away"; says?: string; scale?: "up" | "down" | "reset"; pasted?: Pasted; copied?: { id: number; ok: boolean }; saving?: { id: number; ok: boolean }; paste?: boolean; reloaded?: "stopped" };

// The clipboard in the app. The app's web view gives a page no clipboard of its own (no frame
// in it may read or write one), so the page asks the app, which answers only at the owner's own
// key or press:
//   - a paste whose event carried nothing (a copied picture): what the clipboard holds;
//   - a copy: announced at the press (`shellCopying`), then the text once the page has it.
let asked = 0;
const waiting = new Map<number, (answer: unknown) => void>();
if (shell) {
  addEventListener("keel-shell", (e) => {
    const d = (e as CustomEvent<ShellTold>).detail;
    const answer = d?.pasted ?? d?.copied ?? d?.saving;
    if (!answer) return;
    waiting.get(answer.id)?.(answer);
    waiting.delete(answer.id);
  });
}
function ask<T>(message: object, ms = 8000): Promise<T | null> {
  return new Promise((done) => {
    const id = ++asked;
    waiting.set(id, done as (answer: unknown) => void);
    shell!.post({ ...message, id });
    setTimeout(() => { if (waiting.delete(id)) done(null); }, ms);
  });
}
// The pictures of an answer, as files.
export function pastedFiles(images: Pasted["images"]): File[] {
  return images.flatMap((im) => {
    if (!im.type.startsWith("image/")) return [];
    const raw = atob(im.data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return [new File([bytes], `pasted.${im.type.slice(6).replace(/[^a-z0-9]/g, "") || "png"}`, { type: im.type })];
  });
}
// `edge`: the longer side the page keeps a picture at; the app hands a larger one over at that
// size, so what crosses is never larger than the page would keep. Null: the app did not answer.
export const shellPaste = (edge?: number) => ask<Pasted>({ t: "paste", ...(edge ? { edge } : {}) });
export const shellCopying = () => shell?.post({ t: "copying" });
// The page is about to ask for the microphone, at the owner's press: the app gives it once, to this page only.
// (The word goes first on the app's pipe; a short moment lets it arrive before the engine's own request.)
export async function shellMicrophone(): Promise<void> {
  if (!shell) return;
  shell.post({ t: "microphone" });
  await new Promise((done) => setTimeout(done, 80));
}
// A file the page offers. The app keeps a file only when the page itself announced that very
// address at the owner's press, a moment before: a frame of content, which cannot say anything
// to the app, saves nothing. Null: the app did not answer (one from before this was asked).
export const shellSaving = (url: string) => ask<{ id: number; ok: boolean }>({ t: "saving", url }, 2000);
export async function shellCopy(text: string): Promise<void> {
  const answer = await ask<{ ok: boolean }>({ t: "copy", text });
  if (!answer?.ok) throw new Error("The app did not copy to the clipboard");
}

// A path the shell asked the page to show, as the parts the page acts on.
// `errors`: a failure with no session to open (src/automation/alerts.ts alertPath) opens the Errors panel.
export function pathParts(path: string): { pathname: string; event: string | null; approval: string | null; inbox: boolean; errors: boolean } {
  const u = new URL(path, "http://keel.invalid");
  return { pathname: u.pathname, event: u.searchParams.get("e"), approval: u.searchParams.get("approval"), inbox: u.searchParams.has("inbox"), errors: u.searchParams.has("errors") };
}

// Whether the page asks the app's engine for a collection now (features/shell.ts): the owner
// has turned to another window (a blur alone also comes when the keyboard goes into a frame of
// the page), and the last one was a minute ago or more.
export const mayCollect = (focused: boolean, last: number, now: number) => !focused && now - last >= 60_000;
