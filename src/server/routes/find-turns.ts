// One Find a session at a time on the read thread. The page asks again at
// each pause in typing, so a find that waits behind a running one is only
// worth its run while it is the newest: a newer one takes its place, and one
// whose request was given up (the page aborted it, the tab closed) is dropped
// before it runs. Finds of other sessions do not wait for each other.

type Waiting = { start: () => void; drop: () => void };
type Slot = { next?: Waiting };

export class FindTurns {
  private slots = new Map<string, Slot>();

  // True when this find may run now (call `done` after it), false when it
  // was given up or replaced while it waited (it must not run, nor call `done`).
  turn(session: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const slot = this.slots.get(session);
    if (!slot) {
      this.slots.set(session, {});
      return Promise.resolve(true);
    }
    slot.next?.drop();
    return new Promise((ok) => {
      const gone = () => {
        if (slot.next === mine) slot.next = undefined;
        ok(false);
      };
      const mine: Waiting = {
        start: () => { signal?.removeEventListener("abort", gone); ok(true); },
        drop: () => { signal?.removeEventListener("abort", gone); ok(false); },
      };
      slot.next = mine;
      signal?.addEventListener("abort", gone, { once: true });
    });
  }

  done(session: string) {
    const slot = this.slots.get(session);
    if (!slot) return;
    const next = slot.next;
    if (!next) { this.slots.delete(session); return; }
    slot.next = undefined;
    next.start();
  }

  // Sessions with a find running (for a test).
  get running() { return this.slots.size; }
}
