// What needs the owner, outside the page: the tab's title starts with how many
// things wait on them, its icon carries a dot in the state's color (needs you,
// else working), and an installed app gets the count as its badge. So a tab
// in the background, or the app in the dock, says when to come back.
// Each waiting thing is counted once: an agent's question is its parent's
// to answer and is in the parent's state, so only top-level sessions are read.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { attends } from "../lib/automation.ts";
import { agentFailNews, failStamp, failUnseen, isFailure } from "../lib/home.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import type { Session } from "../../../src/core/types.ts";
import { useNeedCount, useSessionStates, type Watch } from "../lib/watch.ts";

const onVisible = (f: () => void) => (document.addEventListener("visibilitychange", f), () => document.removeEventListener("visibilitychange", f));

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
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id), [sessions]);
  const states = useSessionStates(list);
  // The one count of what waits on the owner: the home headline, the list's line and the phone's dock show the same number.
  const n = useNeedCount();
  const working = list.some((s) => states[s.id]?.watch === "work");
  const state = n > 0 ? "need" : working ? "work" : null;
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

// A failed session (or one whose turn the model declined) the owner is at: its pane is in view (most
// of it inside the window, nothing over it) in a visible, focused page they did something in within
// the last minute. They have seen that failure, and the daemon is told so (every device then stops
// counting it). A pane that is placed but scrolled off the window, a hidden tab, and a page left open
// with nobody at it show nothing: the failure stays news. `placed`: the session has a pane or a page.
export function useSeenFailure(s: Session, w: Watch, placed: boolean) {
  const visible = useSyncExternalStore(onVisible, () => document.visibilityState === "visible");
  const at = placed && visible && isFailure(w) && failUnseen(s) ? failStamp(s) : null;
  // The failures of its agents are seen the same way: the session counts as failed until then.
  const agentsAt = placed && visible && agentFailNews(s) ? s.settings.agents_failed_ms! : null;
  useEffect(() => {
    if (agentsAt === null) return;
    const look = () => { if (!attends(s.id)) return false; actions.patch(s.id, { agents_fail_seen: agentsAt } as never).catch(reportError); return true; };
    if (look()) return;
    const t = setInterval(() => { if (look()) clearInterval(t); }, 1000);
    return () => clearInterval(t);
  }, [s.id, agentsAt]);
  useEffect(() => {
    if (at === null) return;
    const look = () => { if (!attends(s.id)) return false; actions.patch(s.id, { fail_seen: at } as never).catch(reportError); return true; };
    if (look()) return;
    // Looked at again while the failure is news: when the pane comes into view, or the owner comes back.
    const t = setInterval(() => { if (look()) clearInterval(t); }, 1000);
    return () => clearInterval(t);
  }, [s.id, at]);
}
