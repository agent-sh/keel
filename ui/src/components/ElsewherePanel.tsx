import { ArrowDownToLine, ArrowLeft, ArrowUp, CircleAlert, Cpu, RefreshCw, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadPrompt, Row } from "../../../src/drive/drive.ts";
import type { Turn } from "../../../src/drive/transcript.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { copyable, takeOver, TOOL } from "./TakeOver.tsx";
import { ago, cn, when } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";
import { composing } from "../lib/keys.ts";

type List = { configured: boolean; sessions: Row[]; not_listed?: string[]; at?: number };
type Read = { session: Row; turns?: Turn[]; lines?: string[]; prompt: ReadPrompt | null };

const KIND: Record<string, { label: string; cls: string }> = {
  claude: { label: "Claude Code", cls: "bg-brass-soft text-fg" },
  codex: { label: "Codex", cls: "bg-accent-soft text-accent-ink" },
  agy: { label: "agy", cls: "bg-sunken text-muted" },
};
const DOT: Record<string, string> = {
  waiting: "bg-warn",
  working: "bg-accent animate-pulse",
  scheduled: "bg-accent/50",
  idle: "bg-ok",
  done: "bg-ok",
  ended: "bg-line-strong",
  disconnected: "bg-danger",
  unknown: "bg-faint",
};
const GROUPS: { id: string; label: string; states: string[] }[] = [
  { id: "waiting", label: "Waiting on you", states: ["waiting"] },
  { id: "working", label: "Working", states: ["working", "scheduled"] },
  { id: "idle", label: "Idle", states: ["idle", "done", "unknown"] },
  { id: "ended", label: "Ended", states: ["ended", "disconnected"] },
];
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const enc = encodeURIComponent;

// Which part of a text the session's harness would act on, as the composer
// warns before the owner sends it. The server decides; this only explains.
function actsOn(text: string, kind: string, live: boolean): string | null {
  if (!text.trim()) return null;
  if (!live) return "This resumes the session with the text as a command-line argument of its harness.";
  for (const l of text.split("\n")) {
    const c = l.trimStart()[0];
    if (c === "/") return "A line starting with / runs as a command in the session.";
    if (c === "!") return "A line starting with ! runs as a shell command in the session.";
  }
  if (/(^|[^\p{L}\p{N}])@\S/u.test(text)) return "An @ mention makes the session read that file or resource.";
  if (kind === "codex" && /\$[A-Za-z0-9_:-]/.test(text) && !/^\$(HOME|PATH|USER|SHELL|PWD|TMPDIR|TEMP|TMP|LANG|TERM)\b/i.test(text)) return "A $ mention makes Codex invoke that skill or app.";
  return null;
}

export function ElsewherePanel() {
  const [list, setList] = useState<List | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      setList(await api<List>(`/api/fleet/outside${refresh ? "?refresh" : ""}`));
    } catch (e) {
      reportError(e, { at: "elsewhere list" });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 5000);
    const off = onFeature({ frame: (f) => { if (f.name === "outside") setList((l) => (l ? { ...l, sessions: f.data.sessions, at: f.data.at, not_listed: undefined } : l)); }, reconnect: () => load() });
    return () => { clearInterval(t); off(); };
  }, [load]);

  if (open) return <Detail id={open} back={() => setOpen(null)} />;
  if (!list) return <div className="p-6 text-ui text-faint">Reading the agent view…</div>;
  if (!list.configured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" data-testid="elsewhere-unset">
        <AppIcon />
        <p className="max-w-sm text-ui text-muted">Keel lists your Claude Code, Codex and agy sessions through your agent view. Name its program to see them here.</p>
        <button onClick={() => navigate({ name: "settings", section: "elsewhere" })} className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover">Set the agent view</button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="elsewhere-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-caption text-faint">
        <span>{list.sessions.filter((s) => s.live).length} live, {list.sessions.filter((s) => !s.live).length} ended</span>
        {list.at && <span title={when(list.at)}>· read {ago(list.at)}</span>}
        <button aria-label="Read the list again" title="Read the list again" onClick={() => load(true)} className="ml-auto grid size-7 place-items-center rounded-md hover:bg-hover hover:text-fg">
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
        </button>
      </div>
      {list.not_listed?.map((w) => (
        <div key={w} className="flex items-start gap-2 border-b border-line bg-danger-soft px-4 py-2 text-ui text-danger" data-testid="elsewhere-not-listed">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          {w}
        </div>
      ))}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {GROUPS.map((g) => {
          const rows = list.sessions.filter((s) => g.states.includes(s.state)).sort((a, b) => (b.last_activity_ms ?? 0) - (a.last_activity_ms ?? 0));
          if (!rows.length) return null;
          return (
            <section key={g.id} className="mb-3" data-testid={`elsewhere-group-${g.id}`}>
              <h3 className="px-2 pb-1 pt-2 text-micro font-medium uppercase tracking-[0.06em] text-faint">{g.label} <span className="tabular-nums">{rows.length}</span></h3>
              {rows.map((s) => <RowItem key={s.id} s={s} onOpen={() => setOpen(s.id)} />)}
            </section>
          );
        })}
        {!list.sessions.length && !list.not_listed && <p className="p-6 text-center text-ui text-faint">The agent view lists no sessions.</p>}
      </div>
    </div>
  );
}

