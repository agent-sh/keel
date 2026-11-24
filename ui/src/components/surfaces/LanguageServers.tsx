// Customize > Language servers: what the model is told after an edit (the
// type errors and other compiler diagnostics the edit caused), in every
// folder and in the one seen, and the servers that can serve that folder:
// which were found, which run, where, confined how, and what each runs of
// the workspace.
import { RotateCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, failed, onFeature, reportError } from "../../lib/store.ts";
import { Blank, FolderLine, Ledger, ReaderHead, Seg, tail, tilde, Toggle, useFolder, type Group, type Mark } from "./kit.tsx";

type Mode = "off" | "errors" | "warnings";
type Running = { root: string; state: string; error?: string; pid?: number; since?: number; ready_ms?: number | null; server?: string; pull?: boolean; docs?: number; rss_mb?: number; sessions: number; sandbox: string; busy?: boolean; retry_in_ms?: number; argv: string[] };
type Server = { id: string; label: string; extensions: string[]; enabled: boolean; auto: boolean; own: boolean; runs: string; found: { command: string[]; from: "workspace" | "path"; loads: boolean; root: string } | null; missing?: string; elsewhere: number; running: Running[] };
type View = {
  cwd: string; mode: Mode; workspace_mode: Mode | null; in_force: Mode; wait_ms: number; idle_minutes: number; sandbox: boolean;
  trust: { root: string; trusted: boolean };
  totals: { alive: number; rss_mb: number; max_servers: number; max_memory_mb: number; server_memory_mb: number };
  servers: Server[];
  stats: { edits: number; answered: number; timed_out: number; with_new: number; late: number; errors: number; warnings: number; fixed: number; tokens: number; wait_ms: number };
};

const MODES: [Mode, string][] = [["off", "Off"], ["errors", "Errors"], ["warnings", "Errors and warnings"]];
const STATE: Record<string, string> = { starting: "starting", running: "running", failed: "failed", missing: "not found", refused: "not started", untrusted: "not started in this session", stopped: "stopped" };
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

const live = (s: Server) => s.running.filter((r) => r.pid);
function markOf(s: Server): { mark: Mark; label: string } {
  if (s.running.some((r) => r.state === "failed" || r.state === "refused")) return { mark: "fail", label: "failed" };
  if (s.running.some((r) => r.state === "untrusted")) return { mark: "need", label: "not started in a session that asks before commands" };
  if (live(s).length) return { mark: "work", label: "running" };
  if (!s.enabled) return { mark: "off", label: "off" };
  return s.found ? { mark: "on", label: "starts at the first edit" } : { mark: "off", label: "not found" };
}

