//! A window of the shell: the page in a web view under a title bar the shell
//! owns. The title bar is the platform's (drag, double click, the window menu
//! and the controls the desktop is set to show) in the page's colors.
use crate::daemon::Link;
use crate::links;
use crate::page;
use crate::prefs::Look;
use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use webkit::prelude::*;

/// What a window asks of the application.
#[derive(Debug)]
pub enum Ask {
    Start,
    External(String),
    Window(String),
    Look(Look),
    Zoom(f64),
    /// The owner closed the window.
    Close,
    /// A load of the page failed: the daemon went away under it.
    Lost,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Showing {
    Nothing,
    App,
    Away,
}

pub struct Win {
    pub window: gtk::ApplicationWindow,
    pub view: webkit::WebView,
    pub main: bool,
    pub showing: Cell<Showing>,
    /// The path to open once the daemon answers.
    pub wanted: RefCell<String>,
    pill: gtk::Box,
    pill_text: gtk::Label,
    pill_start: gtk::Button,
    dot: gtk::Box,
}

fn rgba(hex: &str) -> gdk::RGBA {
    gdk::RGBA::parse(hex).unwrap_or(gdk::RGBA::WHITE)
}

impl Win {
    #[allow(clippy::too_many_arguments)]
    pub fn new(app: &gtk::Application, session: &webkit::NetworkSession, main: bool, size: (i32, i32), maximized: bool, zoom: f64, look: &Look, tray: bool, devtools: bool, ask: Rc<dyn Fn(&Rc<Win>, Ask)>) -> Rc<Self> {
        let ucm = webkit::UserContentManager::new();
        ucm.add_script(&webkit::UserScript::new(&page::bridge(if main { "main" } else { "session" }, tray), webkit::UserContentInjectedFrames::TopFrame, webkit::UserScriptInjectionTime::Start, &[], &[]));
        ucm.register_script_message_handler("keel", None);
        // For measuring the page inside the shell: a script of the measurer's, whose reports go to standard output.
        if let Some(src) = std::env::var_os("KEEL_DESKTOP_PROBE").and_then(|p| std::fs::read_to_string(p).ok()) {
            ucm.add_script(&webkit::UserScript::new(&src, webkit::UserContentInjectedFrames::TopFrame, webkit::UserScriptInjectionTime::Start, &[], &[]));
            ucm.register_script_message_handler("probe", None);
            ucm.connect_script_message_received(Some("probe"), |_, value| println!("PROBE {}", value.to_str()));
        }

        let settings = webkit::Settings::new();
        settings.set_enable_developer_extras(devtools);
        settings.set_enable_write_console_messages_to_stdout(devtools);
        settings.set_javascript_can_access_clipboard(true);
        settings.set_enable_back_forward_navigation_gestures(false);
        settings.set_user_agent_with_application_details(Some("Keel"), Some(env!("CARGO_PKG_VERSION")));

        let view = webkit::WebView::builder().network_session(session).user_content_manager(&ucm).settings(&settings).hexpand(true).vexpand(true).build();
        view.set_background_color(&rgba(&look.bg));
        view.set_zoom_level(zoom);

        // The title bar: the page's title in the middle, the daemon's state and the controls at the end.
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

        let win = Rc::new(Self { window, view, main, showing: Cell::new(Showing::Nothing), wanted: RefCell::new("/".into()), pill, pill_text, pill_start, dot });

        // The page's title is the window's.
        let (w, t) = (win.window.clone(), title.clone());
        win.view.connect_title_notify(move |v| {
            let s = v.title().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Keel".into());
            t.set_label(&s);
            w.set_title(Some(&s));
        });

        // What the page says to the shell.
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        ucm.connect_script_message_received(Some("keel"), move |_, value| {
            let Some(win) = weak.upgrade() else { return };
            let Ok(m) = serde_json::from_str::<Value>(&value.to_str()) else { return };
            let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            match m.get("t").and_then(Value::as_str) {
                Some("start") => a(&win, Ask::Start),
                Some("external") => a(&win, Ask::External(s("url"))),
                Some("window") => a(&win, Ask::Window(s("path"))),
                Some("look") => {
                    let base = Look::of(m.get("dark").and_then(Value::as_bool).unwrap_or(false));
                    let color = |k: &str, or: &str| m.get(k).and_then(Value::as_str).and_then(crate::prefs::hex).unwrap_or(or).to_string();
                    a(&win, Ask::Look(Look {
                        dark: base.dark,
                        bg: color("bg", &base.bg),
                        panel: color("panel", &base.panel),
                        fg: color("fg", &base.fg),
                        muted: color("muted", &base.muted),
                        line: color("line", &base.line),
                        need: color("need", &base.need),
                        scale: m.get("scale").and_then(Value::as_f64).filter(|s| (0.5..=3.0).contains(s)).unwrap_or(1.0),
                    }));
                }
                _ => {}
            }
        });

        // A link out of the page goes to the owner's browser; a page of Keel asked for in a new window gets a window of the shell.
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        win.view.connect_decide_policy(move |view, decision, kind| {
            let Some(win) = weak.upgrade() else { return false };
            let Some(d) = decision.downcast_ref::<webkit::NavigationPolicyDecision>() else { return false };
            let Some(action) = d.navigation_action() else { return false };
            let uri = action.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
            let here = view.uri().map(|u| u.to_string()).unwrap_or_default();
            let origin = |u: &str| u.split('/').take(3).collect::<Vec<_>>().join("/");
            let inside = uri.starts_with("about:") || uri.starts_with("blob:") || uri.starts_with("data:") || (win.showing.get() == Showing::App && origin(&uri) == origin(&here));
            let new_window = kind == webkit::PolicyDecisionType::NewWindowAction;
            if new_window {
                decision.ignore();
                if inside {
                    let path = uri.strip_prefix(&origin(&here)).unwrap_or("/").to_string();
                    a(&win, Ask::Window(path));
                } else {
                    a(&win, Ask::External(uri));
                }
                return true;
            }
            if !inside && action.navigation_type() == webkit::NavigationType::LinkClicked {
                decision.ignore();
                a(&win, Ask::External(uri));
                return true;
            }
            false
        });

        // The page asks for nothing the shell does for it; the rest is refused quietly.
        win.view.connect_permission_request(|_, req| {
            if req.is::<webkit::ClipboardPermissionRequest>() {
                req.allow();
            } else {
                req.deny();
            }
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
        win.view.connect_load_failed(move |_, _, _, _| {
            if let Some(win) = weak.upgrade() {
                if win.showing.get() == Showing::App {
                    win.showing.set(Showing::Nothing);
                    a(&win, Ask::Lost);
                }
            }
            true
        });
        let weak = Rc::downgrade(&win);
        win.view.connect_web_process_terminated(move |v, _| {
            if weak.upgrade().is_some_and(|w| w.showing.get() == Showing::App) {
                v.reload();
            }
        });

        // Zoom with the keys every desktop app uses; the page's own keys are untouched.
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        keys.connect_key_pressed(move |_, key, _, mods| {
            let Some(win) = weak.upgrade() else { return glib::Propagation::Proceed };
            if !mods.contains(gdk::ModifierType::CONTROL_MASK) || mods.contains(gdk::ModifierType::ALT_MASK) {
                return glib::Propagation::Proceed;
            }
            let z = win.view.zoom_level();
            let next = match key {
                gdk::Key::plus | gdk::Key::equal | gdk::Key::KP_Add => z + 0.1,
                gdk::Key::minus | gdk::Key::KP_Subtract => z - 0.1,
                gdk::Key::_0 | gdk::Key::KP_0 => 1.0,
                _ => return glib::Propagation::Proceed,
            };
            let next = crate::prefs::clamp_zoom((next * 10.0).round() / 10.0);
            win.view.set_zoom_level(next);
            a(&win, Ask::Zoom(next));
            glib::Propagation::Stop
        });
        win.window.add_controller(keys);

        let (weak, a) = (Rc::downgrade(&win), ask.clone());
        win.pill_start.connect_clicked(move |_| {
            if let Some(win) = weak.upgrade() {
                a(&win, Ask::Start);
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

    /// Loads the page at a path.
    pub fn load(&self, base: &str, path: &str) {
        self.showing.set(Showing::App);
        self.view.load_uri(&format!("{base}{}", links::page_path(path).unwrap_or_else(|| "/".into())));
    }

    /// Tells the loaded page to go to a path, without a reload.
    pub fn go(&self, path: &str) {
        self.tell(&serde_json::json!({ "open": path }));
    }

    pub fn tell(&self, detail: &Value) {
        let js = format!("window.dispatchEvent(new CustomEvent('keel-shell', {{ detail: {detail} }}))");
        self.view.evaluate_javascript(&js, None, None, gio::Cancellable::NONE, |_| {});
    }

    /// The calm page for a daemon that is away. A page already showing it changes its words in place.
    pub fn away(&self, look: &Look, link: &Link, starting: bool, url: &str, note: &str) {
        if self.showing.get() == Showing::Away {
            self.view.evaluate_javascript(&page::away_state(link, starting, url, note), None, None, gio::Cancellable::NONE, |_| {});
        } else {
            self.showing.set(Showing::Away);
            self.view.load_html(&page::away(look, link, starting, url, note), Some("about:blank"));
        }
    }

    /// The daemon's state beside the controls, shown only while the page is up without its daemon.
    pub fn link(&self, link: &Link) {
        let over_page = self.showing.get() == Showing::App;
        self.pill.set_visible(over_page && *link != Link::Up);
        self.pill_start.set_visible(over_page && *link == Link::Down);
        self.dot.set_visible(*link == Link::Restarting);
        self.pill.set_tooltip_text(Some("What the sessions were doing is not known until Keel is back. Messages you send wait and go out then."));
        self.pill_text.set_label(match link {
            Link::Restarting => "Reconnecting",
            Link::Down => "Keel is not running",
            Link::Up => "",
        });
    }

    pub fn look(&self, look: &Look) {
        self.view.set_background_color(&rgba(&look.bg));
    }

    /// Raises the window. With the desktop's activation token of the request (a
    /// notification's click, a launch from the dock) it takes the focus; without
    /// one the desktop decides, and may only mark the window as wanting attention.
    pub fn present(&self, token: Option<&str>) {
        if let Some(t) = token {
            self.window.set_startup_id(t);
        }
        self.window.set_visible(true);
        self.window.present();
    }

    pub fn size(&self) -> (i32, i32, bool) {
        (self.window.default_width(), self.window.default_height(), self.window.is_maximized())
    }
}
