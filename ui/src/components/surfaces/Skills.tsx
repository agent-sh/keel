// Settings > Skills: every skill from every folder Keel reads, where each one
// comes from, its file, on and off, and a new one.
import { useCallback, useEffect, useState } from "react";
import { api, reportError } from "../../lib/store.ts";
import { Blank, FileEditor, FolderLine, Ledger, NewFile, ReaderHead, Toggle, tok, useFolder, type Group, type Mark } from "./kit.tsx";

export type SkillInfo = {
  name: string; description: string; scope: "personal" | "project"; kind: "skill" | "command"; root: string; dir: string; file: string;
  enabled: boolean; user_invocable: boolean; model_invocable: boolean; argument_hint?: string;
  trust: "trusted" | "new" | "changed" | "gone" | null; listing_tokens: number;
};
type Listing = { skills: SkillInfo[]; homes: { personal: string; project: string } };

// Where a folder of skills or commands is, in words.
export function rootTitle(s: SkillInfo): string {
  if (s.scope === "project") return s.kind === "command" ? "This repository, command files" : "This repository";
  if (/\/\.claude\/(skills|commands)$/.test(s.root)) return s.kind === "command" ? "Claude Code commands" : "Claude Code";
  if (/\/\.agents\/skills$/.test(s.root)) return "Shared with other agents";
  return s.kind === "command" ? "Your commands" : "Yours";
}
export const skillMark = (s: SkillInfo): Mark => (s.trust === "new" || s.trust === "changed" ? "need" : s.enabled ? "on" : "off");
export const loads = (s: SkillInfo) =>
  s.model_invocable && s.user_invocable ? `the model, and you as /${s.name}` : s.model_invocable ? "only the model" : s.user_invocable ? `only you, as /${s.name}` : "nobody";

export function useSkills(cwd: string) {
  const [data, setData] = useState<Listing | null>(null);
  const load = useCallback(() => (cwd ? api<Listing>(`/api/skills?cwd=${encodeURIComponent(cwd)}`).then(setData).catch(reportError) : undefined), [cwd]);
  useEffect(() => { load(); }, [load]);
  return [data, load, setData] as const;
}

export function groupSkills(list: SkillInfo[], aside: (s: SkillInfo) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const s of list) {
    const g = groups.get(s.root) ?? groups.set(s.root, { id: s.root, title: rootTitle(s), path: s.root, entries: [] }).get(s.root)!;
    g.entries.push({ id: s.name, name: s.name, desc: s.description, mark: skillMark(s), markLabel: s.enabled ? "on" : "off", aside: aside(s), testid: "skill-entry" });
  }
  return [...groups.values()];
}

