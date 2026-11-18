// Client commands of `keel`. Each takes its own argv and returns an exit code.
import { acpCommands } from "./acp.ts";
import { mobileCommands } from "./mobile.ts";

export type Command = (argv: string[]) => Promise<number>;
export const commands: Record<string, Command> = { ...mobileCommands, ...acpCommands };
