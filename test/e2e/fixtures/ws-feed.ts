// A server that pushes events over a WebSocket, the way a deploy feed does:
// on connect it sends three messages a little apart, then closes with 1000.
// Prints its port on the first line. Usage: bun ws-feed.ts
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, s) {
    return s.upgrade(req) ? undefined : new Response("a socket only", { status: 400 });
  },
  websocket: {
    open(ws) {
      const msgs = ["deploy 41 started", "deploy 41 healthy\non every host", "deploy 41 DONE"];
      msgs.forEach((m, i) => setTimeout(() => ws.send(m), 300 + i * 300));
      setTimeout(() => ws.close(1000, "feed over"), 300 + msgs.length * 300 + 300);
    },
    message() {},
  },
});
process.stdout.write(`${server.port}\n`);
