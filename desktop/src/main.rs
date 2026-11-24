//! Keel in a window of its own. One small native program: it finds the daemon
//! (or starts it), shows its page in a window with no browser around it,
//! keeps a mark in the tray with the count of what waits, shows the daemon's
//! alerts as native notifications whose click lands in the window, and opens
//! keel:// links. The daemon is a process of its own: the app follows it
//! across restarts and never stops it unless asked, and asks first then.
mod clip;
mod daemon;
mod http;
mod instance;
mod links;
mod notify;
mod page;
mod prefs;
mod qt;
mod said;
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
use shortcut::{Answer, Keys, Shortcuts};
use view::{Ask, Away, Can, Engine, Opening, Showing, View};

/// The application's id: its name on the session bus, its window's app id and the name of its desktop file.
pub const APP_ID: &str = "io.github.agent_sh.Keel";

const HELP: &str = "keel-desktop: Keel in a window of its own

usage: keel-desktop [options] [keel://LINK]

  keel://session/ID     open a session (also keel://new, keel://inbox, keel://settings/SECTION, keel://customize/SECTION, keel://project/ID)
  --new                 open on a new session
  --window PATH         open a path of the page in a window of its own (/s/ID)
  --hidden              start with the tray mark only
  --quit                quit the running app (the daemon keeps running)
  --url URL             the daemon's address on this machine (else KEEL_URL, the state folder's daemon, the default)
  --state-dir DIR       the daemon's state folder (else KEEL_STATE_DIR)
  --keel PATH           the keel program that starts the daemon (else KEEL_BIN, the one beside this, the PATH)
  --engine NAME         what draws the page: qt (Qt WebEngine, where it is installed) or webkit (else KEEL_DESKTOP_ENGINE)
  --shortcut            ask the desktop for the app's global shortcuts (show Keel, new session) at this start
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

