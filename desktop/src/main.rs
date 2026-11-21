//! Keel in a window of its own. One small native program: it finds the daemon
//! (or starts it), shows its page in a window with no browser around it,
//! keeps a mark in the tray with the count of what waits, shows the daemon's
//! alerts as native notifications whose click lands in the window, and opens
//! keel:// links. The daemon is a process of its own: the shell follows it
//! across restarts and never stops it unless asked.
mod daemon;
mod http;
mod instance;
mod links;
mod notify;
mod page;
mod prefs;
mod shortcut;
mod tray;
mod view;
mod window;

use daemon::{Event, Link, Where};
use gtk::prelude::*;
use gtk::{gio, glib};
use prefs::Prefs;
use std::cell::{Cell, RefCell};
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tray::{Pick, Shown, Tray};
use view::{Ask, Engine, Opening, Showing, View};

/// The application's id: its name on the session bus, its window's app id and the name of its desktop file.
pub const APP_ID: &str = "io.github.agent_sh.Keel";

const HELP: &str = "keel-desktop: Keel in a window of its own

usage: keel-desktop [options] [keel://LINK]

  keel://session/ID     open a session (also keel://new, keel://inbox, keel://settings/SECTION, keel://project/ID)
  --new                 open on a new session
  --window PATH         open a path of the page in a window of its own (/s/ID)
  --hidden              start with the tray mark only
  --quit                quit the running app (the daemon keeps running)
  --url URL             the daemon's address (else KEEL_URL, the state folder's daemon, the default)
  --state-dir DIR       the daemon's state folder (else KEEL_STATE_DIR)
  --keel PATH           the keel program that starts the daemon (else KEEL_BIN, the one beside this, the PATH)
  --shortcut            ask the desktop for a global shortcut that raises the window
  --devtools            the web inspector in the context menu
  --version, --help

A second launch hands its link to the running app and raises its window.
The daemon is never stopped by closing or quitting the app.";

thread_local! {
    static SHELL: RefCell<Option<Rc<Shell>>> = const { RefCell::new(None) };
}

fn with_shell(f: impl FnOnce(&Rc<Shell>)) {
    SHELL.with(|s| {
        if let Some(shell) = s.borrow().as_ref() {
            f(shell);
        }
    });
}

