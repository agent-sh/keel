// Code the first view does not draw, that a press asks for at once (the find bar, the microphone), is
// fetched after the page has settled: the load event, a pause, then an idle moment. A press before that
// fetches it by itself (React.lazy), so the only cost of the wait is the same fetch a little later.
import { whenIdle } from "./utils.ts";

const SETTLE_MS = 2000;
export function preloadSettled(load: () => Promise<unknown>): void {
  const go = () => setTimeout(() => whenIdle(() => void load().catch(() => {}), 5000), SETTLE_MS);
  if (document.readyState === "complete") go();
  else addEventListener("load", go, { once: true });
}
