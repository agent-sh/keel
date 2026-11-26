// Who holds a session of another harness, in the words a row and a composer say it (src/integrations/outside/
// writer.ts reads it). Kept apart from watch.ts: only the list and a session of another harness draw it, so the
// page's start does not carry it.
import type { Holder } from "./types.ts";

export function holderSaid(h: Holder | undefined, harness: string): string {
  const pid = h?.pid ? ` (pid ${h.pid})` : "";
  switch (h?.kind ?? "free") {
    case "free": return "Free";
    case "keel": return "Keel is answering";
    case "terminal": return `Open in a terminal${pid}`;
    case "background": return `Runs as a background job${pid}`;
    case "desktop": return `Open in ${harness} Desktop${pid}`;
    case "editor": return `Open in an editor${pid}`;
    case "app": return `Open in another ${harness} app${pid}`;
    default: return `Held by a process${pid}`;
  }
}
