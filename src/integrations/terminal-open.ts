// A terminal window on this machine, opened on a command in a folder: where the one press that moves a
// session to Claude Code or Codex ends (src/server/routes/continue.ts).
//
// Which terminal: `terminal.command` in the settings (the words that open a window running the command given
// after them: "kitty", "gnome-terminal --", "alacritty -e"), else $TERMINAL, else the first emulator of TERMINALS
// on the owner's PATH. With tmux there (and `terminal.tmux` on) the command runs in a tmux session named for it,
// so a window closed by mistake loses nothing: `tmux attach -t NAME` brings it back, and a second press attaches.
// The window runs the owner's login shell, which reads his own startup files: it gets the daemon's environment
// without the names that carry a secret (scrubbedEnv). Under a systemd user manager it starts in a scope of its
// own (systemd-run --user --scope), so a restart of the daemon does not close it. tmux itself is started from
// that login shell, so a tmux server this press starts has the environment his startup files give (the one his
// own terminals have), not the daemon's scrubbed one; a tmux server already running keeps its own.
//
// Opened: the program still runs after OPEN_WAIT_MS, or ended at once with status 0 (a launcher that hands the
// window to a server, as gnome-terminal does). Anything else is a failure with the last line it wrote.
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { registerSettings, settings } from "../admin/settings.ts";
import { ownerLookup } from "../core/paths.ts";
import { scrubbedEnv } from "../safety/env-secret.ts";
import { outputOf } from "../core/proc.ts";
import { shq } from "../tools/shell.ts";

export type TerminalSettings = { command: string; tmux: boolean };
export const TERMINAL_DEFAULTS: TerminalSettings = { command: "", tmux: true };
registerSettings("terminal", TERMINAL_DEFAULTS as unknown as Record<string, unknown>, (v) => {
  if (typeof v.command !== "string") return "command is the words that open a terminal window on a command, or empty";
  if (typeof v.tmux !== "boolean") return "tmux is true or false";
  return undefined;
});
export const terminalSettings = (): TerminalSettings => ({ ...TERMINAL_DEFAULTS, ...(settings().terminal as Partial<TerminalSettings> | undefined) });

// Terminal emulators by program name, with the words that come before the command to run. The order is the one
// looked for when nothing is set: the system's own choice first, then desktop terminals, then the plain ones.
export const TERMINALS: [string, string[]][] = [
  ["x-terminal-emulator", ["-e"]],
  ["ptyxis", ["--new-window", "--"]],
  ["gnome-terminal", ["--"]],
  ["kgx", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]],
  ["kitty", []],
  ["wezterm", ["start", "--"]],
  ["alacritty", ["-e"]],
  ["foot", []],
  ["xterm", ["-e"]],
];

// The words of the terminal to use (empty: none found), and what they came from. Pure: `which` finds a program.
export function terminalWords(set: string, envTerminal: string | undefined, which: (p: string) => string | undefined): { words: string[]; from: "settings" | "TERMINAL" | "found" } | undefined {
  const own = set.trim().split(/\s+/).filter(Boolean);
  if (own.length) return { words: own, from: "settings" };
  const t = envTerminal?.trim();
  if (t) {
    const words = t.split(/\s+/);
    // $TERMINAL names a program; one Keel knows gets its own words, any other the common -e.
    const known = TERMINALS.find(([p]) => p === basename(words[0]!));
    return { words: words.length > 1 ? words : [words[0]!, ...(known ? known[1] : ["-e"])], from: "TERMINAL" };
  }
  for (const [p, before] of TERMINALS) {
    const at = which(p);
    if (at) return { words: [at, ...before], from: "found" };
  }
  return undefined;
}

// What the window runs: the login shell in the folder, the command, then the shell again, so the window stays
// when the harness ends. In tmux, a session of that name (attached when it is there already).
export function windowCommand(o: { cwd: string; line: string; shell: string; tmux?: string; name: string }): string[] {
  const word = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : shq(w));
  const script = `${o.line}; exec ${word(o.shell)} -l`;
  if (!o.tmux) return [o.shell, "-lic", script];
  const inTmux = [o.tmux, "new-session", "-A", "-s", termName(o.name), "-c", o.cwd, o.shell, "-lic", script];
  return [o.shell, "-lic", `exec ${inTmux.map(word).join(" ")}`];
}

