//! The engine side of the seam (view.rs) on Qt WebEngine. The windows are
//! drawn by a small program of their own (`keel-desktop-qt`, ../qt/main.cpp),
//! there where the distribution's Qt WebEngine is installed; this file drives
//! it. Everything that decides stays here and in the files every engine
//! shares: which message of a page is acted on (said.rs), when the clipboard
//! is touched (clip.rs), where a link leads (links.rs). The other program
//! opens windows, shows pages and reports; the three answers its engine wants
//! at once (may the main frame show this address, may a window open, may
//! content have this permission) it gives by the same rules, as
//! desktop/README.md lists them.
//!
//! The two speak in lines of JSON over the other program's standard input
//! and output.
//!
//! The app says:
//!   {t:"look", look}                              the colors and text size of what the app draws
//!   {t:"open", win, w, h, maximized}              a window, not yet shown
//!   {t:"load", win, url, origin, script, title}   the daemon's page, with the script for its top frame
//!   {t:"html", win, html}                         the app's own page for a daemon that is away
//!   {t:"js", win, src}                            run in the top frame (the app's events, the away page's state)
//!   {t:"pill", win, show, text, dot, start, tip}  the daemon's state beside the window's controls
//!   {t:"present", win, token} {t:"hide", win} {t:"close", win}
//!   {t:"clip-read", win, id, edge} {t:"clip-write", text}
//!   {t:"confirm", id, question, detail, agree}
//!   {t:"quit"}
//!
//! The other program says:
//!   {t:"ready"}                                   it runs: every library it needs was found
//!   {t:"engine", qt, chromium, patched}
//!   {t:"said", win, s}                            a string a page posted (any frame may: see said.rs)
//!   {t:"input", win}                              the owner pressed a key or a button in the window
//!   {t:"keys", win, step}                         the text size keys
//!   {t:"nav", win, kind, url, gesture}            a window asked for ("new-window"), or a link out of Keel ("link")
//!   {t:"loaded", win, url, how, code}             a load of the main frame ended: "ok", "failed" or "stopped"
//!   {t:"url", win, url}                           the main frame's address changed
//!   {t:"start", win} {t:"close", win} {t:"size", win, w, h, maximized}
//!   {t:"clip", win, id, text, picture, png, w, h, from}
//!   {t:"download", path} {t:"confirmed", id, yes} {t:"crashed", win} {t:"probe", s}
use crate::clip::Gate;
use crate::daemon::{Link, DEFAULT_URL};
use crate::links::{self, origin};
use crate::page;
use crate::prefs::Look;
use crate::said::{asked, Asked1};
use crate::view::{Ask, Asked, Away, Engine, Opening, Showing, View};
use gtk::prelude::*;
use gtk::{gio, glib};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

/// How a page of this engine posts the string `s` to the app (the function is put in the top
/// frame by the other program, before the page's own scripts).
const POST: &str = "window.__keelPost(s)";

/// How long the other program has to say it runs.
const READY: Duration = Duration::from_secs(4);
/// The other program is started again when it stops, but not more often than this.
const AGAIN: Duration = Duration::from_secs(10);

thread_local! {
    static QT: RefCell<Option<Rc<Inner>>> = const { RefCell::new(None) };
}

/// The program that draws the windows: the one named by KEEL_DESKTOP_QT, else the one beside this app.
pub fn helper() -> Option<PathBuf> {
    let named = std::env::var_os("KEEL_DESKTOP_QT").map(PathBuf::from);
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("keel-desktop-qt")));
    named.or(beside).filter(|p| p.is_file())
}

struct Running {
    child: Child,
    to: ChildStdin,
}

struct Inner {
    program: PathBuf,
    dir: PathBuf,
    app_id: String,
    devtools: bool,
    running: RefCell<Option<Running>>,
    started: Cell<Instant>,
    /// The other program was started for a screen reader (its engine builds its accessibility tree).
    reader: Cell<bool>,
    wins: RefCell<HashMap<u32, Weak<Win>>>,
    next: Cell<u32>,
    look: RefCell<Look>,
    questions: RefCell<HashMap<u64, Box<dyn FnOnce(bool)>>>,
    /// A line for the app's own record of what it did: a file saved, the Qt and Chromium the windows run on.
    note: Box<dyn Fn(&str, Value)>,
}

