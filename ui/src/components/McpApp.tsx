// An MCP App beside the call that drew it (src/mcp/apps.ts, kept by
// src/server/routes/mcp-apps.ts). The page runs in a frame with scripts only
// and no same origin, under its server's declared origins; the page here is
// its host. Its messages are read by `readAppMessage` and nothing else is
// answered: a call goes to the daemon under this app's id (its own server
// only, through the permission gate), a message to the model goes in as the
// app's, shown to the owner, and a link opens only when the owner presses
// Open. A message comes only from this frame's own window.
import { AppWindow, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APP_PROTOCOL, frameHeight, readAppMessage } from "../../../src/mcp/apps.ts";
import { useMcpApp, type AppCallRow } from "../lib/mcp-apps.ts";
import { api } from "../lib/store.ts";
import { isDark } from "../lib/ui.ts";
import { ContentFrame } from "./ContentFrame.tsx";
import { Under } from "./ToolCall.tsx";

export type AppShown = { id: string; server: string; tool: string; uri: string; error?: string };

// The host's look, as the spec names its variables: the app may draw with them.
const VARS: Record<string, string> = {
  "--color-background-primary": "--raised", "--color-background-secondary": "--sunken", "--color-background-tertiary": "--panel",
  "--color-background-danger": "--danger-soft", "--color-text-primary": "--fg", "--color-text-secondary": "--muted",
  "--color-text-tertiary": "--faint", "--color-text-danger": "--danger-ink", "--color-text-success": "--ok-ink", "--color-text-warning": "--warn-ink",
  "--color-border-primary": "--line-strong", "--color-border-secondary": "--line", "--color-ring-primary": "--ring",
  "--color-background-inverse": "--fg", "--color-text-inverse": "--bg", "--color-border-danger": "--danger", "--color-ring-danger": "--danger",
  "--font-sans": "--font-sans", "--font-mono": "--font-mono", "--font-text-xs-size": "--text-micro", "--font-text-sm-size": "--text-caption", "--font-text-md-size": "--text-ui",
  "--border-radius-xs": "--radius-xs", "--border-radius-sm": "--radius-sm", "--border-radius-md": "--radius-md", "--border-radius-lg": "--radius-xl",
  "--shadow-sm": "--shadow-1", "--shadow-md": "--shadow-2", "--shadow-lg": "--shadow-3",
};
const looks = () => {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(VARS).map(([k, v]) => [k, cs.getPropertyValue(v).trim()]).filter(([, v]) => v));
};
const theme = () => (isDark() ? "dark" : "light");
const context = (width: number) => ({
  theme: theme(), styles: { variables: looks() }, displayMode: "inline", availableDisplayModes: ["inline"],
  containerDimensions: { width, maxHeight: frameHeight(Infinity, window.innerHeight) }, locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: "web",
});

const STATE: Record<AppCallRow["state"], { name: string; tone?: "fail" | "warn" | "note" }> = {
  running: { name: "Calling", tone: "note" }, ok: { name: "Called" }, error: { name: "Failed", tone: "fail" }, denied: { name: "Denied", tone: "warn" }, refused: { name: "Refused", tone: "warn" },
};

