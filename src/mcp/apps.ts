// MCP Apps (the ui extension of MCP, io.modelcontextprotocol/ui, stable
// 2026-01-26): a tool names a `ui://` resource, an HTML page the host draws
// in a sandboxed frame beside the call, and the page speaks JSON-RPC 2.0 to
// the host over postMessage. Pure logic only, shared by the daemon and the
// page: what a tool declares, the frame's content policy, and which of the
// app's messages the host answers. Keeping and serving an app is
// src/server/routes/mcp-apps.ts; the frame and its bridge are
// ui/src/components/McpApp.tsx.

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const APP_MIME = "text/html;profile=mcp-app";
// The extension's version this host speaks (the spec's dated version).
export const APP_PROTOCOL = "2026-01-26";

type Meta = Record<string, unknown> | undefined;
const metaUi = (meta: Meta): Record<string, unknown> | undefined => {
  const ui = meta?.ui;
  return ui && typeof ui === "object" && !Array.isArray(ui) ? (ui as Record<string, unknown>) : undefined;
};

// The app a tool names: `_meta.ui.resourceUri`, else the flat key the spec
// keeps for servers written before it (`_meta["ui/resourceUri"]`). Only a
// `ui://` URI is an app.
export function appUriOf(tool: { _meta?: Meta }): string | undefined {
  const uri = metaUi(tool._meta)?.resourceUri ?? tool._meta?.["ui/resourceUri"];
  return typeof uri === "string" && /^ui:\/\/[^\s]+$/.test(uri) ? uri : undefined;
}

// Who may call a tool: the model, the app, or both (the default). A tool
// whose list leaves the model out is never offered to the model; one that
// leaves the app out is never called by an app.
export type Caller = "model" | "app";
export function visibleTo(tool: { _meta?: Meta }, who: Caller): boolean {
  const v = metaUi(tool._meta)?.visibility;
  if (!Array.isArray(v)) return true;
  return v.includes(who);
}

// Whether a resource's MIME type is an app's (parameters compared without spaces or case).
export const isAppMime = (mime: unknown) => typeof mime === "string" && mime.replace(/\s+/g, "").toLowerCase() === APP_MIME;

