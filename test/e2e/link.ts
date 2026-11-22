// The link between a page and a daemon with a hand on it: a TCP pass-through
// a spec can make slow, hold, or kill, the way networks do.
//   pass   both ways
//   hold   nothing passes and nothing closes; what was sent is delivered when it passes again
//          (a tunnel that stalls: TCP delivers late)
//   dead   nothing passes and nothing closes, and every connection that lived through it, or
//          was made in it, stays dead for good (a network that changed under them); new ones pass after
// `lag`: each chunk is delivered that much later, in order, each way (and `jitter` more, at random).
// A side that closes has its close delivered after what it sent, as a FIN follows the data: an
// answer the daemon closes behind (`connection: close`) still arrives, late.
import net from "node:net";

export type LinkMode = "pass" | "hold" | "dead";
export function tcpLink(targetPort: number, host = "127.0.0.1") {
  let mode: LinkMode = "pass";
  let lag: { ms: number; jitter: number } | null = null;
  type Way = { held: Buffer[]; last: number };
  type Conn = { page: net.Socket; daemon: net.Socket; up: Way; down: Way; dead: boolean };
  const conns = new Set<Conn>();
  let made = 0;
  let shut = false;
  const deliver = (to: net.Socket, w: Way, b: Buffer) => {
    if (!lag) return void (to.destroyed || to.write(b));
    const at = Math.max(w.last, Date.now() + lag.ms + Math.random() * lag.jitter);
    w.last = at;
    setTimeout(() => { if (!to.destroyed) to.write(b); }, at - Date.now());
  };
  const server = net.createServer((page) => {
    made++;
    const daemon = net.connect(targetPort, host);
    const c: Conn = { page, daemon, up: { held: [], last: 0 }, down: { held: [], last: 0 }, dead: false };
    conns.add(c);
    const on = (from: "up" | "down") => (b: Buffer) => {
      if (c.dead) return;
      if (mode === "dead") return void (c.dead = true);
      if (mode === "hold") return void c[from].held.push(b);
      deliver(from === "up" ? daemon : page, c[from], b);
    };
    page.on("data", on("up"));
    daemon.on("data", on("down"));
    const end = () => { conns.delete(c); page.destroy(); daemon.destroy(); };
    // What the closing side sent is still on its way (the lag, or held): the close follows it.
    const closed = (w: Way, other: net.Socket) => () => {
      const wait = lag ? Math.max(0, w.last - Date.now()) + 5 : 0;
      if (shut || c.dead || (!wait && !w.held.length)) return end();
      const follow = () => {
        if (shut || c.dead || !conns.has(c)) return end();
        if (w.held.length) return void setTimeout(follow, 50);
        if (!other.destroyed) other.end();
        setTimeout(end, 50);
      };
      setTimeout(follow, wait);
    };
    page.on("error", end).on("close", closed(c.up, daemon));
    daemon.on("error", end).on("close", closed(c.down, page));
  });
  return {
    listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`))),
    set(m: LinkMode) {
      if (m === "dead") for (const c of conns) c.dead = true;
      mode = m;
      if (m !== "pass") return;
      for (const c of conns) {
        if (c.dead) continue;
        for (const b of c.up.held.splice(0)) deliver(c.daemon, c.up, b);
        for (const b of c.down.held.splice(0)) deliver(c.page, c.down, b);
      }
    },
    lag: (l: { ms: number; jitter?: number } | null) => { lag = l ? { ms: l.ms, jitter: l.jitter ?? 0 } : null; },
    made: () => made,
    close: () => new Promise<void>((r) => { shut = true; for (const c of conns) { c.page.destroy(); c.daemon.destroy(); } server.close(() => r()); }),
  };
}
