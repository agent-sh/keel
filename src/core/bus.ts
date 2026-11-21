import type { Frame } from "./types.ts";

type Listener = (f: Frame) => void;

// One process-wide fan-out. Clients filter by session on their side; the volume
// is one owner's sessions, so a single channel keeps it simple.
export class Bus {
  private listeners = new Set<Listener>();
  private filters: ((f: Frame) => Frame)[] = [];
  // Frames are numbered from the start time in microseconds: a restarted
  // daemon's numbers are above the last one's, so pages can order across it.
  private base = Date.now() * 1000;
  private n = 0;

  // The rev of the last emitted frame: what a snapshot read now reflects.
  rev(): number {
    return this.base + this.n;
  }

  // How far the session list has moved: one step for every frame that tells
  // of a session (made, renamed, moved, archived, deleted). A list read at
  // one level and a socket opened at the same level have nothing between
  // them; a socket opened at a higher one missed a change the list lacks.
  private sessionFrames = 0;
  sessionsLevel(): number {
    return this.base + this.sessionFrames;
  }

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
    if (f.t === "session") this.sessionFrames++;
    f = { ...this.filter(f), rev: this.base + ++this.n };
    for (const l of this.listeners) {
      try {
        l(f);
      } catch {
        // a broken listener never stops the others
      }
    }
  }
}
