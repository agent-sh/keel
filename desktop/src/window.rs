//! The engine side of the seam (view.rs) on GTK 4 and WebKitGTK 6: a window
//! with the page in a web view under a title bar the app owns. The title bar
//! is the platform's (drag, double click, the window menu and the controls
//! the desktop is set to show) in the page's colors.
//!
//! What content inside the web view can reach, and who may use it, is listed
//! in desktop/README.md ("What the page can reach"). The rule here: only the
//! top frame of the daemon's own origin, or the app's own away page, is
//! listened to; everything else in the view is content. The engine itself
//! grants content nothing: every permission request is refused, and its
//! asynchronous clipboard is switched off (clip.rs says how a paste and a
//! copy of the page reach the clipboard instead).
use crate::clip::Gate;
use crate::daemon::{Link, DEFAULT_URL};
use crate::links::{self, origin};
use crate::page;
use crate::prefs::Look;
use crate::said::{asked, Asked1};
use crate::said::may_act;
use crate::view::{retry_after, Ask, Asked, Away, Can, Engine, Step, Opening, Recovery, Showing, View, FAILS_SAID, SPEAKS_WITHIN};
use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};
use webkit::prelude::*;

/// How a page of this engine posts the string `s` to the app.
const POST: &str = "window.webkit.messageHandlers.keel.postMessage(s)";

