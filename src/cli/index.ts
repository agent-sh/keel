// Client commands of `keel`. Each takes its own argv and returns an exit code.
import { acpCommands } from "./acp.ts";
import { adminCommands } from "./admin.ts";
import { debug } from "./debug.ts";
import { completion } from "./help.ts";
import { importCmd } from "./imports.ts";
import { portCmd } from "./port.ts";
import { loginCommands } from "./login.ts";
import { mobileCommands } from "./mobile.ts";
import { pluginCommands } from "./plugin.ts";
import { providerCommands } from "./providers.ts";
import { rulesCmd } from "./rules.ts";
import { run } from "./run.ts";
import { sessionCommands } from "./sessions.ts";
import { inspectCommands } from "./inspect.ts";

export type Command = (argv: string[]) => Promise<number>;
export const commands: Record<string, Command> = {
  ...mobileCommands, ...acpCommands, ...adminCommands, ...pluginCommands, ...sessionCommands, ...inspectCommands, ...loginCommands, ...providerCommands,
  run,
  rules: rulesCmd,
  debug,
  // `keel -p PROMPT` is `keel run -p PROMPT`, as with claude -p.
  "-p": (argv) => run(["-p", ...argv]),
  "--print": (argv) => run(["-p", ...argv]),
  import: importCmd,
  port: portCmd,
  completion,
};
