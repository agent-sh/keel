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
// behind it are still kept and answered. A message this daemon's limits leave
// for later (a backlog drained at once) is not answered either: it and the
// later ones for its session wait, in order, for a drain a minute on.
import { LinkError } from "./link.ts";
import type { Message } from "./messages.ts";

export const OUTBOX_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
// After the quick retries: a link that still fails while its relay is open
// (the relay's own stream is another request) is asked again at this pace.
export const OUTBOX_SLOW_MS = 5 * 60_000;
// The receiving limits count a minute: what they left is tried again after one.
export const OUTBOX_LATER_MS = 60_000;

export type OutboxLink = {
  pending(): Promise<Message[]>;
  keep(m: Message): { refused?: string; title?: string; later?: string };
  ack(ids: string[], refused: Record<string, string>, titles: Record<string, string>): Promise<unknown>;
};

type Deps = {
  link(machineId: string): Promise<OutboxLink>;
  live(machineId: string): boolean;
  // A failure that is not the link's, or a link that failed every quick retry while its relay stayed open.
  failed(e: unknown, machineId: string): void;
  retryMs?: number[];
  slowMs?: number;
  laterMs?: number;
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

  // True when something was left for later.
  private async once(machineId: string): Promise<boolean> {
    const l = await this.d.link(machineId);
    const ids: string[] = [];
    const refused: Record<string, string> = {};
    const titles: Record<string, string> = {};
    const waits = new Set<string>(); // sessions with a message left for later: the ones behind it keep their order
    for (const m of await l.pending()) {
      if (waits.has(m.to_session)) continue;
      let r: ReturnType<OutboxLink["keep"]>;
      try {
        r = l.keep(m);
      } catch (e) {
        this.d.failed(e, machineId); // not answered: it is handed out again
        continue;
      }
      if (r.later !== undefined) { waits.add(m.to_session); continue; }
      if (r.refused !== undefined) refused[m.id] = r.refused;
      if (r.title) titles[m.id] = r.title;
      ids.push(m.id);
    }
    if (ids.length) await l.ack(ids, refused, titles);
    return waits.size > 0;
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
      let left = false;
      do {
        st.again = false;
        left = await this.once(machineId);
      } while (st.again);
      st.tries = 0;
      st.gaveUp = false;
      if (left) this.later(machineId, st, this.d.laterMs ?? OUTBOX_LATER_MS);
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
