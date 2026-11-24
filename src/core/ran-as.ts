// A call the tool-name resolver ran under another name (the model wrote bash, the tool is Bash) is stored
// with the name the model wrote, so the history never changes; its result says which tool it ran as
// (`resolved_as`). Whatever reads a stored call by its tool reads it through this.
export const ranAs = (use: { name: string }, result?: { resolved_as?: string } | null): string => result?.resolved_as || use.name;
