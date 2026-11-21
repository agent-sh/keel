# Keel desktop

Keel in a window of its own. One small native program around the daemon's
page: no browser around it, its own icon, a mark in the tray with the count of
what waits on you, native notifications whose click opens the session they are
about, and `keel://` links. The daemon stays a process of its own. The app
follows it across restarts and upgrades and never stops it unless asked.

Linux first: GTK 4 and the system web view (WebKitGTK 6), which every GNOME
desktop already has. Nothing is bundled, so the program is well under a
megabyte.

## Build and install

```bash
desktop/build.sh              # desktop/dist/keel-desktop
desktop/build.sh install      # for this account: binary, launcher, icons, the keel:// handler
desktop/build.sh deb          # desktop/dist/keel-desktop_<version>_<arch>.deb (--with-keel adds the daemon's binary)
desktop/build.sh test         # unit tests
```

Needs cargo and the development files of GTK 4 and WebKitGTK 6 (Debian and
Ubuntu: `libgtk-4-dev libwebkitgtk-6.0-dev`). At run time: GTK 4.12 or newer
and WebKitGTK 6.0.

## Use

```bash
keel-desktop                       # open the app (a second launch raises the running one)
keel-desktop keel://session/ID     # open a session; also keel://new, keel://inbox, keel://settings/SECTION, keel://project/ID
keel-desktop --new                 # open on a new session
keel-desktop --window /s/ID        # a session in a window of its own
keel-desktop --hidden              # start with the tray mark only
keel-desktop --quit                # quit the app; the daemon keeps running
```

It finds the daemon the way the command line does: `--url`, `KEEL_URL`, the
daemon of the state folder (`--state-dir`, `KEEL_STATE_DIR`), the service's
daemon, then the default address. With no daemon it shows one button that
starts it: the `keel` program beside the app, `KEEL_BIN`, or the one on the
`PATH`.

- **Tray.** The mark shows how many things wait on you, and its menu opens the
  window, starts a session, pauses notifications for an hour, and quits. On a
  desktop with no tray host (GNOME without the AppIndicator extension) there
  is no mark, and closing the window quits the app instead of hiding it.
- **Notifications.** While the app runs, the daemon hands its desktop
  notifications to it, so a click lands in the window, on the session, the
  approval or the message the alert is about. An alert is shown once: by the
  app while it is attached, by the daemon itself otherwise.
- **Summon.** Bind a key of your desktop to `keel-desktop`: a second launch
  raises the running app. `--shortcut` asks the desktop portal for a global
  shortcut instead (GlobalShortcuts; the desktop asks you once).
- **Zoom.** Ctrl with plus, minus and zero. The window's size, the zoom and
  the page's colors are remembered. The title bar follows the page's theme
  and text size.
- **Links and files.** A link out of Keel opens in your browser. A file the
  page offers is saved to your downloads folder. Dropping and pasting files
  works as in a browser.

## How it fits the daemon

- The app is a program of your own account on your own machine, so the daemon
  admits it the way it admits a local page: by who owns the loopback socket.
  Nothing was added to admission. Where the daemon asks for the access token
  instead, the app's own calls send the one in the state folder.
- `GET /api/shell/events` is the app's stream (server-sent events): the count
  of what waits, the notifications to show and to take down, and the snooze.
  The app is attached while the stream is open. The routes are for the
  machine itself: a remote browser gets 403.
- The page knows it runs in the app from one small object, `window.keelShell`
  (`ui/src/lib/shell.ts`), never from its user agent. With it the page tells
  the app its colors, goes where the app asks without a reload, and can open
  a session in a window of its own. In a browser tab nothing changes.

## Check

```bash
desktop/test/e2e.sh                         # in a hidden native Wayland GNOME desktop
KEEL_E2E_BACKEND=x11 desktop/test/e2e.sh    # in a hidden X11 desktop
KEEL_URL=... bunx playwright test test/e2e/shell.spec.ts    # the page's side, in Chromium
```

`e2e.sh` never touches your screen or your daemon: it starts a scratch daemon
with the scripted model, a hidden workspace (`agent-workspace-linux`), and
stand-ins for the tray host and the notification service on that workspace's
bus. It proves the window, a daemon restart under it, the tray count, a
notification's click, a second launch, a link, the remembered size and the
start button, and leaves screenshots in the folder it prints.

`KEEL_DESKTOP_LOG=FILE` makes the app write a line for each thing it does
(the check reads it), and `KEEL_DESKTOP_NO_BROWSER=1` keeps it from opening
the browser for a link. `KEEL_DESKTOP_PROBE=FILE` injects a script into the page for measuring it
inside the app; what it posts to `webkit.messageHandlers.probe` is printed.

## Limits

- The system web view lays out a heavy page (several long panes streaming at
  once) more slowly than Chromium does. For that work a browser tab is still
  the faster window.
- On NVIDIA drivers WebKitGTK can show a blank window; start the app with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` there.
- macOS and Windows are not built. The parts that are Linux's (the tray over
  StatusNotifierItem, notifications over D-Bus, the GTK window) sit behind
  `tray.rs`, `notify.rs`, `instance.rs` and `window.rs`; the daemon's side
  and the page's side are the same everywhere.
