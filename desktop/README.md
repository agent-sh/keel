# Keel desktop

Keel in a window of its own. One small native program around the daemon's
page: no browser around it, its own icon, a mark in the tray with the count of
what waits on you, native notifications whose click opens the session they are
about, and `keel://` links. The daemon stays a process of its own. The app
follows it across restarts and upgrades and never stops it unless asked.

Linux first, and nothing is bundled: the page is drawn by an engine the
distribution already ships. There are two, behind one seam:

- **Qt WebEngine** (Chromium), where the distribution's package is installed.
  It is the engine the page is built and tested on, and it keeps up with
  several panes streaming at once. The windows are then drawn by a second
  small program, `keel-desktop-qt`, that the app starts and drives.
- **GTK 4 and the system web view** (WebKitGTK 6), which every GNOME desktop
  already has. The app draws its windows itself with it whenever the other is
  not there.

The app picks by itself: Qt WebEngine when `keel-desktop-qt` is beside it and
runs, else the system web view. Both programs together are about a megabyte.

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

With a C++ compiler and the development files of Qt WebEngine 6.8 or newer
(Debian and Ubuntu: `qt6-webengine-dev`; Fedora: `qt6-qtwebengine-devel`) the
same command also builds `desktop/dist/keel-desktop-qt` (`desktop/qt/build.sh`
alone builds only that). Without them the app is built alone and says so. At
run time the Qt engine needs the distribution's Qt WebEngine (Debian and
Ubuntu: `sudo apt install libqt6webenginewidgets6`; the package the build
makes recommends it and does not require it).

## Use

