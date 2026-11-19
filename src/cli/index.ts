// Client commands of `keel`. Each takes its own argv and returns an exit code.
import { acpCommands } from "./acp.ts";
import { adminCommands } from "./admin.ts";
import { mobileCommands } from "./mobile.ts";
import { pluginCommands } from "./plugin.ts";

export type Command = (argv: string[]) => Promise<number>;
export const commands: Record<string, Command> = { ...mobileCommands, ...acpCommands, ...adminCommands, ...pluginCommands };
