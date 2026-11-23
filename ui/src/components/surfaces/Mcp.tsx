// Settings > MCP servers: every server Keel connects to, its state and
// error, sign-in, its tools (each one a read or not), what else it publishes,
// adding one (a local command or a remote URL) and importing what the other
// harnesses already use. /mcp and the palette open it.
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, Download, Eye, Globe, KeyRound, LogOut, RefreshCw, RotateCw, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ImportableServer } from "../../../../src/mcp/config.ts";
import type { McpServerState } from "../../../../src/mcp/manager.ts";
import type { ProjectServer, ProjectState } from "../../../../src/mcp/project.ts";
import { api, reportError, failed, useStore } from "../../lib/store.ts";
import type { Outcome } from "../../../../src/mcp/channel.ts";
import { ownerStop } from "../../../../src/core/stoppers.ts";
import { Select } from "../Select.tsx";
import { ago, cn, when } from "../../lib/utils.ts";
import { Connect } from "./McpConnect.tsx";
import { navigate } from "../../lib/ui.ts";
import { STATE_WORD } from "../../../../src/core/state-words.ts";
import { Blank, FolderLine, Ledger, ReaderHead, Seg, tail, tilde, Toggle, type Group, type Mark } from "./kit.tsx";

// A command line to argv: spaces split, quotes group.
function argv(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
// KEY=value lines (env) or Key: value lines (headers) to an object.
function pairs(text: string, sep: "=" | ":"): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const l of text.split("\n")) {
    const i = l.indexOf(sep);
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

const LABEL: Record<McpServerState["state"], string> = {
  ready: "Ready", connecting: "Connecting", error: "Failed", needs_auth: "Needs sign-in", disabled: "Off", idle: "Starts on first use",
  missing: "Not installed", armed: "Armed on the phone", not_armed: "Not armed", unreachable: "Gateway not answering",
};
export const mcpMark = (s: McpServerState): Mark =>
  s.state === "needs_auth" ? "need" : s.state === "connecting" ? "work" : s.state === "error" || s.state === "unreachable" ? "fail" : s.state === "disabled" || s.state === "missing" || s.state === "not_armed" ? "off" : "on";
// Tools are offered: a process that starts on first use, or phone control the owner armed.
const offered = (s: McpServerState) => s.state === "ready" || s.state === "idle" || s.state === "armed" || s.state === "not_armed";
const toolCount = (s: McpServerState) =>
  s.state === "armed" || s.state === "not_armed" ? `${LABEL[s.state]} · ${s.tools} tools` : s.state === "ready" || s.state === "idle" ? `${s.tools} tool${s.tools === 1 ? "" : "s"}` : LABEL[s.state];
type Act = (path: string, body?: unknown, method?: string) => Promise<void>;

function IconButton({ title, onClick, children, danger, testid }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean; testid?: string }) {
  return (
    <button type="button" title={title} aria-label={title} data-testid={testid} onClick={onClick}
      className={cn("grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-hover", danger ? "hover:text-danger" : "hover:text-fg")}>
      {children}
    </button>
  );
}

const PROJECT_LABEL: Record<ProjectServer["state"], string> = { approved: "Approved", rejected: "Rejected", pending: STATE_WORD.need, changed: "Changed since approved" };
const projectMark = (x: ProjectServer): Mark => (x.state === "approved" ? "on" : x.state === "rejected" ? "off" : "need");

// A server a project's .mcp.json names: what it runs, and the owner's decision.
function ProjectReader({ p, x, decide }: { p: ProjectState; x: ProjectServer; decide: (decision: "approved" | "rejected" | "forget") => void }) {
  const waiting = x.state === "pending" || x.state === "changed";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mcp-project-server" data-name={x.name} data-state={x.state}>
      <ReaderHead
        title={x.name}
        path={x.target}
        desc={waiting
          ? "This project's .mcp.json names this server. Keel starts it for the sessions working in the project only once you approve it, as it reads now: a change to its entry waits for you again."
          : x.state === "approved" ? "Sessions working in this project get it, inside their own sandbox. A change to its entry in .mcp.json waits for you again." : "It is never started for this project."}
        facts={[
          ["State", <span data-testid="mcp-project-state">{PROJECT_LABEL[x.state]}</span>],
          ["Project", tilde(p.root)],
          ...(x.by === "claude" ? [["Decided", "in Claude Code"] as [string, React.ReactNode]] : []),
        ]}
      >
        {/* The whole entry as the file holds it, unexpanded: what an approval holds. */}
        <div className="k-sub k-label mt-3">The entry in .mcp.json</div>
        <pre className="mt-1 max-h-[24rem] overflow-auto rounded-lg bg-code px-2.5 py-1.5 font-mono text-micro whitespace-pre-wrap break-all" data-testid="mcp-project-entry-text">{JSON.stringify(x.entry, null, 2)}</pre>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {x.state !== "approved" && <button type="button" className="k-btn" data-ink data-testid="mcp-project-approve" onClick={() => decide("approved")}>Approve</button>}
          {x.state !== "rejected" && <button type="button" className="k-btn" data-quiet data-testid="mcp-project-reject" onClick={() => decide("rejected")}>Reject</button>}
          {!waiting && <button type="button" className="k-btn" data-quiet data-testid="mcp-project-forget" onClick={() => decide("forget")}>Ask again</button>}
        </div>
      </ReaderHead>
    </div>
  );
}