/// Runs on the main loop, from any thread.
fn on_main(f: impl FnOnce(&Rc<Shell>) + Send + 'static) {
    glib::MainContext::default().invoke(move || with_shell(f));
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

struct Shell {
    app: gtk::Application,
    place: Where,
    prefs: RefCell<Prefs>,
    /// What draws the page: the only part that names an engine (view.rs).
    engine: Box<dyn Engine>,
    link: RefCell<Link>,
    url: RefCell<String>,
    main: RefCell<Option<Rc<dyn View>>>,
    others: RefCell<Vec<Rc<dyn View>>>,
    tray: RefCell<Option<Tray>>,
    notifier: RefCell<Option<notify::Notifier>>,
    needs: Cell<u32>,
    paused_until: Cell<Option<i64>>,
    starting: Cell<bool>,
    note: RefCell<String>,
    /// The desktop's activation token of the request being served: it lets the window take the focus.
    token: RefCell<Option<String>>,
    devtools: bool,
    /// A line per thing done, for the end-to-end check (KEEL_DESKTOP_LOG).
    log: Option<PathBuf>,
}

impl Shell {
    fn note_done(&self, what: &str, v: serde_json::Value) {
        if let Some(p) = &self.log {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{}", serde_json::json!({ "at": now_ms(), "what": what, "v": v }));
            }
        }
    }

    fn windows(&self) -> Vec<Rc<dyn View>> {
        self.main.borrow().iter().cloned().chain(self.others.borrow().iter().cloned()).collect()
    }

    fn tray_available(&self) -> bool {
        self.tray.borrow().as_ref().is_some_and(Tray::available)
    }

    fn paused(&self) -> bool {
        self.paused_until.get().is_some_and(|t| t > now_ms())
    }

    fn show_tray(&self) {
        if let Some(t) = self.tray.borrow().as_ref() {
            t.show(Shown { needs: self.needs.get(), paused: self.paused(), link: self.link.borrow().clone() });
            self.note_done("tray", serde_json::json!({ "needs": self.needs.get(), "paused": self.paused(), "headline": tray::headline(&t.shown()) }));
        }
    }

    fn apply_look(&self) {
        let look = self.prefs.borrow().look.clone();
        self.engine.look(&look);
        for w in self.windows() {
            w.look(&look);
        }
    }

    fn new_window(self: &Rc<Self>, main: bool) -> Rc<dyn View> {
        let p = self.prefs.borrow().clone();
        let size = if main { (p.width, p.height) } else { ((p.width * 2 / 3).max(720), (p.height * 9 / 10).max(560)) };
        let opening = Opening { main, size, maximized: main && p.maximized, zoom: p.zoom, look: p.look, tray: self.tray_available(), devtools: self.devtools };
        self.engine.open(opening, Rc::new(|win, ask| with_shell(|s| s.asked(win, ask))))
    }

    /// Puts a window on what the daemon's state allows: the page, or the calm page while it is away.
    fn fill(&self, win: &Rc<dyn View>) {
        let (link, url) = (self.link.borrow().clone(), self.url.borrow().clone());
        if link == Link::Up {
            if win.showing() != Showing::App {
                win.load(&url, &win.wanted());
                self.note_done("load", serde_json::json!({ "window": if win.is_main() { "main" } else { "session" }, "path": win.wanted() }));
            }
        } else if win.showing() != Showing::App {
            win.away(&self.prefs.borrow().look, &link, self.starting.get(), &url, &self.note.borrow());
        }
        win.link(&link);
    }

    /// A notification's click: the window comes up at once, then goes where the alert leads now.
    fn clicked(self: &Rc<Self>, alert: String, token: Option<String>) {
        self.note_done("click", serde_json::json!({ "alert": alert, "token": token.is_some() }));
        self.token.replace(token);
        self.open(None);
        daemon::call(&self.place, "POST", "/api/shell/click".into(), Some(serde_json::json!({ "alert": alert }).to_string()), |v| {
            if let Some(path) = v.and_then(|v| v.get("path").and_then(|p| p.as_str().map(String::from))) {
                on_main(move |s| s.open(Some(&path)));
            }
        });
    }

    /// Opens the main window, on a path when one is given, and raises it.
    fn open(self: &Rc<Self>, path: Option<&str>) {
        let existing = self.main.borrow().clone();
        let win = existing.unwrap_or_else(|| {
            let w = self.new_window(true);
            *self.main.borrow_mut() = Some(w.clone());
            w
        });
        if let Some(p) = path.and_then(links::page_path) {
            if win.showing() == Showing::App && *self.link.borrow() == Link::Up {
                win.go(&p);
            } else {
                win.want(&p);
            }
        }
        self.fill(&win);
        win.present(self.token.take().as_deref());
        self.note_done("present", serde_json::json!({ "window": "main", "path": path }));
    }

    /// A path of the page in a window of its own.
    fn open_window(self: &Rc<Self>, path: &str) {
        let Some(p) = links::page_path(path) else { return };
        let win = self.new_window(false);
        win.want(&p);
        self.others.borrow_mut().push(win.clone());
        self.fill(&win);
        win.present(self.token.take().as_deref());
        self.note_done("present", serde_json::json!({ "window": "session", "path": p }));
    }

    fn external(&self, url: &str) {
        let Some(u) = links::web_url(url) else { return };
        self.note_done("external", serde_json::json!({ "url": u }));
        if std::env::var_os("KEEL_DESKTOP_NO_BROWSER").is_none() {
            gio::AppInfo::launch_default_for_uri_async(u, gio::AppLaunchContext::NONE, gio::Cancellable::NONE, |_| {});
        }
    }

    fn start_daemon(self: &Rc<Self>) {
        if self.starting.get() || *self.link.borrow() == Link::Up {
            return;
        }
        let log = prefs::dir().join("daemon.log");
        match daemon::start(&self.place, &log) {
            Ok(()) => {
                self.starting.set(true);
                self.note.borrow_mut().clear();
                // A daemon that did not come up: say so, and where it wrote.
                glib::timeout_add_seconds_local_once(25, move || {
                    with_shell(|s| {
                        if s.starting.replace(false) {
                            *s.note.borrow_mut() = format!("The daemon did not come up. Its output is in {}.", log.display());
                            s.refill();
                        }
                    })
                });
            }
            Err(e) => *self.note.borrow_mut() = format!("Could not start the daemon: {e}."),
        }
        self.note_done("start", serde_json::json!({ "starting": self.starting.get(), "note": *self.note.borrow() }));
        self.refill();
    }

    fn refill(&self) {
        for w in self.windows() {
            self.fill(&w);
        }
    }

    fn save_size(&self) {
        if let Some(w) = self.main.borrow().as_ref() {
            let (width, height, maximized) = w.size();
            let mut p = self.prefs.borrow_mut();
            if !maximized && width > 0 && height > 0 {
                p.width = width;
                p.height = height;
            }
            p.maximized = maximized;
            p.save();
        }
    }

    fn quit(&self) {
        self.save_size();
        if let Some(n) = self.notifier.borrow().as_ref() {
            n.withdraw_all();
        }
        self.note_done("quit", serde_json::json!({}));
        self.app.quit();
    }

    fn asked(self: &Rc<Self>, win: &Rc<dyn View>, ask: Ask) {
        match ask {
            Ask::Start => self.start_daemon(),
            Ask::External(url) => self.external(&url),
            Ask::Window(path) => self.open_window(&path),
            Ask::Look(look) => {
                if self.prefs.borrow().look != look {
                    let mut p = self.prefs.borrow_mut();
                    p.look = look;
                    p.save();
                    drop(p);
                    self.apply_look();
                }
            }
            Ask::Zoom(z) => {
                let mut p = self.prefs.borrow_mut();
                p.zoom = z;
                p.save();
                drop(p);
                for w in self.windows() {
                    w.zoom(z);
                }
            }
            Ask::Lost => self.fill(win),
            Ask::Close if win.is_main() => {
                self.save_size();
                if self.tray_available() {
                    // The mark in the tray brings it back; the page stays as it is, drafts and all.
                    win.hide();
                    self.note_done("hidden", serde_json::json!({}));
                } else {
                    self.quit();
                }
            }
            Ask::Close => {
                self.others.borrow_mut().retain(|w| w.id() != win.id());
                win.close();
            }
        }
    }

    fn told(self: &Rc<Self>, e: Event) {
        match e {
            Event::Link { link, url } => {
                let moved = *self.url.borrow() != url;
                *self.link.borrow_mut() = link.clone();
                *self.url.borrow_mut() = url.clone();
                if link == Link::Up {
                    self.starting.set(false);
                    self.note.borrow_mut().clear();
                    // A daemon that came back at another address: the page is loaded from there.
                    if moved {
                        for w in self.windows() {
                            if w.showing() == Showing::App {
                                w.forget();
                            }
                        }
                    }
                }
                self.note_done("link", serde_json::json!({ "link": format!("{link:?}"), "url": url }));
                self.refill();
                if link == Link::Up {
                    // The page waits ever longer between its own tries: it is told the daemon is back.
                    for w in self.windows() {
                        if w.showing() == Showing::App {
                            w.daemon_back();
                        }
                    }
                }
                self.show_tray();
            }
            Event::Needs(n) => {
                self.needs.set(n);
                self.show_tray();
            }
            Event::Notify { key, alert, title, body, urgent } => {
                if let Some(n) = self.notifier.borrow().as_ref() {
                    n.show(APP_ID, &key, &alert, &title, &body, urgent);
                }
                self.note_done("notify", serde_json::json!({ "key": key, "alert": alert, "title": title }));
            }
            Event::Withdraw(key) => {
                if let Some(n) = self.notifier.borrow().as_ref() {
                    n.withdraw(&key);
                }
                self.note_done("withdraw", serde_json::json!({ "key": key }));
            }
            Event::Snooze(until) => {
                self.paused_until.set(until);
                if let Some(ms) = until.map(|t| t - now_ms()).filter(|ms| *ms > 0) {
                    glib::timeout_add_local_once(Duration::from_millis(ms as u64 + 500), || with_shell(|s| s.show_tray()));
                }
                self.show_tray();
            }
        }
    }

    fn picked(self: &Rc<Self>, p: Pick) {
        self.note_done("pick", serde_json::json!({ "pick": format!("{p:?}") }));
        match p {
            Pick::Open => self.open(None),
            Pick::New => self.open(Some("/")),
            Pick::Start => {
                self.open(None);
                self.start_daemon();
            }
            Pick::Pause => daemon::call(&self.place, "PUT", "/api/snooze".into(), Some(serde_json::json!({ "until_ms": now_ms() + 3_600_000 }).to_string()), |_| {}),
            Pick::Resume => daemon::call(&self.place, "DELETE", "/api/snooze".into(), None, |_| {}),
            Pick::Quit => self.quit(),
            Pick::QuitAll => {
                daemon::call(&self.place, "POST", "/api/drain".into(), Some("{}".into()), |_| on_main(|s| s.quit()));
                // The daemon may already be gone: the app quits all the same.
                glib::timeout_add_seconds_local_once(6, || with_shell(|s| s.quit()));
            }
        }
    }

    /// The words of a launch: the first, and every later one handed over by a second process.
    fn command(self: &Rc<Self>, args: &[String], first: bool) {
        let mut it = args.iter();
        let (mut path, mut window, mut hidden) = (None, None, false);
        while let Some(a) = it.next() {
            match a.as_str() {
                "--quit" => return self.quit(),
                "--new" => path = Some("/".to_string()),
                "--hidden" => hidden = true,
                "--window" => window = it.next().cloned(),
                "--url" | "--state-dir" | "--keel" => {
                    it.next();
                }
                link if link.starts_with("keel:") => match links::link_path(link) {
                    Some(p) => path = Some(p),
                    None => eprintln!("keel-desktop: not a link the app opens: {link}"),
                },
                _ => {}
            }
        }
        self.note_done("command", serde_json::json!({ "args": args, "first": first }));
        if let Some(p) = window {
            return self.open_window(&p);
        }
        if hidden && first && path.is_none() {
            // With no tray to show the mark, a hidden start would be an app nobody can reach.
            glib::timeout_add_seconds_local_once(3, || with_shell(|s| if !s.tray_available() && s.main.borrow().is_none() { s.open(None) }));
            return;
        }
        self.open(path.as_deref());
    }
}