/// Qt WebEngine, in a program of its own.
pub struct Qt {
    inner: Rc<Inner>,
}

impl Qt {
    /// Starts the other program. None when it is not there or does not run (the distribution's
    /// Qt WebEngine is not installed): the app then draws its windows itself.
    #[allow(deprecated)]
    pub fn start(dir: &Path, app_id: &str, devtools: bool, note: impl Fn(&str, Value) + 'static) -> Option<Self> {
        let inner = Rc::new(Inner {
            program: helper()?,
            dir: dir.to_path_buf(),
            app_id: app_id.to_string(),
            devtools,
            running: RefCell::new(None),
            started: Cell::new(Instant::now()),
            reader: Cell::new(false),
            wins: RefCell::new(HashMap::new()),
            next: Cell::new(1),
            look: RefCell::new(Look::of(false)),
            questions: RefCell::new(HashMap::new()),
            note: Box::new(note),
        });
        if !inner.spawn() {
            return None;
        }
        QT.with(|q| *q.borrow_mut() = Some(inner.clone()));
        // A screen reader turned on or off while the app runs: the windows are drawn again for it.
        if let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
            bus.signal_subscribe(Some("org.a11y.Bus"), Some("org.freedesktop.DBus.Properties"), Some("PropertiesChanged"), Some("/org/a11y/bus"), Some("org.a11y.Status"), gio::DBusSignalFlags::NONE, |_, _, _, _, _, _| {
                let Some(inner) = QT.with(|q| q.borrow().clone()) else { return };
                if inner.running.borrow().is_some() && screen_reader() != inner.reader.get() {
                    inner.stop();
                    for w in inner.windows() {
                        w.open.set(false);
                        w.showing.set(Showing::Nothing);
                    }
                    revive(&inner);
                }
            });
        }
        Some(Self { inner })
    }
}