export function McpApp({ sessionId, shown }: { sessionId?: string; shown: AppShown }) {
  const { app, calls, failed } = useMcpApp(sessionId, shown.id);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const [link, setLink] = useState<{ url: string; answer: (opened: boolean) => void } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const base = sessionId ? `/api/sessions/${sessionId}/mcp-apps/${encodeURIComponent(shown.id)}` : "";
  const error = shown.error ?? app?.error ?? failed;
  const usable = !!app?.page && !!sessionId;

  useEffect(() => {
    if (!usable) return;
    const win = () => frame.current?.contentWindow ?? null;
    const post = (m: unknown) => win()?.postMessage(m, "*");
    const answer = (id: string | number, result: unknown) => post({ jsonrpc: "2.0", id, result });
    const refuse = (id: string | number, code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });
    let initialized = false, lastSaved = 0, saveTimer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = async (e: MessageEvent) => {
      // Only this frame's own page speaks to its host; any other window's message is not read.
      if (!win() || e.source !== win()) return;
      const m = readAppMessage(e.data);
      switch (m.kind) {
        case "initialize":
          return answer(m.id, {
            protocolVersion: APP_PROTOCOL, hostInfo: { name: "keel", version: "1" },
            hostCapabilities: { serverTools: {}, openLinks: {}, logging: {}, message: { text: {} }, sandbox: { permissions: {}, csp: app!.csp } },
            hostContext: { ...context(box.current?.clientWidth ?? 640), toolInfo: { tool: { name: app!.tool } } },
          });
        case "initialized":
          if (initialized) return;
          initialized = true;
          setReady(true);
          post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: app!.input ?? {} } });
          if (app!.result) post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: app!.result });
          return;
        case "ping": return answer(m.id, {});
        case "mode": return answer(m.id, { mode: "inline" });
        case "size": {
          if (m.height === undefined) return;
          const h = frameHeight(m.height, window.innerHeight);
          setHeight(h);
          // The last height asked for is kept, so a reload draws the frame at it before the app speaks.
          clearTimeout(saveTimer);
          if (Math.abs(h - lastSaved) >= 1) saveTimer = setTimeout(() => { lastSaved = h; api(`${base}/height`, { method: "PUT", body: JSON.stringify({ height: m.height }) }).catch(() => {}); }, 400);
          return;
        }
        case "log": return;
        case "call": {
          try {
            const r = await api<{ result?: unknown; refused?: string }>(`${base}/call`, { method: "POST", body: JSON.stringify({ name: m.name, arguments: m.arguments }) });
            return r.refused !== undefined ? refuse(m.id, -32000, r.refused) : answer(m.id, r.result);
          } catch (err) {
            return refuse(m.id, -32603, (err as Error).message);
          }
        }
        case "message": {
          try {
            const r = await api<{ state: string }>(`${base}/message`, { method: "POST", body: JSON.stringify({ text: m.text }) });
            setSaid(r.state === "held" ? "The app's message waits: you stopped this session." : null);
            return answer(m.id, {});
          } catch (err) {
            return refuse(m.id, -32000, `Message sending denied: ${(err as Error).message}`);
          }
        }
        case "link":
          // Opened only on the owner's own press; a new ask takes the place of one not answered.
          return setLink((was) => { was?.answer(false); return { url: m.url, answer: (opened) => (opened ? answer(m.id, {}) : refuse(m.id, -32000, "Link opening denied by user")) }; });
        case "reply": case "drop": return;
        case "refuse": return refuse(m.id, m.code, m.message);
      }
    };
    window.addEventListener("message", onMessage);
    // The owner's theme, as it changes.
    let was = theme();
    const watch = new MutationObserver(() => {
      const now = theme();
      if (now === was || !initialized) return;
      was = now;
      post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: now, styles: { variables: looks() } } });
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { window.removeEventListener("message", onMessage); watch.disconnect(); clearTimeout(saveTimer); };
  }, [usable, base, app]);

  const drawn = height ?? (app?.height ? frameHeight(app.height, window.innerHeight) : null);
  const open = (opened: boolean) => {
    if (!link) return;
    if (opened) window.open(link.url, "_blank", "noopener,noreferrer");
    link.answer(opened);
    setLink(null);
  };
  return (
    <div ref={box} className="k-mcpapp" data-testid="mcp-app" data-app={shown.id} data-state={error ? "error" : !app ? "loading" : ready ? "ready" : "loading"}>
      <div className="k-mcpapp-head">
        <AppWindow className="size-3.5 text-faint" aria-hidden />
        <span className="k-mcpapp-name" data-testid="mcp-app-server">{shown.server}</span>
        <span className="k-mcpapp-uri" title={shown.uri}>{shown.uri}</span>
        <span className="k-mcpapp-note">an app of the server, not Keel's</span>
      </div>
      {error ? (
        <p className="k-mcpapp-status" data-tone="fail" role="status" data-testid="mcp-app-error">The app could not be drawn: {error}</p>
      ) : !sessionId || (app && !app.page) ? null : (
        <div className="k-mcpapp-frame" data-border={app?.prefers_border === false ? undefined : ""} style={drawn ? { height: `${drawn}px` } : undefined}>
          {app && (
            <ContentFrame what="app" frameRef={frame} title={`${shown.server} app`} src={`${base}/page`} sandbox="allow-scripts" referrerPolicy="no-referrer"
              className="block size-full bg-transparent" data-testid="mcp-app-frame" />
          )}
          {!ready && <p className="k-mcpapp-status k-mcpapp-loading" role="status" data-testid="mcp-app-loading">Loading app</p>}
        </div>
      )}
      {link && (
        <div className="k-mcpapp-ask" data-testid="mcp-app-link" role="group" aria-label="The app asks to open a link">
          <ExternalLink className="size-3.5 shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 flex-1">The app asks to open <span className="k-under-code break-all" data-testid="mcp-app-link-url">{link.url}</span></span>
          <button type="button" className="k-btn" data-testid="mcp-app-link-open" onClick={() => open(true)}>Open</button>
          <button type="button" className="k-btn" data-testid="mcp-app-link-dismiss" onClick={() => open(false)}>Dismiss</button>
        </div>
      )}
      {said && <p className="k-mcpapp-status" data-tone="warn" data-testid="mcp-app-said">{said}</p>}
      {calls.length > 0 && (
        <div className="k-under" data-testid="mcp-app-calls">
          {calls.map((c) => (
            <Under key={c.id} name={STATE[c.state].name} tone={STATE[c.state].tone} testid="mcp-app-call">
              <span data-state={c.state} data-tool={c.tool}><span className="k-under-code">{c.tool}</span>{c.text ? ` · ${c.text.split("\n")[0]}` : ""}</span>
            </Under>
          ))}
        </div>
      )}
    </div>
  );
}
