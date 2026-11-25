// Turns a start wakes together go one at a time. A start wakes every session it owes work at one moment
// (their model listed, a provider answered), and each of them prepares its first request the moment it
// wakes: the messages, the secrets pass over them, the transcript for the hooks, the request's body. The
// preparations of several turns run in the same pass of the loop and the page waits for all of them.
// `pace` lets one caller go at a time: it resolves when the callers before it have let go, a timer tick
// after the last one did, and gives the caller its release.
let tail: Promise<void> = Promise.resolve();

export function pace(): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const before = tail;
  tail = mine;
  return before.then(() => new Promise<() => void>((r) => setTimeout(() => r(release), 0)));
}

// The loop serves its timers and its sockets before the caller goes on. Between the parts of a request's
// preparation (each hook, the images, the send), so that no part waits for the one before it.
export const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