```bash
keel-desktop                       # open the app (a second launch raises the running one)
keel-desktop keel://session/ID     # open a session; also keel://new, keel://inbox, keel://settings/SECTION, keel://project/ID
keel-desktop --new                 # open on a new session
keel-desktop --window /s/ID        # a session in a window of its own
keel-desktop --hidden              # start with the tray mark only
keel-desktop --quit                # quit the app; the daemon keeps running
keel-desktop --engine webkit       # draw the page with the system web view (or qt; also KEEL_DESKTOP_ENGINE)
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
session of its own): stopping the app never takes the daemon with it. For an
address that is not this machine's there is no button and nothing is
started: the first page says so.

- **Tray.** The mark shows how many things wait on you, and its menu opens the
  window, starts a session, pauses notifications for an hour, and quits. A
  press on the mark shows the window; the middle button starts a session. On a
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
- **Keys from anywhere.** Where the desktop has global shortcuts for apps
  (the portal's GlobalShortcuts: GNOME, KDE and others under Wayland), the
  app asks for two: one shows Keel, one starts a session. Ask from the tray
  ("Set Global Shortcuts…") or the command list ("Global shortcuts"): the
  desktop shows a dialog of its own, where the keys are yours to choose
  (the app proposes Ctrl+Alt+K and Ctrl+Alt+N). After your yes the app holds
  them at every start with no dialog, the same item shows them to be
  changed, and a no there is the end of it until you ask again.
  `--shortcut` asks at that start. On a desktop without them, bind a key of
  the desktop's own to `keel-desktop` (a second launch raises the running
  app) and to `keel-desktop --new`.
- **Keys in the window.** Ctrl+N starts a session, as in every desktop app
  (a browser tab cannot take that key; Ctrl+Shift+O works in both). The
  launcher's own menu (a right click on the app's icon) has New Session too.
- **Text size.** Ctrl with plus, minus and zero change the text size
  setting of the page itself: one scale, the same one Settings shows. The
  window's size and the page's colors are remembered. The title bar follows
  the page's theme and text size, says which daemon the app is on when it is
  not the default one, and shows the daemon's state.
- **Screen readers.** With the Qt engine the page's accessibility tree is
  built when the desktop says a screen reader is on, as a browser does it;
  turning one on or off draws the windows again for it. Without one the tree
  is left off: with it the engine lays out every row of every pane at every
  change, the ones out of view included. `KEEL_DESKTOP_ACCESSIBILITY=1` turns
  it on whatever the desktop says, `0` never. The window's own bar and
  controls, and the system web view's page, are accessible always.
- **Links and files.** A link out of Keel opens in your browser. A file the
  page offers is saved to your downloads folder, under a free name, when you
  pressed a key or a button in that window a moment before. A copied
  screenshot pastes into the message box.
- **Drafts.** What you typed in a message box is kept where the end of the
  window's own process cannot take its last seconds: a window that comes
  back after its drawing program stopped has it.

## How it fits the daemon

- The app is a program of your own account on your own machine, so the daemon
  admits it the way it admits a local page: by who owns the loopback socket.
  Nothing was added to admission, and the app sends no token. Only when a
  daemon refuses a call for want of one (it cannot read who owns the socket)
  and the state folder's lock names a live process of your account at that
  address, born when the lock says (a pid alone is given to another process
  once its own has gone), and the socket listening on the port is your
  account's, does the app send the state folder's token, to that daemon. A
  stranger on the daemon's port while the daemon is down is never sent it.
- `GET /api/shell/events` is the app's stream (server-sent events): the count
  of what waits, the notifications to show and to take down, and the snooze.
  The app is attached while the stream is open, and is handed alerts only
  because it says it acknowledges them (`?acks=1`, then `POST /api/shell/ack`
  for each one shown, with the word its own stream's hello gave it): another
  reader of the stream holds none, and cannot acknowledge one handed to the
  app. One shell takes the alerts, the one attached longest that
  acknowledges; another is told it is not the one (`takes` in its hello) and
  the app then says so in its tray menu. The routes are for the machine
  itself: a remote browser gets 403.
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
| Messages to the app (`look`, `window`, `start`, and the clipboard below) | The top frame of a document of the daemon's own origin, and the app's away page. WebKit's channel is open to every frame and Qt's reaches the top frame only; under either, each message carries a value of that window alone, held in the top frame's script, and a message without it is dropped. | The title bar's colors (checked hex values); a window for a place of the page (at most eight); starting the daemon when it is down and the address is this machine's. No message opens the browser. |
| `window.keelShell` | The top frame of a document whose own origin is the daemon's. The script is injected for that host and tests the document's origin, so a sandboxed document the daemon serves (an artifact's raw address) gets none. | Read-only facts, and `post` above. |
| Main-frame navigation | The page, to a place of the page at the daemon's origin (`/`, `/s/ID`, `/p/ID`, `/settings`). | Any other document, another origin's or one the daemon serves that is no page, is refused, and the page stays as it was. WebKit refuses when the answer arrives, so a navigation that turns out to be a file of the daemon's to keep is saved instead; Qt is asked before the request goes out and refuses that too (the page's own links to a file are no navigation, and save under both). |
| A link out of the daemon's origin | The owner's click. A scripted click or `window.open` without one does nothing. (Qt says of a window asked for whether the owner asked, and says nothing of a link in the main frame: there the owner's press in that window, within a second, is what counts.) | Opens in the browser: http and https only. No other scheme starts a program. |
| A new window for a place of the page | The owner's click on a link to it, or the page's `window` message. | A window of the app, capped as above. |
| Clipboard, read | The top frame, by a keyed `paste` message, within a second of the owner's own key or button press in that window: the paste key when the event carried nothing (a copied picture), or Paste in the page's menu. | The app reads the clipboard itself and hands its text and picture to that page, the picture no larger than the page keeps one (scaled and encoded off the main loop). The engine reads it for nobody: script has no clipboard through it (WebKit's asynchronous clipboard is off; Qt's clipboard access for script is off) and every permission request is refused, in every frame. |
| The keyboard, for a frame of content (an artifact's page, the preview of a port) | The owner: a press in the frame, or Tab into it. | Both engines refuse a frame the focus it was not given (WebKit by itself; Qt's Chromium by the permissions policy `focus-without-user-activation`, which the Qt program turns on and every content frame carries): a frame that asks for the keyboard in a loop gets none of what the owner types. A frame the owner pressed in a moment ago may still be given the focus it asks for under Chromium, and in a browser tab an engine may not refuse at all: there the page's side decides (`ui/src/lib/frames.ts`). A focus the frame asks for itself goes back to what had it, and a frame that takes it while the owner is at work in the page (a press or a key there in the last seconds), or a second time at all, is taken off the page at once, with a line in its place and a button that shows it again; the keyboard is then where it was. |
| The paste keys (Ctrl+V, Ctrl+Shift+V, Shift+Insert) | The owner, where the keyboard is by their own act. | The Qt program takes them from its engine (which would hand the clipboard to whatever frame has the keyboard at that instant) and tells the page, for a page that said it handles them. The page decides at that moment (`ui/src/lib/paste-key.ts`): a frame of content the owner is in gets the engine's own paste; else the element of the page that has the keyboard gets what the app read from the clipboard. A frame that took the keyboard by itself is answered first and gets nothing. The system web view keeps its own paste: it gives keys to no frame the owner is not in. |
| Clipboard, write | The top frame, by a keyed `copying` message within a second of the owner's press, then `copy` with the text within thirty seconds, once. | The app writes the text. A copy no press announced is refused. Under WebKit a frame can still copy its own selection inside the owner's click in it, as in a browser; under Qt no script copies, and the owner's own copy key and menu do. |
| Permission requests (clipboard, location, camera, microphone, notifications, pointer lock, screen capture, full screen) | Nobody. | Refused, always, and none is remembered. |
| Downloads | The page alone: a file of the daemon's own API that the page announced to the app, with the window's value, at the owner's press on its link, a moment before. One announcement keeps one file, of that address. No frame of content can (it can say nothing to the app), whatever the owner is pressing in the page meanwhile, and nothing is kept from another origin, from a session's port, or from a script's own bytes (`blob:`, `data:`). A page from before the announcement is held to the older rule: the daemon's own API, within ten seconds of the owner's press in that window. | Saved to the downloads folder under a free name: never over a file, never outside that folder, never into the home folder. |
| Print, `alert`, `confirm`, `prompt`, a password prompt | Nobody: the page draws its own dialogs. | The engine's dialogs are not shown. |
| Calls between browsers (WebRTC), the engine's own files (`qrc:`) | Nobody. | The system web view has no such calls; the Qt engine's find no address of this machine, and its own files are served to no page. |
| The Qt program's pipe to the app, its debugging port, its sandbox | The Qt program alone; a developer who starts the app with `--devtools`. | The pipe is moved off the program's standard descriptors, closed on exec: no process the engine starts (a page's script runs in one) inherits a way to write the app a line. Without `--devtools`, what the environment asks of the engine's debugging port and sandbox (`QTWEBENGINE_REMOTE_DEBUGGING`, `QTWEBENGINE_DISABLE_SANDBOX`, the like flags) is not taken, and that is said once on standard error. |
| File chooser, a file dropped on the page, a drag out of it | The owner's own act, as in a browser. | The frame under the pointer gets what the owner gave it. |
| Context menu | The owner. | Copy, paste and the like; no navigation, no "open in a new window", no "save page", no source view, no inspector (unless `--devtools`; without it the Qt engine's debugging port is not opened either). |
| The app tells the page (`keel-shell` events) | The app only. | A place to show, the daemon's state, the text size keys. |
| `keel://` links and a second launch | Any program or web page. | A place of the page and nothing more: no query, so no link names a request to approve. The window comes up with the keyboard off every answer: a Return on its way approves nothing. |
| A notification's click | The desktop's notification service. | Opens where the alert leads now; a click on a request's own notification may land on its answer, as in a browser. |
| Tray menu, the app's name on the session bus | Any program of your session. | Open, new session, pause alerts, start the daemon, quit; "Quit and Stop the Daemon" asks first. |

