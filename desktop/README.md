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
daemon, then the default address. The address is one of this machine: the
app opens no other (open a daemon elsewhere in a browser).

With no daemon it shows one button that starts it. Where `keel service` has
installed the daemon as your service, the button starts that service
(`systemctl --user start keel-bun.service`), so there is never a second,
empty Keel beside yours. Otherwise it runs the `keel` program beside the app,
`KEEL_BIN`, or the one on the `PATH`, on the address and state folder the app
was given, as a process of its own (a scope of the service manager, else a
session of its own): stopping the app never takes the daemon with it.

- **Tray.** The mark shows how many things wait on you, and its menu opens the
  window, starts a session, pauses notifications for an hour, and quits. On a
  desktop with no tray host (GNOME without the AppIndicator extension) there
  is no mark, and closing the window quits the app instead of hiding it.
- **Notifications.** While the app runs, the daemon hands its desktop
  notifications to it, so a click lands in the window, on the session, the
  approval or the message the alert is about. An alert is shown once: by the
  app, which tells the daemon when the notification is on screen; by the
  daemon itself when it hears nothing within three seconds (the app is
  stopped, or the desktop has no notification service). More than three
  sessions alerting together are one notification that says how many, and
  opens the inbox.
- **Quit.** Quit leaves the daemon and its turns running. "Quit and Stop the
  Daemon" asks first, and names the sessions at work.
- **Summon.** Bind a key of your desktop to `keel-desktop`: a second launch
  raises the running app. `--shortcut` asks the desktop portal for a global
  shortcut instead (GlobalShortcuts; the desktop asks you once).
- **Text size.** Ctrl with plus, minus and zero change the text size
  setting of the page itself: one scale, the same one Settings shows. The
  window's size and the page's colors are remembered. The title bar follows
  the page's theme and text size, says which daemon the app is on when it is
  not the default one, and shows the daemon's state.
- **Links and files.** A link out of Keel opens in your browser. A file the
  page offers is saved to your downloads folder, under a free name. A copied
  screenshot pastes into the message box.

## How it fits the daemon

- The app is a program of your own account on your own machine, so the daemon
  admits it the way it admits a local page: by who owns the loopback socket.
  Nothing was added to admission, and the app sends no token. Only when a
  daemon refuses a call for want of one (it cannot read who owns the socket)
  and the state folder's lock names a live process of your account at that
  address does the app send the state folder's token, to that daemon. A
  stranger on the daemon's port while the daemon is down is never sent it.
- `GET /api/shell/events` is the app's stream (server-sent events): the count
  of what waits, the notifications to show and to take down, and the snooze.
  The app is attached while the stream is open, and is handed alerts only
  because it says it acknowledges them (`?acks=1`, then `POST /api/shell/ack`
  for each one shown): another reader of the stream holds none. The routes
  are for the machine itself: a remote browser gets 403.
- The page knows it runs in the app from one small object, `window.keelShell`
  (`ui/src/lib/shell.ts`), never from its user agent. With it the page tells
  the app its colors, goes where the app asks without a reload, and can open
  a session in a window of its own. In a browser tab nothing changes.

## What the page can reach

The web view shows the daemon's page, and inside it content the model wrote
(an HTML artifact in a sandboxed frame, a previewed port). Only the first is
the app's own. Every way from inside the view to something native, and who
may use it:

| Channel | Who may use it | What it does |
| --- | --- | --- |
| Messages to the app (`look`, `window`, `start`, `paste`) | The top frame of the daemon's own origin, and the app's away page. The engine's channel is open to every frame, so each message carries a value of that window alone, held in the top frame's script; a message without it is dropped. | The title bar's colors (checked hex values); a window for a place of the page (at most eight); starting the daemon when it is down; one read of the clipboard (below). No message opens the browser. |
| `window.keelShell` | The top frame of the daemon's origin: the script is injected for that origin and no other. | Read-only facts, and `post` above. |
| Main-frame navigation | The page, within the daemon's origin. | Anything else is stopped before it loads, and the page stays as it was. |
| A link out of the daemon's origin | The owner's click. A scripted click or `window.open` without one does nothing. | Opens in the browser: http and https only. |
| A new window for a place of the page | The owner's click on a link to it, or the page's `window` message. | A window of the app, capped as above. |
| Clipboard read | The top frame's own paste handler, on the owner's paste, for a copied image the event did not carry: it tells the app, which grants the next read within two seconds, once. | Nothing else may read it: script access to the clipboard is off, and every other request is refused. |
| Other permission requests (location, camera, microphone, notifications, pointer lock) | Nobody. | Refused. |
| Downloads | The page, and a frame the page allows downloads in (the preview of a port you opened). An HTML artifact's frame cannot. | Saved to the downloads folder under a free name: never over a file, never outside that folder, never into the home folder. |
| Print, `alert`, `confirm`, `prompt`, a password prompt | Nobody: the page draws its own dialogs. | The engine's dialogs are not shown. |
| File chooser, a file dropped on the page, a drag out of it | The owner's own act, as in a browser. | The frame under the pointer gets what the owner gave it. |
| Context menu | The owner. | Copy, paste and the like; no navigation, no "open in a new window", no inspector (unless `--devtools`). |
| The app tells the page (`keel-shell` events) | The app only. | A place to show, the daemon's state, the text size keys. |
| `keel://` links and a second launch | Any program or web page. | A place of the page and nothing more: no query, so no link names a request to approve. The window comes up with the keyboard off every answer: a Return on its way approves nothing. |
| A notification's click | The desktop's notification service. | Opens where the alert leads now; a click on a request's own notification may land on its answer, as in a browser. |
| Tray menu, the app's name on the session bus | Any program of your session. | Open, new session, pause alerts, start the daemon, quit; "Quit and Stop the Daemon" asks first. |

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
  given size and look, with the app id `io.github.agent_sh.Keel` so the
  desktop shows the app's icon. `present(token)` raises it with the desktop's
  activation token when one is given (xdg-activation on Wayland).
