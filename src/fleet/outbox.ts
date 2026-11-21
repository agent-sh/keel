// The receiving side of a linked daemon's outbox: fetch what waits for this
// daemon there, keep each message, acknowledge what was kept. One drain per
// machine at a time; a trigger during a drain runs it once more after it.
// A link error on the way (the fetch or the acknowledgement lost) is tried
// again after 1, 2, 4 ... 30 s, six times at most and only while the relay to
// that machine is open: a relay that reopens drains by itself. A message kept
// before its acknowledgement was lost is kept once (Messages.receiveOutbound).
import { LinkError } from "./link.ts";
import type { Message } from "./messages.ts";

export const OUTBOX_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export type OutboxLink = {
  pending(): Promise<Message[]>;
  keep(m: Message): void;
  ack(ids: string[]): Promise<unknown>;
};

type Deps = {
  link(machineId: string): Promise<OutboxLink>;
  live(machineId: string): boolean;
  // A failure that is not the link's, or a link that failed every retry while its relay stayed open.
  failed(e: unknown, machineId: string): void;
  retryMs?: number[];
};

type State = { running: boolean; again: boolean; tries: number; timer?: Timer };

export class OutboxDrain {
  private states = new Map<string, State>();
  constructor(private d: Deps) {}

  // The other daemon said something waits, or its relay just opened.
  kick(machineId: string) {
    const st = this.states.get(machineId) ?? { running: false, again: false, tries: 0 };
    this.states.set(machineId, st);
    clearTimeout(st.timer);
    st.timer = undefined;
    st.tries = 0;
    if (st.running) st.again = true;
    else void this.run(machineId, st);
  }

  private async once(machineId: string) {
    const l = await this.d.link(machineId);
    const kept: string[] = [];
    for (const m of await l.pending()) {
      l.keep(m);
      kept.push(m.id);
    }
    if (kept.length) await l.ack(kept);
  }

  private async run(machineId: string, st: State) {
    const delays = this.d.retryMs ?? OUTBOX_RETRY_MS;
    st.running = true;
    try {
      do {
        st.again = false;
        await this.once(machineId);
      } while (st.again);
      st.tries = 0;
    } catch (e) {
      const transient = e instanceof LinkError && this.d.live(machineId);
      if (transient && st.tries < delays.length) {
        st.timer = setTimeout(() => {
          st.timer = undefined;
          if (this.d.live(machineId)) void this.run(machineId, st);
          else st.tries = 0;
        }, delays[st.tries++]);
      } else {
        st.tries = 0;
        // A closed relay is the link's ordinary state: its reopening drains again.
        if (transient || !(e instanceof LinkError)) this.d.failed(e, machineId);
      }
    } finally {
      st.running = false;
    }
  }

  // Nothing pending and nothing running, for a test or a shutdown to wait on.
  idle(machineId: string): boolean {
    const st = this.states.get(machineId);
    return !st || (!st.running && !st.timer);
  }

  stop() {
    for (const st of this.states.values()) clearTimeout(st.timer);
    this.states.clear();
  }
}