export default function LanguageServers() {
  const [folder] = useFolder();
  const [v, setV] = useState<View | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    if (folder) api<View>(`/api/lsp?cwd=${encodeURIComponent(folder)}`).then((r) => { setV(r); setErr(""); }).catch(reportError);
  }, [folder]);
  useEffect(() => { load(); }, [load]);
  // A server that started, ended or failed says so: the page follows.
  useEffect(() => onFeature({ frame: (f) => { if (f.name === "lsp") load(); } }), [load]);
  useEffect(() => { if (v && (!sel || !v.servers.some((s) => s.id === sel))) setSel(v.servers[0]?.id ?? null); }, [v]);

  const patch = (diagnostics: Record<string, unknown>) =>
    api("/api/settings", { method: "PATCH", body: JSON.stringify({ diagnostics }) }).then(load, (e) => setErr(failed(e, { at: "language servers" })));
  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) }).then(load, (e) => setErr(failed(e, { at: "language servers" })));

  if (!v) return <Blank title="Reading the servers" />;
  const on = v.servers.filter((s) => s.enabled && s.found);
  const off = v.servers.filter((s) => !s.enabled && s.found);
  const none = v.servers.filter((s) => !s.found);
  const entry = (s: Server) => {
    const m = markOf(s);
    return {
      id: s.id, name: s.label, desc: s.found ? tilde(s.found.command[0]!) : s.missing, mark: m.mark, markLabel: m.label,
      aside: live(s).length ? "running" : s.running[0] && s.running[0].state !== "stopped" ? STATE[s.running[0].state] : s.extensions.slice(0, 3).join(" "),
      testid: "lsp-server", data: { "data-state": live(s).length ? "running" : s.running[0]?.state ?? (s.found ? "found" : "missing"), "data-enabled": String(s.enabled) },
    };
  };
  const groups: Group[] = [
    { id: "on", title: "On in this folder", entries: on.map(entry) },
    { id: "off", title: "Found, off", entries: off.map(entry) },
    { id: "none", title: "Not available here", entries: none.map(entry) },
  ].filter((g) => g.entries.length);
  const s = v.servers.find((x) => x.id === sel);
  const st = v.stats;

  return (
    <div data-testid="lsp-settings">
      <FolderLine tally={[
        { n: v.servers.reduce((n, x) => n + live(x).length, 0), label: "running here" },
        { n: v.totals.alive, label: `alive of ${v.totals.max_servers}` },
        ...(v.servers.some((x) => x.running.some((r) => r.state === "failed")) ? [{ n: v.servers.filter((x) => x.running.some((r) => r.state === "failed")).length, label: "failed", tone: "fail" as const }] : []),
      ]} />
      <div className="k-lsp-modes">
        <div>
          <div className="k-label">After an edit, the model is told</div>
          <div className="mt-2" data-testid="lsp-mode"><Seg label="What the model is told after an edit" value={v.mode} options={MODES} onChange={(mode) => patch({ mode })} /></div>
          <p className="k-lsp-hint">Off unless you turn it on. On, the model reads what an edit caused (the new ones, and how many it fixed) in that edit's result, and each folder being edited keeps a language server running: about 0.6 to 1.2 GB for a TypeScript project of two thousand files.</p>
          <p className="k-lsp-hint" data-testid="lsp-totals">Now: {v.totals.alive} alive, holding {gb(v.totals.rss_mb)}. At most {v.totals.max_servers} are alive and hold {gb(v.totals.max_memory_mb)} together ({gb(v.totals.server_memory_mb)} each); the one used least recently ends first and starts again at the next edit in its folder.</p>
        </div>
        <div>
          <div className="k-label" title={v.trust.root}>In {tail(v.trust.root, 56)}</div>
          <div className="mt-2" data-testid="lsp-folder-mode">
            <Seg label="What the model is told in this folder" value={v.workspace_mode ?? "same"} options={[["same", "As everywhere"], ...MODES]}
              onChange={(m) => patch({ workspaces: { [v.trust.root]: m === "same" ? null : m } })} />
          </div>
          <p className="k-lsp-hint">{v.in_force === "off" ? "No server starts for this folder." : `A server starts at the first edit of a file it serves, waits at most ${(v.wait_ms / 1000).toFixed(1)} s for its answer, and ends after ${v.idle_minutes} idle minutes.`}</p>
        </div>
      </div>
      {v.in_force !== "off" && (
        <div className="k-issue mb-3 flex items-center gap-3" data-tone={v.trust.trusted ? "quiet" : "need"} data-testid="lsp-trust-note" data-trusted={String(v.trust.trusted)}>
          <span className="min-w-0 flex-1">
            {v.trust.trusted
              ? "You trusted this folder's language servers: they start in every session here, confined as that session's commands are."
              : "A server that is a file of this folder, or that loads its code, is this folder's program. It starts by itself only where a session already runs commands without asking: inside the sandbox in Auto edits, Auto and Full auto, and outside one only in Full auto with the sandbox off. In a session that asks, it starts once you trust this folder's language servers."}
          </span>
          <button type="button" className="k-btn" {...(v.trust.trusted ? { "data-quiet": true } : { "data-ink": true })} data-testid="lsp-trust" onClick={() => post("/api/lsp/trust", { cwd: v.cwd, trusted: !v.trust.trusted })}><ShieldCheck /> {v.trust.trusted ? "Take the trust back" : "Trust its language servers"}</button>
        </div>
      )}
      {err && <div className="k-issue mb-3" data-testid="lsp-error">{err}</div>}
      <Ledger groups={groups} selected={sel} onSelect={setSel} testid="lsp-ledger" empty="No language server is known for this folder.">
        {s ? (
          <>
            <ReaderHead
              title={s.label}
              desc={s.runs}
              path={s.found?.command.join(" ") ?? null}
              right={<Toggle on={s.enabled} label={`${s.label} on`} testid="lsp-enabled" onChange={(enabled) => patch({ servers: { [s.id]: { enabled } } })} />}
              facts={[
                ["Files", s.extensions.join(" ")],
                ["Program", s.found ? `${s.found.from === "workspace" ? "a file of this folder" : "on this machine"}${s.found.loads ? ", loads this folder's code" : ""}` : s.missing ?? "not found"],
                ...(s.found ? [["Project root", tilde(s.found.root)] as [string, string]] : []),
                ["Default", s.own ? "yours" : s.auto ? "on" : "off until you turn it on"],
              ]}
            >
              {!s.found && <p className="k-issue mt-3" data-tone="quiet" data-testid="lsp-missing">Nothing is installed for you. Install the server, or name its command under diagnostics.servers.{s.id}.command in the settings file.</p>}
            </ReaderHead>
            <div className="k-reader-body">
              {s.running.length === 0 && <p className="k-empty">{s.enabled && s.found ? "Not running here. It starts when a session edits a file it serves." : "Not running here."}{s.elsewhere > 0 && ` ${s.elsewhere} running for other folders.`}</p>}
              {s.running.map((r) => (
                <div key={`${r.root}:${r.sandbox}`} className="k-lsp-run" data-testid="lsp-running" data-state={r.state}>
                  <div className="flex items-center gap-2">
                    <b className="text-ui">{STATE[r.state] ?? r.state}</b>
                    {r.server && <span className="k-chip font-mono">{r.server}</span>}
                    {r.busy && <span className="k-chip">loading</span>}
                    <button type="button" className="k-btn ml-auto" data-testid="lsp-restart" onClick={() => post("/api/lsp/restart", { id: s.id, root: r.root })}><RotateCw /> {r.pid ? "Restart" : "Start again"}</button>
                  </div>
                  <dl className="k-facts mt-2">
                    <div><dt>Root</dt><dd>{tilde(r.root)}</dd></div>
                    <div><dt>Sandbox</dt><dd data-testid="lsp-sandbox">{r.sandbox === "off" ? "none: as the session's commands" : r.sandbox}</dd></div>
                    {r.pid && <div><dt>Process</dt><dd>{r.pid}{r.ready_ms != null ? `, ready in ${r.ready_ms} ms` : ""}</dd></div>}
                    {r.rss_mb != null && <div><dt>Memory</dt><dd data-testid="lsp-rss">{gb(r.rss_mb)}</dd></div>}
                    {r.pid && <div><dt>Diagnostics</dt><dd>{r.pull ? "asked for each edit" : "pushed by the server"}</dd></div>}
                    <div><dt>Sessions</dt><dd>{r.sessions}</dd></div>
                    {r.retry_in_ms != null && <div><dt>Next start</dt><dd>in {Math.ceil(r.retry_in_ms / 1000)} s</dd></div>}
                  </dl>
                  {r.error && <div className="k-issue mt-2" data-tone={r.state === "untrusted" || r.state === "missing" ? "quiet" : undefined} data-testid="lsp-run-error">{r.error.slice(0, 600)}</div>}
                  {r.argv.length > 0 && (
                    <details className="mt-2">
                      <summary className="k-link cursor-pointer text-caption text-muted hover:text-fg">The command as it runs</summary>
                      <code className="mt-1.5 block font-mono text-micro leading-relaxed break-all text-muted" data-testid="lsp-argv">{r.argv.join(" ")}</code>
                    </details>
                  )}
                </div>
              ))}
              {st.edits > 0 && (
                <div data-testid="lsp-stats">
                  <div className="k-sub k-label">Since this daemon started</div>
                  <dl className="k-facts">
                    <div><dt>Edits checked</dt><dd>{st.edits}</dd></div>
                    <div><dt>Answered in time</dt><dd>{st.answered}{st.timed_out ? `, ${st.timed_out} late` : ""}</dd></div>
                    <div><dt>Mean wait</dt><dd>{Math.round(st.wait_ms / st.edits)} ms</dd></div>
                    <div><dt>Told the model</dt><dd>{st.errors} {st.errors === 1 ? "error" : "errors"}, {st.warnings} {st.warnings === 1 ? "warning" : "warnings"}, {st.fixed} fixed</dd></div>
                    <div><dt>Tokens added</dt><dd>{st.tokens}</dd></div>
                  </dl>
                </div>
              )}
            </div>
          </>
        ) : <Blank title="No server picked" />}
      </Ledger>
    </div>
  );
}