function ServerReader({ s, act }: { s: McpServerState; act: Act }) {
  const base = `/api/mcp/servers/${encodeURIComponent(s.name)}`;
  const canSignIn = s.state === "needs_auth" || (s.sign_in && !s.signed_in && s.state === "error");
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mcp-server" data-name={s.name} data-state={s.state}>
      <ReaderHead
        title={s.name}
        path={s.target}
        right={s.plugin ? undefined : <span data-testid="mcp-toggle-wrap"><Toggle testid="mcp-toggle" on={s.enabled} label={`Turn ${s.name} ${s.enabled ? "off" : "on"}`} onChange={(on) => act(`${base}/toggle`, { enabled: on })} /></span>}
        facts={[
          ["State", LABEL[s.state]],
          ["Tools", <span data-testid="mcp-tool-count">{toolCount(s)}</span>],
          ["Transport", s.sse ? "http, SSE (older)" : s.transport],
          ...(s.bundled ? [["Source", <span data-testid="mcp-bundled">Built in · {s.bundled}</span>] as [string, React.ReactNode]] : []),
          ...(s.plugin ? [["Source", <button type="button" className="underline decoration-line-strong underline-offset-2 hover:text-accent" data-testid="mcp-plugin" onClick={() => navigate({ name: "settings", section: "plugins" })}>Plugin · {s.plugin}</button>] as [string, React.ReactNode]] : []),
          ...(s.sync ? [["Follows", <span data-testid="mcp-sync" data-gone={s.sync.gone || undefined}>{s.sync.label}{s.sync.name !== s.name ? ` (${s.sync.name})` : ""}{s.sync.gone ? ", which no longer has it" : ""}</span>] as [string, React.ReactNode]] : []),
          ...(s.state === "ready" && s.server_info?.name ? [["Server", `${s.server_info.name}${s.server_info.version ? ` ${s.server_info.version}` : ""}, MCP ${s.version}`] as [string, string]] : []),
          ...(s.state === "ready" && s.last_connected ? [["Connected", ago(s.last_connected)] as [string, string]] : []),
        ]}
      >
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {canSignIn && (
            <button type="button" data-testid="mcp-sign-in" className="k-btn" data-ink onClick={async () => {
              const r = await api<{ url: string }>(`${base}/sign-in`, { method: "POST" }).catch((e) => (reportError(e), null));
              if (r?.url) window.open(r.url, "_blank", "noopener");
            }}><KeyRound /> Sign in</button>
          )}
          {s.signed_in && <button type="button" className="k-btn" onClick={() => act(`${base}/sign-out`)}><LogOut /> Sign out</button>}
          <button type="button" className="k-btn" data-testid="mcp-reconnect" onClick={() => act(`${base}/reconnect`)}><RotateCw /> Reconnect</button>
          {!s.bundled && !s.plugin && <button type="button" className="k-btn" data-quiet data-testid="mcp-remove" onClick={() => act(base, undefined, "DELETE")}><Trash2 /> Remove</button>}
        </div>
        {s.error && s.state !== "disabled" && (
          <div className="k-issue mt-3" data-tone={s.state === "missing" || s.state === "not_armed" ? "quiet" : s.state === "needs_auth" ? "need" : undefined} data-testid="mcp-error">{s.error.slice(0, 600)}</div>
        )}
      </ReaderHead>
      <div className="k-reader-body">
        {offered(s) && s.tool_names.length > 0 && (s.bundled || s.plugin ? (
          <div>
            <div className="k-sub k-label">Tools</div>
            <div className="flex flex-wrap gap-1">{s.tool_names.map((t) => <span key={t} className="k-chip font-mono">{t}</span>)}</div>
          </div>
        ) : <div><div className="k-sub k-label">Tools: which ones count as reads</div><ToolReads s={s} base={base} act={act} /></div>)}
        {!s.bundled && <ChannelSection s={s} base={base} act={act} />}
        {s.state === "ready" && (s.resources || s.prompts) && <ServerContents s={s} base={base} />}
        {!offered(s) && !s.error && <p className="text-caption text-faint">Its tools show once it connects.</p>}
      </div>
    </div>
  );
}

// What became of one event in one session, in a few words (src/mcp/channel.ts Outcome).
const OUTCOME: Record<Outcome["state"], string> = {
  started: "started a turn", next_step: "read at the next step", waiting: "waits for the daemon's start", held: "waits behind your stop",
  duplicate: "a resend: not taken twice", refused: "not delivered",
};

// A held event says whose stop it waits behind: yours, or another's (its parent's, a move).
const outcomeWords = (o: Outcome) =>
  o.state === "held" ? (ownerStop(o.by) ? OUTCOME.held : o.reason ? `waits: ${o.reason}` : "waits behind a stop")
  : `${OUTCOME[o.state]}${o.reason && o.state === "refused" ? ` (${o.reason})` : ""}`;

