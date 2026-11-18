import type { Frame } from "./types.ts";

type Listener = (f: Frame) => void;

// One process-wide fan-out. Clients filter by session on their side; the volume
// is one owner's sessions, so a single channel keeps it simple.
export class Bus {
  private listeners = new Set<Listener>();

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(f: Frame) {
    for (const l of this.listeners) {
      try {
        l(f);
      } catch {
        // a broken listener never stops the others
      }
    }
  }
}