## The engine is a seam

Everything that is not the web view itself names no engine: finding or
starting the daemon and following it (`daemon.rs`, `http.rs`), the tray mark
(`tray.rs`), notifications and their click (`notify.rs`), one instance and
`keel://` links (`instance.rs`, `links.rs`), what is remembered (`prefs.rs`),
the capability object and the away page (`page.rs`), which message of a page
is acted on (`said.rs`), when the clipboard is touched (`clip.rs`), and the
decisions between them (`main.rs`). The engine sits behind two traits in
`view.rs`, and `main.rs` names the engines in one function:

- `window.rs`: GTK 4 and WebKitGTK 6, in the app's own process.
- `qt.rs`: Qt WebEngine, in a program of its own (`qt/main.cpp`, one file of
  C++). That program opens windows, shows pages and reports; `qt.rs` drives
  it over its standard input and output in lines of JSON (the list is at the
  top of `qt.rs`) and decides with the same files as the other engine. So a
  rule about the token, the alerts, a link or the clipboard is written once.
  The other program decides only what its engine wants answered at once:
  whether the main frame may show an address (the same table of paths as
  `links.rs`: `test/paths.txt`, checked by `cargo test` and by
  `keel-desktop-qt --self-test`), that no window opens by itself, and that
  every permission request is refused. When the app goes away the other
  program ends with it. When the other program stops under the app, or stops
  answering, the app starts it again and the windows come back where they
  were (one that stops soon after its start twice in a row cannot draw here
  either: the app draws its windows itself, as below, and never leaves you
  with none); what a line or an ending of the other program means is tied to the
  start it came from, so a program that was replaced is heard no more. A
  program that stops before it drew anything cannot draw here: the app draws
  its windows itself for the rest of the run, and says so once. A page whose
  own process ends is made anew in its window and loaded where it was, and
  says so (a new page of the engine's, not the old one loaded again: the
  engine does not always put the app's script back into a page whose process
  went, and such a page would be cut off from the app); one that ends four times in
  a minute is left, with a button in the bar.

