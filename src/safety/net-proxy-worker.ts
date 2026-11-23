// The sandboxes' thread. Every scope's proxy listens and carries here, so a
// large download or many connections at once do not delay the daemon's loop
// (measured on the loop: 5 ms on average and up to 63 ms with 50 downloads
// at once). A session's read view is made again here too, when the one the
// loop keeps has aged (a few hundred names on disk are read for it). The
// main thread says which sockets to listen on, which ports are the daemon's
// own and which views to make; this thread says what it refused, what it carried and
// gives the views back.
import { setGitViews } from "../core/git.ts";
import { ownPort, startProxy, type FromProxy, type ToProxy } from "./net-proxy.ts";
import { readView } from "./sandbox-view.ts";

declare const self: Worker;

const listening = new Set<string>();
self.onmessage = (ev: MessageEvent<ToProxy>) => {
  const m = ev.data;
  if (m.t === "own") return ownPort(m.port);
  if (m.t === "view") {
    // (Keel's state folder is where the main thread says it is, and the environment is the main thread's as it is
    // now: a thread starts with a copy.)
    setGitViews(m.state);
    for (const [k, v] of Object.entries(m.env)) if (v !== undefined && process.env[k] !== v) process.env[k] = v;
    try { self.postMessage({ t: "view", id: m.id, view: readView(m.workspace, m.profile, m.read, m.env, m.layered, m.offers) } satisfies FromProxy); }
    catch (e) { self.postMessage({ t: "view", id: m.id, error: String((e as Error).message) } satisfies FromProxy); }
    return;
  }
  if (m.t !== "listen" || listening.has(m.path)) return;
  try {
    const server = startProxy(m.path, {
      refused: (r) => self.postMessage({ t: "refused", path: m.path, r } satisfies FromProxy),
      seen: (c) => self.postMessage({ t: "conn", path: m.path, c } satisfies FromProxy),
    });
    listening.add(m.path);
    server.on("error", (e) => { listening.delete(m.path); self.postMessage({ t: "failed", path: m.path, error: String((e as Error).message) } satisfies FromProxy); });
    self.postMessage({ t: "listening", path: m.path } satisfies FromProxy);
  } catch (e) {
    self.postMessage({ t: "failed", path: m.path, error: String((e as Error).message) } satisfies FromProxy);
  }
};
