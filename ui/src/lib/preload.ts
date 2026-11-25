// Code the first view does not draw, that a press asks for at once (the find bar, the microphone), is
// fetched after the page has settled: the load event, a pause, then an idle moment. A press before that
// fetches it by itself (React.lazy), so the only cost of the wait is the same fetch a little later.
import { createElement, lazy, useState, type ComponentType } from "react";
import { whenIdle } from "./utils.ts";

const SETTLE_MS = 2000;
export function preloadSettled(load: () => Promise<unknown>): void {
  const go = () => setTimeout(() => whenIdle(() => void load().catch(() => {}), 5000), SETTLE_MS);
  if (document.readyState === "complete") go();
  else addEventListener("load", go, { once: true });
}

// A view whose code is its own chunk. `start` fetches it (once); a view drawn after the code is here is drawn
// whole, at once. React.lazy cannot do that: it always draws its fallback first, and React holds the content
// back for 300 ms after a fallback it has shown, so a chunk that came in a few milliseconds late still cost the
// first paint 300 ms. The component chosen at its first draw is kept, so a view never remounts when the code
// arrives while it is up.
export function chunked<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  let started: Promise<void> | undefined;
  const start = () => (started ??= load().then((c) => { loaded = c; }));
  const Later = lazy(() => start().then(() => ({ default: loaded! })));
  const View = (props: P) => {
    const [C] = useState<ComponentType<P>>(() => loaded ?? (Later as ComponentType<P>));
    return createElement(C, props);
  };
  return { View, start };
}

// The first draw waits for what the first view needs, but not past `ms`: a page whose code is slow to come
// draws what it has, and the rest follows.
export const firstDraw = (needs: Promise<unknown>, ms: number) =>
  Promise.race([needs.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]).then(() => undefined);
