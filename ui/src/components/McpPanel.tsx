import { Collapsible } from "@base-ui/react/collapsible";
import { Dialog } from "@base-ui/react/dialog";
import { Switch } from "@base-ui/react/switch";
import { Tabs } from "@base-ui/react/tabs";
import { ChevronRight, Download, Globe, KeyRound, LogOut, Plug, RefreshCw, RotateCw, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { McpServerState } from "../../../src/mcp/manager.ts";
import type { ImportableServer } from "../../../src/mcp/config.ts";
import { reportError } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

// A command line to argv: spaces split, quotes group.
function argv(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const DOT: Record<McpServerState["state"], string> = {
  ready: "bg-ok",
  connecting: "bg-accent animate-pulse-dot",
  error: "bg-danger",
  needs_auth: "bg-warn",
  disabled: "bg-line-strong",
  idle: "bg-ok/50",
  missing: "bg-warn",
};
const LABEL: Record<McpServerState["state"], string> = {
  ready: "Ready",
  connecting: "Connecting",
  error: "Failed",
  needs_auth: "Needs sign-in",
  disabled: "Off",
  idle: "Starts on first use",
  missing: "Not installed",
};

function IconButton({ title, onClick, children, danger, testid }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; testid?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testid}
      onClick={onClick}
      className={cn("grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-hover", danger ? "hover:text-danger" : "hover:text-fg")}
    >
      {children}
    </button>
  );
}

function ServerRow({ s, act }: { s: McpServerState; act: (path: string, body?: unknown, method?: string) => Promise<void> }) {
  const base = `/api/mcp/servers/${encodeURIComponent(s.name)}`;
  const shown = s.tool_names.slice(0, 10);
  return (
    <div data-testid="mcp-server" data-name={s.name} data-state={s.state} className="group rounded-xl border border-line bg-raised px-3.5 py-3 transition-colors hover:border-line-strong">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[s.state])} title={LABEL[s.state]} />
        <span className="font-medium text-ui">{s.name}</span>
        {s.bundled && (
          <span data-testid="mcp-bundled" title="Keel brings this server itself: every session has it, no setup" className="shrink-0 whitespace-nowrap rounded-md bg-accent-soft px-1.5 py-px text-micro font-medium text-accent">
            Built in · {s.bundled}
          </span>
        )}
        <span className="inline-flex items-center gap-1 rounded-md bg-panel px-1.5 py-px text-micro text-muted">
          {s.transport === "http" ? <Globe className="size-3" /> : <SquareTerminal className="size-3" />}
          {s.transport}
        </span>
        <span className="whitespace-nowrap text-caption text-faint tabular-nums" data-testid="mcp-tool-count">
          {s.state === "ready" || s.state === "idle" ? `${s.tools} tool${s.tools === 1 ? "" : "s"}` : LABEL[s.state]}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {(s.state === "needs_auth" || (s.sign_in && !s.signed_in && s.state === "error")) && (
            <button
              type="button"
              data-testid="mcp-sign-in"
              onClick={async () => {
                const r = await api<{ url: string }>(`${base}/sign-in`, { method: "POST" }).catch((e) => (reportError(e), null));
                if (r?.url) window.open(r.url, "_blank", "noopener");
              }}
              className="mr-1 inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-caption font-medium text-accent-fg hover:opacity-90"
            >
              <KeyRound className="size-3.5" /> Sign in
            </button>
          )}
          {s.signed_in && (
            <IconButton title="Sign out" onClick={() => act(`${base}/sign-out`)}><LogOut className="size-3.5" /></IconButton>
          )}
          <IconButton title="Reconnect" testid="mcp-reconnect" onClick={() => act(`${base}/reconnect`)}><RotateCw className="size-3.5" /></IconButton>
          {!s.bundled && <IconButton title="Remove" danger onClick={() => act(base, undefined, "DELETE")}><Trash2 className="size-3.5" /></IconButton>}
          <Switch.Root
            data-testid="mcp-toggle"
            checked={s.enabled}
            onCheckedChange={(on) => act(`${base}/toggle`, { enabled: on })}
            aria-label={`Turn ${s.name} ${s.enabled ? "off" : "on"}`}
            className="relative ml-1.5 flex h-5 w-9 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-150 data-checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Switch.Thumb className="size-4 rounded-full bg-raised shadow-3 transition-transform duration-150 data-checked:translate-x-4" />
          </Switch.Root>
        </span>
      </div>
      <div className="mt-1.5 truncate pl-[18px] font-mono text-micro text-faint" title={s.target}>{s.target}</div>
      {s.error && s.state !== "disabled" && (
        <div className={cn("mt-2 ml-[18px] rounded-md", s.state === "missing" ? "bg-warn/12 text-muted" : "bg-danger-soft text-danger", " px-2 py-1.5 font-mono text-micro leading-relaxed whitespace-pre-wrap break-words")} data-testid="mcp-error">
          {s.error.slice(0, 600)}
        </div>
      )}
      {(s.state === "ready" || s.state === "idle") && shown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 pl-[18px]">
          {shown.map((t) => (
            <span key={t} className="rounded-md border border-line px-1.5 py-px font-mono text-micro text-muted">{t}</span>
          ))}
          {s.tool_names.length > shown.length && <span className="px-1 text-micro text-faint">+{s.tool_names.length - shown.length} more</span>}
        </div>
      )}
      {s.state === "ready" && s.last_connected && (
        <div className="mt-1.5 pl-[18px] text-micro text-faint">
          {s.server_info?.name ? `${s.server_info.name}${s.server_info.version ? ` ${s.server_info.version}` : ""} · ` : ""}MCP {s.version} · connected {ago(s.last_connected)}
        </div>
      )}
    </div>
  );
}

