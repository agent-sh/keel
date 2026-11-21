// The command of a tool call, from its input's shape: every family's shell
// tool and keel__run_on carry `command` or `cmd`, as one string or as a list
// of words (`bash -lc SCRIPT` is the script). Null when the call has none.
export function commandOf(input: any): string | null {
  const c = input?.command ?? input?.cmd;
  if (typeof c === "string" && c.trim()) return c;
  if (Array.isArray(c) && c.length && c.every((x) => typeof x === "string")) {
    const [sh = "", flag = "", script = ""] = c as string[];
    if (c.length === 3 && /(^|\/)(ba|z)?sh$/.test(sh) && /^-l?c$/.test(flag)) return script;
    return c.join(" ");
  }
  return null;
}