/// Windows of single sessions open at once: a page cannot fill the desktop with them.
const SESSION_WINDOWS: usize = 8;

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
    engine: RefCell<Box<dyn Engine>>,
    link: RefCell<Link>,
    url: RefCell<String>,
    main: RefCell<Option<Rc<dyn View>>>,
    others: RefCell<Vec<Rc<dyn View>>>,
    tray: RefCell<Option<Tray>>,
    notifier: RefCell<Option<notify::Notifier>>,
    needs: Cell<u32>,
    /// The sessions the tray lists and the unread count: from the frame the count came in.
    listed: RefCell<Vec<daemon::Listed>>,
    unread: Cell<u32>,
    paused_until: Cell<Option<i64>>,
    starting: Cell<bool>,
    note: RefCell<String>,
    /// The daemon's address is not this machine's: the app does not speak to it and starts nothing there.
    refused: Cell<bool>,
    /// Another program attached to the daemon as its app first: the daemon hands the alerts to it.
    elsewhere: Cell<bool>,
    /// The desktop's activation token of the request being served: it lets the window take the focus.
    token: RefCell<Option<String>>,
    /// The desktop's global shortcuts for the app (shortcut.rs); none before the session bus is known.
    keys: RefCell<Option<Rc<Shortcuts>>>,
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

    fn keys(&self) -> Keys {
        self.keys.borrow().as_ref().map_or(Keys::None, |k| k.keys())
    }

    /// The app's global shortcuts. Not held: the desktop is asked for them (it answers at once
    /// when the owner agreed before, and with its own dialog when not). Held, and the owner
    /// asked: the desktop shows them to be changed.
    fn shortcuts(self: &Rc<Self>, asked: bool) {
        let Some(keys) = self.keys.borrow().clone() else { return };
        match keys.keys() {
            Keys::Offer => keys.bind(|answer| with_shell(|s| s.bound(&answer))),
            Keys::Change if asked => keys.change(),
            _ => {}
        }
    }

    /// The desktop's answer. The owner's yes or no is remembered, so a start asks again only
    /// after a yes; a desktop that could not do it changes nothing of what is remembered.
    fn bound(&self, answer: &Answer) {
        let keys: Vec<String> = match answer {
            Answer::Held(bound) => bound.iter().map(|(id, keys)| format!("{id}={keys}")).collect(),
            _ => Vec::new(),
        };
        self.note_done("shortcuts", serde_json::json!({ "held": matches!(answer, Answer::Held(_)), "failed": *answer == Answer::Failed, "keys": keys }));
        let keep = shortcut::remembered(self.prefs.borrow().shortcuts, answer);
        if self.prefs.borrow().shortcuts != keep {
            let mut p = self.prefs.borrow_mut();
            p.shortcuts = keep;
            p.save();
        }
        self.show_tray();
    }

    /// A global shortcut was pressed, somewhere else on the desktop.
    fn pressed(self: &Rc<Self>, id: &str, token: Option<String>) {
        self.note_done("shortcut", serde_json::json!({ "id": id, "token": token.is_some() }));
        if token.is_some() {
            self.token.replace(token);
        }
        self.open(if id == "new-session" { Some("/") } else { None }, false);
    }

    fn show_tray(&self) {
        if let Some(t) = self.tray.borrow().as_ref() {
            t.show(Shown { needs: self.needs.get(), list: self.listed.borrow().clone(), unread: self.unread.get(), paused: self.paused(), link: self.link.borrow().clone(), refused: self.refused.get(), elsewhere: self.elsewhere.get(), keys: self.keys() });
            self.note_done("tray", serde_json::json!({ "needs": self.needs.get(), "listed": self.listed.borrow().iter().map(|l| l.id.clone()).collect::<Vec<_>>(), "unread": self.unread.get(), "paused": self.paused(), "headline": tray::headline(&t.shown()) }));
        }
    }

    fn apply_look(&self) {
        let look = self.prefs.borrow().look.clone();
        self.engine.borrow().look(&look);
        for w in self.windows() {
            w.look(&look);
        }
    }

    fn new_window(self: &Rc<Self>, main: bool) -> Rc<dyn View> {
        let p = self.prefs.borrow().clone();
        let size = if main { (p.width, p.height) } else { ((p.width * 2 / 3).max(720), (p.height * 9 / 10).max(560)) };
        let opening = Opening { main, size, maximized: main && p.maximized, look: p.look, can: Can { tray: self.tray_available(), shortcuts: self.keys.borrow().as_ref().is_some_and(|k| k.page_may_ask()) }, devtools: self.devtools };
        self.engine.borrow().open(opening, Rc::new(|win, ask| with_shell(|s| s.asked(win, ask))))
    }

    /// The Qt engine's program cannot draw here (it stopped before it drew anything, or keeps
    /// stopping soon after it is started). The app draws its windows itself from now on, each
    /// in the place it was asked for.
    fn fall_back(self: &Rc<Self>) {
        let engine: Box<dyn Engine> = Box::new(window::WebKit::new(&self.app, &prefs::dir(), |path| with_shell(|s| s.note_done("download", serde_json::json!({ "to": path })))));
        *self.engine.borrow_mut() = engine;
        self.apply_look();
        self.note_done("engine", serde_json::json!({ "name": "webkit", "after": "qt" }));
        let was = self.main.borrow_mut().take();
        if let Some(old) = was {
            let win = self.new_window(true);
            win.want(&old.wanted());
            *self.main.borrow_mut() = Some(win.clone());
            self.fill(&win);
            win.present(None);
            old.close();
        }
        let were = std::mem::take(&mut *self.others.borrow_mut());
        for old in were {
            let win = self.new_window(false);
            win.want(&old.wanted());
            self.others.borrow_mut().push(win.clone());
            self.fill(&win);
            win.present(None);
            old.close();
        }
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
            let state = Away { link: link.clone(), starting: self.starting.get(), url, note: self.note.borrow().clone(), refused: self.refused.get(), failing: false };
            if win.showing() != Showing::Away {
                self.note_done("away", serde_json::json!({ "refused": state.refused, "note": state.note }));
            }
            win.away(&self.prefs.borrow().look, &state);
        } else {
            // The page stays as it is, and is told the title bar says the daemon is away.
            win.daemon_away(&link);
        }
        win.link(&link);
    }

    /// A notification's click: the window comes up at once, then goes where the alert leads now.
    fn clicked(self: &Rc<Self>, alert: String, token: Option<String>) {
        self.note_done("click", serde_json::json!({ "alert": alert, "token": token.is_some() }));
        self.token.replace(token);
        if alert.is_empty() {
            // The one that stands for many sessions: the inbox lists them.
            return self.open(Some("/?inbox=1"), false);
        }
        self.open(None, false);
        daemon::call(&self.place, "POST", "/api/shell/click".into(), Some(serde_json::json!({ "alert": alert }).to_string()), |v| {
            if let Some(path) = v.and_then(|v| v.get("path").and_then(|p| p.as_str().map(String::from))) {
                on_main(move |s| s.open(Some(&path), true));
            }
        });
    }

    /// Opens the main window, on a path when one is given, and raises it. `clicked`: the path is
    /// where a notification the owner clicked leads; else a link, a launch or the tray brought them.
    fn open(self: &Rc<Self>, path: Option<&str>, clicked: bool) {
        let existing = self.main.borrow().clone();
        let win = existing.unwrap_or_else(|| {
            let w = self.new_window(true);
            *self.main.borrow_mut() = Some(w.clone());
            w
        });
        if let Some(p) = path.and_then(links::page_path) {
            if win.showing() == Showing::App && *self.link.borrow() == Link::Up {
                win.go(&p, clicked);
            } else {
                win.want(&p);
            }
        }
        self.fill(&win);
        let token = self.token.take();
        win.present(token.as_deref());
        self.note_done("present", serde_json::json!({ "window": "main", "path": path, "token": token.is_some() }));
    }

    /// A path of the page in a window of its own.
    fn open_window(self: &Rc<Self>, path: &str) {
        let Some(p) = links::page_path(path) else { return };
        if !links::room_for_window(self.others.borrow().len(), SESSION_WINDOWS) {
            self.note_done("refused", serde_json::json!({ "window": p, "open": self.others.borrow().len() }));
            return;
        }
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
        if self.starting.get() || self.refused.get() || *self.link.borrow() == Link::Up {
            return;
        }
        let log = prefs::dir().join("daemon.log");
        self.starting.set(true);
        self.note.borrow_mut().clear();
        self.note_done("start", serde_json::json!({ "starting": true }));
        self.refill();
        // Off the main loop: asking the service manager to start a unit can take a while.
        let said = log.clone();
        daemon::start(&self.place, &log, move |made| {
            on_main(move |s| match made {
                Ok(()) => {
                    // A daemon that did not come up: say so, and where it wrote.
                    glib::timeout_add_seconds_local_once(25, move || {
                        with_shell(|s| {
                            if s.starting.replace(false) {
                                *s.note.borrow_mut() = format!("The daemon did not come up. Its output is in {}.", said.display());
                                s.refill();
                            }
                        })
                    });
                }
                Err(e) => {
                    s.starting.set(false);
                    *s.note.borrow_mut() = format!("Could not start the daemon: {e}.");
                    s.note_done("start-failed", serde_json::json!({ "note": *s.note.borrow() }));
                    s.refill();
                }
            })
        });
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
            Ask::Shortcuts => self.shortcuts(true),
            Ask::Note(what, v) => self.note_done(what, v),
            // The daemon answers and its page keeps failing: the calm page says so, between the tries.
            Ask::Failing => {
                let (link, url) = (self.link.borrow().clone(), self.url.borrow().clone());
                self.note_done("away", serde_json::json!({ "failing": true, "refused": false, "note": "" }));
                win.away(&self.prefs.borrow().look, &Away { link, starting: false, url, note: String::new(), refused: false, failing: true });
            }
            Ask::Look(look) => {
                if self.prefs.borrow().look != look {
                    let mut p = self.prefs.borrow_mut();
                    p.look = look;
                    p.save();
                    drop(p);
                    self.apply_look();
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
            Event::Needs { n, unread, list } => {
                self.needs.set(n);
                self.unread.set(unread);
                *self.listed.borrow_mut() = list;
                self.show_tray();
            }
            Event::Notify { key, alert, title, body, urgent, silent, ack, stream } => {
                if let Some(n) = self.notifier.borrow().as_ref() {
                    n.show(APP_ID, &key, &alert, &title, &body, urgent, silent, ack.map(|n| (n, stream)));
                }
                self.note_done("notify", serde_json::json!({ "key": key, "alert": alert, "title": title }));
            }
            Event::Refused(why) => {
                if !self.refused.replace(true) || *self.note.borrow() != why {
                    *self.note.borrow_mut() = why;
                    self.refill();
                    self.show_tray();
                }
            }
            Event::Withdraw(key) => {
                if let Some(n) = self.notifier.borrow().as_ref() {
                    n.withdraw(&key);
                }
                self.note_done("withdraw", serde_json::json!({ "key": key }));
            }
            Event::Takes(takes) => {
                if self.elsewhere.replace(!takes) == takes {
                    self.note_done("takes", serde_json::json!({ "takes": takes }));
                    self.show_tray();
                }
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
            Pick::Open => self.open(None, false),
            Pick::New => self.open(Some("/"), false),
            Pick::Session(id) => self.open(Some(&format!("/s/{id}")), false),
            Pick::MarkRead => daemon::call(&self.place, "POST", "/api/alerts/read".into(), Some("{}".into()), |_| {}),
            Pick::Start => {
                self.open(None, false);
                self.start_daemon();
            }
            Pick::Pause => daemon::call(&self.place, "PUT", "/api/snooze".into(), Some(serde_json::json!({ "until_ms": now_ms() + 3_600_000 }).to_string()), |_| {}),
            Pick::Resume => daemon::call(&self.place, "DELETE", "/api/snooze".into(), None, |_| {}),
            Pick::Shortcuts => self.shortcuts(true),
            Pick::Quit => self.quit(),
            Pick::QuitAll => self.quit_all(),
        }
    }

    /// Quit and stop the daemon. It ends every running turn, so the owner is asked first, and told which.
    fn quit_all(self: &Rc<Self>) {
        if *self.link.borrow() != Link::Up {
            return self.quit();
        }
        daemon::call(&self.place, "GET", "/api/shell".into(), None, |v| {
            // (None: the daemon did not say. That is not "nothing is working".)
            let running = v.as_ref().and_then(running_titles);
            on_main(move |s| {
                let (question, detail) = stop_words(running.as_deref());
                s.note_done("confirm", serde_json::json!({ "question": question, "detail": detail }));
                // The window comes up under the question, so it is seen.
                s.open(None, false);
                s.engine.borrow().confirm(&question, &detail, "Stop Keel", Box::new(|yes| {
                    with_shell(|s| {
                        s.note_done("confirmed", serde_json::json!({ "stop": yes }));
                        if yes {
                            daemon::call(&s.place, "POST", "/api/drain".into(), Some("{}".into()), |_| on_main(|s| s.quit()));
                            // The daemon may already be gone: the app quits all the same.
                            glib::timeout_add_seconds_local_once(6, || with_shell(|s| s.quit()));
                        }
                    })
                }));
            });
        });
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
                // A launch names a place and nothing more, as a link does.
                "--window" => window = it.next().map(|p| links::place(p).to_string()),
                "--url" | "--state-dir" | "--keel" | "--engine" => {
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
            glib::timeout_add_seconds_local_once(3, || with_shell(|s| if !s.tray_available() && s.main.borrow().is_none() { s.open(None, false) }));
            return;
        }
        self.open(path.as_deref(), false);
    }
}

/// The titles of the sessions with a turn at work, as the daemon tells its app (GET /api/shell).
/// None when the answer does not say.
fn running_titles(shell: &serde_json::Value) -> Option<Vec<String>> {
    Some(shell.get("running")?.as_array()?.iter().filter_map(|t| t.as_str()).map(String::from).collect())
}

/// What the owner is asked before the daemon is stopped. `running`: the sessions at work, or
/// None when that could not be read.
fn stop_words(running: Option<&[String]>) -> (String, String) {
    let question = "Stop Keel and quit?".to_string();
    let detail = match running {
        None => "What is working now could not be read. Any session at work will be stopped; it can go on when Keel starts again.".to_string(),
        Some([]) => "No session is working. Keel stops, and starts again when you open the app.".to_string(),
        Some([one]) => format!("\u{201c}{one}\u{201d} is working and will be stopped. It can go on when Keel starts again."),
        Some(many) => {
            let shown: Vec<String> = many.iter().take(4).map(|t| format!("\u{201c}{t}\u{201d}")).collect();
            let rest = many.len() - shown.len();
            format!("{} sessions are working and will be stopped: {}{}. They can go on when Keel starts again.", many.len(), shown.join(", "), if rest > 0 { format!(" and {rest} more") } else { String::new() })
        }
    };
    (question, detail)
}

/// What draws the page: Qt WebEngine in its own program where the distribution has it, else the
/// system web view in this one. `asked`: the engine the owner named ("qt" or "webkit"), if any.
fn engine_for(app: &gtk::Application, asked: Option<&str>, devtools: bool) -> Box<dyn Engine> {
    let dir = prefs::dir();
    let downloaded = |path: &std::path::Path| with_shell(|s| s.note_done("download", serde_json::json!({ "to": path })));
    if asked != Some("webkit") {
        match qt::Qt::start(&dir, &instance::bus_name(), devtools, |what, v| with_shell(|s| s.note_done(what, v)), || with_shell(|s| s.fall_back())) {
            Some(engine) => return Box::new(engine),
            None if asked == Some("qt") => eprintln!("keel-desktop: Qt WebEngine is not there to draw the page (keel-desktop-qt beside the app, and the distribution's Qt WebEngine): using the system web view"),
            None => {}
        }
    }
    Box::new(window::WebKit::new(app, &dir, downloaded))
}

fn place_from(args: &[String]) -> (Where, bool, bool, Option<String>) {
    let mut w = Where::default();
    let (mut devtools, mut shortcut) = (false, false);
    let mut engine = std::env::var("KEEL_DESKTOP_ENGINE").ok().filter(|e| !e.is_empty());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--url" => w.url = it.next().cloned(),
            "--state-dir" => w.state_dir = it.next().map(PathBuf::from),
            "--keel" => w.keel = it.next().map(PathBuf::from),
            "--devtools" => devtools = true,
            "--shortcut" => shortcut = true,
            "--engine" => engine = it.next().cloned(),
            _ => {}
        }
    }
    (w, devtools, shortcut, engine)
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
    let (place, devtools, shortcut, engine) = place_from(&args);
    // An app already running takes this launch's words and raises its window.
    if instance::hand_over(&args) {
        return glib::ExitCode::SUCCESS;
    }
    // (Its name on the session bus too: an instance of another name runs beside the owner's app.)
    let app = gtk::Application::builder().application_id(instance::bus_name()).build();
    glib::set_application_name("Keel");

    app.connect_startup(move |app| {
        let prefs = Prefs::load();
        // The one place the engines are named.
        let engine = engine_for(app, engine.as_deref(), devtools);
        let shell = Rc::new(Shell {
            app: app.clone(),
            place: place.clone(),
            prefs: RefCell::new(prefs),
            engine: RefCell::new(engine),
            link: RefCell::new(Link::Down),
            url: RefCell::new(daemon::find(&place).url),
            main: RefCell::new(None),
            others: RefCell::new(Vec::new()),
            tray: RefCell::new(None),
            notifier: RefCell::new(None),
            needs: Cell::new(0),
            listed: RefCell::new(Vec::new()),
            unread: Cell::new(0),
            paused_until: Cell::new(None),
            starting: Cell::new(false),
            // Known before the first window: an address the app does not speak to says so in its first page.
            note: RefCell::new(daemon::refusal(&daemon::find(&place).url).unwrap_or_default()),
            refused: Cell::new(daemon::refusal(&daemon::find(&place).url).is_some()),
            elsewhere: Cell::new(false),
            token: RefCell::new(None),
            keys: RefCell::new(None),
            devtools,
            log: std::env::var_os("KEEL_DESKTOP_LOG").map(PathBuf::from),
        });
        shell.apply_look();
        shell.note_done("engine", serde_json::json!({ "name": shell.engine.borrow().name() }));
        SHELL.with(|s| *s.borrow_mut() = Some(shell.clone()));

        if let Some(conn) = app.dbus_connection() {
            // The panel paints a symbolic icon in its own ink; the drawn mark is for a desktop whose theme lacks it.
            let symbolic = gtk::gdk::Display::default().is_some_and(|d| gtk::IconTheme::for_display(&d).has_icon(tray::SYMBOLIC));
            match Tray::new(&conn, symbolic, |p| with_shell(|s| s.picked(p)), |on| with_shell(|s| s.note_done("tray-host", serde_json::json!({ "available": on })))) {
                Ok(t) => *shell.tray.borrow_mut() = Some(t),
                Err(e) => eprintln!("keel-desktop: no tray mark: {e}"),
            }
            *shell.notifier.borrow_mut() = Some(notify::Notifier::new(
                &conn,
                |alert, token| with_shell(|s| s.clicked(alert, token)),
                // The notification is on screen: the daemon is told, and does not show it itself.
                |(ack, stream)| with_shell(|s| daemon::call(&s.place, "POST", "/api/shell/ack".into(), Some(serde_json::json!({ "ack": ack, "stream": stream }).to_string()), |_| {})),
            ));
            // The desktop's global shortcuts, where it has them: asked for at the start when the
            // owner agreed to them before (or passed --shortcut), else from the tray or the page.
            *shell.keys.borrow_mut() = Some(Shortcuts::new(&conn, &instance::bus_name(), |id, token| with_shell(|s| s.pressed(id, token))));
            shell.note_done("shortcuts-known", serde_json::json!({ "keys": format!("{:?}", shell.keys()) }));
            if shortcut || shell.prefs.borrow().shortcuts {
                shell.shortcuts(false);
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
        let drawn_by = shell.engine.borrow().name();
        daemon::watch(place.clone(), drawn_by, |e| on_main(move |s| s.told(e)));
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

#[cfg(test)]
mod tests {
    use super::*;

    // The review's case: "Quit and Stop the Daemon" stopped a running turn without a word.
    #[test]
    fn stopping_the_daemon_names_the_turns_it_ends() {
        let shell = serde_json::json!({ "attached": true, "running": ["Fix the build", "Untitled session"] });
        assert_eq!(running_titles(&shell).unwrap(), ["Fix the build", "Untitled session"]);
        assert_eq!(running_titles(&serde_json::json!({ "running": [] })), Some(vec![]));
        let (q, d) = stop_words(Some(&["Fix the build".to_string()]));
        assert_eq!(q, "Stop Keel and quit?");
        assert!(d.contains("\u{201c}Fix the build\u{201d} is working and will be stopped"));
        // The review's case: when the daemon's answer could not be read, the question said "No session is working".
        assert_eq!(running_titles(&serde_json::json!({})), None);
        assert!(stop_words(None).1.starts_with("What is working now could not be read"));
        assert!(stop_words(Some(&[])).1.starts_with("No session is working"));
        let many: Vec<String> = (1..=6).map(|n| format!("T{n}")).collect();
        let (_, d) = stop_words(Some(&many));
        assert!(d.starts_with("6 sessions are working") && d.contains("\u{201c}T4\u{201d} and 2 more") && !d.contains("T5"));
    }
}
