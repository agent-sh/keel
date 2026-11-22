// The systemd user unit for keel-bun. `keel service install` writes it to
// ~/.config/systemd/user/keel-bun.service with ExecStart pointing at the binary
// that ran it; it never enables or starts it. To use it:
//   systemctl --user daemon-reload && systemctl --user enable --now keel-bun.service
const template = `[Unit]
Description=Keel coding agent daemon (Bun)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=@EXEC@
# \`keel restart\` drains and exits 75; on-failure starts it again. A plain stop
# drains too: running turns get up to KEEL_DRAIN_MS to finish, and the
# ones that do not are parked and continue after the next start.
Environment=KEEL_SUPERVISED=systemd
Environment=KEEL_DRAIN_MS=600000
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=660
# Only the daemon is signalled: background commands outlive a restart and the
# new daemon takes them up again.
KillMode=process
# None of the unit's memory goes to swap: a page of the daemon that was
# swapped out is brought back from the disk on its next use, and its loop
# waits for as long as that takes.
MemorySwapMax=0

[Install]
WantedBy=default.target
`;

// One word of an ExecStart line, as systemd reads it back: in double quotes
// with its own escapes, and with the percent sign doubled (systemd expands
// specifiers). In an argument the dollar sign is doubled too (systemd expands
// variables there, never in the executable's path). A path with spaces stays
// one word.
export function unitWord(s: string, executable = false): string {
  if (/[\n\r\0]/.test(s)) throw new Error(`a path with a line break cannot go in a unit: ${JSON.stringify(s)}`);
  // systemd itself refuses these in the path it executes, however they are written.
  if (executable && /[\x00-\x1f\x7f"'\\]/.test(s)) throw new Error(`systemd does not start an executable whose path holds a quote, a backslash or a control character: ${JSON.stringify(s)}`);
  if (/^[\w@:.,/+=-]+$/.test(s)) return s;
  const q = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${executable ? q : q.replace(/\$/g, "$$$$")}"`;
}

// The unit for a daemon started as `command` (the binary, or bun and the
// script) on `bind`, with the workspace and state folder it is to use when
// they are given. Without them the daemon uses its defaults, as before.
export function unitFor(o: { command: string[]; bind: string; workspace?: string; stateDir?: string }): string {
  const words = [...o.command, "serve", "--bind", o.bind];
  if (o.workspace) words.push("--workspace", o.workspace);
  if (o.stateDir) words.push("--state-dir", o.stateDir);
  return template.replace("@EXEC@", () => words.map((w, i) => unitWord(w, i === 0)).join(" "));
}
