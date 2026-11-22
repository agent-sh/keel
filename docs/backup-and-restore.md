# Backup and restore

A backup is a checked copy of what the daemon keeps about sessions in its state
folder, with the files of its config folder. This page says what it holds,
what it does not, and how to put one back.

## Name the state folder

Every step works on one state folder. The daemon uses, in this order:
`--state-dir DIR`, then `KEEL_STATE_DIR`, then `$XDG_STATE_HOME/keel-bun`
(`~/.local/state/keel-bun` when that is unset). `keel status` prints the folder
of the daemon it reaches. Pass `--state-dir` to `keel restore` every time, so a
restore never lands in the folder of another daemon on the machine.

The config folder is a second folder, outside the state: `$KEEL_CONFIG_DIR`,
else `$XDG_CONFIG_HOME/keel-bun` (`~/.config/keel-bun`). A backup carries its
files, and a restore puts them back only when asked (see Restore).

## What a backup holds

`keel backup` writes `<state>/backups/keel-<time>/`:

| In the backup | What it is |
| --- | --- |
| `keel.db` | Sessions, events, queues, telemetry and errors: a consistent copy made while the daemon runs. |
| `*.json` of the state folder | Daemon settings and the saved listings, as they were (`settings.json`, `model-listings.json` and the like). |
| `attachments/` | Files uploaded with prompts, stored by the hash of their content. |
| `config/` | The files of the daemon's config folder: endpoints, MCP servers, hooks, skills, plugins, agents, instructions. Each at its own mode, in folders only the owner can open. |
| `manifest.json` | When and why it was made, the session and event counts, the size and SHA-256 of each file, the config folder the files came from, and any config file that was skipped. |

The copy is opened and checked before it counts: SQLite's integrity check, and
the same sessions and at least the same events as the live database. A backup
that fails the check is removed. `keel backups` lists them, newest first; the
newest five are kept (`backup.keep` in the settings). The daemon also makes
one before a restart when `backup.before_restart` is on: before the restart
when it holds the pages that changed, and right after the start, with the
reason "after a restart", when it would be a full copy (the README's Backups
section says when).

Left out of `config/`: links, `.prev` and temp files, folders whose name
starts with a dot, `node_modules`, and the sign-in file (its tokens rotate, so
an older copy would no longer sign in). A config file that cannot be read is
skipped and named in the manifest; it never fails the backup. A file that did
not change since the last backup shares that backup's copy.

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
- **Sign-ins and provider credentials.** The sign-in file of the config
  folder, environment variables, the system keyring and the sign-ins of other
  tools.
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
   went. The config folder is not touched, and the last line says so:

   ```text
   left alone: the 4 config files this backup carries, from /home/me/.config/keel-bun. The config
   folder is not part of the state folder, so it is put back only when asked: keel restore
   keel-2026-01-31T09-00-00-000Z --state-dir ~/.local/state/keel-bun --config=/home/me/.config/keel-bun
   ```

   To put the config files back too, add one of:

   - `--config`: into this shell's config folder. Refused, with nothing
     changed, unless that is the folder the backup was made from.
   - `--config=DIR`: into `DIR`. A bare `--config` never takes the next word
     as its folder.

   Each file put back keeps its mode, and what it held stays beside it as
   `<name>.prev`. A config file the backup does not hold stays as it is, and
   so does the sign-in file. A daemon that uses the folder takes the files up
   at its next reload.
4. Start the daemon again the way it is started on this machine (`keel serve
   --state-dir ...`, or the systemd unit).

The backup is first copied into the state folder and checked, so a restore
that cannot finish (no space, a damaged file) fails with the state untouched.
The swap itself is a set of renames written down before the first one. If the
process dies in the middle, the next `keel restore` or the next start of the
daemon takes the swap back: the state is either the one before or the backup,
never a mix.

The state folder does not say which config folder goes with it. That is why
config is put back only when asked: a backup of a scratch daemon restored into
scratch state must not rewrite the servers and hooks of the daemon you use. A
keel from before backups carried config refuses such a backup and says why,
with the state untouched.

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

This walks the whole path on folders of its own. The config folder is set
first, so the scratch daemon reads and backs up a scratch config, never yours.
It needs a model for the two prompts; any model works.

```bash
S=$(mktemp -d)
export KEEL_CONFIG_DIR="$S/config"        # before the first keel serve
mkdir -p "$S/config" && echo '{"mcpServers":{}}' > "$S/config/mcp.json"
keel serve --bind 127.0.0.1:27123 --state-dir "$S/state" --workspace "$S/ws" &
U=http://127.0.0.1:27123

keel run -p "one" --url $U                # a session to keep
keel backup --url $U                      # .../backups/keel-<time>  1 sessions, checked
keel run -p "two" --url $U                # work after the backup
keel sessions --url $U                    # two sessions

keel drain --url $U                       # stopped
B=$(ls "$S/state/backups" | head -n 1)
keel restore "$B" --state-dir "$S/state"  # restored 1 sessions ...; the files it replaced are in
                                          # $S/state/before-restore-<time>
                                          # left alone: the 1 config file this backup carries ...
keel serve --bind 127.0.0.1:27123 --state-dir "$S/state" --workspace "$S/ws" &
keel sessions --url $U                    # one session: the state of the backup
keel restore "$B" --state-dir "$S/state"  # refused: a daemon uses the folder
keel drain --url $U

echo '{"mcpServers":{"changed":{}}}' > "$S/config/mcp.json"
keel restore "$B" --state-dir "$S/state" --config
                                          # put back 1 of 1 config file into $S/config
cat "$S/config/mcp.json"                  # as the backup has it
cat "$S/config/mcp.json.prev"             # what the restore replaced
```

`$S/state/before-restore-<time>` holds the database with both sessions, and
the state's JSON files as they were before each restore.