// A name tmux and systemd take as one plain word: what is not a letter, a digit, - or _ becomes _ (tmux reads
// . and : as a window and a pane, systemd refuses most marks).
export const termName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "keel";

export type Opened = { opened: true; how: string } | { opened: false; why: string };
export const OPEN_WAIT_MS = 2_000;

const ownWhich = (p: string) => Bun.which(p, { PATH: ownerLookup("PATH") ?? process.env.PATH ?? "" }) ?? undefined;

// The terminal Keel would use now, said for the settings (nothing is started).
export function terminalFound(): { terminal?: string; from?: string; tmux?: string } {
  const s = terminalSettings();
  const t = terminalWords(s.command, ownerLookup("TERMINAL"), ownWhich);
  return { ...(t ? { terminal: t.words.join(" "), from: t.from } : {}), ...(s.tmux && ownWhich("tmux") ? { tmux: ownWhich("tmux") } : {}) };
}

// A display the window can open on: the daemon's own, else the user manager's (a daemon started before the
// desktop session has none of its own).
async function displayEnv(env: Record<string, string>): Promise<Record<string, string>> {
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return env;
  const sc = Bun.which("systemctl");
  if (!sc) return env;
  try {
    const p = Bun.spawn([sc, "--user", "show-environment"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const { out, code } = await outputOf(p, { timeoutMs: 3_000 });
    if (code !== 0) return env;
    const add: Record<string, string> = {};
    for (const l of out.split("\n")) {
      const m = /^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=(.*)$/.exec(l);
      if (m && !env[m[1]!]) add[m[1]!] = m[2]!;
    }
    return { ...env, ...add };
  } catch {
    return env;
  }
}

// Open a window running `line` (a shell line that goes to the folder itself) in `cwd`. `log`: where what the
// terminal writes goes, read when it fails.
export async function openTerminal(o: { cwd: string; line: string; name: string; log: string }): Promise<Opened> {
  if (process.platform !== "linux") return { opened: false, why: "Keel opens a terminal only on Linux: paste the command into one" };
  const s = terminalSettings();
  const t = terminalWords(s.command, ownerLookup("TERMINAL"), ownWhich);
  if (!t) return { opened: false, why: "no terminal program was found: name one in Settings, Sessions elsewhere" };
  const tmux = s.tmux ? ownWhich("tmux") : undefined;
  const shell = ownerLookup("SHELL") || "/bin/bash";
  const env = await displayEnv(scrubbedEnv());
  let argv = [...t.words, ...windowCommand({ cwd: o.cwd, line: o.line, shell, tmux, name: o.name })];
  // A scope of its own under the user manager, when one answers here.
  const run = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "systemd", "private") : "";
  const sr = Bun.which("systemd-run");
  if (sr && run && existsSync(run)) argv = [sr, "--user", "--scope", "--quiet", "--collect", `--unit=keel-terminal-${termName(o.name)}-${Date.now().toString(36)}`, "--", ...argv];
  mkdirSync(dirname(o.log), { recursive: true });
  let p;
  try {
    p = Bun.spawn(argv, { cwd: existsSync(o.cwd) ? o.cwd : "/", env, stdin: "ignore", stdout: Bun.file(o.log), stderr: Bun.file(o.log), detached: true });
  } catch (e) {
    return { opened: false, why: `${basename(t.words[0]!)} did not start: ${(e as Error).message}` };
  }
  const how = `${basename(t.words[0]!)}${tmux ? `, in tmux session ${termName(o.name)}` : ""}`;
  const code = await Promise.race([p.exited, Bun.sleep(OPEN_WAIT_MS).then(() => undefined)]);
  if (code === undefined || code === 0) {
    p.unref();
    return { opened: true, how };
  }
  const said = (await Bun.file(o.log).text().catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return { opened: false, why: `${basename(t.words[0]!)} ended at once (exit ${code})${said ? `: ${said.slice(0, 200)}` : ""}` };
}