function AppIcon() {
  return (
    <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
      <TerminalSquare className="size-5" />
    </span>
  );
}

function KindPill({ kind }: { kind: string }) {
  const k = KIND[kind] ?? { label: kind, cls: "bg-sunken text-muted" };
  return <span className={cn("shrink-0 rounded px-1.5 py-px text-micro font-medium", k.cls)}>{k.label}</span>;
}

function RowItem({ s, onOpen }: { s: Row; onOpen: () => void }) {
  const line = s.waiting_on ?? s.detail;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="elsewhere-row"
      data-id={s.id}
      data-state={s.state}
      className={cn("group flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-hover", !s.live && "opacity-75")}
    >
      <span className="flex w-full items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[s.state])} title={s.state} />
        <span className="min-w-0 truncate text-ui font-medium text-fg">{s.name || s.id}</span>
        <KindPill kind={s.kind} />
        <span className="ml-auto shrink-0 text-caption tabular-nums text-faint" title={s.last_activity_ms ? when(s.last_activity_ms) : ""}>
          {s.last_activity_ms ? ago(s.last_activity_ms) : ""}
        </span>
      </span>
      <span className="flex w-full items-center gap-2 pl-4 text-caption text-muted">
        {s.cwd && <span className="shrink-0 font-mono" title={s.cwd}>{base(s.cwd)}</span>}
        {s.host && <span className="shrink-0 text-faint">on {s.host}</span>}
        {line && <span className={cn("min-w-0 truncate", s.state === "waiting" && "text-warn")}>{line}</span>}
      </span>
    </button>
  );
}

