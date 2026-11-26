// A new page installed on the daemon (`keel ui install`, src/server/ui-bundle.ts):
// the socket's hello and its `ui` frame name the version served. This page
// knows its own from the meta tag the daemon stamped into its HTML. It reloads
// itself when nothing would be lost (no text in a box, no send still out, no key pressed for 5 s, no dialog,
// every transcript at its end, or the tab hidden with no text in a box);
// otherwise it offers the reload and keeps trying while it waits.
import { useSyncExternalStore } from "react";
import { popupShown } from "./overlay.ts";
import { sendsBusy } from "./send-drafts.ts";

const mine = document.querySelector<HTMLMetaElement>('meta[name="keel-ui"]')?.content ?? "dev";
const TRIED = "keel.ui-reload";
let pending: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
let lastKey = 0;
addEventListener("keydown", () => (lastKey = Date.now()), true);

const hasDraft = () => sendsBusy() || [...document.querySelectorAll("textarea")].some((t) => t.value.trim())
  || !!document.querySelector("[contenteditable=true]:not(:empty)");
const atRest = () =>
  ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(popupShown) &&
  Date.now() - lastKey > 5000 &&
  [...document.querySelectorAll('[data-testid="transcript"]')].every((c) => {
    const el = c.parentElement!;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  });

export function reloadNow() {
  if (pending) sessionStorage.setItem(TRIED, pending);
  location.reload();
}

function check() {
  if (!pending) return;
  // A reload that brought back the same page (a cache in the way) is not tried again by itself.
  if (sessionStorage.getItem(TRIED) !== pending && !hasDraft() && (document.hidden || atRest())) reloadNow();
}

export function servedUi(v: string | undefined) {
  const next = v && v !== mine ? v : null;
  if (next === pending) return;
  pending = next;
  clearInterval(timer);
  if (pending) {
    timer = setInterval(check, 2000);
    check();
  }
  notify();
}
document.addEventListener("visibilitychange", check);

export const useUiUpdate = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => pending);
