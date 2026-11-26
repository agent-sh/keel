import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeLine, resumeOf, SAFE_ID } from "./export.ts";
import { termName, terminalWords, windowCommand } from "./terminal-open.ts";

const on = (...have: string[]) => (p: string) => (have.includes(p) ? `/usr/bin/${p}` : undefined);

test("the owner's words come first, then $TERMINAL, then the first emulator found", () => {
  expect(terminalWords("  kitty  --single-instance ", "foot", on("xterm"))).toEqual({ words: ["kitty", "--single-instance"], from: "settings" });
  // A program $TERMINAL names gets its own words before the command; an unknown one the common -e.
  expect(terminalWords("", "/opt/bin/alacritty", on())).toEqual({ words: ["/opt/bin/alacritty", "-e"], from: "TERMINAL" });
  expect(terminalWords("", "ptyxis", on())).toEqual({ words: ["ptyxis", "--new-window", "--"], from: "TERMINAL" });
  expect(terminalWords("", "myterm", on())).toEqual({ words: ["myterm", "-e"], from: "TERMINAL" });
  expect(terminalWords("", "myterm --exec", on())).toEqual({ words: ["myterm", "--exec"], from: "TERMINAL" });
  expect(terminalWords("", undefined, on("xterm", "gnome-terminal"))).toEqual({ words: ["/usr/bin/gnome-terminal", "--"], from: "found" });
  expect(terminalWords("", "", on())).toBeUndefined();
});

test("the window runs the login shell on the line, then stays as a shell; in tmux under a name", () => {
  const line = "cd /w && claude --resume abc";
  expect(windowCommand({ cwd: "/w", line, shell: "/bin/zsh", name: "claude-abc" })).toEqual(["/bin/zsh", "-lic", `${line}; exec /bin/zsh -l`]);
  // tmux starts from the login shell, so a server it starts has the environment the owner's startup files give.
  expect(windowCommand({ cwd: "/w", line, shell: "/bin/zsh", tmux: "/usr/bin/tmux", name: "claude-abc" })).toEqual(["/bin/zsh", "-lic", `exec /usr/bin/tmux new-session -A -s claude-abc -c /w /bin/zsh -lic '${line}; exec /bin/zsh -l'`]);
});

// An id read from a transcript is the file's word: it is refused unless a harness could have made it, and the
// line that resumes it quotes it anyway, so no id runs a command in the window or in the line shown to copy.
test("a hostile id runs nothing: refused, quoted on the resume line, plain in tmux and systemd names", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-id-"));
  const hostile = [`abc$(touch ${dir}/a)`, `x\`touch ${dir}/b\``, `y; touch ${dir}/c`, `z' ; touch ${dir}/d ; '`, `--help`, `n\ntouch ${dir}/e`];
  for (const id of hostile) {
    expect(SAFE_ID.test(id), id).toBe(false);
    for (const h of ["claude", "codex"] as const) {
      // The program is a stand-in that prints its last word: the shell must hand it the id whole.
      const line = resumeLine(dir, resumeOf(h, id)).replace(h === "claude" ? "claude --resume" : "codex resume", "printf %s");
      const r = Bun.spawnSync(["bash", "-c", line]);
      expect(r.stdout.toString(), line).toBe(id);
    }
    expect(termName(`claude-${id}`)).toMatch(/^[A-Za-z0-9_-]+$/);
  }
  for (const f of "abcde") expect(existsSync(join(dir, f)), f).toBe(false);
  for (const id of ["0b2e5b7c-1f1e-4d2a-9c7e-3a1b2c3d4e5f", "rollout-2026.11-x_y"]) {
    expect(SAFE_ID.test(id)).toBe(true);
    expect(resumeOf("claude", id)).toBe(`claude --resume ${id}`);
  }
});
