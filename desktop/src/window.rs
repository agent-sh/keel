//! The engine side of the seam (view.rs) on GTK 4 and WebKitGTK 6: a window
//! with the page in a web view under a title bar the app owns. The title bar
//! is the platform's (drag, double click, the window menu and the controls
//! the desktop is set to show) in the page's colors.
use crate::daemon::Link;
use crate::links;
use crate::page;
use crate::prefs::Look;
use crate::view::{Ask, Asked, Engine, Opening, Showing, View};
use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use webkit::prelude::*;

/// How a page of this engine posts the string `s` to the app.
const POST: &str = "window.webkit.messageHandlers.keel.postMessage(s)";

/// The style of the shell's own widgets, in the page's colors. Every color is
/// a checked hex value (prefs::hex), so nothing a page says can add a rule.
fn style(l: &Look) -> String {
    let px = |n: f64| format!("{:.0}px", (n * l.scale).round());
    format!(
        r#"
window.keel {{ background: {bg}; }}
window.keel .titlebar {{ min-height: 0; padding: 0; margin: 0; border: none; background: transparent; box-shadow: none; }}
.keel-bar {{ background: {panel}; color: {muted}; min-height: {h}; padding: 0 {pad}; border-bottom: 1px solid {line}; box-shadow: none; }}
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
"#,
        bg = l.bg, panel = l.panel, fg = l.fg, muted = l.muted, line = l.line, need = l.need,
        h = px(34.0), pad = px(6.0), font = px(13.0), small = px(12.0), btn = px(26.0), radius = px(7.0), icon = px(16.0),
        gap = px(4.0), dot = px(6.0), pill_y = px(2.0), pill_x = px(10.0), start_y = px(3.0),
    )
}

/// GTK 4 and the system web view.
pub struct WebKit {
    app: gtk::Application,
    session: webkit::NetworkSession,
    css: gtk::CssProvider,
    next: Cell<u32>,
}

impl WebKit {
    /// `dir` holds the page's own storage; `on_download(path)` is told where a file the page offered was saved.
    pub fn new(app: &gtk::Application, dir: &std::path::Path, on_download: impl Fn(&std::path::Path) + 'static) -> Self {
        let css = gtk::CssProvider::new();
        if let Some(d) = gdk::Display::default() {
            gtk::style_context_add_provider_for_display(&d, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        }
        let session = webkit::NetworkSession::new(dir.join("web").to_str(), dir.join("web-cache").to_str());
        // A file the page offers is saved where the owner's downloads go, under the name it suggests.
        let on_download = Rc::new(on_download);
        session.connect_download_started(move |_, download| {
            let on_download = on_download.clone();
            download.connect_decide_destination(move |d, suggested| {
                let folder = glib::user_special_dir(glib::UserDirectory::Downloads).unwrap_or_else(glib::home_dir);
                let path = crate::links::free_name(&folder, suggested, |p| p.exists());
                d.set_destination(&path.to_string_lossy());
                on_download(&path);
                true
            });
        });
        Self { app: app.clone(), session, css, next: Cell::new(1) }
    }
}

impl Engine for WebKit {
    fn name(&self) -> &'static str {
        "webkit"
    }

    fn open(&self, opening: Opening, ask: Asked) -> Rc<dyn View> {
        let id = self.next.replace(self.next.get() + 1);
        Win::new(&self.app, &self.session, id, opening, ask)
    }

    fn look(&self, look: &Look) {
        self.css.load_from_string(&style(look));
        if let Some(s) = gtk::Settings::default() {
            s.set_gtk_application_prefer_dark_theme(look.dark);
        }
    }
}

struct Win {
    id: u32,
    window: gtk::ApplicationWindow,
    view: webkit::WebView,
    main: bool,
    showing: Cell<Showing>,
    /// The path to open once the daemon answers.
    wanted: RefCell<String>,
    pill: gtk::Box,
    pill_text: gtk::Label,
    pill_start: gtk::Button,
    dot: gtk::Box,
}

fn rgba(hex: &str) -> gdk::RGBA {
    gdk::RGBA::parse(hex).unwrap_or(gdk::RGBA::WHITE)
}

impl Win {
    fn new(app: &gtk::Application, session: &webkit::NetworkSession, id: u32, opening: Opening, ask: Asked) -> Rc<dyn View> {
        let Opening { main, size, maximized, zoom, look, tray, devtools } = opening;
        // What a closure of the window asks goes out as the view it is.
        let ask: Rc<dyn Fn(&Rc<Win>, Ask)> = Rc::new(move |win, what| {
            let view: Rc<dyn View> = win.clone();
            ask(&view, what)
        });
        let ucm = webkit::UserContentManager::new();
        ucm.add_script(&webkit::UserScript::new(&page::bridge("webkit", if main { "main" } else { "session" }, tray, POST), webkit::UserContentInjectedFrames::TopFrame, webkit::UserScriptInjectionTime::Start, &[], &[]));
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

        let win = Rc::new(Self { id, window, view, main, showing: Cell::new(Showing::Nothing), wanted: RefCell::new("/".into()), pill, pill_text, pill_start, dot });

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
                // A place of the page gets a window of the app. Anything else the daemon serves
                // (a file to look at, an export) has no place in the app: the browser shows it.
                match uri.strip_prefix(&origin(&here)).filter(|_| inside).and_then(links::page_path) {
                    Some(path) => a(&win, Ask::Window(path)),
                    None => a(&win, Ask::External(uri)),
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

    fn tell(&self, detail: &Value) {
        let js = format!("window.dispatchEvent(new CustomEvent('keel-shell', {{ detail: {detail} }}))");
        self.view.evaluate_javascript(&js, None, None, gio::Cancellable::NONE, |_| {});
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
        self.showing.set(Showing::App);
        self.view.load_uri(&format!("{base}{}", links::page_path(path).unwrap_or_else(|| "/".into())));
    }

    fn go(&self, path: &str) {
        self.tell(&serde_json::json!({ "open": path }));
    }

    fn daemon_back(&self) {
        self.tell(&serde_json::json!({ "daemon": "up" }));
    }

    fn away(&self, look: &Look, link: &Link, starting: bool, url: &str, note: &str) {
        if self.showing.get() == Showing::Away {
            self.view.evaluate_javascript(&page::away_state(link, starting, url, note), None, None, gio::Cancellable::NONE, |_| {});
        } else {
            self.showing.set(Showing::Away);
            self.view.load_html(&page::away(look, link, starting, url, note, POST), Some("about:blank"));
        }
    }

    fn link(&self, link: &Link) {
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

    fn look(&self, look: &Look) {
        self.view.set_background_color(&rgba(&look.bg));
    }

    fn zoom(&self, zoom: f64) {
        self.view.set_zoom_level(zoom);
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
}
