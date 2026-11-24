// Client commands of `keel`. Each takes its own argv and returns an exit code.
//
// A command's code is loaded when the command is run, and no other: `keel
// status` loads the admin commands and the client, never the daemon. So this
// file names where each command lives and imports nothing of them.
export type Command = (argv: string[]) => Promise<number>;

const from = {
  mobile: () => import("./mobile.ts").then((m) => m.mobileCommands as Record<string, Command>),
  acp: () => import("./acp.ts").then((m) => m.acpCommands as Record<string, Command>),
  admin: () => import("./admin.ts").then((m) => m.adminCommands as Record<string, Command>),
  plugin: () => import("./plugin.ts").then((m) => m.pluginCommands as Record<string, Command>),
  sessions: () => import("./sessions.ts").then((m) => m.sessionCommands as Record<string, Command>),
  login: () => import("./login.ts").then((m) => m.loginCommands as Record<string, Command>),
  providers: () => import("./providers.ts").then((m) => m.providerCommands as Record<string, Command>),
  inspect: () => import("./inspect.ts").then((m) => m.inspectCommands as Record<string, Command>),
  run: () => import("./run.ts").then((m): Record<string, Command> => ({
    run: m.run,
    // `keel -p PROMPT` is `keel run -p PROMPT`, as with claude -p.
    "-p": (argv) => m.run(["-p", ...argv]),
    "--print": (argv) => m.run(["-p", ...argv]),
  })),
  rules: () => import("./rules.ts").then((m): Record<string, Command> => ({ rules: m.rulesCmd })),
  safety: () => import("./safety.ts").then((m): Record<string, Command> => ({ safety: m.safetyCmd })),
  review: () => import("./review.ts").then((m): Record<string, Command> => ({ review: m.reviewCmd })),
  debug: () => import("./debug.ts").then((m): Record<string, Command> => ({ debug: m.debug })),
  import: () => import("./imports.ts").then((m): Record<string, Command> => ({ import: m.importCmd })),
  port: () => import("./port.ts").then((m): Record<string, Command> => ({ port: m.portCmd })),
  mcp: () => import("./mcp.ts").then((m): Record<string, Command> => ({ mcp: m.mcpCmd })),
  completion: () => import("./help.ts").then((m): Record<string, Command> => ({ completion: m.completion })),
} satisfies Record<string, () => Promise<Record<string, Command>>>;

// Which file holds each command (src/cli/index.test.ts checks the table against the files).
export const WHERE: Record<string, keyof typeof from> = {
  pair: "mobile", devices: "mobile", revoke: "mobile", notify: "mobile",
  acp: "acp",
  ui: "admin", status: "admin", drain: "admin", restart: "admin", upgrade: "admin", storage: "admin", leftovers: "admin", doctor: "admin", cleanup: "admin",
  backup: "admin", backups: "admin", restore: "admin", report: "admin", usage: "admin", service: "admin", activity: "admin",
  plugin: "plugin",
  sessions: "sessions", ls: "sessions", stuck: "sessions", show: "sessions", logs: "sessions", stop: "sessions", agents: "sessions", send: "sessions",
  approve: "sessions", attach: "sessions", open: "sessions", resume: "sessions", export: "sessions", models: "sessions", search: "sessions",
  login: "login", logout: "login",
  providers: "providers",
  messages: "inspect", changes: "inspect", cost: "inspect",
  run: "run", "-p": "run", "--print": "run",
  rules: "rules", safety: "safety", review: "review", debug: "debug", import: "import", port: "port", mcp: "mcp", completion: "completion",
};

export const isCommand = (name: string): boolean => Object.hasOwn(WHERE, name);

// The command of that name, its file loaded now.
export async function commandOf(name: string): Promise<Command | undefined> {
  if (!isCommand(name)) return undefined;
  return (await from[WHERE[name]!]())[name];
}

// Every file's commands, loaded (the test of the table, and nothing a command runs).
export async function allCommands(): Promise<Record<string, Command>> {
  const out: Record<string, Command> = {};
  for (const load of Object.values(from)) Object.assign(out, await load());
  return out;
}
