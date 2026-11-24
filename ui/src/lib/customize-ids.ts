// Customize: the sections that shape the agent, kept out of Settings. They are sections of the
// same registry (`settingsSections`, lib/extend.ts) and are drawn on the same page frame
// (components/Settings.tsx); what makes one of them Customize's is only its id here.

// The rail's groups, in order: what the agent is told, what it can use, what comes over from other tools.
export const CUSTOMIZE_GROUPS: [string, string[]][] = [
  ["Guide the agent", ["instructions", "rulings", "lessons"]],
  ["Extend it", ["skills", "commands", "agents", "plugins", "hooks", "mcp", "lsp"]],
  ["Bring over", ["port"]],
];

const IDS = new Set(CUSTOMIZE_GROUPS.flatMap(([, ids]) => ids));
export const isCustomize = (id: string | undefined): boolean => !!id && IDS.has(id);
