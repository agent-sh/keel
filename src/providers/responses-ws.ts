// The Responses API over a WebSocket (OpenAI "WebSocket mode", what Codex main
// uses by default): one socket per session and model, a `response.create`
// message per request, and after the first only the new input items with
// `previous_response_id`, so a long agent loop does not resend its history.
// The server keeps the previous response in a connection-local cache (it works
// with `store: false`); a socket lives at most 60 minutes.
//
// A request continues the previous one only when every field but `input` is
// unchanged and its input starts with the previous input; the items between
// that prefix and the new ones are the previous answer's own output (the
// server already holds them). Anything else is sent whole on the same socket.
import type { SseEvent } from "./sse.ts";
import { idleGuard, ProviderError, scrub, streamIdleMs } from "./http.ts";
import type { ProviderRequest } from "./types.ts";

const MAX_AGE = 55 * 60_000;     // under the server's 60 minute limit
const IDLE_CLOSE = 10 * 60_000;  // a socket nobody used for this long is closed
const OPEN_MS = 15_000;

// The handshake was refused: this session goes over HTTP from now on.
export class WsUnavailable extends Error {}

const OUTPUT = (it: any) => it?.type === "reasoning" || it?.type === "function_call" || it?.type === "custom_tool_call" || (it?.type === "message" && it?.role === "assistant");

type Chan = {
  ws: WebSocket;
  opened: number;
  used: number;
  busy: boolean;
  closed: boolean;
  last?: { rest: string; input: any[]; id: string };
  listener?: (m: any) => void;
  onClose?: () => void;
};

// The continuation of `prev` that `body` is, or null when it must be sent whole.
export function continuation(prev: Chan["last"], body: Record<string, any>): { id: string; input: any[] } | null {
  if (!prev) return null;
  const { input, ...rest } = body;
  if (JSON.stringify(rest) !== prev.rest || !Array.isArray(input) || input.length < prev.input.length) return null;
  for (let i = 0; i < prev.input.length; i++) if (JSON.stringify(input[i]) !== JSON.stringify(prev.input[i])) return null;
  let k = prev.input.length;
  while (k < input.length && OUTPUT(input[k])) k++;
  return { id: prev.id, input: input.slice(k) };
}

export class ResponsesSockets {
  private chans = new Map<string, Chan>();
  private off = new Set<string>();
  // Counted for the measurement in the decision log: whole vs continued requests.
  readonly stats = { whole: 0, continued: 0, fallback: 0 };

  constructor(private label: string, private url: () => string) {
    setInterval(() => {
      for (const [k, c] of this.chans) if (!c.busy && Date.now() - c.used > IDLE_CLOSE) this.drop(k);
    }, 60_000).unref?.();
  }

  usable(key: string) { return !this.off.has(key); }
  disable(key: string) { this.off.add(key); this.stats.fallback++; this.drop(key); }

  private drop(key: string) {
    const c = this.chans.get(key);
    this.chans.delete(key);
    if (c && !c.closed) try { c.ws.close(); } catch {}
  }

  private open(key: string, headers: Record<string, string>): Promise<Chan> {
    const cur = this.chans.get(key);
    if (cur && !cur.closed && Date.now() - cur.opened < MAX_AGE) return Promise.resolve(cur);
    if (cur) this.drop(key);
    return new Promise((resolve, reject) => {
      // Bun's WebSocket takes request headers (the sign-in and the beta header).
      const ws = new WebSocket(this.url(), { headers } as any);
      const c: Chan = { ws, opened: Date.now(), used: Date.now(), busy: false, closed: false };
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new WsUnavailable("the socket did not open")); }, OPEN_MS);
      ws.onopen = () => { clearTimeout(t); this.chans.set(key, c); resolve(c); };
      ws.onerror = () => { clearTimeout(t); c.closed = true; reject(new WsUnavailable("the handshake was refused")); };
      ws.onclose = () => { c.closed = true; clearTimeout(t); c.onClose?.(); if (this.chans.get(key) === c) this.chans.delete(key); };
      ws.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        c.listener?.(m);
      };
    });
  }

  // The events of one request over the session's socket, as runEvents reads
  // them. Throws WsUnavailable before any event when the socket cannot be used.
  events(key: string, headers: Record<string, string>, req: ProviderRequest, onMessage?: (m: any) => void) {
    const self = this;
    return async function* (body: Record<string, any>): AsyncGenerator<SseEvent> {
      const c = await self.open(key, headers);
      if (c.busy) throw new WsUnavailable("the session's socket is busy");
      c.busy = true;
      c.used = Date.now();
      const guard = idleGuard(req.signal, streamIdleMs(), self.label);
      try {
        const { stream: _s, background: _b, ...whole } = body;
        let cont = continuation(c.last, whole);
        for (let attempt = 0; attempt < 2; attempt++) {
          const queue: any[] = [];
          let wake: (() => void) | null = null;
          let gone = false;
          c.listener = (m) => { queue.push(m); guard.touch(); wake?.(); };
          c.onClose = () => { gone = true; wake?.(); };
          const onAbort = () => { gone = true; self.drop(key); wake?.(); };
          guard.signal.addEventListener("abort", onAbort, { once: true });
          const msg = cont ? { type: "response.create", ...whole, previous_response_id: cont.id, input: cont.input } : { type: "response.create", ...whole };
          cont ? self.stats.continued++ : self.stats.whole++;
          c.ws.send(JSON.stringify(msg));
          let retry = false;
          try {
            for (;;) {
              while (!queue.length && !gone) await new Promise<void>((r) => (wake = r));
              wake = null;
              if (!queue.length && gone) {
                const stalled = guard.stalled();
                if (stalled) throw stalled;
                if (req.signal.aborted) throw new ProviderError("cancelled", "cancelled");
                throw new ProviderError("network", `${self.label}: the socket closed during the answer`);
              }
              const m = queue.shift();
              onMessage?.(m);
              if (m.type === "error" || m.type === "response.failed") {
                const code = m.error?.code ?? m.response?.error?.code ?? m.code ?? "";
                // The connection lost the previous response: send it whole once.
                if (cont && /previous_response_not_found/.test(code) && attempt === 0) { retry = true; c.last = undefined; break; }
                if (m.status && !m.error?.type) {
                  throw new ProviderError(m.status === 429 ? "rate" : m.status >= 500 ? "server" : m.status === 401 ? "auth" : "invalid", `${self.label}: ${scrub(String(m.error?.message ?? code))}`, m.status);
                }
              }
              yield { event: m.type, data: JSON.stringify(m) } as SseEvent;
              if (m.type === "response.completed" || m.type === "response.incomplete" || m.type === "response.failed" || m.type === "error") {
                const id = m.response?.id;
                c.last = m.type === "response.completed" && id ? { rest: JSON.stringify((({ input: _, ...r }) => r)(whole)), input: whole.input, id } : undefined;
                return;
              }
            }
          } finally {
            guard.signal.removeEventListener("abort", onAbort);
            c.listener = undefined;
            c.onClose = undefined;
          }
          if (!retry) return;
          cont = null;
        }
      } finally {
        c.busy = false;
        c.used = Date.now();
        guard.done();
      }
    };
  }
}
