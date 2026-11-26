import { pumpText } from "../core/proc.ts";

// Only a real syntax rejection settles a call. Missing Bash, an abort, a timeout and an unexpected
// diagnostic all leave it on the usual approval path. Do not run the original line after probing:
// Bash can execute a complete earlier line before it discovers a syntax error on a later one.
export async function bashSyntaxError(bash: string, command: string, signal?: AbortSignal): Promise<string | undefined> {
  // Bash reads and executes one command at a time; no-exec cannot see an earlier command's
  // changes to its grammar, such as enabling extglob or defining an alias.
  if (signal?.aborted || command.includes("\0") || /\b(?:shopt|alias)\b/.test(command)) return;
  try {
    const p = Bun.spawn([bash, "--noprofile", "--norc", "-pns"], {
      cwd: "/", env: { LC_ALL: "C" }, stdin: new Blob([command]), stdout: "ignore", stderr: "pipe",
      signal, timeout: 1000, killSignal: "SIGKILL",
    });
    let stderr = "";
    const [code] = await Promise.all([p.exited, pumpText(p.stderr, (text) => { if (stderr.length < 8192) stderr += text.slice(0, 8192 - stderr.length); })]);
    if (code === 2 && !signal?.aborted && /^.*\bbash: (?:line \d+: )?(?:syntax error\b|unexpected EOF\b)/m.test(stderr))
      return `Bash syntax check failed (exit code ${code}):\n${stderr.trimEnd()}`;
  } catch { /* An inconclusive check never grants a call. */ }
}