// Events the server pushes into sessions (src/mcp/channel.ts). Off by
// default: the switch says whether its events are taken at all, the list
// which sessions take them (an editor's own server is for its own session).
function ChannelSection({ s, base, act }: { s: McpServerState; base: string; act: Act }) {
  const sessions = useStore((st) => st.sessions);
  const ch = s.channel;
  const named = new Set((ch.sessions ?? []).map((x) => x.id));
  const open = Object.values(sessions).filter((x) => !x.archived && !x.parent_id && !named.has(x.id)).sort((a, b) => b.updated - a.updated).slice(0, 40);
  const title = (id?: string) => (id && (sessions[id]?.title || ch.sessions?.find((x) => x.id === id)?.title)) || (id ? `session ${id.slice(-8)}` : "");
  const post = (body: { on: boolean; session?: string }) => act(`${base}/channel`, s.session ? { ...body, session: s.session } : body);
  return (
    <div data-testid="mcp-channel" data-on={ch.on || undefined}>
      <div className="k-sub k-label flex items-center gap-2">
        <span className="min-w-0 flex-1">Events it pushes into sessions</span>
        <Toggle testid="mcp-channel-toggle" on={ch.on} label={`${ch.on ? "Stop taking" : "Take"} ${s.name}'s events`} onChange={(on) => post({ on })} />
      </div>
      <p className="text-caption text-muted" data-testid="mcp-channel-says">
        {!ch.declared && s.state === "ready" ? "It declares no channel, so it sends no events. " : ch.declared ? "It is a channel: it can push chat, CI or webhook events. " : ""}
        {s.session ? (ch.on ? "Its events go into the session that passed it." : "Off: its events are dropped.")
          : !ch.on ? "Off: its events are dropped." : named.size ? "Each event is read at a working session's next step, or starts a turn in an idle one. A session you stopped keeps it until you go on." : "On, but no session takes its events yet: name one below."}
      </p>
      {!s.session && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="mcp-channel-sessions">
          {(ch.sessions ?? []).map((x) => (
            <span key={x.id} className="k-chip inline-flex items-center gap-1" data-testid="mcp-channel-session" data-session={x.id}>
              {title(x.id)}
              <button type="button" aria-label={`Stop sending its events to ${title(x.id)}`} className="text-faint hover:text-fg" onClick={() => post({ on: false, session: x.id })}><X className="size-3" /></button>
            </span>
          ))}
          {open.length > 0 && (
            <Select value="" onChange={(e) => e.target.value && post({ on: true, session: e.target.value })} aria-label="Add a session that takes its events" data-testid="mcp-channel-add" className="h-7 text-caption">
              <option value="">Add a session…</option>
              {open.map((x) => <option key={x.id} value={x.id}>{x.title || `session ${x.id.slice(-8)}`}</option>)}
            </Select>
          )}
        </div>
      )}
      {!!ch.recent?.length && (
        <ul className="mt-2.5 flex flex-col gap-1 text-caption" data-testid="mcp-channel-recent">
          {ch.recent.slice(0, 6).map((p, i) => (
            <li key={`${p.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2" data-testid="mcp-channel-event">
              <span className="text-faint tabular-nums" title={when(p.at)}>{ago(p.at)}</span>
              {p.event_id && <span className="font-mono text-micro text-faint">{p.event_id}</span>}
              <span className="text-muted">{p.outcomes.map((o) => `${o.session ? `${title(o.session)}: ` : ""}${outcomeWords(o)}`).join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A server's tools, each one a toggle: a tool the owner counts as a read runs
// without asking; every other one asks first. What the server itself calls
// read-only is only its word, shown with a mark, until the owner takes it.
function ToolReads({ s, base, act }: { s: McpServerState; base: string; act: Act }) {
  const [all, setAll] = useState(false);
  const reads = new Set(s.read_tools);
  const hinted = s.hinted_reads.filter((t) => !reads.has(t));
  // Counted against the tools the server offers now; a marked tool it no
  // longer offers is listed apart, kept until the owner drops it.
  const current = s.read_tools.filter((t) => s.tool_names.includes(t));
  const gone = s.read_tools.filter((t) => !s.tool_names.includes(t));
  const put = (tools: string[]) => act(`${base}/reads`, { tools }, "PUT");
  const shown = all ? s.tool_names : s.tool_names.slice(0, 10);
  return (
    <div data-testid="mcp-tool-reads">
      <div className="flex flex-wrap gap-1">
        {shown.map((t) => {
          const read = reads.has(t);
          const hint = s.hinted_reads.includes(t);
          return (
            <button
              key={t}
              type="button"
              data-testid="mcp-tool-read"
              data-tool={t}
              aria-pressed={read}
              title={`${read ? "Counts as a read: runs without asking. Click to ask first again." : "Asks before it runs. Click to count it as a read."}${hint ? " The server calls it read-only." : ""}`}
              onClick={() => put(read ? s.read_tools.filter((x) => x !== t) : [...s.read_tools, t])}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-px font-mono text-micro transition-colors",
                read ? "border-accent/40 bg-accent-soft text-accent-ink" : "border-line text-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {read && <Eye className="size-3" aria-hidden />}
              {t}
              {hint && !read && <span className="text-faint" aria-hidden>·ro</span>}
            </button>
          );
        })}
        {s.tool_names.length > 10 && (
          <button type="button" onClick={() => setAll(!all)} className="px-1 text-micro text-faint hover:text-fg">
            {all ? "fewer" : `+${s.tool_names.length - 10} more`}
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-micro text-faint">
        <span data-testid="mcp-reads-count">{current.length ? `${current.length} of ${s.tool_names.length} current tools count as reads` : "Every tool asks first"}</span>
        {hinted.length > 0 && (
          <button type="button" data-testid="mcp-reads-hinted" onClick={() => put([...s.read_tools, ...hinted])} className="k-link text-accent hover:underline">
            Count the {hinted.length} it calls read-only as reads
          </button>
        )}
        {reads.size > 0 && <button type="button" onClick={() => put([])} className="k-link hover:text-fg hover:underline">Ask for all</button>}
      </div>
      {gone.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-micro text-faint" data-testid="mcp-reads-gone">
          <span>Marked as reads, no longer offered: <span className="font-mono">{gone.join(", ")}</span></span>
          <button type="button" onClick={() => put(current)} className="k-link hover:text-fg hover:underline">Forget them</button>
        </div>
      )}
    </div>
  );
}

type Resource = { uri?: string; uriTemplate?: string; name?: string; description?: string; mimeType?: string };
type Half = { items: Resource[]; error?: string; unsupported?: boolean; next?: string };
type Item = { uri: string; mimeType?: string; text?: string; bytes?: number };
type Message = { role: string; type: string; text: string };
type Prompt = { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] };
type Shown = { title: string; uri?: string; rev?: number; items?: Item[]; messages?: Message[] };

// What a server publishes besides tools: its resources (read one) and its
// prompt templates (fill the arguments, see the messages). Listed when
// opened, and listed again when the server says its list changed or it
// reconnected; a body is read only when the owner asks.
function ServerContents({ s, base }: { s: McpServerState; base: string }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<{ resources: Half; templates: Half } | null>(null);
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [err, setErr] = useState("");
  // A listing from page one makes any continuation still on its way another list's: its rows are dropped.
  const listing = useRef(0);
  const going = useRef<Record<string, boolean>>({});
  const loadLists = useCallback(() => {
    const mine = ++listing.current;
    going.current = {};
    api<{ resources: Half; templates: Half }>(`${base}/resources`).then((r) => { if (mine === listing.current) setLists(r); }).catch((e) => setErr(failed(e, { at: "Mcp resources" })));
  }, [base]);
  useEffect(() => {
    if (open && s.resources) loadLists();
  }, [open, s.resources, s.resources_rev, s.last_connected, loadLists]);
  useEffect(() => {
    if (open && s.prompts) api<{ prompts: Prompt[] }>(`${base}/prompts`).then((r) => setPrompts(r.prompts)).catch((e) => setErr(failed(e, { at: "Mcp prompts" })));
  }, [open, base, s.prompts, s.last_connected]);
  // Load more goes on from where the bound stopped, and Retry from the page
  // that failed, for that one list: the rows already shown and the other list
  // stay. One request at a time per list, so a page's rows are added once.
  const more = (list: "resources" | "templates", cursor: string) => {
    if (going.current[list]) return;
    going.current[list] = true;
    const mine = listing.current;
    api<{ resources: Half; templates: Half }>(`${base}/resources?list=${list}&cursor=${encodeURIComponent(cursor)}`)
      .then((r) => { if (mine === listing.current) setLists((x) => x && { ...x, [list]: { ...x[list], items: [...x[list].items, ...r[list].items], next: r[list].next, error: r[list].error } }); })
      .catch((e) => setErr(failed(e, { at: "Mcp resources" })))
      .finally(() => { if (mine === listing.current) going.current[list] = false; });
  };
  const read = (uri: string) =>
    api<{ items: Item[] }>(`${base}/resource?uri=${encodeURIComponent(uri)}`)
      .then((r) => setShown({ title: uri, uri, rev: s.resource_updates[uri] ?? 0, items: r.items }))
      .catch((e) => setErr(failed(e, { at: "Mcp resource" })));
  const stale = !!shown?.uri && (s.resource_updates[shown.uri] ?? 0) !== shown.rev;
  const what = [s.resources && "resources", s.prompts && "prompts"].filter(Boolean).join(" and ");
  const half = (label: string, list: "resources" | "templates", h: Half) => (
    <>
      {h.items.map((r) => (
        <li key={r.uri ?? r.uriTemplate} className="flex items-baseline gap-2 text-caption">
          {r.uri ? (
            <button type="button" data-testid="mcp-resource" onClick={() => read(r.uri!)} className="k-link font-mono text-accent hover:underline">{r.uri}</button>
          ) : (
            <span data-testid="mcp-resource-template" className="font-mono text-muted" title="A template: the model fills it in">{r.uriTemplate}</span>
          )}
          {(r.name || r.description) && <span className="truncate text-faint">{r.description ?? r.name}</span>}
        </li>
      ))}
      {h.error && (
        <li className="flex items-baseline gap-2 text-caption text-danger" data-testid="mcp-list-failed" data-list={list}>
          {h.next !== undefined ? `Listing more ${label} failed` : `Listing the ${label} failed`}: {h.error}
          <button type="button" data-testid="mcp-list-retry" onClick={() => (h.next !== undefined ? more(list, h.next) : loadLists())} className="k-link text-muted hover:text-fg hover:underline">Retry</button>
        </li>
      )}
      {h.next !== undefined && !h.error && (
        <li><button type="button" data-testid="mcp-load-more" data-list={list} onClick={() => more(list, h.next!)} className="k-link text-caption text-muted hover:text-fg hover:underline">More may exist: load more {label}</button></li>
      )}
    </>
  );
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger data-testid="mcp-contents-toggle" className="group/c inline-flex items-center gap-1 text-caption text-muted hover:text-fg">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]/c:rotate-90" />
        {what[0]!.toUpperCase() + what.slice(1)}
      </Collapsible.Trigger>
      <Collapsible.Panel data-testid="mcp-contents" className="mt-1.5 space-y-2">
        {err && <div className="text-micro text-danger">{err}</div>}
        {s.resources && (
          <div>
            <div className="k-label">Resources</div>
            {lists === null ? <div className="text-micro text-faint">Loading</div>
              : !lists.resources.items.length && !lists.templates.items.length && !lists.resources.error && !lists.templates.error ? <div className="text-micro text-faint">None</div> : (
                <>
                  <ul className="mt-1 space-y-0.5">{half("resources", "resources", lists.resources)}</ul>
                  {/* Under a heading of their own: a failure that ends the resources is not read as theirs. */}
                  {(lists.templates.items.length > 0 || lists.templates.error || lists.templates.next !== undefined) && (
                    <>
                      <div className="mt-1.5 k-label">Templates</div>
                      <ul className="mt-1 space-y-0.5">{half("templates", "templates", lists.templates)}</ul>
                    </>
                  )}
                </>
              )}
          </div>
        )}
        {s.prompts && (
          <div>
            <div className="k-label">Prompts</div>
            {prompts === null ? <div className="text-micro text-faint">Loading</div> : prompts.length === 0 ? <div className="text-micro text-faint">None</div> : (
              <ul className="mt-1 space-y-2">
                {prompts.map((p) => <PromptForm key={p.name} p={p} base={base} onShown={(messages) => setShown({ title: p.name, messages })} />)}
              </ul>
            )}
          </div>
        )}
        {shown && (
          <div data-testid="mcp-content-text" className="rounded-md border border-line bg-bg">
            <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1">
              <span className="truncate font-mono text-micro text-muted">{shown.title}</span>
              {stale && (
                <button type="button" data-testid="mcp-resource-stale" onClick={() => read(shown.uri!)} className="k-link ml-auto text-micro text-warn hover:underline">Changed on the server: read again</button>
              )}
              <IconButton title="Close" onClick={() => setShown(null)}><X className="size-3.5" /></IconButton>
            </div>
            <div className="max-h-64 space-y-1.5 overflow-auto px-2 py-1.5">
              {shown.items?.map((it, i) => (
                <div key={i} data-testid="mcp-resource-item">
                  {(shown.items!.length > 1 || it.uri !== shown.uri) && <div className="font-mono text-micro text-faint">{it.uri}{it.mimeType ? ` · ${it.mimeType}` : ""}</div>}
                  {it.text !== undefined
                    ? <pre className="whitespace-pre-wrap break-words font-mono text-micro text-fg">{it.text}</pre>
                    : <div className="text-micro text-muted">Binary {it.mimeType ?? "data"}, {it.bytes} {it.bytes === 1 ? "byte" : "bytes"}</div>}
                </div>
              ))}
              {shown.messages?.map((m, i) => (
                <div key={i} data-testid="mcp-prompt-message" data-role={m.role}>
                  <div className="k-label">{m.role}{m.type !== "text" ? ` · ${m.type}` : ""}</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-micro text-fg">{m.text}</pre>
                </div>
              ))}
              {shown.messages?.length === 0 && <div className="text-micro text-faint">The prompt has no messages.</div>}
            </div>
          </div>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

// One prompt's arguments, each with its name, required mark and description.
// Show asks the server only once every required argument is given; an
// optional one left empty is not sent.
function PromptForm({ p, base, onShown }: { p: Prompt; base: string; onShown: (m: Message[]) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const params = p.arguments ?? [];
  const show = async (e: FormEvent) => {
    e.preventDefault();
    const missing = params.find((a) => a.required && !(vals[a.name] ?? "").trim());
    if (missing) {
      setErr(`${missing.name} is required`);
      refs.current[missing.name]?.focus();
      return;
    }
    setErr("");
    const args = Object.fromEntries(params.filter((a) => (vals[a.name] ?? "") !== "").map((a) => [a.name, vals[a.name]!]));
    try {
      const r = await api<{ messages: Message[] }>(`${base}/prompts/${encodeURIComponent(p.name)}`, { method: "POST", body: JSON.stringify({ arguments: args }) });
      onShown(r.messages);
    } catch (x) {
      setErr(failed(x, { at: "Mcp prompt" }));
    }
  };
  return (
    <li data-testid="mcp-prompt" data-name={p.name} className="text-caption">
      <form onSubmit={show} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 basis-full">
          <span className="font-mono text-fg">{p.name}</span>
          {p.description && <span className="ml-2 text-faint">{p.description}</span>}
        </div>
        {params.map((a) => (
          <label key={a.name} className="flex flex-col gap-0.5">
            <span className="max-w-56 truncate text-micro text-muted" title={a.description}>
              {a.name}{a.required ? <span className="text-danger" aria-hidden> *</span> : <span className="text-faint"> optional</span>}
              {a.description && <span className="text-faint"> · {a.description}</span>}
            </span>
            <input
              ref={(el) => { refs.current[a.name] = el; }}
              aria-label={`${p.name} ${a.name}`}
              aria-required={!!a.required}
              aria-description={a.description}
              title={a.description}
              value={vals[a.name] ?? ""}
              onChange={(e) => setVals((x) => ({ ...x, [a.name]: e.target.value }))}
              className="h-7 w-56 rounded-md border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
            />
          </label>
        ))}
        <button type="submit" data-testid="mcp-prompt-get" className="h-7 rounded-md border border-line px-2 text-caption text-muted hover:bg-hover hover:text-fg">Show</button>
        {err && <span className="basis-full text-micro text-danger" role="alert" data-testid="mcp-prompt-error">{err}</span>}
      </form>
    </li>
  );
}

function AddServer({ onAdded }: { onAdded: (servers: McpServerState[], name: string) => void }) {
  const [kind, setKind] = useState<"command" | "url">("command");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  // The lines typed for each kind are kept apart: looking at the other kind does not erase them.
  const [extras, setExtras] = useState({ command: "", url: "" });
  const extra = extras[kind], setExtra = (v: string) => setExtras((x) => ({ ...x, [kind]: v }));
  const [bearer, setBearer] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    const words = argv(target.trim());
    const body = kind === "command"
      ? { name: name.trim(), command: words[0], args: words.slice(1), env: pairs(extra, "=") }
      : { name: name.trim(), url: target.trim(), headers: pairs(extra, ":"), bearer_env: bearer.trim() || undefined };
    try {
      const r = await api<{ servers: McpServerState[] }>("/api/mcp/servers", { method: "POST", body: JSON.stringify(body) });
      onAdded(r.servers, name.trim());
      setName(""); setTarget(""); setExtra(""); setBearer("");
    } catch (x) {
      setErr(failed(x, { at: "Mcp" }));
    }
  };
  return (
    <form onSubmit={submit} className="k-form" data-testid="mcp-add">
      <div className="k-form-row">
        <Seg manual value={kind} onChange={setKind} label="Kind" options={[["command", "Local command"], ["url", "Remote URL"]]} />
        <span className="k-form-hint">{kind === "command" ? "A program Keel starts, speaking MCP over stdio." : "Streamable HTTP. Sign-in (OAuth) is offered when the server asks for it."}</span>
      </div>
      <label>Name<input data-testid="mcp-add-name" data-mono value={name} onChange={(e) => setName(e.target.value)} placeholder="docs" /></label>
      <label>{kind === "command" ? "Command" : "URL"}
        <input data-testid="mcp-add-target" data-mono value={target} onChange={(e) => setTarget(e.target.value)} placeholder={kind === "command" ? "npx -y @modelcontextprotocol/server-everything" : "https://example.com/mcp"} />
      </label>
      <label>{kind === "command" ? "Environment, one KEY=value a line" : "Headers, one Name: value a line"}
        <textarea data-testid="mcp-add-extra" value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} placeholder={kind === "command" ? "LOG_LEVEL=warn" : "X-Team: tools"} />
      </label>
      {kind === "url" && (
        <label>Bearer token from the variable<input data-mono data-testid="mcp-add-bearer" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="DOCS_TOKEN (its value never enters the file)" /></label>
      )}
      {err && <p className="k-form-err" data-testid="mcp-add-error">{err}</p>}
      <div><button type="submit" data-testid="mcp-add-submit" className="k-btn" data-ink disabled={!name.trim() || !target.trim()}>Add the server</button></div>
    </form>
  );
}

// The same server is often set up in several agents, under one name or
// another: one row per endpoint and account, with the agents (and names) that hold it.
type Row = { first: ImportableServer; holders: { label: string; name: string }[]; configured: boolean };
function importRows(items: ImportableServer[]): Row[] {
  const rows = new Map<string, Row>();
  for (const i of items) {
    const k = `${i.project ? "p" : "u"}\u0000${i.group}`;
    const r = rows.get(k);
    if (r) { r.holders.push({ label: i.label, name: i.name }); r.configured ||= i.configured; }
    else rows.set(k, { first: i, holders: [{ label: i.label, name: i.name }], configured: i.configured });
  }
  return [...rows.values()].sort((a, b) => Number(a.configured) - Number(b.configured) || Number(!!a.first.project) - Number(!!b.first.project) || a.first.name.localeCompare(b.first.name));
}

function ImportList({ rows, taken, onImport }: { rows: Row[]; taken: Set<string>; onImport: (i: ImportableServer, as?: string) => void }) {
  const target = (i: ImportableServer) => i.config.url ?? [i.config.command, ...(i.config.args ?? [])].join(" ");
  if (!rows.length) return <p className="text-caption text-faint">The other agents on this machine hold no servers Keel can read.</p>;
  return (
    <div data-testid="mcp-importable">
      {rows.map(({ first: i, holders, configured }) => {
        // A name Keel already uses for another server: import under the source's name for it.
        const as = taken.has(i.name) ? `${i.name}-${(i.source.split(":")[0] ?? i.source).replace(/^claude-desktop$/, "desktop")}` : undefined;
        const names = [...new Set(holders.map((h) => h.name))];
        return (
          <div key={i.source + i.name} className="flex items-center gap-2.5 border-b border-line py-2.5 last:border-0" data-testid="mcp-import-row" data-name={i.name}>
            {i.config.url ? <Globe className="size-3.5 shrink-0 text-faint" /> : <SquareTerminal className="size-3.5 shrink-0 text-faint" />}
            <span className="shrink-0 text-ui font-medium">{i.name}</span>
            {names.length > 1 && <span className="shrink-0 text-caption text-faint">also {names.filter((n) => n !== i.name).join(", ")}</span>}
            <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint" title={target(i)}>{tilde(target(i))}</span>
            {[...new Set(holders.map((h) => h.label))].map((l) => <span key={l} className="k-chip">{l}</span>)}
            {i.config.enabled === false && <span className="k-chip" title="Turned off there; imported off">off</span>}
            {!configured && i.other_account && <span className="shrink-0 text-caption text-muted" data-testid="mcp-other-account" title={`Keel's ${i.other_account} reaches the same server with other credentials or environment`}>same server, another account</span>}
            {configured ? <span className="w-24 shrink-0 text-right text-caption text-faint">In Keel</span> : (
              <button type="button" data-testid="mcp-import" title={as ? `Keel has a server named ${i.name}: this one comes in as ${as}` : undefined} onClick={() => onImport(i, as)} className="k-btn w-24 justify-center"><Download /> {as ? "As new" : "Import"}</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function McpServers() {
  const [servers, setServers] = useState<McpServerState[] | null>(null);
  const [importable, setImportable] = useState<ImportableServer[]>([]);
  const [unread, setUnread] = useState<{ file: string; error: string }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const load = useCallback(() => {
    api<{ projects: ProjectState[] }>("/api/mcp/projects").then((r) => setProjects(r.projects)).catch(reportError);
    return api<{ servers: McpServerState[] }>("/api/mcp/servers").then((r) => setServers(r.servers)).catch(reportError);
  }, []);
  const loadImportable = useCallback(() => api<{ servers: ImportableServer[]; failed: { file: string; error: string }[] }>("/api/mcp/importable").then((r) => { setImportable(r.servers); setUnread(r.failed ?? []); }).catch(reportError), []);
  // States change on the daemon (connects, crashes): read them again while the page is open.
  useEffect(() => {
    load();
    loadImportable();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [load, loadImportable]);
  useEffect(() => { if (servers && !sel) setSel(servers.find((s) => !s.bundled)?.name ?? servers[0]?.name ?? "+add"); }, [servers]);

  const act: Act = async (path, body, method = "POST") => {
    try {
      const r = await api<{ servers: McpServerState[] }>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      setServers(r.servers);
      if (method === "DELETE") { loadImportable(); setSel(null); }
    } catch (e) {
      setNote(failed(e, { at: "Mcp" }));
    }
  };
  const all = servers ?? [];
  const entry = (s: McpServerState) => ({ id: s.name, name: s.name, desc: s.bundled ?? tilde(s.target), mark: mcpMark(s), markLabel: LABEL[s.state], aside: s.state === "ready" || s.state === "idle" ? `${s.tools}` : LABEL[s.state].toLowerCase(), testid: "mcp-entry" });
  const groups: Group[] = [
    { id: "yours", title: "Yours", path: "mcp.json", entries: all.filter((s) => !s.bundled && !s.plugin).map(entry) },
    { id: "plugins", title: "From plugins", entries: all.filter((s) => s.plugin).map((s) => ({ ...entry(s), desc: `${s.plugin} · ${tilde(s.target)}` })) },
    { id: "bundled", title: "Built into Keel", entries: all.filter((s) => s.bundled).map(entry) },
    ...projects.map((p) => ({
      id: `project:${p.root}`, title: `Project ${tail(p.root, 28)}`, path: ".mcp.json",
      entries: p.servers.map((x) => ({ id: `project:${p.root}\u0000${x.name}`, name: x.name, desc: tilde(x.target), mark: projectMark(x), markLabel: PROJECT_LABEL[x.state], aside: PROJECT_LABEL[x.state].toLowerCase(), testid: "mcp-project-entry" })),
    })),
  ];
  const cur = all.find((s) => s.name === sel);
  const proj = sel?.startsWith("project:") ? (() => { const [root, name] = sel.slice(8).split("\u0000"); const p = projects.find((x) => x.root === root); const x = p?.servers.find((y) => y.name === name); return p && x ? { p, x } : null; })() : null;
  const pendingProjects = projects.reduce((n, p) => n + p.servers.filter((x) => x.state === "pending" || x.state === "changed").length, 0);
  const ready = all.filter((s) => s.state === "ready" || s.state === "idle" || s.state === "armed");
  const waiting = all.filter((s) => s.state === "needs_auth").length;
  const failing = all.filter((s) => mcpMark(s) === "fail").length;
  const rows = importRows(importable);
  const fresh = rows.filter((r) => !r.configured).length;
  const freshAll = rows.filter((r) => !r.configured && !r.first.project).length;
  const taken = new Set(all.filter((s) => !s.bundled).map((s) => s.name));

  return (
    <div data-testid="mcp-panel">
      <FolderLine global="Tools load on demand: the model searches for them" tally={[
        { n: all.length, label: "servers" },
        { n: ready.reduce((n, s) => n + s.tools, 0), label: "tools offered" },
        ...(waiting ? [{ n: waiting, label: "need sign-in", tone: "need" as const }] : []),
        ...(failing ? [{ n: failing, label: "failed", tone: "fail" as const }] : []),
        ...(pendingProjects ? [{ n: pendingProjects, label: "wait for your approval", tone: "need" as const }] : []),
      ]} />
      {note && (
        <div className="k-issue mb-3 flex items-center gap-2" data-tone="quiet" data-testid="mcp-note">
          <span className="min-w-0 flex-1">{note}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNote("")}><X className="size-3.5" /></button>
        </div>
      )}
      <Ledger testid="mcp-servers" groups={groups} selected={sel} onSelect={setSel}
        add={[{ id: "+connect", label: "Connect an app" }, { id: "+add", label: "Add a server" }, { id: "+import", label: fresh ? `Import from other agents (${fresh})` : "Import from other agents" }]}
        empty="No servers yet.">
        {sel === "+connect" ? (
          <>
            <ReaderHead title="Connect an app" desc="The apps' own MCP servers, run by their makers. What each needs to sign in is read from the server itself; a sign-in opens the maker's page and the token stays with Keel." />
            <div className="k-reader-body"><Connect onDone={(s, name) => { setServers(s); setNote(`${name} is added.`); }} /></div>
          </>
        ) : sel === "+add" ? (
          <>
            <ReaderHead title="Add a server" desc="It is written to Keel's mcp.json. Its tools stay out of every request until the model searches for them, so a server costs no tokens until it is used." />
            <div className="k-reader-body"><AddServer onAdded={(s, name) => { setServers(s); loadImportable(); setSel(name); }} /></div>
          </>
        ) : sel === "+import" ? (
          <>
            <ReaderHead title="Import from other agents" desc="The servers Claude Code, Codex, Gemini, Antigravity, Cursor, OpenCode, Hermes and Zed are set up with, read from their own files. An import is a copy in Keel's mcp.json that follows its source: a change there reaches Keel; their files are never written." right={
              <div className="flex items-center gap-2">
                <button type="button" className="k-btn" data-testid="mcp-reload" onClick={async () => {
                  try {
                    const r = await api<{ line: string; servers: McpServerState[] }>("/api/mcp/reload", { method: "POST", body: "{}" });
                    setServers(r.servers);
                    setNote(r.line);
                  } catch (e) { setNote(failed(e, { at: "Mcp" })); }
                }}><RefreshCw /> Read mcp.json again</button>
                <button type="button" className="k-btn" data-ink data-testid="mcp-import-all" disabled={!freshAll} onClick={async () => {
                  try {
                    const r = await api<{ imported: string[]; skipped: { name: string; source: string; why: string }[]; servers: McpServerState[] }>("/api/mcp/import-all", { method: "POST", body: "{}" });
                    setServers(r.servers);
                    loadImportable();
                    setNote(`Imported ${r.imported.length}${r.imported.length ? `: ${r.imported.join(", ")}` : ""}.${r.skipped.length ? ` Not imported: ${r.skipped.map((x) => `${x.name} from ${x.source} (${x.why})`).join("; ")}.` : ""}`);
                  } catch (e) { setNote(failed(e, { at: "Mcp" })); }
                }}><Download /> Import all{freshAll ? ` ${freshAll}` : ""}</button>
              </div>
            } />
            <div className="k-reader-body">
              {unread.map((u) => <div key={u.file} className="k-issue mb-3" data-tone="quiet" data-testid="mcp-source-unread">{tilde(u.file)} could not be read: {u.error}</div>)}
              <ImportList rows={rows} taken={taken} onImport={async (i, as) => { await act("/api/mcp/import", { source: i.source, name: i.name, as }); loadImportable(); setSel(as ?? i.name); }} />
            </div>
          </>
        ) : proj ? <ProjectReader key={sel!} p={proj.p} x={proj.x} decide={async (decision) => {
          try {
            const r = await api<{ projects: ProjectState[] }>("/api/mcp/projects/decide", { method: "POST", body: JSON.stringify({ root: proj.p.root, name: proj.x.name, digest: proj.x.digest, decision }) });
            setProjects(r.projects);
          } catch (e) { setNote(failed(e, { at: "Mcp" })); }
        }} /> : cur ? <ServerReader key={cur.name} s={cur} act={act} /> : <Blank title={servers ? "No server picked" : "Reading the servers"} />}
      </Ledger>
    </div>
  );
}
