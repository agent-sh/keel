// How a skill's allowed-tools field is read and what rules it becomes.
import { expect, test } from "bun:test";
import { listField, skillRules, type Skill } from "./skills.ts";

test("allowed-tools: a string splits at spaces and commas outside a rule's parentheses; a list is taken as it is", () => {
  expect(listField("Bash(git add *) Bash(git commit *), Read")).toEqual(["Bash(git add *)", "Bash(git commit *)", "Read"]);
  expect(listField(["Bash(npm test)", " Grep "])).toEqual(["Bash(npm test)", "Grep"]);
  expect(listField(undefined)).toEqual([]);
});

test("allowed-tools become the rules a Claude Code allow maps to, the skill's folder filled in; a write is an edit", () => {
  const skill = { allowedTools: ["Bash(${CLAUDE_SKILL_DIR}/run.sh *)", "Read", "Write", "Bash(cat a | wc -l)", "mcp__gh__get_issue"] } as Skill;
  const { rules, left } = skillRules(skill, { CLAUDE_SKILL_DIR: "/s/k", CLAUDE_PROJECT_DIR: "/p" });
  expect(rules).toEqual([{ kind: "shell", pattern: "/s/k/run.sh *" }, { kind: "edit", pattern: "/p" }, { kind: "tool", pattern: "gh__get_issue" }]);
  expect(left).toHaveLength(1);
  expect(left[0]).toStartWith("Bash(cat a | wc -l)");
});
