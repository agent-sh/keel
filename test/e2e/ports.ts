import { createServer } from "node:net";

// A port for a daemon a spec starts itself: free now, and below the range the
// kernel hands to outgoing connections (32768 and up on Linux). Up there a
// port that was free when it was looked at is often taken before the daemon
// binds it, on a machine where many programs open connections.
export async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const free = await new Promise<boolean>((done) => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port between 20000 and 32000 on 127.0.0.1");
}
