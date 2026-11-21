// Settings > Hooks: commands at fixed points of a session, in the hooks.json
// shape Claude Code and Codex share. Yours runs and is edited here; a
// repository's runs only once you read and pin exactly that file.
import { useCallback, useEffect, useState } from "react";
import { api, reportError, failed } from "../../lib/store.ts";
import { Blank, FileEditor, FolderLine, Ledger, ReaderHead, tilde, type Group } from "./kit.tsx";

type Source = { path: string; scope: "owner" | "project"; root: string; text: string; sha256: string; active: boolean; events: Record<string, number>; problems: string[]; covers?: string[] };
type Owner = { path: string; text: string | null; template: string };

export default function Hooks() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<{ sources: Source[] }>("/api/hooks").then((r) => setSources(r.sources)).catch(reportError);
    api<Owner>("/api/hooks/owner").then(setOwner).catch(reportError);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (owner && !sel) setSel(owner.path); }, [owner]);

  const mine = sources?.find((s) => s.scope === "owner");
  const repos = sources?.filter((s) => s.scope === "project") ?? [];
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
      <FolderLine global="A hook can block, ask, change a call or add context; its allow answers only a low-risk ask" tally={[
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
              desc="Runs in every session. Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact; each takes a matcher and command handlers."
              facts={mine ? Object.entries(mine.events).map(([e, n]) => [e, `${n}`] as [string, string]) : []}
            >
              {mine && mine.problems.length > 0 && <ul className="k-issue mt-3" data-testid="hook-problems">{mine.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            </ReaderHead>
            <FileEditor
              name="hooks.json"
              text={owner.text ?? owner.template}
              note={owner.text === null ? "Not written yet: this is an example to start from." : "Sessions run the saved file from their next event."}
              onSave={async (text) => {
                const r = await api<{ problems: string[] }>("/api/hooks/owner", { method: "PUT", body: JSON.stringify({ text }) });
                load();
                return r.problems.length ? `Saved, with problems: ${r.problems.join("; ")}` : undefined;
              }}
            />
          </>
        ) : cur ? (
          <>
            <ReaderHead
              title={tilde(cur.root)}
              path={cur.path}
              desc={cur.active ? "Pinned: it runs at exactly this content." : "Read it, then pin it: it runs only at the content you pinned, and a change to it or to a script it runs stops it until you pin again."}
              right={!cur.active && cur.sha256 ? <button type="button" className="k-btn" data-ink data-testid="hook-pin" onClick={() => pin(cur)}>Pin this file</button> : undefined}
              facts={Object.entries(cur.events).map(([e, n]) => [e, `${n}`] as [string, string])}
            >
              {err && <p className="k-issue mt-3">{err}</p>}
              {cur.problems.length > 0 && <ul className="k-issue mt-3" data-tone={cur.active ? undefined : "need"} data-testid="hook-problems">{cur.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
              {!!cur.covers?.length && <p className="mt-3 text-caption text-muted" data-testid="hook-covers">The pin also covers what it runs: {cur.covers.map((f, i) => <span key={f}>{i ? ", " : ""}<code className="font-mono text-micro">{f}</code></span>)}</p>}
            </ReaderHead>
            <FileEditor name="hooks.json" text={cur.text} readOnly="a repository's file is pinned, not edited here" testid="hook-text" />
          </>
        ) : <Blank title="Reading the hook files" />}
      </Ledger>
    </div>
  );
}