// One skill: what it costs, who can run it, its file.
export function SkillReader({ name, cwd, onChanged }: { name: string; cwd: string; onChanged: (skills?: SkillInfo[]) => void }) {
  const [d, setD] = useState<{ skill: SkillInfo; text: string; body_tokens: number } | null>(null);
  const q = `cwd=${encodeURIComponent(cwd)}`;
  useEffect(() => { setD(null); api(`/api/skills/${encodeURIComponent(name)}?${q}`).then(setD).catch(reportError); }, [name, q]);
  if (!d) return <Blank title="Reading the skill" />;
  const s = d.skill;
  const held = s.trust === "new" || s.trust === "changed";
  return (
    <>
      <ReaderHead
        title={s.kind === "command" ? `/${s.name}` : s.name}
        desc={s.description}
        path={s.file}
        right={<Toggle testid="skill-toggle" on={s.enabled} label={`Turn ${s.name} ${s.enabled ? "off" : "on"}`} onChange={async (on) => {
          const r = await api<{ skills: SkillInfo[] }>(`/api/skills/${encodeURIComponent(s.name)}/toggle`, { method: "POST", body: JSON.stringify({ cwd, enabled: on }) }).catch(reportError);
          if (r) { setD({ ...d, skill: { ...s, enabled: on } }); onChanged(r.skills); }
        }} />}
        facts={[
          ["Kind", s.kind === "command" ? "command file" : "skill"],
          ["Runs for", loads(s)],
          ...(s.argument_hint ? [["Arguments", s.argument_hint] as [string, string]] : []),
          ["Every session", s.model_invocable && s.enabled ? `~${tok(s.listing_tokens)} tokens` : "nothing"],
          ["When loaded", `~${tok(d.body_tokens)} tokens`],
          ...(s.trust ? [["Trust", s.trust] as [string, string]] : []),
        ]}
      >
        {held && (
          <div className="k-issue mt-3" data-tone="need" data-testid="skill-held">
            {s.trust === "new" ? "New in this repository: " : "Changed since you trusted it: "}
            sessions do not load it until you trust it. Saving it here trusts what you saved.
          </div>
        )}
      </ReaderHead>
      <FileEditor
        name={s.kind === "command" ? `${s.name}.md` : "SKILL.md"}
        text={d.text}
        note="New sessions read a change. A running session keeps the list it started with, so its cached prompt stays the same."
        onSave={async (text) => {
          const r = await api<{ skill: SkillInfo; text: string; body_tokens?: number }>(`/api/skills/${encodeURIComponent(s.name)}`, { method: "PUT", body: JSON.stringify({ cwd, text }) });
          setD({ skill: r.skill, text: r.text, body_tokens: Math.ceil(r.text.length / 4) });
          onChanged();
        }}
      />
    </>
  );
}

export default function Skills() {
  const [cwd] = useFolder();
  const [data, load, setData] = useSkills(cwd);
  const [sel, setSel] = useState<string | null>(null);
  const list = data?.skills.filter((s) => s.kind === "skill") ?? [];
  const cur = sel && sel !== "+new" ? list.find((s) => s.name === sel) : undefined;
  useEffect(() => { if (data && !sel && list[0]) setSel(list[0].name); }, [data]);
  const every = list.filter((s) => s.enabled && s.model_invocable).reduce((n, s) => n + s.listing_tokens, 0);
  const held = list.filter((s) => skillMark(s) === "need").length;
  return (
    <div data-testid="skills-settings">
      <FolderLine tally={[
        { n: list.length, label: "skills" },
        { n: list.filter((s) => !s.enabled).length, label: "off" },
        ...(held ? [{ n: held, label: "held", tone: "need" as const }] : []),
        { n: every, label: "tokens a session" },
      ]} />
      <Ledger
        testid="skills-ledger"
        groups={groupSkills(list, (s) => (!s.enabled ? "off" : s.model_invocable ? `${tok(s.listing_tokens)} tok` : "by hand"))}
        selected={sel}
        onSelect={setSel}
        add={[{ id: "+new", label: "New skill" }]}
        empty="No skills in your folders or this repository."
      >
        {sel === "+new" ? (
          <>
            <ReaderHead title="New skill" desc="A folder with a SKILL.md, in the shape Claude Code, Codex and OpenCode share. The model sees its name and the line below in every session, and loads the rest when a task matches." />
            <div className="k-reader-body">
              <NewFile
                kind="skill"
                hint="Use when writing release notes from the merged pull requests."
                scopes={[["personal", "Yours", `${data?.homes.personal ?? ""}/`], ["project", "This repository", `${data?.homes.project ?? ""}/`]]}
                onCreate={async (b) => {
                  const r = await api<{ skill: SkillInfo }>("/api/skills", { method: "POST", body: JSON.stringify({ ...b, cwd }) });
                  await load();
                  setSel(r.skill.name);
                }}
              />
            </div>
          </>
        ) : cur ? (
          <SkillReader key={cur.name} name={cur.name} cwd={cwd} onChanged={(skills) => (skills ? setData({ ...data!, skills }) : load())} />
        ) : (
          <Blank title="No skill picked">Pick one on the left, or make a new one.</Blank>
        )}
      </Ledger>
    </div>
  );
}
