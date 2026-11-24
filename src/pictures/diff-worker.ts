// The thread a run's pictures are compared on (src/pictures/pairs.ts): one message in, one answer out.
import { pairsOf } from "./pairs.ts";

declare var self: Worker;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { beforeDir: string; afterDir: string; before: string[]; after: string[]; again?: { dir: string; names: string[] } };
  try { self.postMessage({ pairs: pairsOf(m.beforeDir, m.afterDir, m.before, m.after, m.again) }); }
  catch (e) { self.postMessage({ error: (e as Error).message }); }
};
