// The systemd user unit for keel-bun. `keel service install` writes it to
// ~/.config/systemd/user/keel-bun.service with ExecStart pointing at the binary
// that ran it; it never enables or starts it. To use it:
//   systemctl --user daemon-reload && systemctl --user enable --now keel-bun.service
export const unitTemplate = `[Unit]
Description=Keel coding agent daemon (Bun)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=@EXEC@ serve --bind @BIND@
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

[Install]
WantedBy=default.target
`;
