// An agent's name in the rail, its card and its reports: the title of its task.
//
// The spawn's own short name comes first: Claude's Agent tool sends a
// `description` (3 to 5 words), Codex's spawn_agent a `task_name`
// (lowercase words joined by underscores, read here as a sentence). A spawn
// with neither is named from its message: the first line when it is short,
// else its first sentence, else the first words up to the cap with an
// ellipsis. Ten agents whose messages begin "Harness N cache study. Study
// how harness N..." are then "Harness N cache study", not 80 characters that
// differ in one digit mid-line.

export const TITLE_CHARS = 80;

// "harness_3_cache_study" or "harness-3-cache-study": "Harness 3 cache study".
// A name already written as words is kept as it is.
export function fromTaskName(name: string): string {
  const s = name.trim();
  if (!s) return "";
  if (/\s/.test(s) || !/[_-]/.test(s)) return s;
  const words = s.split(/[_-]+/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.-]+$/, "")}…`;
}

export function fromMessage(message: string, max = TITLE_CHARS): string {
  const line = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (line.length <= max) return line;
  // The first sentence: up to its stop, when the stop is followed by a space (not "v1.2" or "a.ts").
  const stop = line.search(/[.!?](\s|$)/);
  if (stop >= 3 && stop < max) return line.slice(0, stop);
  return cut(line, max);
}

export function agentTitle(input: { title?: string; task_name?: string; prompt: string }, max = TITLE_CHARS): string {
  const own = input.title?.trim() || (input.task_name ? fromTaskName(input.task_name) : "");
  return own ? cut(own.replace(/\s+/g, " "), max) : fromMessage(input.prompt, max);
}