// What a resource says of how it is drawn (`_meta.ui` of its content).
export type AppCsp = { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
export type AppResourceMeta = { csp?: AppCsp; prefersBorder?: boolean };
export function resourceMetaOf(meta: Meta): AppResourceMeta {
  const ui = metaUi(meta);
  if (!ui) return {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const c = ui.csp && typeof ui.csp === "object" ? (ui.csp as Record<string, unknown>) : undefined;
  const csp: AppCsp = {};
  for (const k of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const) { const l = list(c?.[k]); if (l?.length) csp[k] = l; }
  return { ...(Object.keys(csp).length ? { csp } : {}), ...(typeof ui.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}) };
}

// One origin a server declared, as it may stand in the policy: https or wss,
// a host name (a leading `*.` allowed over a name of two labels or more, so
// never `https://*.com`), a port at most. Never a keyword ('self',
// 'unsafe-eval'), a bare scheme or `*`, a path, or anything that would end
// the directive. A loopback, private or shared (100.64.0.0/10, a carrier's
// and a tailnet's) address is refused too: it would reach this machine (the
// daemon's API among it) or the owner's network, which no server's app has
// any business with. A host written in any form but its canonical one
// (`127.1`, `0x7f.0.0.1`, `2130706433`, a number for a last label) is refused
// before it is read: a browser reads those as addresses.
const ORIGIN = /^(https|wss):\/\/(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$/i;
const QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PRIVATE_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;
function privateQuad(host: string): boolean {
  const q = QUAD.exec(host);
  if (!q) return false;
  const [a, b] = [Number(q[1]), Number(q[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
export function originOk(o: string): boolean {
  if (!ORIGIN.test(o)) return false;
  const named = o.replace(/^[a-z]+:\/\//i, "").replace(/:\d+$/, "").toLowerCase();
  const wild = named.startsWith("*.");
  const host = wild ? named.slice(2) : named;
  let canonical: string;
  try { canonical = new URL(`https://${host}`).hostname; } catch { return false; }
  if (canonical !== host) return false;
  const labels = host.split(".");
  if (/^\d+$/.test(labels.at(-1)!)) {
    // A number for a last label is an address: only a dotted quad, of the public internet, never under a wildcard.
    if (wild || !QUAD.test(host) || host.split(".").some((n) => Number(n) > 255)) return false;
    return !privateQuad(host);
  }
  if (wild && labels.length < 2) return false;
  return !PRIVATE_NAME.test(host);
}
const origins = (l: string[] | undefined) => [...new Set((l ?? []).map((o) => o.trim().replace(/\/+$/, "")).filter(originOk))];
// What of a declared policy the frame applies (the host tells the app, as hostCapabilities.sandbox.csp).
export function appliedCsp(csp: AppCsp | undefined): AppCsp {
  const out: AppCsp = {};
  for (const k of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const) { const l = origins(csp?.[k]); if (l.length) out[k] = l; }
  return out;
}

// The frame's content policy, sent as the page's header. The page runs in a
// sandbox of its own with scripts only, in an opaque origin (no same-origin:
// it reads nothing of the daemon's, no cookie, no storage of Keel's), and
// reaches only what its server declared: scripts, styles, images, fonts and
// media from its resource origins, requests to its connect origins, frames
// of its frame origins, a base URI of its base origins. Nothing declared is
// nothing at all: the spec's default policy, without 'self', since the page
// is served by the daemon and 'self' would be the daemon.
export function appCsp(csp: AppCsp | undefined): string {
  const res = origins(csp?.resourceDomains), con = origins(csp?.connectDomains), fr = origins(csp?.frameDomains), base = origins(csp?.baseUriDomains);
  const src = (extra: string[]) => [...extra, ...res].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${src(["'unsafe-inline'"])}`,
    `style-src ${src(["'unsafe-inline'"])}`,
    `img-src ${src(["data:", "blob:"])}`,
    `font-src ${src(["data:"])}`,
    `media-src ${src(["data:", "blob:"])}`,
    `connect-src ${con.length ? con.join(" ") : "'none'"}`,
    `frame-src ${fr.length ? fr.join(" ") : "'none'"}`,
    `base-uri ${base.length ? base.join(" ") : "'none'"}`,
    "form-action 'none'",
    "object-src 'none'",
    "worker-src 'none'",
  ].join("; ");
}

// One call an app made, as its card shows it (src/server/routes/mcp-apps.ts keeps them).
export type AppCallRow = { id: string; app: string; seq: number; tool: string; input: unknown; state: "running" | "ok" | "error" | "denied" | "refused"; text: string; started: number; ended?: number };

// ---- the app's messages to the host

// What the host does with one message from the app. Only the methods of the
// spec's set that this host offers are answered: the app's own handshake, a
// call of a tool of its own server, a message to the model (shown to the
// owner as the app's, never as the owner's words), a link to open (on the
// owner's press), its size, its log, a ping and a display mode (inline only).
// Anything else is refused, a request with the JSON-RPC error for an unknown
// method, a notification by being dropped.
export type AppAsk =
  | { kind: "initialize"; id: Id }
  | { kind: "call"; id: Id; name: string; arguments: Record<string, unknown> }
  | { kind: "message"; id: Id; text: string }
  | { kind: "link"; id: Id; url: string }
  | { kind: "mode"; id: Id; mode: string }
  | { kind: "ping"; id: Id }
  | { kind: "initialized" }
  | { kind: "size"; height?: number; width?: number }
  | { kind: "log"; level: string; data: unknown }
  | { kind: "reply"; id: Id; result?: unknown; error?: unknown }
  | { kind: "refuse"; id: Id; code: number; message: string }
  | { kind: "drop"; why: string };
type Id = string | number;

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
// A message's words to the model, at most: the cap an outside event has (src/mcp/channel.ts CONTENT_MAX).
export const MESSAGE_MAX = 16 * 1024;
// A link the app may ask to open: a web page, nothing that runs a program or reads a file.
const LINK = /^https?:\/\/[^\s]+$/i;

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function readAppMessage(m: unknown): AppAsk {
  if (!obj(m) || m.jsonrpc !== "2.0") return { kind: "drop", why: "not JSON-RPC 2.0" };
  const id = m.id;
  const hasId = typeof id === "string" || typeof id === "number";
  if (typeof m.method !== "string") {
    // An answer to a request of the host's (its teardown).
    if (hasId && ("result" in m || "error" in m)) return { kind: "reply", id: id as Id, result: m.result, error: m.error };
    return { kind: "drop", why: "neither a request nor an answer" };
  }
  const p = obj(m.params) ? m.params : {};
  const bad = (message: string): AppAsk => (hasId ? { kind: "refuse", id: id as Id, code: INVALID_PARAMS, message } : { kind: "drop", why: message });
  if (!hasId) {
    if (m.method === "ui/notifications/initialized") return { kind: "initialized" };
    if (m.method === "ui/notifications/size-changed") {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
      return { kind: "size", ...(n(p.height) !== undefined ? { height: n(p.height) } : {}), ...(n(p.width) !== undefined ? { width: n(p.width) } : {}) };
    }
    if (m.method === "notifications/message") return { kind: "log", level: typeof p.level === "string" ? p.level : "info", data: p.data };
    return { kind: "drop", why: `the host takes no notification ${m.method.slice(0, 80)}` };
  }
  const rid = id as Id;
  switch (m.method) {
    case "ui/initialize": return { kind: "initialize", id: rid };
    case "ping": return { kind: "ping", id: rid };
    case "tools/call": {
      if (typeof p.name !== "string" || !p.name) return bad("tools/call needs the tool's name");
      if (p.arguments !== undefined && !obj(p.arguments)) return bad("tools/call takes its arguments as an object");
      return { kind: "call", id: rid, name: p.name, arguments: (p.arguments as Record<string, unknown>) ?? {} };
    }
    case "ui/message": {
      if (p.role !== undefined && p.role !== "user") return bad("ui/message takes the role user only");
      const content = Array.isArray(p.content) ? p.content : obj(p.content) ? [p.content] : [];
      const text = content.filter((c): c is { type: "text"; text: string } => obj(c) && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n\n").trim();
      if (!text) return bad("ui/message needs text content");
      if (text.length > MESSAGE_MAX) return bad(`ui/message holds at most ${MESSAGE_MAX} characters`);
      return { kind: "message", id: rid, text };
    }
    case "ui/open-link": {
      if (typeof p.url !== "string" || !LINK.test(p.url)) return bad("ui/open-link takes an http or https URL");
      try { new URL(p.url); } catch { return bad("ui/open-link takes an http or https URL"); }
      return { kind: "link", id: rid, url: p.url };
    }
    case "ui/request-display-mode": return { kind: "mode", id: rid, mode: typeof p.mode === "string" ? p.mode : "inline" };
    default:
      return { kind: "refuse", id: rid, code: METHOD_NOT_FOUND, message: `the host does not offer ${m.method.slice(0, 80)}` };
  }
}

// How tall the frame is drawn, in CSS pixels: what the app asks for, within
// bounds. The least keeps its status line readable; the most is a share of
// the window it is drawn in, so one app never pushes the conversation off the
// screen (an app taller than that scrolls inside its frame).
export const APP_MIN_PX = 48;
export const APP_MAX_SHARE = 0.7;
export function frameHeight(asked: number | undefined, viewport: number, fallback = 160): number {
  const max = Math.max(APP_MIN_PX, Math.round(viewport * APP_MAX_SHARE));
  const want = asked === undefined || !Number.isFinite(asked) ? fallback : asked;
  return Math.round(Math.min(max, Math.max(APP_MIN_PX, want)));
}