const input = "h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-ui outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20";

function AddForm({ onAdded }: { onAdded: (servers: McpServerState[]) => void }) {
  const [kind, setKind] = useState<"command" | "url">("command");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const words = argv(target.trim());
    const body = kind === "command" ? { name: name.trim(), command: words[0], args: words.slice(1) } : { name: name.trim(), url: target.trim() };
    try {
      const r = await api<{ servers: McpServerState[] }>("/api/mcp/servers", { method: "POST", body: JSON.stringify(body) });
      setName("");
      setTarget("");
      onAdded(r.servers);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="rounded-xl border border-dashed border-line-strong p-3.5" data-testid="mcp-add">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="text-ui font-medium">Add a server</span>
        <Tabs.Root value={kind} onValueChange={(v) => setKind(v as "command" | "url")}>
          <Tabs.List className="relative flex rounded-lg bg-panel p-0.5 text-caption">
            {(["command", "url"] as const).map((k) => (
              <Tabs.Tab
                key={k}
                value={k}
                data-testid={`mcp-add-${k}-tab`}
                className="relative z-10 rounded-md px-2.5 py-0.5 text-muted outline-none transition-colors data-active:text-fg focus-visible:ring-2 focus-visible:ring-accent/30"
              >
                {k === "command" ? "Local command" : "Remote URL"}
              </Tabs.Tab>
            ))}
            <Tabs.Indicator className="absolute top-0.5 left-0 h-[calc(100%-4px)] w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md bg-raised shadow-3 transition-[translate,width] duration-150" />
          </Tabs.List>
        </Tabs.Root>
      </div>
      <div className="flex gap-2">
        <input data-testid="mcp-add-name" className={cn(input, "w-40 shrink-0")} placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          data-testid="mcp-add-target"
          className={cn(input, "font-mono text-caption")}
          placeholder={kind === "command" ? "npx -y @modelcontextprotocol/server-everything" : "https://example.com/mcp"}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <button
          type="submit"
          data-testid="mcp-add-submit"
          disabled={!name.trim() || !target.trim()}
          className="h-8 shrink-0 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Add
        </button>
      </div>
      {err && <p className="mt-2 text-caption text-danger">{err}</p>}
    </form>
  );
}

