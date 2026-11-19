// Client commands of `keel`. Each takes its own argv and returns an exit code.
import { acpCommands } from "./acp.ts";
import { adminCommands } from "./admin.ts";
import { completion } from "./help.ts";
import { importCmd } from "./imports.ts";
import { loginCommands } from "./login.ts";
import { mobileCommands } from "./mobile.ts";
import { pluginCommands } from "./plugin.ts";
import { rulesCmd } from "./rules.ts";
import { run } from "./run.ts";
import { sessionCommands } from "./sessions.ts";

export type Command = (argv: string[]) => Promise<number>;
export const commands: Record<string, Command> = {
  ...mobileCommands, ...acpCommands, ...adminCommands, ...pluginCommands, ...sessionCommands, ...loginCommands,
  run,
  rules: rulesCmd,
  // `keel -p PROMPT` is `keel run -p PROMPT`, as with claude -p.
  "-p": (argv) => run(["-p", ...argv]),
  "--print": (argv) => run(["-p", ...argv]),
  import: importCmd,
  completion,
};
