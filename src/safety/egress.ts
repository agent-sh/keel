// Everything that leaves is a row. Each outward transfer the daemon makes or
// carries is recorded in the `egress` table with the session and call it was
// for, the tool, the host and port, the bytes it sent and whether it went:
// model requests, the web tools, MCP servers over HTTP, the fleet, the OTLP
// export, phone pushes, the daemon's own git pushes, session exports, and the
// connections a sandboxed command makes through the sandbox's proxy (allowed
// and refused).
//
// Who a transfer is for is read from where it runs: a tool call runs inside
// an `outward` scope with its tool, call and session (src/engine/turn.ts), a
// model request inside one of its own, and a turn's work inside the turn's
// error scope (src/core/errors.ts), which names the session and the turn. A
// sandboxed command's connections reach the proxy on a thread of its own: its
// relay puts the call's tag before each one (tagFor, src/safety/net-proxy.ts).
//
// What the daemon itself does not carry is not seen: with the sandbox off, a
// command's own connections; an MCP server that runs as a program here, and
// what that program reaches; a web tool's helper program beyond the address
// it reports. The Network page says so.
//
// The rows wait with the other side writes and are made in their commit
// (src/core/side.ts): a step's transfers cost no commit of their own.
import { AsyncLocalStorage } from "node:async_hooks";
import { errorScope } from "../core/errors.ts";
import { endpointOf, hostText, loopbackHost, requestBytes } from "./egress-count.ts";

export type Outcome = "sent" | "refused" | "failed";
export type Outward = {
  at: number; session: string | null; turn: string | null; call: string | null;
  tool: string; via: string | null; host: string; port: number | null;
  bytes: number | null; outcome: Outcome; status: number | null; why: string | null;
};

// Who the transfers made inside a scope are for, and what makes them. `host`
// and `port`: where a request over a local socket really goes (the fleet's
// ssh link). `counted`: the code inside records its transfers itself.
export type Label = { tool?: string; via?: string; session?: string; call?: string; turn?: string; host?: string; port?: number; counted?: boolean };
const scope = new AsyncLocalStorage<Label>();
export const outward = <T>(label: Label, f: () => T): T => scope.run({ ...scope.getStore(), ...label }, f);
export const outwardLabel = (): Label | undefined => scope.getStore();

let sink: ((o: Outward) => void) | undefined;
// The daemon's writer of rows (src/server/routes/egress.ts). Without one (a command line, a unit test) nothing is kept.
export const setEgressSink = (f: typeof sink) => void (sink = f);

// One transfer. What it does not say is read from the scope it runs in.
export function noteOutward(o: Partial<Omit<Outward, "host">> & { host: string }) {
  if (!sink) return;
  const l = scope.getStore(), e = errorScope.getStore();
  const session = o.session ?? l?.session ?? e?.session ?? null;
  // (A turn's id is the error scope's only when that scope is the same session's.)
  const turn = o.turn ?? l?.turn ?? (e && e.session === session ? e.turn : undefined) ?? null;
  const host = hostText(o.host);
  if (!host) return;
  try {
    sink({
      at: o.at ?? Date.now(), session, turn, call: o.call ?? l?.call ?? null,
      tool: o.tool ?? l?.tool ?? "daemon", via: o.via ?? l?.via ?? null, host, port: o.port ?? null,
      bytes: o.bytes ?? null, outcome: o.outcome ?? "sent", status: o.status ?? null, why: o.why ? o.why.slice(0, 200) : null,
    });
  } catch {} // a ledger row never fails what made the transfer
}

// One transfer that says itself who it is for, whatever scope it is told in (a thread's message
// runs in the scope its listener was set up in).
export const noteDetached = (o: Parameters<typeof noteOutward>[0]) => scope.exit(() => errorScope.exit(() => noteOutward(o)));

// ---- the tags a sandbox's relay puts before a connection ----

type Tagged = { session: string; call: string; tool: string; turn: string | null };
const tags = new Map<string, Tagged>();
const TAGS_MAX = 4096;
// The tag of a call's sandboxed command (one per call; a background job keeps its call's tag).
export function tagFor(t: Tagged): string {
  const tag = Bun.hash(`${t.session}\0${t.call}`).toString(36);
  tags.delete(tag);
  tags.set(tag, t);
  if (tags.size > TAGS_MAX) tags.delete(tags.keys().next().value!);
  return tag;
}
export const tagged = (tag: string | undefined): Tagged | undefined => (tag ? tags.get(tag) : undefined);

// ---- the daemon's fetch ----

const TAPPED = Symbol.for("keel.egress.tap");
const ORIG = Symbol.for("keel.egress.orig");
// Every fetch of this process is recorded when it settles: its host, port, the
// bytes it sent and its status. A fetch over a unix socket is a local one and
// is not, unless its scope names where it goes. A fetch to this machine's own
// loopback with no tool or session to name is the daemon's own plumbing (a
// portal, a probe) and is not either: one a tool call or a turn makes is.
// Installed by the daemon only; returns what takes it away.
export function tapFetch(): () => void {
  // (A tap a hot reload left is taken off: this module's own is put on the fetch under it.)
  const found = globalThis.fetch as typeof fetch & { [TAPPED]?: true; [ORIG]?: typeof fetch };
  // (A tap without the fetch under it, from an older build of this module: it is left as it is.)
  if (found[TAPPED] && !found[ORIG]) return () => {};
  const orig = (found[TAPPED] ? found[ORIG]! : found) as typeof fetch;
  const tapped = function (this: unknown, input: string | URL | Request, init?: RequestInit & { unix?: string }) {
    const l = scope.getStore();
    if (l?.counted) return orig(input, init);
    let url: string, method: string | undefined, headers: any, body: unknown, sized: number | null = 0;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else {
      // (A Request's body is a stream: its length is the one its headers state, when they do.)
      url = input.url; method = input.method; headers = input.headers;
      if (input.body !== null) { const n = Number(input.headers.get("content-length")); sized = Number.isFinite(n) && n >= 0 && input.headers.has("content-length") ? n : null; }
    }
    if (init?.method) method = init.method;
    if (init?.headers) headers = init.headers;
    if (init && "body" in init) { body = init.body ?? undefined; sized = 0; }
    const p = orig(input, init);
    const end = init?.unix ? (l?.host ? { host: l.host, port: l.port ?? null } : null) : endpointOf(url);
    if (!end || !/^(https?|wss?):/i.test(init?.unix ? "http:" : url)) return p;
    const e = errorScope.getStore();
    if (loopbackHost(end.host) && !l?.tool && !l?.session && !e?.session) return p;
    const head = requestBytes({ method, url, headers, body });
    const bytes = head === null || sized === null ? null : head + sized;
    p.then(
      (r) => noteOutward({ host: end.host, port: end.port, bytes, status: r.status, outcome: "sent" }),
      (err) => noteOutward({ host: end.host, port: end.port, bytes, outcome: "failed", why: String((err as Error)?.message ?? err) }),
    );
    return p;
  } as typeof fetch & { [TAPPED]?: true; [ORIG]?: typeof fetch };
  Object.assign(tapped, orig);
  // (Bun's own addition to fetch, not enumerable.)
  if ("preconnect" in orig) (tapped as any).preconnect = (orig as any).preconnect;
  tapped[TAPPED] = true;
  tapped[ORIG] = orig;
  globalThis.fetch = tapped;
  return () => { if (globalThis.fetch === tapped) globalThis.fetch = orig; };
}