function Detail({ id, back }: { id: string; back: () => void }) {
  const [r, setR] = useState<Read | null>(null);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setR(await api<Read>(`/api/fleet/outside/${enc(id)}?lines=120`));
      setErr("");
    } catch (e) {
      setErr(failed(e, { at: "ElsewherePanel" }));
    }
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  const size = (r?.turns?.length ?? 0) + (r?.lines?.length ?? 0);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [size]);

  const act = async (body: object) => {
    setSending(true);
    setNote(null);
    try {
      const res = await api<{ message: string }>(`/api/fleet/outside/${enc(id)}`, { method: "POST", body: JSON.stringify(body) });
      setNote({ ok: true, text: res.message });
      load();
      return true;
    } catch (e) {
      setNote({ ok: false, text: failed(e, { at: "ElsewherePanel" }) });
      return false;
    } finally {
      setSending(false);
    }
  };

  const s = r?.session;
  const held = !!r?.prompt && !!s?.live;
  const warn = s ? actsOn(text, s.kind, s.live) : null;
  const canSend = !!s?.drive.send && !held && !!text.trim() && !sending;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="elsewhere-detail">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
        <button aria-label="Back to the list" onClick={back} className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><ArrowLeft className="size-4" /></button>
        {s ? (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn("size-2 shrink-0 rounded-full", DOT[s.state])} />
              <span className="truncate text-ui font-medium" data-testid="elsewhere-title">{s.name || s.id}</span>
              <KindPill kind={s.kind} />
              <span className="text-caption text-faint" data-testid="elsewhere-state">{s.state}</span>
            </div>
            <div className="truncate pl-4 text-caption text-faint">
              {[s.model, s.cwd, s.host && `on ${s.host}`].filter(Boolean).join(" · ")}
            </div>
          </div>
        ) : <span className="text-ui text-faint">{id}</span>}
        {s && copyable(s) && (
          <button
            data-testid="elsewhere-import"
            title="Import into Keel: a copy that goes on here; the original keeps running"
            aria-label="Import into Keel"
            onClick={() => {
              const go = (mode?: string) => api<{ session: { id: string } }>("/api/import", { method: "POST", body: JSON.stringify({ outside: s.id, mode }) });
              // Imported before: bring that copy up to date instead of making another.
              go().catch((e: Error) => (/imported before/.test(e.message) ? go("update") : Promise.reject(e)))
                .then((r) => navigate({ name: "session", id: r.session.id }), reportError);
            }}
            className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"
          >
            <ArrowDownToLine className="size-4" />
          </button>
        )}
        {s && s.live && copyable(s) && (
          <button
            data-testid="elsewhere-takeover"
            title="Take over: end it where it runs and go on with it in Keel"
            disabled={sending}
            onClick={async () => {
              setNote(null);
              try {
                const res = await takeOver(s.id, s.name || s.id, TOOL[s.kind] ?? s.kind);
                if (res) navigate({ name: "session", id: res.session.id });
              } catch (e) {
                setNote({ ok: false, text: failed(e, { at: "ElsewherePanel" }) });
              }
            }}
            className="h-8 shrink-0 rounded-md px-2.5 text-caption font-medium text-muted hover:bg-hover hover:text-fg"
          >
            Take over
          </button>
        )}
        {s?.drive.model && (
          <button onClick={() => setModel(model === null ? "" : null)} title="Switch its model" aria-label="Switch its model" className={cn("grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg", model !== null && "bg-hover text-fg")}>
            <Cpu className="size-4" />
          </button>
        )}
      </div>
      {model !== null && s && (
        <form
          className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-2"
          onSubmit={async (e) => { e.preventDefault(); if (model.trim() && (await act({ action: "model", model }))) setModel(null); }}
        >
          <span className="text-caption text-muted">Sends</span>
          <code className="font-mono text-caption text-faint">/model</code>
          <input autoFocus value={model} onChange={(e) => setModel(e.target.value)} placeholder={s.model || "model name"} data-testid="elsewhere-model"
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 font-mono text-caption outline-none focus:border-line-strong" />
          <button disabled={!model.trim() || held || sending} className="h-7 rounded-md bg-accent px-2.5 text-caption font-medium text-accent-fg disabled:opacity-40">Switch</button>
        </form>
      )}
      {err && <div className="border-b border-line bg-danger-soft px-4 py-2 text-ui text-danger">{err}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="elsewhere-read">
        {r?.turns?.map((t, i) => <TurnRow key={i} t={t} />)}
        {r?.lines && (
          <pre className="rounded-lg bg-code px-3 py-2 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-fg" data-testid="elsewhere-screen">{r.lines.join("\n") || " "}</pre>
        )}
        {r && !r.turns?.length && !r.lines?.length && <p className="text-ui text-faint">Nothing to show yet.</p>}
        <div ref={end} />
      </div>
      {r?.prompt && s && <PromptCard p={r.prompt} kind={s.kind} busy={sending} answer={(choice) => act({ action: "answer", request: r.prompt!.id, hash: r.prompt!.hash, choice })} />}
      {note && (
        <div className={cn("mx-3 mb-2 rounded-lg px-3 py-2 text-caption", note.ok ? "bg-accent-soft/60 text-fg" : "bg-danger-soft text-danger")} data-testid="elsewhere-note">{note.text}</div>
      )}
      {s && (
        <form
          className="shrink-0 border-t border-line p-3"
          onSubmit={async (e) => { e.preventDefault(); if (canSend && (await act({ action: "send", text }))) setText(""); }}
        >
          {held && <p className="mb-2 flex items-center gap-1.5 text-caption text-warn" data-testid="elsewhere-held"><CircleAlert className="size-3.5" />A prompt is open there: a message would answer it. Answer it first.</p>}
          {!held && warn && <p className="mb-2 flex items-center gap-1.5 text-caption text-warn" data-testid="elsewhere-warn"><CircleAlert className="size-3.5" />{warn}</p>}
          <div className={cn("flex items-end gap-2 rounded-xl border border-line bg-raised px-3 py-2 shadow-1 focus-within:border-line-strong", (held || !s.drive.send) && "opacity-60")}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !composing(e)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
              disabled={!s.drive.send}
              rows={Math.min(6, Math.max(1, text.split("\n").length))}
              data-testid="elsewhere-input"
              placeholder={!s.drive.send ? `This ${s.state} session takes no message` : s.live ? `Message ${s.name || "the session"}` : "Resume it with a message"}
              className="min-h-6 flex-1 resize-none bg-transparent text-ui outline-none placeholder:text-faint"
            />
            <button aria-label={s.live ? "Send" : "Resume"} disabled={!canSend} data-testid="elsewhere-send"
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-35">
              <ArrowUp className="size-4" />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function TurnRow({ t }: { t: Turn }) {
  if (t.role === "tool") return <div className="truncate py-0.5 pl-3 font-mono text-caption text-faint" title={t.text}>{t.text}</div>;
  if (t.role === "user") {
    return (
      <div className="my-2 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sunken px-3 py-2 text-ui whitespace-pre-wrap break-words">{t.text}</div>
      </div>
    );
  }
  return <div className="my-2 text-ui [&_p]:my-1"><Markdown text={t.text} /></div>;
}

function PromptCard({ p, kind, busy, answer }: { p: ReadPrompt; kind: string; busy: boolean; answer: (choice: string) => void }) {
  return (
    <div className="mx-3 mb-2 animate-in overflow-hidden rounded-2xl border border-warn/50 bg-raised shadow-2" data-testid="elsewhere-prompt">
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="grid size-6 place-items-center rounded-md bg-brass-soft text-warn"><CircleAlert className="size-3.5" /></span>
        <span className="text-ui font-medium">{p.title || "A prompt is open"}</span>
        <span className="ml-auto text-caption text-faint">{KIND[kind]?.label ?? kind} asks</span>
      </div>
      {p.body && <pre className="mx-4 mt-2.5 max-h-40 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-caption whitespace-pre-wrap break-all">{p.body}</pre>}
      <div className="flex flex-wrap gap-2 px-4 py-3">
        {(p.choices ?? []).map((c) => {
          const no = /^(no|nope|deny|reject|cancel|decline|stop)\b/i.test(c.label.trim());
          return (
            <button key={c.value} disabled={busy} onClick={() => answer(c.value)} data-testid="elsewhere-choice"
              className={cn("h-8 rounded-lg px-3 text-ui font-medium disabled:opacity-40", no ? "border border-line text-muted hover:bg-hover hover:text-fg" : "bg-accent text-accent-fg hover:bg-accent-hover")}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ElsewhereSettings() {
  const [path, setPath] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [status, setStatus] = useState<List | null>(null);
  const [err, setErr] = useState("");
  const check = () => api<List>("/api/fleet/outside?refresh").then(setStatus).catch((e) => reportError(e));
  useEffect(() => {
    api<{ agent_view: string }>("/api/fleet/outside/settings").then((r) => { setPath(r.agent_view); setSaved(r.agent_view); }).catch((e) => reportError(e));
    check();
  }, []);
  const save = async () => {
    setErr("");
    try {
      const r = await api<{ agent_view: string }>("/api/fleet/outside/settings", { method: "PUT", body: JSON.stringify({ agent_view: path }) });
      setSaved(r.agent_view);
      setStatus(null);
      check();
    } catch (e) {
      setErr(failed(e, { at: "ElsewherePanel" }));
    }
  };
  return (
    <div className="flex flex-col gap-5" data-testid="elsewhere-settings">
      <p className="text-ui text-muted">
        Keel reaches your sessions of other harnesses through one program, your agent view. It lists them (<code className="font-mono text-caption">list -a --json</code>) and reads, answers and queues messages (<code className="font-mono text-caption">rpc</code>). Keel never types into a terminal itself.
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-ui font-medium">Agent view program</span>
        <div className="flex gap-2">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/agent-view" data-testid="elsewhere-path"
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 font-mono text-ui outline-none focus:border-line-strong" />
          <button onClick={save} disabled={path === saved} data-testid="elsewhere-save" className="h-9 rounded-lg bg-accent px-4 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">Save</button>
        </div>
      </label>
      {err && <p className="text-ui text-danger">{err}</p>}
      {saved && (
        <div className="rounded-xl border border-line bg-raised px-4 py-3 text-ui" data-testid="elsewhere-status">
          {!status ? <span className="text-faint">Reading the list…</span>
            : status.not_listed?.length ? <span className="text-danger">{status.not_listed[0]}</span>
            : <span>Lists {status.sessions.filter((s) => s.live).length} live and {status.sessions.filter((s) => !s.live).length} ended sessions.</span>}
        </div>
      )}
      <div className="text-caption text-faint">
        A model drives these sessions with the keel__session tools. A message into a session waiting on a prompt is held, since it would answer the prompt. A line starting with ! / or -, an @ mention, a $ mention for Codex, any text for an ended session and an allow on another session's prompt go to you to send.
      </div>
    </div>
  );
}