// The bar is the rail's colour and runs into it with no line between: a hairline under it read
// as a short white line at the top of the session list in the dark theme.
fn style(l: &Look) -> String {
    let px = |n: f64| format!("{:.0}px", (n * l.scale).round());
    format!(
        r#"
window.keel {{ background: {bg}; }}
window.keel .titlebar {{ min-height: 0; padding: 0; margin: 0; border: none; background: transparent; box-shadow: none; }}
.keel-bar {{ background: {panel}; color: {muted}; min-height: {h}; padding: 0 {pad}; border: none; box-shadow: none; }}
.keel-bar .keel-title {{ font-size: {font}; font-weight: 500; color: {muted}; }}
.keel-bar windowcontrols {{ border-spacing: {gap}; }}
.keel-bar windowcontrols button {{ min-width: {btn}; min-height: {btn}; padding: 0; margin: 0; border: none; border-radius: {radius}; background: transparent; color: {muted}; box-shadow: none; outline-offset: -2px; transition: background 120ms ease, color 120ms ease; }}
.keel-bar windowcontrols button image {{ background: transparent; box-shadow: none; padding: 0; -gtk-icon-size: {icon}; }}
.keel-bar windowcontrols button:hover {{ background: alpha({fg}, 0.09); color: {fg}; }}
.keel-bar windowcontrols button:active {{ background: alpha({fg}, 0.16); }}
.keel-bar windowcontrols button.close:hover {{ background: #d9434b; color: #ffffff; }}
.keel-bar:backdrop .keel-title, .keel-bar:backdrop windowcontrols button {{ color: alpha({muted}, 0.6); }}
.keel-pill {{ font-size: {small}; color: {muted}; padding: {pill_y} {pill_x}; border-radius: 999px; background: alpha({fg}, 0.06); border-spacing: {gap}; }}
.keel-pill .keel-dot {{ min-width: {dot}; min-height: {dot}; border-radius: 999px; background: {need}; animation: keel-pulse 1.8s ease-in-out infinite; }}
.keel-start {{ font-size: {small}; font-weight: 600; min-height: 0; min-width: 0; padding: {start_y} {pill_x}; margin: 0; border: none; border-radius: 999px; background: {fg}; color: {bg}; box-shadow: none; outline-offset: 2px; transition: background 120ms ease; }}
.keel-start:hover {{ background: alpha({fg}, 0.85); }}
.keel-start:active {{ background: alpha({fg}, 0.7); }}
@keyframes keel-pulse {{ 0% {{ opacity: 0.3; }} 50% {{ opacity: 1; }} 100% {{ opacity: 0.3; }} }}
window.dialog.message {{ background: {panel}; color: {fg}; border: 1px solid {line}; border-radius: {sheet}; box-shadow: 0 18px 48px alpha(black, 0.28); }}
window.dialog.message headerbar, window.dialog.message .titlebar {{ min-height: 0; padding: 0; margin: 0; border: none; background: transparent; box-shadow: none; }}
window.dialog.message .dialog-vbox {{ background: transparent; }}
window.dialog.message label {{ font-size: {font}; color: {muted}; }}
window.dialog.message label.title {{ font-size: {head}; font-weight: 600; color: {fg}; }}
window.dialog.message .dialog-action-area {{ border-top: 1px solid {line}; margin: 0; padding: 0; border-spacing: 0; }}
window.dialog.message .dialog-action-area button {{ min-height: {row}; margin: 0; padding: 0 {pill_x}; border: none; border-radius: 0; background: transparent; color: {fg}; font-size: {font}; font-weight: 500; box-shadow: none; outline-offset: -3px; transition: background 120ms ease; }}
window.dialog.message .dialog-action-area button:not(:first-child) {{ border-left: 1px solid {line}; }}
window.dialog.message .dialog-action-area button:hover {{ background: alpha({fg}, 0.06); }}
window.dialog.message .dialog-action-area button:active {{ background: alpha({fg}, 0.12); }}
window.dialog.message .dialog-action-area button:first-child {{ border-bottom-left-radius: {sheet}; }}
window.dialog.message .dialog-action-area button label {{ color: {fg}; }}
window.dialog.message .dialog-action-area button:last-child {{ border-bottom-right-radius: {sheet}; }}
window.dialog.message .dialog-action-area button.default, window.dialog.message .dialog-action-area button:focus {{ font-weight: 600; }}
window.dialog.message .dialog-action-area button:focus {{ outline: 2px solid {need}; outline-offset: -3px; }}
"#,
        bg = l.bg, panel = l.panel, fg = l.fg, muted = l.muted, line = l.line, need = l.need,
        h = px(34.0), pad = px(6.0), font = px(13.0), small = px(12.0), btn = px(26.0), radius = px(7.0), icon = px(16.0),
        gap = px(4.0), dot = px(6.0), pill_y = px(2.0), pill_x = px(10.0), start_y = px(3.0), sheet = px(12.0), head = px(15.0), row = px(40.0),
    )
}

/// A picture's bytes as the clipboard gave them, as PNG no larger than `edge` on its longer side:
/// (the PNG, its width and height, the width and height it came with). Decoded, scaled and
/// encoded here, off the main loop: a large picture takes a while at each.
fn picture_within(bytes: &glib::Bytes, png: bool, edge: Option<i32>) -> Option<(Vec<u8>, i32, i32, i32, i32)> {
    use gtk::gdk_pixbuf::{InterpType, Pixbuf};
    let whole = Pixbuf::from_stream(&gio::MemoryInputStream::from_bytes(bytes), gio::Cancellable::NONE).ok()?;
    let (w, h) = (whole.width(), whole.height());
    let (nw, nh) = edge.map_or((w, h), |e| crate::clip::fit(w, h, e));
    if (nw, nh) == (w, h) {
        // (A PNG that needs no scaling goes as it is.)
        let out = if png { bytes.to_vec() } else { whole.save_to_bufferv("png", &[]).ok()? };
        return Some((out, w, h, w, h));
    }
    let small = whole.scale_simple(nw, nh, InterpType::Bilinear)?;
    small.save_to_bufferv("png", &[]).ok().map(|out| (out, nw, nh, w, h))
}

/// The pattern of the engine's user scripts for an origin: its scheme and host, any port
/// (the engine's patterns name no port; the injected script checks the whole origin itself).
fn pattern(origin: &str) -> String {
    let (scheme, authority) = origin.split_once("://").unwrap_or(("http", origin));
    let host = match authority.strip_prefix('[') {
        Some(v6) => format!("[{}]", v6.split(']').next().unwrap_or("")),
        None => authority.rsplit_once(':').map_or(authority, |(h, _)| h).to_string(),
    };
    format!("{scheme}://{host}/*")
}

/// Where a file the page offers is saved: the desktop's downloads folder, else
/// a Downloads folder of its own under the home folder. Never the home folder
/// itself, where a name the page chose could be a dotfile the shell reads.
fn downloads() -> std::path::PathBuf {
    let home = glib::home_dir();
    match glib::user_special_dir(glib::UserDirectory::Downloads) {
        Some(d) if d != home => d,
        _ => home.join("Downloads"),
    }
}

/// GTK 4 and the system web view.
pub struct WebKit {
    app: gtk::Application,
    session: webkit::NetworkSession,
    css: gtk::CssProvider,
    next: Cell<u32>,
    /// The windows, for what the session hears of a view (a file to keep).
    wins: Rc<RefCell<Vec<Weak<Win>>>>,
}

impl WebKit {
    /// `dir` holds the page's own storage; `on_download(path)` is told where a file the page offered was saved.
    pub fn new(app: &gtk::Application, dir: &std::path::Path, on_download: impl Fn(&std::path::Path) + 'static) -> Self {
        let css = gtk::CssProvider::new();
        if let Some(d) = gdk::Display::default() {
            gtk::style_context_add_provider_for_display(&d, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        let session = webkit::NetworkSession::new(dir.join("web").to_str(), dir.join("web-cache").to_str());
        let on_download = Rc::new(on_download);
        let wins: Rc<RefCell<Vec<Weak<Win>>>> = Rc::default();
        let known = wins.clone();
        session.connect_download_started(move |_, download| {
            // A file is kept only when the owner pressed in that window a moment before: a script,
            // in the page or in a frame the page lets keep files, saves nothing by itself.
            // And only one of the daemon's own, from its API: not what a frame's script made
            // (`blob:`, `data:`), not what a session's port serves, not another origin.
            let from = download.web_view();
            let url = download.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
            let kept = known.borrow().iter().filter_map(Weak::upgrade).any(|w| {
                Some(&w.view) == from.as_ref() && links::keepable(&url, &w.origin.borrow()) && w.gate.borrow_mut().may_keep(&url, Instant::now())
            });
            if !kept {
                download.cancel();
                return;
            }
            let on_download = on_download.clone();
            download.connect_decide_destination(move |d, suggested| {
                let folder = downloads();
                let _ = std::fs::create_dir_all(&folder);
                let path = links::free_name(&folder, suggested, |p| p.exists());
                d.set_destination(&path.to_string_lossy());
                on_download(&path);
                true
            });
        });
        Self { app: app.clone(), session, css, next: Cell::new(1), wins }
    }
}

impl Engine for WebKit {
    fn name(&self) -> &'static str {
        "webkit"
    }

    fn open(&self, opening: Opening, ask: Asked) -> Rc<dyn View> {
        let id = self.next.replace(self.next.get() + 1);
        self.wins.borrow_mut().retain(|w| w.strong_count() > 0);
        Win::new(&self.app, &self.session, id, opening, ask, &self.wins)
    }

    fn look(&self, look: &Look) {
        self.css.load_from_string(&style(look));
        if let Some(s) = gtk::Settings::default() {
            s.set_gtk_application_prefer_dark_theme(look.dark);
        }
    }

    fn confirm(&self, question: &str, detail: &str, agree: &str, answer: Box<dyn FnOnce(bool)>) {
        let dialog = gtk::AlertDialog::builder().message(question).detail(detail).buttons(["Cancel", agree]).cancel_button(0).default_button(0).modal(true).build();
        let parent = self.app.active_window();
        let answer = RefCell::new(Some(answer));
        dialog.choose(parent.as_ref(), gio::Cancellable::NONE, move |picked| {
            if let Some(f) = answer.borrow_mut().take() {
                f(picked == Ok(1));
            }
        });
    }
}

struct Win {
    id: u32,
    window: gtk::ApplicationWindow,
    view: webkit::WebView,
    ucm: webkit::UserContentManager,
    main: bool,
    can: Can,
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
    me: RefCell<Weak<Win>>,
    /// When the app reads or writes the clipboard for the page (clip.rs).
    gate: RefCell<Gate>,
    /// Loads of the daemon's page that failed in a row (`retry_after`).
    failed: Cell<u32>,
    /// What is known of a page whose process ended, or that came back and says nothing (view.rs).
    rec: RefCell<Recovery>,
    /// What the window asks of the app (the same closure its handlers hold).
    ask: Rc<dyn Fn(&Rc<Win>, Ask)>,
    /// The away page's last state, said again once that page has loaded.
    away_js: RefCell<String>,
    /// What the bar said last (`bar_said`).
    bar: RefCell<String>,
    title: gtk::Label,
    pill: gtk::Box,
    pill_text: gtk::Label,
    pill_start: gtk::Button,
    dot: gtk::Box,
}

fn rgba(hex: &str) -> gdk::RGBA {
    gdk::RGBA::parse(hex).unwrap_or(gdk::RGBA::WHITE)
}

impl Win {
    fn new(app: &gtk::Application, session: &webkit::NetworkSession, id: u32, opening: Opening, ask: Asked, wins: &Rc<RefCell<Vec<Weak<Win>>>>) -> Rc<dyn View> {
        let Opening { main, size, maximized, look, can, devtools } = opening;
        // What a closure of the window asks goes out as the view it is.
        let ask: Rc<dyn Fn(&Rc<Win>, Ask)> = Rc::new(move |win, what| {
            let view: Rc<dyn View> = win.clone();
            ask(&view, what)
        });
        let ucm = webkit::UserContentManager::new();
        ucm.register_script_message_handler("keel", None);
        // For measuring the page inside the app: the measurer's reports go to standard output.
        if std::env::var_os("KEEL_DESKTOP_PROBE").is_some() {
            ucm.register_script_message_handler("probe", None);
            ucm.connect_script_message_received(Some("probe"), |_, value| println!("PROBE {}", value.to_str()));
        }

        let settings = webkit::Settings::new();
        settings.set_enable_developer_extras(devtools);
        settings.set_enable_write_console_messages_to_stdout(devtools);
        settings.set_enable_back_forward_navigation_gestures(false);
        settings.set_user_agent_with_application_details(Some("Keel"), Some(env!("CARGO_PKG_VERSION")));
        // No frame reads or writes the clipboard through the engine (clip.rs): script access stays
        // off, and so does the asynchronous clipboard, which would otherwise give any frame a write
        // some seconds after a click in it.
        settings.set_javascript_can_access_clipboard(false);
        if let Some(features) = webkit::Settings::all_features() {
            for f in (0..features.length()).filter_map(|i| features.get(i)) {
                if f.identifier().as_deref() == Some("AsyncClipboardAPI") {
                    settings.set_feature_enabled(&f, false);
                }
            }
        }

        let view = webkit::WebView::builder().network_session(session).user_content_manager(&ucm).settings(&settings).hexpand(true).vexpand(true).build();
        view.set_background_color(&rgba(&look.bg));

        // The title bar: the app's name (and which daemon, when it is not the usual one), the daemon's state and the controls.
        // The session's title sits right below in the page, so it is not said twice.
        let title = gtk::Label::builder().label("Keel").ellipsize(gtk::pango::EllipsizeMode::End).css_classes(["keel-title"]).build();
        let dot = gtk::Box::builder().css_classes(["keel-dot"]).valign(gtk::Align::Center).build();
        let pill_text = gtk::Label::new(None);
        let pill_start = gtk::Button::builder().label("Start").css_classes(["keel-start"]).valign(gtk::Align::Center).visible(false).build();
        let pill = gtk::Box::builder().css_classes(["keel-pill"]).valign(gtk::Align::Center).visible(false).build();
        pill.append(&dot);
        pill.append(&pill_text);
        let end = gtk::Box::builder().spacing(8).build();
        end.append(&pill);
        end.append(&pill_start);
        end.append(&gtk::WindowControls::new(gtk::PackType::End));
        let bar = gtk::CenterBox::builder().css_classes(["keel-bar"]).build();
        bar.set_start_widget(Some(&gtk::WindowControls::new(gtk::PackType::Start)));
        bar.set_center_widget(Some(&title));
        bar.set_end_widget(Some(&end));
        let handle = gtk::WindowHandle::builder().child(&bar).build();

        let window = gtk::ApplicationWindow::builder().application(app).title("Keel").default_width(size.0).default_height(size.1).maximized(maximized).css_classes(["keel"]).icon_name(crate::APP_ID).build();
        window.set_titlebar(Some(&handle));
        window.set_child(Some(&view));

        let win = Rc::new(Self {
            id,
            window,
            view,
            ucm: ucm.clone(),
            main,
            can,
            showing: Cell::new(Showing::Nothing),
            wanted: RefCell::new("/".into()),
            key: glib::uuid_string_random().to_string(),
            origin: RefCell::new(String::new()),
            link: RefCell::new(Link::Down),
            loading: Cell::new(false),
            slow: Cell::new(false),
            me: RefCell::new(Weak::new()),
            gate: RefCell::new(Gate::default()),
            failed: Cell::new(0),
            rec: RefCell::new(Recovery::default()),
            ask: ask.clone(),
            away_js: RefCell::new(String::new()),
            bar: RefCell::new(String::new()),
            title,
            pill,
            pill_text,
            pill_start,
            dot,
        });

        *win.me.borrow_mut() = Rc::downgrade(&win);
        wins.borrow_mut().push(Rc::downgrade(&win));

        // The page's title is the window's name on the desktop (the overview, the task switcher).
        let w = win.window.clone();
        win.view.connect_title_notify(move |v| {
            let s = v.title().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Keel".into());
            w.set_title(Some(&s));
        });

        // What the page says to the app: only with this window's key.
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        ucm.connect_script_message_received(Some("keel"), move |_, value| {
            let Some(win) = weak.upgrade() else { return };
            let Ok(m) = serde_json::from_str::<Value>(&value.to_str()) else { return };
            match asked(&m, &win.key) {
                Some(Asked1::Ask(what)) => {
                    if may_act(&what, win.gate.borrow().pressed(Instant::now())) {
                        a(&win, what)
                    }
                }
                Some(Asked1::Paste(id, edge)) => {
                    if win.gate.borrow().may_read(Instant::now()) {
                        win.paste(id, edge);
                    } else {
                        win.tell(&serde_json::json!({ "pasted": { "id": id, "refused": true, "images": [] } }));
                    }
                }
                Some(Asked1::Copying) => {
                    win.gate.borrow_mut().arm(Instant::now());
                }
                Some(Asked1::Copy(id, text)) => {
                    let ok = win.gate.borrow_mut().take(Instant::now());
                    if ok {
                        win.window.clipboard().set_text(&text);
                    }
                    win.tell(&serde_json::json!({ "copied": { "id": id, "ok": ok } }));
                }
                // (This engine's paste keys stay its own: it gives no frame the keyboard it was not given.)
                Some(Asked1::Can { paste, saving }) => {
                    // The page itself speaks: one that was loaded again because its process
                    // had ended is told so, once, now that it listens; one that was left is
                    // left no more.
                    if paste && win.showing.get() == Showing::App {
                        let left = win.rec.borrow().stopped();
                        if win.rec.borrow_mut().spoke() {
                            win.tell(&json!({ "reloaded": "stopped" }));
                            a(&win, Ask::Note("told-reloaded", json!({ "window": win.id })));
                        }
                        if left {
                            win.pill_now();
                        }
                    }
                    win.gate.borrow_mut().announces(saving)
                }
                Some(Asked1::PasteThrough) => {}
                Some(Asked1::Saving(id, url)) => {
                    let ok = links::keepable(&url, &win.origin.borrow()) && win.gate.borrow_mut().announce(&url, Instant::now());
                    win.tell(&serde_json::json!({ "saving": { "id": id, "ok": ok } }));
                }
                None => {}
            }
        });

        // Where a navigation goes. The owner's click on a link out of Keel opens the browser; a place
        // of the page asked for in a new window gets a window of the app. A script cannot do either.
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        win.view.connect_decide_policy(move |_, decision, kind| {
            let Some(win) = weak.upgrade() else { return false };
            // The main frame shows places of the daemon's page and nothing else: any other document
            // (another origin's, or one the daemon serves that is no page, like an artifact's raw
            // address) is refused when its answer arrives, before any of it is shown or run, and the
            // page stays. A file of the daemon's to keep is saved instead; the page stays there too.
            if let Some(r) = decision.downcast_ref::<webkit::ResponsePolicyDecision>() {
                let uri = r.request().and_then(|q| q.uri()).map(|u| u.to_string()).unwrap_or_default();
                if !r.is_main_frame_main_resource() || win.ours(&uri) {
                    return false;
                }
                let of_daemon = win.showing.get() == Showing::App && origin(&uri) == *win.origin.borrow();
                let file = r.response().and_then(|x| x.suggested_filename()).is_some_and(|n| !n.is_empty()) || !r.is_mime_type_supported();
                if of_daemon && file {
                    decision.download();
                } else {
                    decision.ignore();
                }
                return true;
            }
            let Some(d) = decision.downcast_ref::<webkit::NavigationPolicyDecision>() else { return false };
            let Some(action) = d.navigation_action() else { return false };
            let uri = action.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
            let here = win.origin.borrow().clone();
            let inside = uri.starts_with("about:") || uri.starts_with("blob:") || uri.starts_with("data:") || (win.showing.get() == Showing::App && origin(&uri) == here);
            let gesture = action.is_user_gesture();
            if kind == webkit::PolicyDecisionType::NewWindowAction {
                decision.ignore();
                if gesture {
                    match uri.strip_prefix(&here).filter(|_| inside).and_then(links::page_path) {
                        Some(path) => a(&win, Ask::Window(path)),
                        None => a(&win, Ask::External(uri)),
                    }
                }
                return true;
            }
            if !inside && action.navigation_type() == webkit::NavigationType::LinkClicked {
                decision.ignore();
                if gesture {
                    a(&win, Ask::External(uri));
                }
                return true;
            }
            false
        });

        // Should a document from anywhere else reach the main frame all the same (one that came
        // with no answer to refuse), the daemon's page is loaded again over it.
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        win.view.connect_load_changed(move |v, event| {
            let Some(win) = weak.upgrade() else { return };
            let uri = v.uri().map(|u| u.to_string()).unwrap_or_default();
            if !win.ours(&uri) {
                if matches!(event, webkit::LoadEvent::Committed | webkit::LoadEvent::Finished) && win.showing.get() == Showing::App {
                    win.showing.set(Showing::Nothing);
                    a(&win, Ask::Lost);
                }
                return;
            }
            // A page that arrived (only a load that got an answer commits): the failures in a row are over.
            // (Not at Finished: the engine ends a failed load with a Finished too, by when the first
            // retry of it has started, and the count would never pass one.)
            if event == webkit::LoadEvent::Committed && win.showing.get() == Showing::App {
                win.failed.set(0);
            }
            if event == webkit::LoadEvent::Finished {
                win.loading.set(false);
                win.slow.set(false);
                win.pill_now();
                // A state the away page was told before it had loaded is told again.
                if win.showing.get() == Showing::Away {
                    let js = win.away_js.borrow().clone();
                    if !js.is_empty() {
                        v.evaluate_javascript(&js, None, None, gio::Cancellable::NONE, |_| {});
                    }
                }
            }
        });

        // The engine grants content nothing: not the clipboard (clip.rs), not a device, not a place.
        win.view.connect_permission_request(|_, req| {
            req.deny();
            true
        });

        // The page has no use for the engine's own windows, and content inside it must not raise one
        // that reads as the app's: no print dialog, no script dialog (alert, confirm, prompt: the
        // page draws its own), no password dialog.
        win.view.connect_print(|_, _| true);
        win.view.connect_script_dialog(|_, _| true);
        win.view.connect_authenticate(|_, request| {
            request.cancel();
            true
        });

        // The context menu keeps what acts on the page's content; a browser's navigation has no place here.
        win.view.connect_context_menu(move |_, menu, _| {
            use webkit::ContextMenuAction as A;
            for item in menu.items() {
                if matches!(item.stock_action(), A::GoBack | A::GoForward | A::Stop | A::Reload | A::OpenLink | A::OpenLinkInNewWindow | A::DownloadLinkToDisk | A::OpenImageInNewWindow | A::OpenFrameInNewWindow | A::OpenVideoInNewWindow | A::OpenAudioInNewWindow) || (!devtools && item.stock_action() == A::InspectElement) {
                    menu.remove(&item);
                }
            }
            menu.n_items() == 0
        });

        // The daemon went away under a load: the calm page, not the engine's error page.
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        win.view.connect_load_failed(move |_, _, uri, _| {
            if let Some(win) = weak.upgrade() {
                // A document refused above is no loss of the daemon: the page that was there stays.
                if !win.ours(uri) {
                    return true;
                }
                if win.showing.get() == Showing::App {
                    win.showing.set(Showing::Nothing);
                    // At once the first time, then less and less often; said in the window from the third (view.rs).
                    let n = win.failed.get().saturating_add(1);
                    win.failed.set(n);
                    let wait = retry_after(n);
                    if wait.is_zero() {
                        a(&win, Ask::Lost);
                        return true;
                    }
                    if n >= FAILS_SAID {
                        a(&win, Ask::Failing);
                    }
                    let (weak, a) = (weak.clone(), a.clone());
                    glib::timeout_add_local_once(wait, move || {
                        if let Some(win) = weak.upgrade().filter(|w| w.failed.get() == n && w.showing.get() != Showing::App) {
                            a(&win, Ask::Lost);
                        }
                    });
                }
            }
            true
        });
        let weak = Rc::downgrade(&win);
        // The page's own process ended: the page is loaded again and told so, a few times; one
        // that keeps ending, or that comes back and says nothing, is left with the bar's button
        // (the rule both engines follow: view.rs `Recovery`).
        win.view.connect_web_process_terminated(move |_, _| {
            let Some(win) = weak.upgrade() else { return };
            win.gate.borrow_mut().announces(false);
            if win.showing.get() != Showing::App {
                // The app's own page: put back as it is, three times a minute at most.
                let wait = win.rec.borrow_mut().own_ended(Instant::now());
                (win.ask)(&win, Ask::Note("page-stopped", json!({ "window": win.id, "again": true, "own": true, "wait_ms": wait.as_millis() as u64 })));
                win.showing.set(Showing::Nothing);
                if wait.is_zero() {
                    return (win.ask)(&win, Ask::Lost);
                }
                let me = Rc::downgrade(&win);
                glib::timeout_add_local_once(wait, move || {
                    // (Put on a page meanwhile, by the daemon's coming or going: nothing more to do.)
                    if let Some(win) = me.upgrade().filter(|w| w.showing.get() == Showing::Nothing) {
                        (win.ask)(&win, Ask::Lost);
                    }
                });
                return;
            }
            let next = win.rec.borrow_mut().ended(Instant::now());
            (win.ask)(&win, Ask::Note("page-stopped", json!({ "window": win.id, "again": next != Step::Leave })));
            win.follow(next);
        });

        // The keys every desktop app uses for text size drive the page's own setting: one scale, not two.
        // The toolkit's inspector keys are the developer's, not the owner's.
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = Rc::downgrade(&win);
        keys.connect_key_pressed(move |_, key, _, mods| {
            let Some(win) = weak.upgrade() else { return glib::Propagation::Proceed };
            win.gate.borrow_mut().input(Instant::now());
            if !mods.contains(gdk::ModifierType::CONTROL_MASK) || mods.contains(gdk::ModifierType::ALT_MASK) {
                return glib::Propagation::Proceed;
            }
            if mods.contains(gdk::ModifierType::SHIFT_MASK) && matches!(key, gdk::Key::I | gdk::Key::i | gdk::Key::D | gdk::Key::d) {
                return if devtools { glib::Propagation::Proceed } else { glib::Propagation::Stop };
            }
            let step = match key {
                gdk::Key::plus | gdk::Key::equal | gdk::Key::KP_Add => "up",
                gdk::Key::minus | gdk::Key::KP_Subtract => "down",
                gdk::Key::_0 | gdk::Key::KP_0 => "reset",
                _ => return glib::Propagation::Proceed,
            };
            if win.showing.get() == Showing::App {
                win.tell(&serde_json::json!({ "scale": step }));
            }
            glib::Propagation::Stop
        });
        win.window.add_controller(keys);
        // The owner's press of a button in the window, seen before the page sees it (clip.rs).
        let press = gtk::GestureClick::new();
        press.set_button(0);
        press.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = Rc::downgrade(&win);
        press.connect_pressed(move |_, _, _, _| {
            if let Some(win) = weak.upgrade() {
                win.gate.borrow_mut().input(Instant::now());
            }
        });
        win.window.add_controller(press);

        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        win.pill_start.connect_clicked(move |_| {
            let Some(win) = weak.upgrade() else { return };
            // The same button, in a window whose page kept stopping: it loads the page again,
            // watched like any other load. With the daemon away it starts Keel, as it says.
            let up = *win.link.borrow() == Link::Up;
            let again = if up { win.rec.borrow_mut().again() } else { None };
            match again {
                Some(watch) => {
                    win.view.reload();
                    win.pill_now();
                    win.expect_word(watch);
                }
                None => a(&win, Ask::Start),
            }
        });

        let (weak, a) = (Rc::downgrade(&win), ask);
        win.window.connect_close_request(move |_| {
            if let Some(win) = weak.upgrade() {
                a(&win, Ask::Close);
            }
            // The application decides: it hides the main window while a tray shows the mark, and closes it otherwise.
            glib::Propagation::Stop
        });
        win
    }

    /// An address the main frame may show: the app's own page (about:blank), or the daemon's origin while its page is up.
    /// (An event of the away page may still come after the daemon's page was asked for: it is the app's own too.)
    fn ours(&self, uri: &str) -> bool {
        uri.is_empty() || uri.starts_with("about:") || (self.showing.get() == Showing::App && links::main_frame_may_show(uri, &self.origin.borrow()))
    }

    /// What the clipboard holds, read by the app and handed to the page that asked: its text,
    /// and a picture as PNG, no larger than the page keeps one. Nothing else of the web view ever
    /// sees it. The picture's bytes are read as they come, and decoded, scaled and encoded off
    /// the main loop: the window goes on answering while a large one is made ready.
    fn paste(self: &Rc<Self>, id: u64, edge: Option<i32>) {
        let clipboard = self.window.clipboard();
        let (win, board) = (self.clone(), clipboard.clone());
        clipboard.read_text_async(gio::Cancellable::NONE, move |text| {
            let text = text.ok().flatten().map(|t| t.to_string());
            // Whether the clipboard says it holds a picture, and in which form it is asked for.
            let offered: Vec<String> = board.formats().mime_types().iter().map(|m| m.to_string()).collect();
            let Some(kind) = crate::clip::picture_format(offered.iter().map(String::as_str)) else {
                return win.tell(&serde_json::json!({ "pasted": { "id": id, "text": text, "images": [] } }));
            };
            let png = kind == "image/png";
            board.read_async(&[kind], glib::Priority::DEFAULT, gio::Cancellable::NONE, move |read| {
                glib::spawn_future_local(async move {
                    let mut made = None;
                    if let Ok((stream, _)) = read {
                        let into = gio::MemoryOutputStream::new_resizable();
                        let all = into.splice_future(&stream, gio::OutputStreamSpliceFlags::CLOSE_SOURCE | gio::OutputStreamSpliceFlags::CLOSE_TARGET, glib::Priority::DEFAULT).await;
                        if all.is_ok() {
                            let bytes = into.steal_as_bytes();
                            made = gio::spawn_blocking(move || picture_within(&bytes, png, edge)).await.ok().flatten();
                        }
                    }
                    // A picture the clipboard offered and that could not be made ready is said, not
                    // passed off as an empty clipboard.
                    match made {
                        Some((out, w, h, from_w, from_h)) => win.tell(&serde_json::json!({ "pasted": { "id": id, "text": text, "failed": false, "from": [from_w, from_h],
                            "images": [{ "type": "image/png", "data": glib::base64_encode(&out).to_string(), "width": w, "height": h }] } })),
                        None => win.tell(&serde_json::json!({ "pasted": { "id": id, "text": text, "images": [], "failed": true } })),
                    }
                });
            });
        });
    }

    fn tell(&self, detail: &Value) {
        let js = format!("window.dispatchEvent(new CustomEvent('keel-shell', {{ detail: {detail} }}))");
        self.view.evaluate_javascript(&js, None, None, gio::Cancellable::NONE, |_| {});
    }

    /// What the rule says next about this window's page (view.rs `Recovery`).
    fn follow(self: &Rc<Self>, next: Step) {
        match next {
            Step::Renew(watch) => {
                self.view.reload();
                self.expect_word(watch);
            }
            Step::Leave => {
                self.pill_now();
                // The page has nothing to say: the keyboard is the button's.
                self.pill_start.grab_focus();
            }
        }
    }

    /// A page loaded again is expected to speak: its own first word to the app. One that has
    /// not within `SPEAKS_WITHIN` is loaded anew, twice at most, then left with the bar's button.
    fn expect_word(self: &Rc<Self>, watch: u32) {
        let me = Rc::downgrade(self);
        glib::timeout_add_local_once(SPEAKS_WITHIN, move || {
            let Some(win) = me.upgrade().filter(|w| w.showing.get() == Showing::App) else { return };
            let next = win.rec.borrow_mut().silent(watch);
            match next {
                Some(Step::Leave) => (win.ask)(&win, Ask::Note("page-silent", json!({ "window": win.id, "left": true }))),
                Some(Step::Renew(_)) => (win.ask)(&win, Ask::Note("page-silent", json!({ "window": win.id, "again": win.rec.borrow().renews() }))),
                None => return,
            }
            win.follow(next.expect("matched above"));
        });
    }

    /// The state beside the controls: the daemon away while its page is up, the page still
    /// coming, or a page that kept stopping.
    fn pill_now(&self) {
        let link = self.link.borrow().clone();
        let over_page = self.showing.get() == Showing::App;
        // A page that kept stopping, while the daemon is up: with the daemon away, the bar says
        // that, and its button starts Keel.
        if over_page && link == Link::Up && self.rec.borrow().stopped() {
            self.pill.set_visible(true);
            self.dot.set_visible(false);
            self.pill.set_tooltip_text(Some("The page stopped several times, or came back and said nothing. Your sessions went on in Keel."));
            self.pill_text.set_label("This page keeps stopping");
            self.pill_start.set_label("Load again");
            self.pill_start.set_visible(true);
            return self.bar_said("This page keeps stopping");
        }
        self.pill_start.set_label("Start");
        let coming = over_page && link == Link::Up && self.loading.get() && self.slow.get();
        let show = over_page && (link != Link::Up || coming);
        self.pill.set_visible(show);
        self.pill_start.set_visible(over_page && link == Link::Down);
        self.dot.set_visible(link == Link::Restarting || coming);
        self.pill.set_tooltip_text(if coming { None } else { Some("What the sessions were doing is not known until Keel is back. Messages you send wait and go out then.") });
        // The daemon's state in the words the tray, the calm page and the page inside say it.
        let text = if coming { "Opening" } else { link.said() };
        self.pill_text.set_label(text);
        self.bar_said(if show { text } else { "" });
    }

    /// What the bar says, for the app's log when it changes (the end-to-end check reads it).
    fn bar_said(&self, text: &str) {
        if *self.bar.borrow() == text {
            return;
        }
        *self.bar.borrow_mut() = text.to_string();
        if let Some(me) = self.me.borrow().upgrade() {
            (self.ask)(&me, Ask::Note("bar", json!({ "window": self.id, "text": text, "start": self.pill_start.is_visible() })));
        }
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
        self.ucm.remove_all_scripts();
        let bridge = page::bridge("webkit", if self.main { "main" } else { "session" }, self.can, POST, &self.key, &at);
        let only = pattern(&at);
        self.ucm.add_script(&webkit::UserScript::new(&bridge, webkit::UserContentInjectedFrames::TopFrame, webkit::UserScriptInjectionTime::Start, &[only.as_str()], &[]));
        if let Some(src) = std::env::var_os("KEEL_DESKTOP_PROBE").and_then(|p| std::fs::read_to_string(p).ok()) {
            // The measurer's script, for this daemon's origin alone as well.
            let src = format!("if (location.origin === {}) {{ {src} }}", Value::String(at.clone()));
            self.ucm.add_script(&webkit::UserScript::new(&src, webkit::UserContentInjectedFrames::TopFrame, webkit::UserScriptInjectionTime::Start, &[only.as_str()], &[]));
        }
        *self.origin.borrow_mut() = at;
        // Which daemon, when it is not the one a bare launch finds.
        self.title.set_label(&match crate::http::authority(base) {
            Ok(host) if base != DEFAULT_URL => format!("Keel  \u{b7}  {host}"),
            _ => "Keel".to_string(),
        });
        self.showing.set(Showing::App);
        self.loading.set(true);
        self.slow.set(false);
        self.view.load_uri(&format!("{base}{}", links::page_path(path).unwrap_or_else(|| "/".into())));
        // A daemon that is slow to answer: after a moment the title bar says the page is coming, instead of an empty window.
        let weak = self.me.borrow().clone();
        glib::timeout_add_local_once(Duration::from_millis(1200), move || {
            if let Some(win) = weak.upgrade() {
                if win.loading.get() {
                    win.slow.set(true);
                    win.pill_now();
                }
            }
        });
    }

    fn go(&self, path: &str, clicked: bool) {
        self.tell(&serde_json::json!({ "open": path, "from": if clicked { "click" } else { "link" } }));
    }

    fn daemon_back(&self) {
        self.tell(&serde_json::json!({ "daemon": "up" }));
    }

    fn daemon_away(&self, link: &Link) {
        self.tell(&serde_json::json!({ "daemon": "away", "says": link.said() }));
    }

    fn away(&self, look: &Look, state: &Away) {
        let js = page::away_state(state);
        *self.away_js.borrow_mut() = js.clone();
        if self.showing.get() == Showing::Away {
            self.view.evaluate_javascript(&js, None, None, gio::Cancellable::NONE, |_| {});
        } else {
            self.ucm.remove_all_scripts();
            self.showing.set(Showing::Away);
            self.loading.set(false);
            self.slow.set(false);
            self.title.set_label("Keel");
            self.view.load_html(&page::away(look, state, POST, &self.key), Some("about:blank"));
        }
    }

    fn link(&self, link: &Link) {
        *self.link.borrow_mut() = link.clone();
        self.pill_now();
    }

    fn look(&self, look: &Look) {
        self.view.set_background_color(&rgba(&look.bg));
    }

    fn present(&self, token: Option<&str>) {
        if let Some(t) = token {
            self.window.set_startup_id(t);
        }
        self.window.set_visible(true);
        self.window.present();
    }

    fn hide(&self) {
        self.window.set_visible(false);
    }

    fn close(&self) {
        self.window.destroy();
    }

    fn size(&self) -> (i32, i32, bool) {
        (self.window.default_width(), self.window.default_height(), self.window.is_maximized())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_style_scales_with_the_text_size() {
        let mut l = Look::of(false);
        assert!(style(&l).contains("min-height: 34px"));
        l.scale = 1.5;
        assert!(style(&l).contains("min-height: 51px"));
        assert!(style(&l).contains(&l.panel));
    }

    #[test]
    fn the_script_pattern_names_the_host_without_its_port() {
        assert_eq!(pattern("http://127.0.0.1:47960"), "http://127.0.0.1/*");
        assert_eq!(pattern("http://localhost:8080"), "http://localhost/*");
        assert_eq!(pattern("http://[::1]:47960"), "http://[::1]/*");
        assert_eq!(pattern("http://keel.localhost"), "http://keel.localhost/*");
    }
}
