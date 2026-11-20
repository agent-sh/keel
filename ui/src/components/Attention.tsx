// What needs the owner, outside the page: the tab's title starts with how many
// sessions need them, its icon carries a dot in the state's color (needs you,
// else working), and an installed app gets the count as its badge. So a tab
// in the background, or the app in the dock, says when to come back.
import { useEffect, useMemo } from "react";
import { useStore } from "../lib/store.ts";
import { useWatches } from "../lib/watch.ts";

let base = "Keel";
let need = 0;
const apply = () => { document.title = need > 0 ? `(${need}) ${base}` : base; };
// The page's own title (a session's name); the count is put in front of it.
export function setBaseTitle(t: string) { base = t; apply(); }

let icon: HTMLImageElement | null = null;
function favicon(state: "need" | "work" | null) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-keel]');
  if (!link) {
    link = Object.assign(document.createElement("link"), { rel: "icon", type: "image/svg+xml", href: "/icons/icon.svg" });
    link.dataset.keel = "";
    document.head.append(link);
  }
  link.dataset.state = state ?? "";
  if (!state) { link.type = "image/svg+xml"; link.href = "/icons/icon.svg"; return; }
  const draw = () => {
    if (link!.dataset.state !== state) return; // a newer state drew meanwhile
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    // The app's icon when it loaded, else the dot alone says it.
    if (icon!.naturalWidth > 0) g.drawImage(icon!, 0, 0, 64, 64);
    const css = getComputedStyle(document.documentElement);
    g.beginPath();
    g.arc(48, 16, 15, 0, Math.PI * 2);
    g.fillStyle = css.getPropertyValue("--bg").trim() || "#fff";
    g.fill();
    g.beginPath();
    g.arc(48, 16, 11, 0, Math.PI * 2);
    g.fillStyle = css.getPropertyValue(state === "need" ? "--st-need" : "--st-work").trim();
    g.fill();
    link!.type = "image/png";
    link!.href = c.toDataURL("image/png");
  };
  if (icon?.complete) return draw();
  icon ??= Object.assign(new Image(), { src: "/icons/icon.svg" });
  icon.onload = icon.onerror = draw;
}

export function Attention() {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const w = useWatches(list);
  let n = 0, working = 0;
  for (const s of list) { if (w[s.id] === "need") n++; else if (w[s.id] === "work") working++; }
  const state = n > 0 ? "need" : working > 0 ? "work" : null;
  useEffect(() => {
    need = n;
    apply();
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    // Badging is only for an installed app; a browser without it says nothing.
    (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
  }, [n]);
  useEffect(() => favicon(state), [state]);
  return null;
}
