// Which argument of an MCP prompt the caret is in, for the composer's
// suggestions (completion/complete). A prompt runs as `/server:prompt words`,
// the words filling its arguments in order and the last one taking the rest
// (the daemon's /api/sessions/:id/mcp-prompt).
export type PromptArg = {
  server: string; prompt: string;
  arg: string;                       // the argument's name
  value: string;                     // what is typed of it so far
  start: number;                     // where its value starts in the text
  last: boolean;                     // it takes the rest of the line
  context: Record<string, string>;   // the arguments before it, as typed
};

// `before`: the text up to the caret. `params`: the prompt's arguments, by its id (`server:prompt`).
export function promptArgAt(before: string, params: (id: string) => { server: string; name: string; arguments: { name: string }[] } | undefined): PromptArg | null {
  const m = /^\/(\S+?) (.*)$/s.exec(before);
  if (!m) return null;
  const p = params(m[1]!);
  if (!p || !p.arguments.length) return null;
  const rest = m[2]!;
  const words = rest.split(/\s+/);
  const i = Math.min(words.length - 1, p.arguments.length - 1);
  const head = new RegExp(`^(?:\\S+\\s+){${i}}`).exec(rest)?.[0] ?? "";
  const context: Record<string, string> = {};
  p.arguments.slice(0, i).forEach((a, k) => { context[a.name] = words[k]!; });
  return { server: p.server, prompt: p.name, arg: p.arguments[i]!.name, value: rest.slice(head.length), start: before.length - rest.length + head.length, last: i === p.arguments.length - 1, context };
}
