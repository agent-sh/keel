// Customize > Agents: the advisor, and every subagent definition the model can
// start (built in, yours, the repository's) with its file.
import { useCallback, useEffect, useState } from "react";
import { api, reportError } from "../../lib/store.ts";
import AgentSettings from "../automation/AgentSettings.tsx";
import { Blank, FileEditor, FolderLine, Ledger, NewFile, ReaderHead, useFolder, type Group, type Mark } from "./kit.tsx";

type Def = {
  name: string; description: string; source: string; file: string | null; model: string | null; tools: string[] | null; disallowed: string[] | null;
  permission_mode: string | null; isolation: string | null; read_only: boolean; trust: string | null;
  format: "markdown" | "codex"; effort: string | null;
};
type Listing = { agents: Def[]; homes: { owner: string; project: string } };
const dir = (f: string) => f.slice(0, f.lastIndexOf("/"));
const mark = (d: Def): Mark => (d.trust === "new" || d.trust === "changed" ? "need" : "on");

export default function Agents() {
  const [cwd] = useFolder();
  const [data, setData] = useState<Listing | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; file: string | null; text: string } | null>(null);
  const load = useCallback(() => (cwd ? api<Listing>(`/api/agents/files?cwd=${encodeURIComponent(cwd)}`).then(setData).catch(reportError) : undefined), [cwd]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (data && !sel && data.agents[0]) setSel(data.agents[0].name); }, [data]);
  const cur = data?.agents.find((d) => d.name === sel);
  useEffect(() => {
    setFile(null);
    if (cur) api<{ name: string; file: string | null; text: string }>(`/api/agents/file?cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(cur.name)}`).then(setFile).catch(reportError);
  }, [cur?.name, cur?.file, cwd]);

  const groups = new Map<string, Group>();
  for (const d of data?.agents ?? []) {
    const key = d.file ? dir(d.file) : "built-in";
    const title = !d.file ? "Built in" : d.source === "project" ? (d.format === "codex" ? "This repository, Codex" : "This repository") : d.format === "codex" ? "Codex" : /\/\.claude\/agents$/.test(key) ? "Claude Code" : "Yours";
    const g = groups.get(key) ?? groups.set(key, { id: key, title, path: d.file ? key : undefined, entries: [] }).get(key)!;
    g.entries.push({ id: d.name, name: d.name, desc: d.description, mark: mark(d), aside: d.read_only ? "reads" : d.permission_mode ?? "", testid: "agent-entry" });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="agents-settings">
      <AgentSettings />
      <div>
        <FolderLine tally={[
          { n: data?.agents.length ?? 0, label: "agents" },
          { n: data?.agents.filter((d) => d.file).length ?? 0, label: "from files" },
        ]} />
        <Ledger testid="agents-ledger" groups={[...groups.values()]} selected={sel} onSelect={setSel} add={[{ id: "+new", label: "New agent" }]}>
          {sel === "+new" ? (
            <>
              <ReaderHead title="New agent" desc="A Markdown file with frontmatter, the shape Claude Code reads: the model picks an agent by its description and starts it with the body as its instructions. Add tools, model or permission_mode to the frontmatter after." />
              <div className="k-reader-body">
                <NewFile
                  kind="agent"
                  hint="Use to review a diff for correctness before it lands."
                  scopes={[["owner", "Yours", `${data?.homes.owner ?? ""}/`], ["project", "This repository", `${data?.homes.project ?? ""}/`]]}
                  onCreate={async (b) => {
                    const r = await api<Listing>("/api/agents/files", { method: "POST", body: JSON.stringify({ ...b, cwd }) });
                    setData({ ...data!, agents: r.agents });
                    setSel(b.name);
                  }}
                />
              </div>
            </>
          ) : cur ? (
            <>
              <ReaderHead
                title={cur.name}
                desc={cur.description}
                path={cur.file}
                facts={[
                  ["Source", cur.file ? (cur.source === "project" ? "this repository" : "yours") : "built in"],
                  ["Model", cur.model ? (cur.format === "codex" ? `${cur.model} when listed, else the session's` : cur.model) : "the session's"],
                  ...(cur.effort ? [["Effort", `${cur.effort} when the model lists it`] as [string, string]] : []),
                  ["Tools", cur.tools ? `${cur.tools.length}` : cur.read_only ? "reads only" : "all"],
                  ...(cur.disallowed?.length ? [["Not allowed", cur.disallowed.join(", ")] as [string, string]] : []),
                  ["Mode", cur.read_only ? "read only" : cur.permission_mode ?? "the session's"],
                  ...(cur.isolation ? [["Isolation", cur.isolation] as [string, string]] : []),
                ]}
              />
              {file && (
                <FileEditor
                  name={cur.file ? cur.file.slice(cur.file.lastIndexOf("/") + 1) : `${cur.name} (built in)`}
                  text={file.text}
                  readOnly={cur.file ? undefined : "built in: a file of the same name in yours replaces it"}
                  onSave={cur.file ? async (text) => {
                    const r = await api<Listing>("/api/agents/files", { method: "PUT", body: JSON.stringify({ cwd, name: cur.name, text }) });
                    setData({ ...data!, agents: r.agents });
                  } : undefined}
                  note={cur.file ? "Agents started after a save run on it." : undefined}
                />
              )}
            </>
          ) : <Blank title="No agent picked" />}
        </Ledger>
      </div>
    </div>
  );
}
