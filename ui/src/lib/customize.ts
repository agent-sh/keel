// The palette's entries for Customize: the page, and each of its sections by name.
import { registerCommand } from "./keys.ts";
import { navigate } from "./ui.ts";

// What the palette says for each section: the label, and the words that find it besides.
const COMMANDS: [string, string, string][] = [
  ["instructions", "Instructions", "agents.md claude.md memory files prompt"],
  ["rulings", "Standing rulings", "kept answers decisions revoke"],
  ["lessons", "Lessons from repeated failures", "learned mistakes recurring notes"],
  ["skills", "Skills", "skill.md agent skills"],
  ["commands", "Commands", "slash command files prompts"],
  ["agents", "Agents", "advisor consult second opinion"],
  ["plugins", "Plugins", "provider plugins bundled"],
  ["hooks", "Hooks", "pretooluse posttooluse pin"],
  ["mcp", "MCP servers", "tools connect oauth"],
  ["lsp", "Language servers", "lsp diagnostics type errors"],
  ["port", "Bring your setup from other tools", "port import migrate claude codex hermes"],
];

registerCommand(
  { id: "customize", label: "Customize", group: "General", words: "instructions skills commands agents plugins hooks mcp language servers rulings lessons shape the agent", run: () => navigate({ name: "customize", section: "instructions" }) },
  ...COMMANDS.map(([id, label, words]) => ({ id: `customize-${id}`, label: `Customize: ${label}`, group: "General", words, run: () => navigate({ name: "customize", section: id }) })),
);
