// Customize > Commands: everything the message box answers to after a slash.
// Keel's own commands, command files (the older form of a skill) and the
// skills you can run by name, each with where it comes from.
import { useEffect, useState, useSyncExternalStore } from "react";
import { slash } from "../../lib/extend.ts";
import { api } from "../../lib/store.ts";
import { Blank, FolderLine, Ledger, NewFile, ReaderHead, useFolder, type Group } from "./kit.tsx";
import { groupSkills, SkillReader, useSkills, type SkillInfo } from "./Skills.tsx";

export default function Commands() {
  const [cwd] = useFolder();
  const [data, load, setData] = useSkills(cwd);
  useSyncExternalStore(slash.subscribe, slash.version);
  const builtIn = slash.all().filter((i) => i.run).sort((a, b) => a.id.localeCompare(b.id));
  const runnable = data?.skills.filter((s) => s.user_invocable) ?? [];
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (!sel && builtIn[0]) setSel(`b:${builtIn[0].id}`); }, [builtIn.length]);

  const fileGroups = groupSkills(runnable.filter((s) => s.kind === "command"), () => "file");
  const skillGroup: Group = {
    id: "skills", title: "From skills", entries: runnable.filter((s) => s.kind === "skill").map((s) => ({
      id: s.name, name: `/${s.name}`, desc: s.description, mark: s.enabled ? "on" as const : "off" as const, aside: s.argument_hint ?? "", testid: "command-entry",
    })),
  };
  const groups: Group[] = [
    { id: "builtin", title: "Built in", entries: builtIn.map((i) => ({ id: `b:${i.id}`, name: `/${i.id}`, desc: i.label, mark: "on" as const, aside: i.hint ?? "", testid: "command-entry" })) },
    ...fileGroups.map((g) => ({ ...g, entries: g.entries.map((e) => ({ ...e, name: `/${e.name}`, testid: "command-entry" })) })),
    skillGroup,
  ];
  const item = sel?.startsWith("b:") ? builtIn.find((i) => `b:${i.id}` === sel) : undefined;
  const skill = sel && !sel.startsWith("b:") && sel !== "+new" ? runnable.find((s) => s.name === sel) : undefined;

  return (
    <div data-testid="commands-settings">
      <FolderLine tally={[
        { n: builtIn.length, label: "built in" },
        { n: runnable.filter((s) => s.kind === "command").length, label: "command files" },
        { n: skillGroup.entries.length, label: "skills" },
      ]} />
      <Ledger testid="commands-ledger" groups={groups} selected={sel} onSelect={setSel} add={[{ id: "+new", label: "New command" }]}>
        {item ? (
          <>
            <ReaderHead title={`/${item.id}`} desc={item.label} facts={[["Kind", "built in"], ...(item.hint ? [["Arguments", item.hint] as [string, string]] : [])]} />
            <div className="k-reader-body">
              <p className="k-issue" data-tone="quiet">Part of Keel: no file to edit. Type <code className="font-mono">/{item.id}</code> in the message box; a skill of the same name does not replace it.</p>
            </div>
          </>
        ) : skill ? (
          <SkillReader key={skill.name} name={skill.name} cwd={cwd} onChanged={(skills?: SkillInfo[]) => (skills ? setData({ ...data!, skills }) : load())} />
        ) : sel === "+new" ? (
          <>
            <ReaderHead title="New command" desc="A command is a skill you run by name: /name and what follows becomes $ARGUMENTS. Claude Code merged its command files into skills, so a new one is written as a skill." />
            <div className="k-reader-body">
              <NewFile
                kind="command"
                hint="Summarize the changes on this branch for a pull request."
                scopes={[["personal", "Yours", `${data?.homes.personal ?? ""}/`], ["project", "This repository", `${data?.homes.project ?? ""}/`]]}
                onCreate={async (b) => {
                  const r = await api<{ skill: SkillInfo }>("/api/skills", { method: "POST", body: JSON.stringify({ ...b, cwd }) });
                  await load();
                  setSel(r.skill.name);
                }}
              />
            </div>
          </>
        ) : <Blank title="No command picked" />}
      </Ledger>
    </div>
  );
}
