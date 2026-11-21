# Backup and restore

A backup is a checked copy of what the daemon keeps in its state folder about
sessions. This page says what it holds, what it does not, and how to put one
back.

## Name the state folder

Every step works on one state folder. The daemon uses, in this order:
`--state-dir DIR`, then `KEEL_STATE_DIR`, then `$XDG_STATE_HOME/keel-bun`
(`~/.local/state/keel-bun` when that is unset). `keel status` prints the folder
of the daemon it reaches. Pass `--state-dir` to `keel restore` every time, so a
restore never lands in the folder of another daemon on the machine.

## What a backup holds

`keel backup` writes `<state>/backups/keel-<time>/`:

| In the backup | What it is |
| --- | --- |
| `keel.db` | Sessions, events, queues, telemetry and errors: a consistent copy made while the daemon runs. |
| `*.json` of the state folder | Daemon settings and the saved listings, as they were (`settings.json`, `model-listings.json` and the like). |
| `attachments/` | Files uploaded with prompts, stored by the hash of their content. |
| `manifest.json` | When and why it was made, the session and event counts, and the size and SHA-256 of each file. |

The copy is opened and checked before it counts: SQLite's integrity check, and
the same sessions and at least the same events as the live database. A backup
that fails the check is removed. `keel backups` lists them, newest first; the
newest five are kept (`backup.keep` in the settings). The daemon also makes
one before a restart when `backup.before_restart` is on.

## What a backup does not hold

A restore leaves all of this as it is on the machine, and a backup moved to
another machine brings none of it:

- **Workspace files.** Repositories, worktrees and anything a session wrote in
  them. A restored session's transcript can name files and commits that the
  workspace no longer has, or has in a newer form. Use git for those.
- **The rest of the state folder.** Checkpoints of edited files, artifacts,
  spilled tool output, transcripts, logs, installed UI bundles, plugins, and
  the daemon's keys (`secret-key`, `api-token`, `mcp-bind.key`). After a
  restore on the same folder they are still there. A state folder rebuilt
  from a backup alone, on another machine or after a lost disk, has none of
  them: the daemon makes new keys, and what the old ones protected or the
  folders held is gone.
- **The config folder.** `$KEEL_CONFIG_DIR`, else `~/.config/keel-bun`:
  endpoints, MCP servers, hooks.
- **Provider credentials.** Environment variables, the system keyring and the
  sign-ins of other tools.
- **Anything written after the backup.** Sessions and events newer than it
  are not in the restored database (they stay in the files moved aside, see
  below).

## Back up

```bash
keel backup --url http://127.0.0.1:47960
keel backups --url http://127.0.0.1:47960
```

The daemon keeps running. To keep a copy elsewhere, copy the whole
`keel-<time>` folder; `manifest.json` lets the restore check it.

## Restore

A restore needs the daemon stopped, and refuses while one holds the folder.

1. Note the backup's name while the daemon still answers (`keel backups`), or
   read it from `<state>/backups` afterwards.
2. Stop the daemon. Running turns get time to finish; the rest are parked.

   ```bash
   keel drain --url http://127.0.0.1:47960
   ```

   Under systemd, stop the unit instead (`systemctl --user stop keel-bun.service`),
   or the unit starts the daemon again.
3. Restore, naming the state folder. The backup is a name from the list or a
   folder path.

   ```bash
   keel restore keel-2026-01-31T09-00-00-000Z --state-dir ~/.local/state/keel-bun
   ```

   It prints the sessions and events restored and where the replaced files
   went.
4. Start the daemon again the way it is started on this machine (`keel serve
   --state-dir ...`, or the systemd unit).

The backup is first copied into the state folder and checked, so a restore
that cannot finish (no space, a damaged file) fails with the state untouched.
The swap itself is a set of renames written down before the first one. If the
process dies in the middle, the next `keel restore` or the next start of the
daemon takes the swap back: the state is either the one before or the backup,
never a mix.

## `before-restore-<time>`

The files a restore replaces are not deleted. They move to
`<state>/before-restore-<time>/`: the live `keel.db` with its `-wal` and `-shm`
files, and every `*.json` of the state folder, including one the backup does
not have (a settings file written after it), so the restored state reads as it
did then. Attachments are only added, never moved.

To undo a restore, stop the daemon, remove `keel.db`, `keel.db-wal` and
`keel.db-shm` from the state folder, copy the files of the
`before-restore-<time>` folder back into it, and start the daemon. Delete the
folder when you are sure the restore was right: nothing else removes it.

## Try it on a scratch folder

This walks the whole path without touching a real daemon. It needs a model
only for the two prompts; any model works.

```bash
S=$(mktemp -d)
keel serve --bind 127.0.0.1:47123 --state-dir "$S/state" --workspace "$S/ws" &
U=http://127.0.0.1:47123

keel run -p "one" --url $U                # a session to keep
keel backup --url $U                      # .../backups/keel-<time>  1 sessions, checked
keel run -p "two" --url $U                # work after the backup
keel sessions --url $U                    # two sessions

keel drain --url $U                       # stopped
keel restore "$(ls "$S/state/backups" | head -n 1)" --state-dir "$S/state"
                                          # restored 1 sessions ...; the files it replaced are in
                                          # $S/state/before-restore-<time>
keel serve --bind 127.0.0.1:47123 --state-dir "$S/state" --workspace "$S/ws" &
keel sessions --url $U                    # one session: the state of the backup
keel restore x --state-dir "$S/state"     # refused: a daemon uses the folder
keel drain --url $U
```

`$S/state/before-restore-<time>` now holds the database with both sessions,
and the state's JSON files as they were before the restore.
