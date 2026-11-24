import { expect, test } from "bun:test";
import { appCsp, appliedCsp, appUriOf, frameHeight, METHOD_NOT_FOUND, INVALID_PARAMS, originOk, readAppMessage, resourceMetaOf, visibleTo } from "./apps.ts";

const req = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const note = (method: string, params?: unknown) => ({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });

test("the host answers the spec's set and refuses every other method", () => {
  expect(readAppMessage(req("ui/initialize", { protocolVersion: "2026-01-26" }))).toEqual({ kind: "initialize", id: 1 });
  expect(readAppMessage(req("ping"))).toEqual({ kind: "ping", id: 1 });
  expect(readAppMessage(req("tools/call", { name: "tally", arguments: { team: "blue" } }))).toEqual({ kind: "call", id: 1, name: "tally", arguments: { team: "blue" } });
  expect(readAppMessage(req("ui/open-link", { url: "https://example.com/rules" }))).toEqual({ kind: "link", id: 1, url: "https://example.com/rules" });
  expect(readAppMessage(req("ui/message", { role: "user", content: [{ type: "text", text: "blue leads" }] }))).toEqual({ kind: "message", id: 1, text: "blue leads" });
  expect(readAppMessage(req("ui/request-display-mode", { mode: "fullscreen" }))).toEqual({ kind: "mode", id: 1, mode: "fullscreen" });
  expect(readAppMessage(note("ui/notifications/initialized"))).toEqual({ kind: "initialized" });
  expect(readAppMessage(note("ui/notifications/size-changed", { height: 212, width: 600 }))).toEqual({ kind: "size", height: 212, width: 600 });
  expect(readAppMessage(note("notifications/message", { level: "info", data: "x" }))).toEqual({ kind: "log", level: "info", data: "x" });
  expect(readAppMessage({ jsonrpc: "2.0", id: 7, result: {} })).toEqual({ kind: "reply", id: 7, result: {}, error: undefined });
  // What the host does not offer: the daemon's own methods, another session's, a server's own requests, a model context.
  for (const m of ["sessions/list", "api/fetch", "resources/read", "resources/list", "sampling/createMessage", "elicitation/create", "ui/update-model-context", "tools/list", "keel/anything"]) {
    const r = readAppMessage(req(m, {}));
    expect(r.kind).toBe("refuse");
    expect((r as { code: number }).code).toBe(METHOD_NOT_FOUND);
  }
  // A notification the host does not take is dropped, never acted on.
  expect(readAppMessage(note("notifications/tools/list_changed")).kind).toBe("drop");
  // Not JSON-RPC at all.
  for (const m of [null, "tools/call", 3, [], { id: 1, method: "tools/call" }, { jsonrpc: "1.0", id: 1, method: "ping" }]) expect(readAppMessage(m).kind).toBe("drop");
});

test("the allowed methods take only their own shapes", () => {
  const bad = (m: unknown) => { const r = readAppMessage(m); expect(r.kind).toBe("refuse"); expect((r as { code: number }).code).toBe(INVALID_PARAMS); };
  bad(req("tools/call", {}));
  bad(req("tools/call", { name: "x", arguments: [1] }));
  // A link is a web page only: no script, no file, no other scheme, no relative path.
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "/api/sessions", "ftp://x", "https://exa mple.com"]) bad(req("ui/open-link", { url }));
  // A message is the user's role, in text, and short enough.
  bad(req("ui/message", { role: "assistant", content: [{ type: "text", text: "x" }] }));
  bad(req("ui/message", { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] }));
  bad(req("ui/message", { role: "user", content: [{ type: "text", text: "x".repeat(16 * 1024 + 1) }] }));
});

test("the frame's policy reaches only the origins its server declared", () => {
  const none = appCsp(undefined);
  expect(none).toContain("sandbox allow-scripts");
  expect(none).toContain("default-src 'none'");
  expect(none).toContain("connect-src 'none'");
  expect(none).toContain("frame-src 'none'");
  expect(none).toContain("form-action 'none'");
  // Never the daemon's own origin: the page is served by it.
  expect(none).not.toContain("'self'");
  expect(none).not.toContain("allow-same-origin");
  const some = appCsp({ connectDomains: ["https://api.example.com", "wss://live.example.com"], resourceDomains: ["https://cdn.example.com/"], frameDomains: ["https://*.player.example"] });
  expect(some).toContain("connect-src https://api.example.com wss://live.example.com");
  expect(some).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
  expect(some).toContain("img-src data: blob: https://cdn.example.com;");
  expect(some).toContain("frame-src https://*.player.example");
  // What would widen it, end a directive or reach this machine is left out.
  const wide = appCsp({ connectDomains: ["*", "'self'", "https:", "http://api.example.com", "https://x.com; script-src *", "http://127.0.0.1:47950", "https://localhost", "https://10.0.0.2", "https://printer.local", "https://192.168.1.4:8443"] });
  expect(wide).toContain("connect-src 'none'");
  for (const o of ["https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://keel.localhost", "https://2130706433"]) expect(originOk(o)).toBe(false);
  expect(originOk("https://api.example.com:8443")).toBe(true);
  // What the host tells the app it applied is the same list, without what it left out.
  expect(appliedCsp({ connectDomains: ["https://api.example.com/", "*", "http://127.0.0.1:1"], frameDomains: ["'self'"] })).toEqual({ connectDomains: ["https://api.example.com"] });
});

test("a tool's app and who may call it", () => {
  expect(appUriOf({ _meta: { ui: { resourceUri: "ui://board/app.html" } } })).toBe("ui://board/app.html");
  expect(appUriOf({ _meta: { "ui/resourceUri": "ui://old/app.html" } })).toBe("ui://old/app.html");
  expect(appUriOf({ _meta: { ui: { resourceUri: "https://evil.example/app.html" } } })).toBeUndefined();
  expect(appUriOf({})).toBeUndefined();
  expect(visibleTo({}, "model")).toBe(true);
  expect(visibleTo({ _meta: { ui: { visibility: ["app"] } } }, "model")).toBe(false);
  expect(visibleTo({ _meta: { ui: { visibility: ["app"] } } }, "app")).toBe(true);
  expect(visibleTo({ _meta: { ui: { visibility: ["model"] } } }, "app")).toBe(false);
  expect(resourceMetaOf({ ui: { prefersBorder: false, csp: { connectDomains: ["https://a.example", 3], other: ["x"] } } })).toEqual({ prefersBorder: false, csp: { connectDomains: ["https://a.example"] } });
});

test("the frame is as tall as the app asks, within its bounds", () => {
  expect(frameHeight(212, 1000)).toBe(212);
  expect(frameHeight(3, 1000)).toBe(48);
  expect(frameHeight(5000, 1000)).toBe(700);
  expect(frameHeight(undefined, 1000)).toBe(160);
  expect(frameHeight(Number.NaN, 1000)).toBe(160);
});
