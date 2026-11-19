import type { Frame } from "./types.ts";

type Listener = (f: Frame) => void;

// One process-wide fan-out. Clients filter by session on their side; the volume
// is one owner's sessions, so a single channel keeps it simple.
export class Bus {
  private listeners = new Set<Listener>();
  private filters: ((f: Frame) => Frame)[] = [];

  // Every frame passes the filters before any listener sees it (secrets are
  // kept out of what the UI is sent).
  use(filter: (f: Frame) => Frame) {
    this.filters.push(filter);
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // A frame as listeners would get it (a replay of stored events goes through the same filters).
  filter(f: Frame): Frame {
    for (const g of this.filters) {
      try { f = g(f); } catch {}
    }
    return f;
  }

  emit(f: Frame) {
    f = this.filter(f);
    for (const l of this.listeners) {
      try {
        l(f);
      } catch {
        // a broken listener never stops the others
      }
    }
  }
}
