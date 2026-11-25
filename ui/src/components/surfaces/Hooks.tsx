// Customize > Hooks: commands at fixed points of a session, in the hooks.json
// shape Claude Code and Codex share. Yours runs and is edited here; a
// repository's runs only once you read and pin exactly that file.
import { useCallback, useEffect, useState } from "react";
import { api, reportError, failed } from "../../lib/store.ts";
import { Blank, FileEditor, FolderLine, Ledger, ReaderHead, tilde, type Group } from "./kit.tsx";
import { navigate } from "../../lib/ui.ts";
import { fmtMs } from "../../lib/observe.ts";
import { ago } from "../../lib/utils.ts";

// `whole`: the text is all of the file (a longer one is not pinned). `notes`: what loads and never runs here.
// `reaches`: where its hooks send what they are given.
type Source = { path: string; scope: "owner" | "project" | "plugin"; plugin?: string; root: string; text: string; sha256: string; active: boolean; events: Record<string, number>; problems: string[]; covers?: string[]; whole?: boolean; notes?: string[]; reaches?: { urls: string[]; tools: string[] }; unheld?: string[] };

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

// What a file's hooks reach outside the machine's own commands, and what loads without running: read before a pin.
function Reach({ s }: { s: Source }) {
  return (
    <>
      {s.reaches?.urls.map((u) => (
        <p key={u} className="k-issue mt-3" data-tone="need" data-testid="hook-sends">Sends your prompts, tool inputs and tool results to <b>{host(u)}</b>: <code className="font-mono text-micro">{u}</code></p>
      ))}
      {s.reaches?.tools.map((t) => (
        <p key={t} className="k-issue mt-3" data-tone="quiet" data-testid="hook-calls">Calls the MCP tool <code className="font-mono text-micro">{t}</code> with values of the event, without asking.</p>
      ))}
      {s.unheld?.map((f) => (
        <p key={f} className="k-issue mt-3" data-tone="need" data-testid="hook-unheld">Runs <code className="font-mono text-micro">{f}</code>, which the pin does not hold: it runs as it is on disk when its hook fires. Keel asks you before a session changes it. Keep a script under <code className="font-mono text-micro">.keel/</code> to pin it with the file.</p>
      ))}
      {!!s.notes?.length && <ul className="k-issue mt-3" data-tone="quiet" data-testid="hook-notes">{s.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </>
  );
}
type Owner = { path: string; text: string | null; template: string };
type Run = { hook: string; event: string; file: string; runs: number; p95_ms: number; failures: number; last_ms: number; last_outcome: string };

// What each hook of this file did in the last day, from the spans its runs leave in their turns' traces.
function Runs({ file, runs }: { file: string; runs: Run[] | null }) {
  const mine = (runs ?? []).filter((r) => r.file === file);
  if (!mine.length) return runs ? <p className="mt-3 text-caption text-faint" data-testid="hook-runs-none">No run of these hooks in the last day (a hook that runs inside a turn is counted).</p> : null;
  return (
    <div className="mt-3" data-testid="hook-runs">
      <div className="k-sub k-label">Runs in the last day</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto_auto] items-baseline gap-x-4 gap-y-1 text-caption tabular-nums">
        {["Hook", "Runs", "p95", "Failures", "Last run", ""].map((h, i) => <span key={i} className={`text-micro text-faint ${i ? "text-right" : ""}`}>{h}</span>)}
        {mine.map((r) => (
          <div key={`${r.event}\n${r.hook}`} className="contents" data-testid="hook-run-row" data-hook={r.hook} data-failures={r.failures}>
            <span className="min-w-0 truncate" title={r.hook}><span className="text-muted">{r.event}</span> <code className="font-mono text-micro">{r.hook}</code></span>
            <span className="text-right" data-testid="hook-run-count">{r.runs}</span>
            <span className="text-right" data-testid="hook-run-p95">{fmtMs(r.p95_ms)}</span>
            <span className={`text-right ${r.failures ? "text-danger" : "text-faint"}`} data-testid="hook-run-failed">{r.failures}</span>
            <span className="text-right text-muted">{ago(r.last_ms)}</span>
            <span className={`text-right ${r.last_outcome === "failed" || r.last_outcome === "timed out" ? "text-danger" : "text-faint"}`} data-testid="hook-run-last">{r.last_outcome}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Hooks() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [runs, setRuns] = useState<Run[] | null>(null);
  const load = useCallback(() => {
    api<{ runs: Run[] }>("/api/hooks/runs").then((r) => setRuns(r.runs)).catch(reportError);
    api<{ sources: Source[] }>("/api/hooks").then((r) => setSources(r.sources)).catch(reportError);
    api<Owner>("/api/hooks/owner").then(setOwner).catch(reportError);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (owner && !sel) setSel(owner.path); }, [owner]);

  const mine = sources?.find((s) => s.scope === "owner");
  const repos = sources?.filter((s) => s.scope === "project") ?? [];
  const plugins = sources?.filter((s) => s.scope === "plugin") ?? [];
  const events = (s: Source) => Object.values(s.events).reduce((n, x) => n + x, 0);
  const groups: Group[] = [
    {
      id: "owner", title: "Yours", path: owner?.path, entries: owner ? [{
        id: owner.path, name: "hooks.json", desc: mine ? Object.keys(mine.events).join(", ") || "no handlers" : "not written yet",
        mark: mine ? (mine.problems.length ? "fail" : "on") : "off", aside: mine ? `${events(mine)}` : "new", testid: "hook-source",
        data: { "data-scope": "owner", "data-active": String(!!mine?.active) },
      }] : [],
    },
    {
      id: "repos", title: "Repositories", entries: repos.map((s) => ({
        id: s.path, name: tilde(s.root).split("/").pop() || s.root, desc: tilde(s.root), mark: s.active ? "on" as const : "need" as const,
        aside: s.active ? `${events(s)}` : "not pinned", testid: "hook-source", data: { "data-scope": "project", "data-active": String(s.active) },
      })),
    },
    {
      id: "plugins", title: "From plugins", entries: plugins.map((s) => ({
        id: s.path, name: s.plugin ?? tilde(s.path), desc: Object.keys(s.events).join(", "), mark: "on" as const,
        aside: `${events(s)}`, testid: "hook-source", data: { "data-scope": "plugin", "data-active": "true", "data-plugin": s.plugin ?? "" },
      })),
    },
  ];
  const cur = sources?.find((s) => s.path === sel);
  const pin = async (s: Source) => {
    setErr("");
    try {
      await api("/api/hooks/trust", { method: "POST", body: JSON.stringify({ cwd: s.root, sha256: s.sha256 }) });
      load();
    } catch (e) { setErr(failed(e, { at: "Hooks" })); }
  };
  const isOwner = sel === owner?.path;

  return (
    <div data-testid="hooks-settings">
      <FolderLine global="A hook can block, ask, change a call or add context; its allow answers only a card you would have got, for a call inside the session's own scope" tally={[
        { n: (mine ? 1 : 0) + repos.length, label: "files" },
        { n: sources?.filter((s) => s.active).reduce((n, s) => n + events(s), 0) ?? 0, label: "handlers running" },
        ...(repos.some((s) => !s.active) ? [{ n: repos.filter((s) => !s.active).length, label: "wait for a pin", tone: "need" as const }] : []),
      ]} />
      <Ledger testid="hooks-ledger" groups={groups} selected={sel} onSelect={setSel}>
        {isOwner && owner ? (
          <>
            <ReaderHead
              title="Your hooks"
              path={owner.path}
              desc="Runs in every session, with no pin. Twenty events fire (the README lists them with what each can do); each takes a matcher and handlers: a command, an http URL or an MCP tool."
              facts={mine ? Object.entries(mine.events).map(([e, n]) => [e, `${n}`] as [string, string]) : []}
            >
              {mine && mine.problems.length > 0 && <ul className="k-issue mt-3" data-testid="hook-problems">{mine.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              {mine && <Reach s={mine} />}
              {mine && <Runs file={mine.path} runs={runs} />}
            </ReaderHead>
            <FileEditor
              name="hooks.json"
              text={owner.text ?? owner.template}
              note={owner.text === null ? "Not written yet: this is an example to start from." : "Sessions run the saved file from their next event."}
              onSave={async (text) => {
                const r = await api<{ problems: string[] }>("/api/hooks/owner", { method: "PUT", body: JSON.stringify({ text }) });
                load();
                return r.problems.length ? `Saved, with problems: ${r.problems.join("; ")}` : undefined; // (what loads and never runs is listed above, and is no problem)
              }}
            />
          </>
        ) : cur?.scope === "plugin" ? (
          <>
            <ReaderHead
              title={cur.plugin ?? "Plugin"}
              path={cur.path}
              desc="A plugin's hooks run as you agreed when you installed it, while the plugin is on. Turn it off or remove it in Customize > Plugins."
              right={<button type="button" className="k-btn" data-testid="hook-plugin" onClick={() => navigate({ name: "customize", section: "plugins" })}>Open in Plugins</button>}
              facts={Object.entries(cur.events).map(([e, n]) => [e, `${n}`] as [string, string])}
            >
              {cur.problems.length > 0 && <ul className="k-issue mt-3" data-testid="hook-problems">{cur.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              <Reach s={cur} />
              <Runs file={cur.path} runs={runs} />
            </ReaderHead>
            <FileEditor name="its hooks" text={cur.text} readOnly="a plugin's hooks change with the plugin: update it in Customize > Plugins" testid="hook-text" />
          </>
        ) : cur ? (
          <>
            <ReaderHead
              title={tilde(cur.root)}
              path={cur.path}
              desc={cur.active ? "Pinned: it runs at exactly this content." : "Read it, then pin it: it runs only at the content you pinned, and a change to it or to a script it runs stops it until you pin again."}
              right={!cur.active && cur.sha256 && cur.whole !== false ? <button type="button" className="k-btn" data-ink data-testid="hook-pin" onClick={() => pin(cur)}>Pin this file</button> : undefined}
              facts={Object.entries(cur.events).map(([e, n]) => [e, `${n}`] as [string, string])}
            >
              {err && <p className="k-issue mt-3">{err}</p>}
              {cur.problems.length > 0 && <ul className="k-issue mt-3" data-tone={cur.active ? undefined : "need"} data-testid="hook-problems">{cur.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              {cur.whole === false && <p className="k-issue mt-3" data-testid="hook-too-long">This file is longer than Keel shows whole, so it cannot be pinned: you would pin hooks you were not shown.</p>}
              <Reach s={cur} />
              <Runs file={cur.path} runs={runs} />
              {!!cur.covers?.length && <p className="mt-3 text-caption text-muted" data-testid="hook-covers">The pin also covers what it runs: {cur.covers.map((f, i) => <span key={f}>{i ? ", " : ""}<code className="font-mono text-micro">{f}</code></span>)}</p>}
            </ReaderHead>
            <FileEditor name="hooks.json" text={cur.text} readOnly="a repository's file is pinned, not edited here" testid="hook-text" />
          </>
        ) : <Blank title="Reading the hook files" />}
      </Ledger>
    </div>
  );
}