Another engine implements `Engine` and `View`. What that takes:

- **A window per `Opening`**: the app's window or a session's own, at the
  given size and look, with the app's id so the desktop shows the app's icon.
  `present(token)` raises it with the desktop's activation token when one is
  given (xdg-activation on Wayland).
- **The page's object**: run `page::bridge(engine, window, tray, post, key,
  origin)` before any script of the top frame of the daemon's origin, and in
  no other frame or origin. `post` is the engine's own way for a page to send
  a string to the app; `key` is a random value of that window.
- **What the page says** (JSON through `post`), read by `said::asked` and
  acted on only when it carries the window's `key` (everything in "What the
  page can reach" holds for every engine):
  `{t:"look", dark, bg, panel, fg, muted, line, need, scale}`,
  `{t:"window", path}`, `{t:"start"}`, and the clipboard, decided by
  `clip.rs` from the owner's presses in the window (the engine reports each
  key and button press to it): `{t:"paste", id, edge}`, `{t:"copying"}`,
  `{t:"copy", id, text}`. Colors are checked hex values.
- **What the app says to the page**: `go(path, clicked)`, `daemon_back()` and
  `daemon_away()` dispatch a `keel-shell` event on the window with
  `{open: path, from: "click" | "link"}`, `{daemon: "up"}` or
  `{daemon: "away"}`; the text size keys send `{scale: "up" | "down" |
  "reset"}`; the clipboard's answers are `{pasted: {id, text, images}}` and
  `{copied: {id, ok}}`.
- **The away page**: `page::away(...)` as the content when the daemon is not
  there, moved between its states with `page::away_state(...)`, never by a
  reload, and told its state again once it has loaded; a failed load of the
  daemon's page becomes `Ask::Lost`.
- **Where a navigation goes**: on the owner's click, a place of the page
  asked for in a new window becomes `Ask::Window` and any other address
  becomes `Ask::External`; without a click neither happens; the main frame
  shows places of the page at the daemon's origin and nothing else
  (`links::main_frame_may_show`).
- **Around the page**: the daemon's state beside the window controls
  (`link`, and a word while a slow daemon's page is still coming), the
  page's title as the window's name on the desktop, Ctrl plus, minus and
  zero sent to the page, a file the page offers saved to the downloads
  folder under a free name (`links::free_name`), the permissions and dialogs
  as the table above says, no browser navigation in the context menu, and
  `Ask::Close` when the owner closes the window (the app decides between
  hiding and quitting).
- **A question** (`Engine::confirm`) before something that cannot be taken
  back: the safe answer is the default and shows the focus.
- **Storage of the page's own** (local storage, cookies) under the app's
  folder, so the theme, the text size and the panes survive a restart.

The daemon's side (`/api/shell/events`, `/api/shell/ack`, `/api/shell/click`) and the page's
side (`ui/src/lib/shell.ts`, `ui/src/features/shell.ts`) do not change with
the engine. The page is told which engine draws it (`keelShell.engine`:
`"qt"` or `"webkit"`) and has no use for it.

## Check

```bash
desktop/test/e2e.sh                         # in a hidden X11 desktop, with the engine the app picks
KEEL_DESKTOP_ENGINE=webkit desktop/test/e2e.sh   # the same checks with the system web view (or qt)
KEEL_E2E_BACKEND=kwin desktop/test/e2e.sh   # in a hidden native Wayland desktop (KWin)
KEEL_E2E_ROOT=DIR desktop/test/e2e.sh       # the same, of a package unpacked in DIR (below)
KEEL_URL=... bunx playwright test test/e2e/shell.spec.ts    # the page's side, in Chromium
```

`e2e.sh` never touches your screen or your daemon: it starts a scratch daemon
with the scripted model, a hidden workspace (`agent-workspace-linux`, its X11
or its KWin session: the check starts no desktop shell of a whole session,
which under your account could reach your own session's services), and
stand-ins for the tray host, the notification service and the desktop's word
on a screen reader on that workspace's bus. It reads the first picture of
the window (with ImageMagick, when it is there): a page that answers but is
not drawn fails the check. A signal it sends goes only to a
process it started itself. It proves the window, a daemon restart under it, the tray count, a
notification's click, a second launch, a link, the text size keys, the
remembered size and the start button, and leaves screenshots in the folder
it prints. It drives what an owner does at the desktop's own edges: the
notification that stands for many sessions is clicked and the Inbox panel
opens (a `keel://inbox` link opens it too); the attach button is pressed
with the pointer, a file is picked in the toolkit's own file dialog and is
attached; the window is closed by its close button while the tray holds the
app's mark, which hides it, and a click on the mark brings it back with what
was typed and the page not loaded again. It also plays what must not work: HTML in a sandboxed frame that
posts to the app and reads the clipboard, a page that leaves the daemon's
origin, a stranger on the daemon's port, an alert while the app is stopped
or has no notification service, a Return after a link to a session with a
request waiting, quitting the daemon with a turn at work, a frame the owner
clicked in racing the owner's paste for the clipboard, a copy and a paste
with no press behind them, the main frame at an artifact's own address, a
lock whose pid was given to another process, and an address that is not this
machine's. On both engines a frame asks for the keyboard as fast as it can
while 41 characters are typed into the message box, a frame that may keep
files offers some all the while, and a script offers a file with no press.
`KEEL_E2E_5B2_TIMES=10` runs the paste race (a click in an artifact's frame,
a click in the message box, the paste key) that many times in the run. With
the Qt engine it also stops the program that draws
the windows and expects them back where they were with what was typed a
moment before, flips the desktop's word on a screen reader ten times and
times a second launch against one timed before the flips, ends a page's own process four times, looks at what
the engine's processes hold of the pipe to the app, asks the environment for
the debugging port and no sandbox, and starts a Qt that cannot start, one
that stops before it drew and one that stops soon after each start
(`test/e2e-more.sh`). The desktop's own keys are played
against a stand-in for the portal (`test/portal-host.js`, `test/e2e-keys.sh`):
the app asks for nothing unasked, names itself first, holds its two
shortcuts after a yes from the tray, shows the window and starts a session
at their press, has the desktop show them to be changed, holds them again
at the next start with no dialog, and stops asking after a no; the tray's
middle button and Ctrl+N start a session. With another
app in front it checks focus under Wayland: a launch that carries the
desktop's activation token brings Keel's window to the front; one without
it, or with a made-up one, does not where the desktop refuses it (some let an
app you have just used come forward by itself, and the check notes that).

