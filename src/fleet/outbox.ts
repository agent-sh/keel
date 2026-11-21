// The receiving side of a linked daemon's outbox: fetch what waits for this
// daemon there, keep each message, answer for each: kept, or refused with the
// reason. One drain per machine at a time; a trigger during a drain runs it
// once more after it.
// A link error on the way (the fetch or the acknowledgement lost) is tried
// again after 1, 2, 4 ... 30 s, six times, then every 5 minutes, and only
// while the relay to that machine is open: a relay that reopens drains by
// itself. A message kept before its acknowledgement was lost is kept once
// (Messages.receiveOutbound). A message that cannot be kept for a reason of
// this daemon's own (a bug) is reported and left for the next drain: the ones
// behind it are still kept and answered.
import { LinkError } from "./link.ts";
import type { Message } from "./messages.ts";

export const OUTBOX_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
// After the quick retries: a link that still fails while its relay is open
// (the relay's own stream is another request) is asked again at this pace.
export const OUTBOX_SLOW_MS = 5 * 60_000;

export type OutboxLink = {
  pending(): Promise<Message[]>;
  keep(m: Message): { refused?: string };
  ack(ids: string[], refused: Record<string, string>): Promise<unknown>;
};

type Deps = {
  link(machineId: string): Promise<OutboxLink>;
  live(machineId: string): boolean;
  // A failure that is not the link's, or a link that failed every quick retry while its relay stayed open.
  failed(e: unknown, machineId: string): void;
  retryMs?: number[];
  slowMs?: number;
};

type State = { running: boolean; again: boolean; tries: number; gaveUp: boolean; timer?: Timer };

export class OutboxDrain {
  private states = new Map<string, State>();
  constructor(private d: Deps) {}

  // The other daemon said something waits, or its relay just opened.
  kick(machineId: string) {
    const st = this.states.get(machineId) ?? { running: false, again: false, tries: 0, gaveUp: false };
    this.states.set(machineId, st);
    clearTimeout(st.timer);
    st.timer = undefined;
    st.tries = 0;
    if (st.running) st.again = true;
    else void this.run(machineId, st);
  }

  private async once(machineId: string) {
    const l = await this.d.link(machineId);
    const ids: string[] = [];
    const refused: Record<string, string> = {};
    for (const m of await l.pending()) {
      let why: string | undefined;
      try {
        why = l.keep(m).refused;
      } catch (e) {
        this.d.failed(e, machineId); // not answered: it is handed out again
        continue;
      }
      if (why !== undefined) refused[m.id] = why;
      ids.push(m.id);
    }
    if (ids.length) await l.ack(ids, refused);
  }

  private later(machineId: string, st: State, ms: number) {
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (this.d.live(machineId)) void this.run(machineId, st);
      else st.tries = 0;
    }, ms);
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
      st.gaveUp = false;
    } catch (e) {
      if (!(e instanceof LinkError)) {
        st.tries = 0;
        this.d.failed(e, machineId);
      } else if (!this.d.live(machineId)) {
        st.tries = 0; // a closed relay is the link's ordinary state: its reopening drains again
      } else if (st.tries < delays.length) {
        this.later(machineId, st, delays[st.tries++]!);
      } else {
        // Reported once, until a drain gets through again.
        if (!st.gaveUp) this.d.failed(e, machineId);
        st.gaveUp = true;
        this.later(machineId, st, this.d.slowMs ?? OUTBOX_SLOW_MS);
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