impl Inner {
    /// Starts the other program and waits until it says it runs.
    fn spawn(&self) -> bool {
        let mut cmd = Command::new(&self.program);
        cmd.arg("--dir").arg(&self.dir).arg("--app-id").arg(&self.app_id).stdin(Stdio::piped()).stdout(Stdio::piped());
        if self.devtools {
            cmd.arg("--devtools");
        }
        if std::env::var_os("KEEL_DESKTOP_PROBE").is_some() {
            cmd.arg("--probe");
        }
        let reader = screen_reader();
        if reader {
            cmd.arg("--screen-reader");
        }
        self.reader.set(reader);
        let Ok(mut child) = cmd.spawn() else { return false };
        let (Some(to), Some(from)) = (child.stdin.take(), child.stdout.take()) else { return false };
        let (ready, is_ready) = std::sync::mpsc::channel::<bool>();
        std::thread::spawn(move || {
            let mut said_ready = false;
            for line in BufReader::new(from).lines() {
                let Ok(line) = line else { break };
                if !said_ready {
                    said_ready = line.contains("\"ready\"");
                    if said_ready {
                        let _ = ready.send(true);
                    }
                    continue;
                }
                glib::MainContext::default().invoke(move || heard(&line));
            }
            // It ended: before it ran (the first wait hears that), or under the app.
            let _ = ready.send(false);
            if said_ready {
                glib::MainContext::default().invoke(ended);
            }
        });
        if is_ready.recv_timeout(READY) != Ok(true) {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        self.started.set(Instant::now());
        *self.running.borrow_mut() = Some(Running { child, to });
        self.send(&json!({ "t": "look", "look": look_json(&self.look.borrow()) }));
        true
    }

    /// Ends the other program on purpose (its end is then not a stop under the app).
    fn stop(&self) {
        if let Some(mut r) = self.running.borrow_mut().take() {
            let _ = writeln!(r.to, "{}", json!({ "t": "quit" }));
            drop(r.to);
            let _ = r.child.wait();
        }
    }

    fn send(&self, m: &Value) {
        if let Some(r) = self.running.borrow_mut().as_mut() {
            let _ = writeln!(r.to, "{m}").and_then(|()| r.to.flush());
        }
    }

    fn win(&self, m: &Value) -> Option<Rc<Win>> {
        let id = m.get("win").and_then(Value::as_u64)? as u32;
        self.wins.borrow().get(&id).and_then(Weak::upgrade)
    }

    fn windows(&self) -> Vec<Rc<Win>> {
        self.wins.borrow().values().filter_map(Weak::upgrade).collect()
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Whether the desktop says a screen reader is on (the same word a browser goes by), or the
/// owner said so for the app (KEEL_DESKTOP_ACCESSIBILITY=1, or 0 for never).
fn screen_reader() -> bool {
    if let Some(said) = owner_said(std::env::var("KEEL_DESKTOP_ACCESSIBILITY").ok().as_deref()) {
        return said;
    }
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else { return false };
    let asked = ("org.a11y.Status", "ScreenReaderEnabled").to_variant();
    bus.call_sync(Some("org.a11y.Bus"), "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Get", Some(&asked), None, gio::DBusCallFlags::NONE, 400, gio::Cancellable::NONE)
        .ok()
        .and_then(|v| v.child_value(0).as_variant())
        .and_then(|v| v.get::<bool>())
        .unwrap_or(false)
}

fn look_json(l: &Look) -> Value {
    json!({ "dark": l.dark, "bg": l.bg, "panel": l.panel, "fg": l.fg, "muted": l.muted, "line": l.line, "need": l.need, "scale": l.scale })
}

/// A line of the other program, on the main loop.
fn heard(line: &str) {
    let Some(inner) = QT.with(|q| q.borrow().clone()) else { return };
    let Ok(m) = serde_json::from_str::<Value>(line) else { return };
    let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let win = inner.win(&m);
    match (m.get("t").and_then(Value::as_str).unwrap_or(""), win) {
        ("engine", _) => (inner.note)("qt", json!({ "qt": s("qt"), "chromium": s("chromium"), "patched": s("patched") })),
        ("download", _) => (inner.note)("download", json!({ "to": s("path") })),
        ("probe", _) => println!("PROBE {}", s("s")),
        ("confirmed", _) => {
            let answer = m.get("id").and_then(Value::as_u64).and_then(|id| inner.questions.borrow_mut().remove(&id));
            if let Some(answer) = answer {
                answer(m.get("yes").and_then(Value::as_bool).unwrap_or(false));
            }
        }
        ("said", Some(win)) => win.said(&s("s")),
        ("input", Some(win)) => win.gate.borrow_mut().input(Instant::now()),
        ("keys", Some(win)) => {
            if win.showing.get() == Showing::App {
                win.tell(&json!({ "scale": s("step") }));
            }
        }
        ("nav", Some(win)) => {
            let gesture = m.get("gesture").and_then(Value::as_bool);
            if let Some(what) = leads(&s("kind"), &s("url"), gesture, win.gate.borrow().pressed(Instant::now()), win.showing.get() == Showing::App, &win.origin.borrow()) {
                (win.ask)(&win, what);
            }
        }
        ("loaded", Some(win)) => win.loaded(&s("url"), &s("how")),
        ("url", Some(win)) => {
            // Should a document from anywhere else reach the main frame all the same, the daemon's page is loaded again over it.
            if win.showing.get() == Showing::App && !win.ours(&s("url")) {
                win.showing.set(Showing::Nothing);
                (win.ask)(&win, Ask::Lost);
            }
        }
        ("start", Some(win)) => (win.ask)(&win, Ask::Start),
        ("close", Some(win)) => (win.ask)(&win, Ask::Close),
        ("size", Some(win)) => {
            let n = |k: &str| m.get(k).and_then(Value::as_i64).unwrap_or(0) as i32;
            win.size.set((n("w"), n("h"), m.get("maximized").and_then(Value::as_bool).unwrap_or(false)));
        }
        ("clip", Some(win)) => win.tell(&json!({ "pasted": pasted(&m) })),
        _ => {}
    }
}

/// What the owner said about the page's accessibility tree, if anything: "1" always, "0" never.
pub fn owner_said(word: Option<&str>) -> Option<bool> {
    match word {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    }
}

/// What a navigation the engine did not make leads to. It makes none by itself: a window asked
/// for and a link out of Keel are told to the app, and become something only at the owner's own
/// press in that window. `gesture`: what the engine says of it, where it says anything (it does
/// for a window, not for a link, which may as well be a script's).
pub fn leads(kind: &str, url: &str, gesture: Option<bool>, pressed: bool, app: bool, here: &str) -> Option<Ask> {
    if !pressed || gesture == Some(false) {
        return None;
    }
    match kind {
        // A place of the page asked for in a new window gets a window of the app.
        "new-window" => Some(match url.strip_prefix(here).filter(|_| app && !here.is_empty()).and_then(links::page_path) {
            Some(path) => Ask::Window(path),
            None => Ask::External(url.to_string()),
        }),
        "link" => Some(Ask::External(url.to_string())),
        _ => None,
    }
}

/// The clipboard as the other program read it, as the page is told (the same shape as the other engine's).
pub fn pasted(m: &Value) -> Value {
    let id = m.get("id").cloned().unwrap_or(Value::Null);
    let text = m.get("text").cloned().unwrap_or(Value::Null);
    if m.get("picture").and_then(Value::as_bool) != Some(true) {
        return json!({ "id": id, "text": text, "images": [] });
    }
    let images: Vec<Value> = m.get("png").and_then(Value::as_str).map(|png| json!({ "type": "image/png", "data": png, "width": m.get("w"), "height": m.get("h") })).into_iter().collect();
    // A picture that could not be made ready is said, not dropped.
    let failed = images.is_empty();
    json!({ "id": id, "text": text, "images": images, "failed": failed, "from": m.get("from") })
}

/// The other program stopped under the app: it is started again and the windows come back
/// where they were. Twice in a short while it is left stopped, until the owner asks for a window.
fn ended() {
    let Some(inner) = QT.with(|q| q.borrow().clone()) else { return };
    let Some(mut gone) = inner.running.borrow_mut().take() else { return };
    let _ = gone.child.wait();
    let soon = inner.started.get().elapsed() < AGAIN;
    eprintln!("keel-desktop: the program that draws the windows stopped{}", if soon { "; it is left stopped until a window is asked for" } else { "; starting it again" });
    for w in inner.windows() {
        w.open.set(false);
        w.showing.set(Showing::Nothing);
    }
    if !soon {
        revive(&inner);
    }
}

/// Starts the other program again and puts every window back.
fn revive(inner: &Rc<Inner>) -> bool {
    if inner.running.borrow().is_some() {
        return true;
    }
    if !inner.spawn() {
        return false;
    }
    for w in inner.windows() {
        w.reopen();
        (w.ask)(&w, Ask::Lost);
        if w.visible.get() {
            inner.send(&json!({ "t": "present", "win": w.id }));
        }
    }
    true
}

impl Engine for Qt {
    fn name(&self) -> &'static str {
        "qt"
    }

    fn open(&self, opening: Opening, ask: Asked) -> Rc<dyn View> {
        let Opening { main, size, maximized, look: _, tray, devtools: _ } = opening;
        let id = self.inner.next.replace(self.inner.next.get() + 1);
        // What the window asks goes out as the view it is.
        let ask: Rc<dyn Fn(&Rc<Win>, Ask)> = Rc::new(move |win, what| {
            let view: Rc<dyn View> = win.clone();
            ask(&view, what)
        });
        let win = Rc::new(Win {
            id,
            inner: self.inner.clone(),
            main,
            tray,
            ask,
            showing: Cell::new(Showing::Nothing),
            wanted: RefCell::new("/".into()),
            key: glib::uuid_string_random().to_string(),
            origin: RefCell::new(String::new()),
            link: RefCell::new(Link::Down),
            loading: Cell::new(false),
            slow: Cell::new(false),
            gate: RefCell::new(Gate::default()),
            away_js: RefCell::new(String::new()),
            size: Cell::new((size.0, size.1, maximized)),
            visible: Cell::new(false),
            open: Cell::new(false),
        });
        self.inner.wins.borrow_mut().insert(id, Rc::downgrade(&win));
        win.reopen();
        win
    }

    fn look(&self, look: &Look) {
        *self.inner.look.borrow_mut() = look.clone();
        self.inner.send(&json!({ "t": "look", "look": look_json(look) }));
    }

    fn confirm(&self, question: &str, detail: &str, agree: &str, answer: Box<dyn FnOnce(bool)>) {
        if !revive(&self.inner) {
            // Nothing can ask: the answer is the safe one.
            return answer(false);
        }
        let id = self.inner.next.replace(self.inner.next.get() + 1) as u64;
        self.inner.questions.borrow_mut().insert(id, answer);
        self.inner.send(&json!({ "t": "confirm", "id": id, "question": question, "detail": detail, "agree": agree }));
    }
}

struct Win {
    id: u32,
    inner: Rc<Inner>,
    main: bool,
    tray: bool,
    ask: Rc<dyn Fn(&Rc<Win>, Ask)>,
    showing: Cell<Showing>,
    /// The path to open once the daemon answers.
    wanted: RefCell<String>,
    /// This window's own value: a message without it is not from the top frame's bridge or the away page.
    key: String,
    /// The daemon's origin the page is loaded from; the main frame stays there.
    origin: RefCell<String>,
    link: RefCell<Link>,
    /// The page is being loaded; `slow` once that took long enough to say so.
    loading: Cell<bool>,
    slow: Cell<bool>,
    /// When the app reads or writes the clipboard for the page (clip.rs).
    gate: RefCell<Gate>,
    /// The away page's last state, said again once that page has loaded.
    away_js: RefCell<String>,
    /// Width, height, maximized, as the other program last said.
    size: Cell<(i32, i32, bool)>,
    visible: Cell<bool>,
    /// The other program has this window.
    open: Cell<bool>,
}

impl Win {
    /// The window in the other program, as it was last sized.
    fn reopen(&self) {
        let (w, h, maximized) = self.size.get();
        self.inner.send(&json!({ "t": "open", "win": self.id, "w": w, "h": h, "maximized": maximized }));
        self.open.set(self.inner.running.borrow().is_some());
    }

    /// An address the main frame may show: the app's own page, or a place of the daemon's page while it is up.
    fn ours(&self, uri: &str) -> bool {
        uri.is_empty() || uri.starts_with("about:") || uri.starts_with("data:") || (self.showing.get() == Showing::App && links::main_frame_may_show(uri, &self.origin.borrow()))
    }

    fn js(&self, src: &str) {
        self.inner.send(&json!({ "t": "js", "win": self.id, "src": src }));
    }

    fn tell(&self, detail: &Value) {
        self.js(&format!("window.dispatchEvent(new CustomEvent('keel-shell', {{ detail: {detail} }}))"));
    }

    /// What the page says to the app: only with this window's key.
    fn said(self: &Rc<Self>, raw: &str) {
        let Ok(m) = serde_json::from_str::<Value>(raw) else { return };
        match asked(&m, &self.key) {
            Some(Asked1::Ask(what)) => (self.ask)(self, what),
            Some(Asked1::Paste(id, edge)) => {
                if self.gate.borrow().may_read(Instant::now()) {
                    self.inner.send(&json!({ "t": "clip-read", "win": self.id, "id": id, "edge": edge.unwrap_or(0) }));
                } else {
                    self.tell(&json!({ "pasted": { "id": id, "refused": true, "images": [] } }));
                }
            }
            Some(Asked1::Copying) => {
                self.gate.borrow_mut().arm(Instant::now());
            }
            Some(Asked1::Copy(id, text)) => {
                let ok = self.gate.borrow_mut().take(Instant::now());
                if ok {
                    self.inner.send(&json!({ "t": "clip-write", "text": text }));
                }
                self.tell(&json!({ "copied": { "id": id, "ok": ok } }));
            }
            None => {}
        }
    }

    /// A load of the main frame ended.
    fn loaded(self: &Rc<Self>, url: &str, how: &str) {
        let ours = self.ours(url);
        match how {
            "ok" if ours => {
                self.loading.set(false);
                self.slow.set(false);
                self.pill_now();
                // A state the away page was told before it had loaded is told again.
                if self.showing.get() == Showing::Away && !self.away_js.borrow().is_empty() {
                    self.js(&self.away_js.borrow());
                }
            }
            // The daemon went away under a load: the calm page, not the engine's error page.
            // (A document the main frame was refused is no loss of the daemon: the page stays.)
            "ok" | "failed" if self.showing.get() == Showing::App && (how == "ok" || ours) => {
                self.showing.set(Showing::Nothing);
                (self.ask)(self, Ask::Lost);
            }
            _ => {}
        }
    }

    /// The state beside the controls: the daemon away while its page is up, or the page still coming.
    fn pill_now(&self) {
        let link = self.link.borrow().clone();
        let over_page = self.showing.get() == Showing::App;
        let coming = over_page && link == Link::Up && self.loading.get() && self.slow.get();
        let text = match link {
            Link::Restarting => "Reconnecting",
            Link::Down => "Keel is not running",
            Link::Up if coming => "Opening",
            Link::Up => "",
        };
        let tip = if coming { "" } else { "What the sessions were doing is not known until Keel is back. Messages you send wait and go out then." };
        self.inner.send(&json!({ "t": "pill", "win": self.id, "show": over_page && (link != Link::Up || coming), "text": text, "dot": link == Link::Restarting || coming, "start": over_page && link == Link::Down, "tip": tip }));
    }
}

impl View for Win {
    fn id(&self) -> u32 {
        self.id
    }

    fn is_main(&self) -> bool {
        self.main
    }

    fn showing(&self) -> Showing {
        self.showing.get()
    }

    fn forget(&self) {
        self.showing.set(Showing::Nothing);
    }

    fn wanted(&self) -> String {
        self.wanted.borrow().clone()
    }

    fn want(&self, path: &str) {
        *self.wanted.borrow_mut() = path.to_string();
    }

    fn load(&self, base: &str, path: &str) {
        // The capability object goes to the top frame of this daemon's origin, and nowhere else.
        let at = origin(base);
        let mut script = page::bridge("qt", if self.main { "main" } else { "session" }, self.tray, POST, &self.key, &at);
        if let Some(src) = std::env::var_os("KEEL_DESKTOP_PROBE").and_then(|p| std::fs::read_to_string(p).ok()) {
            // The measurer's script, for this daemon's origin alone as well.
            script.push_str(&format!("\nif (self.origin === {}) {{ {src} }}", Value::String(at.clone())));
        }
        // Which daemon, when it is not the one a bare launch finds.
        let title = match crate::http::authority(base) {
            Ok(host) if base != DEFAULT_URL => format!("Keel  \u{b7}  {host}"),
            _ => "Keel".to_string(),
        };
        let url = format!("{base}{}", links::page_path(path).unwrap_or_else(|| "/".into()));
        *self.origin.borrow_mut() = at.clone();
        self.showing.set(Showing::App);
        self.loading.set(true);
        self.slow.set(false);
        self.inner.send(&json!({ "t": "load", "win": self.id, "url": url, "origin": at, "script": script, "title": title }));
        // A daemon that is slow to answer: after a moment the title bar says the page is coming, instead of an empty window.
        let (inner, id) = (Rc::downgrade(&self.inner), self.id);
        glib::timeout_add_local_once(Duration::from_millis(1200), move || {
            let win = inner.upgrade().and_then(|i| i.wins.borrow().get(&id).and_then(Weak::upgrade));
            if let Some(win) = win.filter(|w| w.loading.get()) {
                win.slow.set(true);
                win.pill_now();
            }
        });
    }

    fn go(&self, path: &str, clicked: bool) {
        self.tell(&json!({ "open": path, "from": if clicked { "click" } else { "link" } }));
    }

    fn daemon_back(&self) {
        self.tell(&json!({ "daemon": "up" }));
    }

    fn daemon_away(&self) {
        self.tell(&json!({ "daemon": "away" }));
    }

    fn away(&self, look: &Look, state: &Away) {
        let js = page::away_state(state);
        *self.away_js.borrow_mut() = js.clone();
        if self.showing.get() == Showing::Away {
            self.js(&js);
        } else {
            self.showing.set(Showing::Away);
            self.loading.set(false);
            self.slow.set(false);
            self.inner.send(&json!({ "t": "html", "win": self.id, "html": page::away(look, state, POST, &self.key) }));
        }
    }

    fn link(&self, link: &Link) {
        *self.link.borrow_mut() = link.clone();
        self.pill_now();
    }

    fn look(&self, _look: &Look) {}

    fn present(&self, token: Option<&str>) {
        self.visible.set(true);
        // The other program had stopped and was left so: the owner asks for a window, so it is started again.
        if !self.open.get() && revive(&self.inner) {
            return;
        }
        self.inner.send(&json!({ "t": "present", "win": self.id, "token": token.unwrap_or("") }));
    }

    fn hide(&self) {
        self.visible.set(false);
        self.inner.send(&json!({ "t": "hide", "win": self.id }));
    }

    fn close(&self) {
        self.visible.set(false);
        self.inner.wins.borrow_mut().remove(&self.id);
        self.inner.send(&json!({ "t": "close", "win": self.id }));
    }

    fn size(&self) -> (i32, i32, bool) {
        self.size.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HERE: &str = "http://127.0.0.1:47960";

    // The first review's case, for this engine: content opened windows and sent addresses to the
    // browser with no click. The engine tells of every window asked for; only the owner's press makes one.
    #[test]
    fn nothing_opens_without_the_owners_press() {
        for kind in ["new-window", "link"] {
            assert!(leads(kind, "https://example.com/x", Some(true), false, true, HERE).is_none(), "{kind}");
            assert!(leads(kind, &format!("{HERE}/s/abc"), None, false, true, HERE).is_none(), "{kind}");
        }
        // The engine says no gesture made it: the press of a moment ago was for something else.
        assert!(leads("new-window", "https://example.com/x", Some(false), true, true, HERE).is_none());
        assert!(leads("anything", "https://example.com/x", Some(true), true, true, HERE).is_none());
    }

    #[test]
    fn a_click_leads_to_a_window_of_the_app_or_to_the_browser() {
        assert!(matches!(leads("new-window", &format!("{HERE}/s/abc"), Some(true), true, true, HERE), Some(Ask::Window(p)) if p == "/s/abc"));
        // Not a place of the page: an artifact's raw address goes to the browser, not into a window of the app.
        assert!(matches!(leads("new-window", &format!("{HERE}/api/sessions/x/artifacts/raw?path=a"), Some(true), true, true, HERE), Some(Ask::External(_))));
        // Another daemon's address that begins the same is not this one's.
        assert!(matches!(leads("new-window", "http://127.0.0.1:479601/s/abc", Some(true), true, true, HERE), Some(Ask::External(_))));
        // While the away page is up there is no page to open a place of.
        assert!(matches!(leads("new-window", &format!("{HERE}/s/abc"), Some(true), true, false, HERE), Some(Ask::External(_))));
        assert!(matches!(leads("link", "https://example.com/x", None, true, true, HERE), Some(Ask::External(u)) if u == "https://example.com/x"));
    }

    #[test]
    fn the_owners_word_on_accessibility_comes_before_the_desktops() {
        assert_eq!(owner_said(Some("1")), Some(true));
        assert_eq!(owner_said(Some("0")), Some(false));
        // Anything else leaves it to the desktop: its word on whether a screen reader is on.
        assert_eq!(owner_said(None), None);
        assert_eq!(owner_said(Some("")), None);
        assert_eq!(owner_said(Some("yes")), None);
    }

    #[test]
    fn the_clipboard_is_told_to_the_page_in_one_shape() {
        let none = pasted(&json!({ "id": 7, "text": "words" }));
        assert_eq!(none, json!({ "id": 7, "text": "words", "images": [] }));
        let picture = pasted(&json!({ "id": 8, "picture": true, "png": "AAAA", "w": 1568, "h": 1045, "from": [3000, 2000] }));
        assert_eq!(picture["images"][0], json!({ "type": "image/png", "data": "AAAA", "width": 1568, "height": 1045 }));
        assert_eq!((picture["failed"].clone(), picture["from"].clone()), (json!(false), json!([3000, 2000])));
        // A picture that could not be made ready is said.
        let broken = pasted(&json!({ "id": 9, "picture": true }));
        assert_eq!((broken["failed"].clone(), broken["images"].clone()), (json!(true), json!([])));
    }
}
