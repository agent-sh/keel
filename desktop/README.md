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
  page offers is saved to your downloads folder, under a free name. A copied
  screenshot pastes into the message box.

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

## The engine is a seam

Everything that is not the web view itself names no engine: finding or
starting the daemon and following it (`daemon.rs`, `http.rs`), the tray mark
(`tray.rs`), notifications and their click (`notify.rs`), one instance and
`keel://` links (`instance.rs`, `links.rs`), what is remembered (`prefs.rs`),
the capability object and the away page (`page.rs`), and the decisions between
them (`main.rs`). The engine sits behind two traits in `view.rs`, implemented
today by `window.rs` (GTK 4 and WebKitGTK 6).

A second engine implements `Engine` and `View` and is named in one line of
`main.rs`. What that takes:

- **A window per `Opening`**: the app's window or a session's own, at the
  given size, zoom and look, with the app id `io.github.agent_sh.Keel` so the
  desktop shows the app's icon. `present(token)` raises it with the desktop's
  activation token when one is given (xdg-activation on Wayland).
- **The page's object**: run `page::bridge(engine, window, tray, post)` before
  any script of every top-level page. `post` is the engine's own way for a
  page to send a string to the app.
- **What the page says** (JSON through `post`), turned into an `Ask`:
  `{t:"look", dark, bg, panel, fg, muted, line, need, scale}`,
  `{t:"window", path}`, `{t:"start"}`. Colors are checked hex values.
- **What the app says to the page**: `go(path)` and `daemon_back()` dispatch a
  `keel-shell` event on the window with `{open: path}` or `{daemon: "up"}`.
- **The away page**: `page::away(...)` as the content when the daemon is not
  there, moved between its states with `page::away_state(...)`, never by a
  reload; a failed load of the daemon's page becomes `Ask::Lost`.
- **Where a navigation goes**: a place of the page asked for in a new window
  becomes `Ask::Window`; any other address, in a new window or by a clicked
  link out of the daemon's origin, becomes `Ask::External`; nothing else
  leaves the daemon's origin in the app's window.
- **Around the page**: the daemon's state beside the window controls
  (`link`), the page's title as the window's, zoom with Ctrl plus, minus and
  zero (`Ask::Zoom`), a file the page offers saved to the downloads folder
  under a free name (`links::free_name`), the clipboard allowed and every
  other permission refused, no browser navigation in the context menu, and
  `Ask::Close` when the owner closes the window (the app decides between
  hiding and quitting).
- **Storage of the page's own** (local storage, cookies) under the app's
  folder, so the theme, the text size and the panes survive a restart.

The daemon's side (`/api/shell/events`, `/api/shell/click`) and the page's
side (`ui/src/lib/shell.ts`, `ui/src/features/shell.ts`) do not change with
the engine.

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
  the faster window. The engine is a seam (above) so this can change.
- Not proven by the check, which has no real pointer or input method: a file
  dropped on the window, and typing through an input method. A real desktop
  session is also what proves the tray with a shell's own tray host, a
  notification's click through the desktop's own service, and a second
  window on a real Wayland session.
- On NVIDIA drivers WebKitGTK can show a blank window; start the app with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` there.
- macOS and Windows are not built. The parts that are Linux's are the tray
  over StatusNotifierItem (`tray.rs`), notifications over D-Bus (`notify.rs`),
  the hand-over between launches (`instance.rs`) and the engine (`window.rs`);
  the daemon's side and the page's side are the same everywhere.
- A link to something the daemon serves that is not a place of the page (a
  file to look at in a new tab) opens in the browser: the app has no tabs.