- **The page's object**: run `page::bridge(engine, window, tray, post, key,
  origin)` before any script of the top frame of the daemon's origin, and in
  no other frame or origin. `post` is the engine's own way for a page to send
  a string to the app; `key` is a random value of that window.
- **What the page says** (JSON through `post`), turned into an `Ask` only
  when it carries the window's `key` (everything in "What the page can
  reach" holds for a second engine too):
  `{t:"look", dark, bg, panel, fg, muted, line, need, scale}`,
  `{t:"window", path}`, `{t:"start"}`, `{t:"paste"}`. Colors are checked hex
  values.
- **What the app says to the page**: `go(path, clicked)`, `daemon_back()` and
  `daemon_away()` dispatch a `keel-shell` event on the window with
  `{open: path, from: "click" | "link"}`, `{daemon: "up"}` or
  `{daemon: "away"}`; the text size keys send `{scale: "up" | "down" |
  "reset"}`.
- **The away page**: `page::away(...)` as the content when the daemon is not
  there, moved between its states with `page::away_state(...)`, never by a
  reload; a failed load of the daemon's page becomes `Ask::Lost`.
- **Where a navigation goes**: on the owner's click, a place of the page
  asked for in a new window becomes `Ask::Window` and any other address
  becomes `Ask::External`; without a click neither happens; the main frame
  never leaves the daemon's origin.
- **Around the page**: the daemon's state beside the window controls
  (`link`, and a word while a slow daemon's page is still coming), the
  page's title as the window's name on the desktop, Ctrl plus, minus and
  zero sent to the page, a file the page offers saved to the downloads
  folder under a free name (`links::free_name`), the permissions and dialogs
  as the table above says, no browser navigation in the context menu, and
  `Ask::Close` when the owner closes the window (the app decides between
  hiding and quitting).
- **A question** (`Engine::confirm`) before something that cannot be taken
  back.
- **Storage of the page's own** (local storage, cookies) under the app's
  folder, so the theme, the text size and the panes survive a restart.

The daemon's side (`/api/shell/events`, `/api/shell/ack`, `/api/shell/click`) and the page's
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
notification's click, a second launch, a link, the text size keys, the
remembered size and the start button, and leaves screenshots in the folder
it prints. It also plays what must not work: HTML in a sandboxed frame that
posts to the app and reads the clipboard, a page that leaves the daemon's
origin, a stranger on the daemon's port, an alert while the app is stopped
or has no notification service, a Return after a link to a session with a
request waiting, and quitting the daemon with a turn at work. With another
app in front it checks focus: a launch that carries the desktop's activation
token brings Keel's window to the front, and one without it, or with a
made-up one, does not.

`KEEL_DESKTOP_LOG=FILE` makes the app write a line for each thing it does
(the check reads it), and `KEEL_DESKTOP_NO_BROWSER=1` keeps it from opening
the browser for a link. `KEEL_DESKTOP_PROBE=FILE` injects a script into the page for measuring it
inside the app; what is posted to `webkit.messageHandlers.probe` is printed.

## Limits

- The system web view lays out a heavy page (several long panes streaming at
  once) more slowly than Chromium does. For that work a browser tab is still
  the faster window. The engine is a seam (above) so this can change.
- Not proven by the check, which has no real pointer or input method: a file
  dropped on the window, and typing through an input method. A real desktop
  session is also what proves the tray with a shell's own tray host, a
  notification's click through the desktop's own service (the check proves
  the token of a launch, and that a click's token reaches the same call),
  and a second window on a real Wayland session.
- On NVIDIA drivers WebKitGTK can show a blank window; start the app with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` there.
- macOS and Windows are not built. The parts that are Linux's are the tray
  over StatusNotifierItem (`tray.rs`), notifications over D-Bus (`notify.rs`),
  the hand-over between launches (`instance.rs`) and the engine (`window.rs`);
  the daemon's side and the page's side are the same everywhere.
- A link to something the daemon serves that is not a place of the page (a
  file to look at in a new tab) opens in the browser: the app has no tabs.