// The same server is often configured in several agents: one row each, with
// the agents that hold it as chips. Collapsed once keel has servers of its own.
function ImportList({ items, onImport, open }: { items: ImportableServer[]; onImport: (i: ImportableServer) => void; open: boolean }) {
  if (!items.length) return null;
  const target = (i: ImportableServer) => i.config.url ?? [i.config.command, ...(i.config.args ?? [])].join(" ");
  const rows = new Map<string, { first: ImportableServer; labels: string[]; configured: boolean }>();
  for (const i of items) {
    const k = `${i.name}\u0000${target(i)}`;
    const r = rows.get(k);
    if (r) { r.labels.push(i.label); r.configured ||= i.configured; }
    else rows.set(k, { first: i, labels: [i.label], configured: i.configured });
  }
  const list = [...rows.values()].sort((a, b) => Number(a.configured) - Number(b.configured) || a.first.name.localeCompare(b.first.name));
  const available = list.filter((r) => !r.configured).length;
  return (
    <Collapsible.Root defaultOpen={open} className="group/imp" data-testid="mcp-importable">
      <Collapsible.Trigger className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
        <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/imp:rotate-90" />
        <span className="text-caption font-medium uppercase tracking-wide text-faint">Import from other agents</span>
        <span className="text-caption text-faint tabular-nums">{available} available</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-1.5 overflow-hidden rounded-xl border border-line">
        {list.map(({ first: i, labels, configured }) => (
          <div key={i.source + i.name} className="flex items-center gap-2.5 border-b border-line bg-raised px-3 py-2 last:border-b-0">
            {i.config.url ? <Globe className="size-3.5 shrink-0 text-faint" /> : <SquareTerminal className="size-3.5 shrink-0 text-faint" />}
            <span className="shrink-0 text-ui font-medium">{i.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint" title={target(i)}>{target(i)}</span>
            {labels.map((l) => (
              <span key={l} className="shrink-0 rounded-md bg-panel px-1.5 py-px text-micro text-muted">{l.replace(/^Claude Code \((.*)\)$/, "Claude · $1")}</span>
            ))}
            {configured ? (
              <span className="w-16 shrink-0 text-right text-caption text-faint">Added</span>
            ) : (
              <button
                type="button"
                data-testid="mcp-import"
                onClick={() => onImport(i)}
                className="inline-flex w-16 shrink-0 items-center justify-end gap-1 rounded-md px-1.5 py-0.5 text-caption text-accent hover:bg-accent-soft"
              >
                <Download className="size-3.5" /> Import
              </button>
            )}
          </div>
        ))}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function McpPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [servers, setServers] = useState<McpServerState[] | null>(null);
  const [importable, setImportable] = useState<ImportableServer[]>([]);
  const [note, setNote] = useState("");

  const load = useCallback(() => api<{ servers: McpServerState[] }>("/api/mcp/servers").then((r) => setServers(r.servers)).catch(reportError), []);
  const loadImportable = useCallback(() => api<{ servers: ImportableServer[] }>("/api/mcp/importable").then((r) => setImportable(r.servers)).catch(reportError), []);

  // States change on the daemon (connects, crashes); poll while the panel is open.
  useEffect(() => {
    if (!open) return;
    load();
    loadImportable();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [open, load, loadImportable]);

  const act = async (path: string, body?: unknown, method = "POST") => {
    try {
      const r = await api<{ servers: McpServerState[] }>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      setServers(r.servers);
      if (method === "DELETE") loadImportable();
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const ready = servers?.filter((s) => s.state === "ready") ?? [];
  const tools = ready.reduce((n, s) => n + s.tools, 0);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="mcp-panel"
          className={cn(
            "fixed right-4 top-4 bottom-4 z-50 flex w-[min(42rem,calc(100vw-2rem))] flex-col rounded-xl border border-line bg-bg shadow-3",
            "transition-[transform,opacity] duration-200 data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0",
          )}
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Plug className="size-4 text-muted" />
            <Dialog.Title className="shrink-0 whitespace-nowrap font-semibold">MCP servers</Dialog.Title>
            <span className="ml-1 min-w-0 truncate text-caption text-faint" data-testid="mcp-summary">
              {servers ? `${ready.length} of ${servers.length} ready · ${tools} tools, loaded on demand` : "Loading"}
            </span>
            <button
              type="button"
              title="Read mcp.json again"
              data-testid="mcp-reload"
              onClick={async () => {
                try {
                  const r = await api<{ line: string; servers: McpServerState[] }>("/api/mcp/reload", { method: "POST", body: "{}" });
                  setServers(r.servers);
                  setNote(r.line);
                } catch (e) {
                  setNote((e as Error).message);
                }
              }}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-caption text-muted hover:bg-hover hover:text-fg"
            >
              <RefreshCw className="size-3.5" /> Reload
            </button>
            <Dialog.Close className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          {note && (
            <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-caption text-muted">
              <span className="min-w-0 flex-1 truncate">{note}</span>
              <button type="button" onClick={() => setNote("")} className="text-faint hover:text-fg"><X className="size-3.5" /></button>
            </div>
          )}
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className="space-y-2" data-testid="mcp-servers">
              {servers?.length === 0 && (
                <div className="rounded-xl border border-line bg-raised px-4 py-6 text-center">
                  <p className="text-ui font-medium">No servers yet</p>
                  <p className="mt-1 text-caption text-faint">Add one below or import what Claude Code and Codex already use. Their tools stay out of every request until the model searches for them.</p>
                </div>
              )}
              {servers?.map((s) => <ServerRow key={s.name} s={s} act={act} />)}
            </div>
            <AddForm onAdded={(s) => { setServers(s); loadImportable(); }} />
            <ImportList
              key={servers ? (servers.length ? "has" : "none") : "loading"}
              open={servers?.length === 0}
              items={importable}
              onImport={async (i) => {
                await act("/api/mcp/import", { source: i.source, name: i.name });
                loadImportable();
              }}
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