`KEEL_E2E_ROOT=DIR` checks a package instead of the build in the tree:
`desktop/build.sh deb --with-keel`, then `dpkg -x dist/keel-desktop_*.deb
DIR` (nothing is installed on the machine). The app, the Qt engine's
program and keel are the ones under `DIR/usr/bin`, and the package's own
files are checked with them: what runs is the package's, its launcher is a
valid desktop entry that takes `keel://` links, its icons are found by the
app's name, and a `keel://` link opened the way a desktop opens one (the
launcher looked up for the link's kind, with the package's files and the
system's and none of your account's) shows its session in the app.

`KEEL_DESKTOP_INSTANCE=Name` runs an app of another name beside yours: it
owns `io.github.agent_sh.Keel.Name` on the session bus, so its launches never
reach your running app, nor yours it. The check runs as one, beside a second
app of the app's own name, and refuses to start without a session bus and a
display of the hidden workspace's own.

`KEEL_DESKTOP_LOG=FILE` makes the app write a line for each thing it does
(the check reads it), and `KEEL_DESKTOP_NO_BROWSER=1` keeps it from opening
the browser for a link. `KEEL_DESKTOP_PROBE=FILE` injects a script into the page for measuring it
inside the app; what it reports (`window.__keelProbe(s)` under Qt,
`webkit.messageHandlers.probe` under WebKit) is printed. `KEEL_DESKTOP_QT`
names the Qt engine's program when it is not beside the app.

## Limits

- The system web view lays out a heavy page (several long panes streaming at
  once) more slowly than Chromium does. That is what the Qt engine is for;
  without it, a browser tab is still the faster window for that work.