fn place_from(args: &[String]) -> (Where, bool, bool) {
    let mut w = Where::default();
    let (mut devtools, mut shortcut) = (false, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--url" => w.url = it.next().cloned(),
            "--state-dir" => w.state_dir = it.next().map(PathBuf::from),
            "--keel" => w.keel = it.next().map(PathBuf::from),
            "--devtools" => devtools = true,
            "--shortcut" => shortcut = true,
            _ => {}
        }
    }
    (w, devtools, shortcut)
}

fn main() -> glib::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return glib::ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version") {
        println!("keel-desktop {}", env!("CARGO_PKG_VERSION"));
        return glib::ExitCode::SUCCESS;
    }
    let (place, devtools, shortcut) = place_from(&args);
    // An app already running takes this launch's words and raises its window.
    if instance::hand_over(&args) {
        return glib::ExitCode::SUCCESS;
    }
    let app = gtk::Application::builder().application_id(APP_ID).build();
    glib::set_application_name("Keel");

    app.connect_startup(move |app| {
        let prefs = Prefs::load();
        // The one place an engine is named.
        let engine = window::WebKit::new(app, &prefs::dir(), |path| with_shell(|s| s.note_done("download", serde_json::json!({ "to": path }))));
        let shell = Rc::new(Shell {
            app: app.clone(),
            place: place.clone(),
            prefs: RefCell::new(prefs),
            engine: Box::new(engine),
            link: RefCell::new(Link::Down),
            url: RefCell::new(daemon::find(&place)),
            main: RefCell::new(None),
            others: RefCell::new(Vec::new()),
            tray: RefCell::new(None),
            notifier: RefCell::new(None),
            needs: Cell::new(0),
            paused_until: Cell::new(None),
            starting: Cell::new(false),
            note: RefCell::new(String::new()),
            token: RefCell::new(None),
            devtools,
            log: std::env::var_os("KEEL_DESKTOP_LOG").map(PathBuf::from),
        });
        shell.apply_look();
        SHELL.with(|s| *s.borrow_mut() = Some(shell.clone()));

        if let Some(conn) = app.dbus_connection() {
            match Tray::new(&conn, |p| with_shell(|s| s.picked(p)), |on| with_shell(|s| s.note_done("tray-host", serde_json::json!({ "available": on })))) {
                Ok(t) => *shell.tray.borrow_mut() = Some(t),
                Err(e) => eprintln!("keel-desktop: no tray mark: {e}"),
            }
            *shell.notifier.borrow_mut() = Some(notify::Notifier::new(&conn, |alert, token| with_shell(|s| s.clicked(alert, token))));
            // Asked for only: the desktop shows its own dialog for it.
            if shortcut {
                shortcut::bind(&conn, || with_shell(|s| s.open(None)));
            }
            // A later launch hands its words to this one and ends.
            if let Err(e) = instance::serve(&conn, |args, token| {
                with_shell(|s| {
                    s.token.replace(token);
                    s.command(&args, false);
                })
            }) {
                eprintln!("keel-desktop: a second launch cannot reach this one: {e}");
            }
        }
        // The app lives on with its windows closed while the tray shows its mark.
        std::mem::forget(app.hold());
        daemon::watch(place.clone(), shell.engine.name(), |e| on_main(move |s| s.told(e)));
    });

    let first = Cell::new(true);
    app.connect_activate(move |_| {
        // The first activation is this launch, with its own words; a later one is the desktop asking for the app again.
        let is_first = first.replace(false);
        let own = if is_first { args.clone() } else { Vec::new() };
        with_shell(|s| s.command(&own, is_first));
    });
    app.run_with_args::<&str>(&[])
}