- The Qt engine runs the Chromium the distribution's Qt WebEngine is built
  on, which is older than a current browser's. Its script heap is bounded
  (`HEAP_MB` in `qt/main.cpp`): unbounded, it grows several times further
  than a browser lets it before it is collected, and the process holds all
  of it. The bound costs no frames. Should a page ever need more, the engine
  ends that page's process and the app loads the page again;
  `QTWEBENGINE_CHROMIUM_FLAGS=--js-flags=--max-old-space-size=N` sets another
  bound. The bound is on scripts' own heap, not on the page's whole process:
  with several long panes streaming for half an hour that process grows to
  less than twice its size and levels off, and gives most of it back when
  the page has been quiet for some minutes. What grows is the engine's own
  objects for the documents, not pictures or the graphics memory. So that
  the memory comes back sooner than that, the app lets its page ask the
  engine for a collection, and the page asks when you have turned to
  another window for a few seconds (at most once a minute).
- Under Wayland with an NVIDIA driver as the desktop's own, Qt's engine
  draws its pages with Vulkan (it shares no buffers with that driver), and a
  window drawn with OpenGL shows none of it: the page works and the window
  is black. There the Qt program draws its windows with Vulkan too
  (`QSG_RHI_BACKEND`, left alone when you set it or `QT_QUICK_BACKEND`
  yourself). Where Vulkan cannot start, or the card has no memory left, the
  program stops before it drew and the app draws its windows itself. The
  app's log says what draws (`"what":"qt"`: `draws`, `gl`).
- Where the desktop's OpenGL is the processor's own work (a virtual machine,
  a remote desktop: llvmpipe and the like), the Qt program draws its windows
  without OpenGL: the same picture for about a quarter of the processor's
  time while a session streams, with less memory and a faster first
  picture. `QT_QUICK_BACKEND` or `QSG_RHI_BACKEND` set by hand is left as it
  is.
- A window of the Qt engine draws its own bar and has no frame of the
  desktop's: floating, it has a line around it and no shadow; it is resized
  from its edges.
- The caret in a window of the Qt engine stands still. A blinking caret
  wakes the whole drawing path twice a second in a window nobody types in,
  and this engine reads the blink once, as a page starts, so it cannot be
  rested after the last key as the desktop's own fields are.
  `KEEL_DESKTOP_CARET_BLINK=1` keeps the desktop's blink.
- A page of the Qt engine whose process ends is given a new page of the
  engine's and loaded where it was. One whose process ends while it is
  still loading can come back empty, or cut off from the app (seen with two
  windows' pages ended together a moment after the drawing program
  started): the app expects a reloaded page's first word within ten
  seconds, and makes the page anew when none came, twice at most.
- A session's own window that you close is kept by the Qt program, hidden
  and empty, for the next one you open: this engine does not give back the
  buffers of a page whose process went. Its memory comes back when it has
  rested.
- A very large picture pasted in a window of the Qt engine holds the window
  for as long as the clipboard takes to hand it over: the toolkit reads the
  clipboard on the thread that draws. (The system web view's window reads it
  as it comes.)
- Each engine keeps the page's own storage in a folder of its own, so the
  theme, the text size and the panes are set once per engine.
- Not proven by the check: a file dropped on the window, and typing through
  an input method. The tray and the notifications are checked against
  stand-ins that speak the desktop's protocols on the hidden desktop's bus
  (what a panel asks of the mark, what a notification service is sent and
  what its click sends back), and the file dialog is the toolkit's real one.
  The global shortcuts are checked against a stand-in that speaks the
  portal's interface as its specification has it: no desktop's own portal
  and no dialog of a real desktop has been part of a check.
  A real desktop session is still what proves the mark as a shell's own tray
  host draws it, a notification as the desktop's own service shows it, the
  file dialog a desktop's portal puts in the toolkit's place, and a second
  window on a real Wayland session.
- On NVIDIA drivers WebKitGTK can show a blank window; start the app with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` there.
- macOS and Windows are not built. The parts that are Linux's are the tray
  over StatusNotifierItem (`tray.rs`), notifications over D-Bus (`notify.rs`),
  the hand-over between launches (`instance.rs`) and the engine (`window.rs`);
  the daemon's side and the page's side are the same everywhere.
- A link to something the daemon serves that is not a place of the page (a
  file to look at in a new tab) opens in the browser: the app has no tabs.
