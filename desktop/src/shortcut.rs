//! Global shortcuts: keys that reach the app while another window has the
//! keyboard, through the desktop portal (org.freedesktop.portal.GlobalShortcuts),
//! the only way an app gets one under Wayland. The app names what it wants (show
//! the window, start a session); the desktop asks the owner once, in a dialog
//! of its own, and the keys are the owner's to choose there. A desktop without
//! the portal has none: there the owner binds a key of the desktop's own to
//! `keel-desktop` (and to `keel-desktop --new`), which reach the running app.
use gtk::prelude::*;
use gtk::{gio, glib};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";

/// What the app asks for: the id the desktop says back, what the desktop's
/// dialog calls it, and the keys it proposes (the owner's choice there wins).
pub const WANTED: [(&str, &str, &str); 2] = [("summon", "Show Keel", "CTRL+ALT+K"), ("new-session", "New Session", "CTRL+ALT+N")];

/// What the owner can do about the shortcuts now.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Keys {
    /// The desktop has no global shortcuts for apps.
    None,
    /// It has, and the app holds none: they can be asked for.
    Offer,
    /// The app holds its shortcuts, and the desktop can show them to be changed.
    Change,
    /// The app holds its shortcuts; this desktop changes them in its own settings only.
    Held,
}

/// What follows from the portal's version and whether the shortcuts are held.
pub fn keys(version: u32, held: bool) -> Keys {
    match (version, held) {
        (0, _) => Keys::None,
        (_, false) => Keys::Offer,
        // (The desktop's own dialog for an app's shortcuts came with the interface's second version.)
        (v, true) if v >= 2 => Keys::Change,
        _ => Keys::Held,
    }
}

/// The desktop's answer to the app's asking for its shortcuts.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    /// Held: each shortcut's id and its keys as the desktop words them.
    Held(Vec<(String, String)>),
    /// The owner said no in the desktop's dialog.
    No,
    /// The desktop could not do it (its answer said so, or no session was made): not the owner's word.
    Failed,
}

/// The answer to a request, from its code (0: done, 1: the owner said no, anything else: it could not be done).
pub fn answer(code: u32, results: &glib::Variant) -> Answer {
    match code {
        0 => Answer::Held(bound(results)),
        1 => Answer::No,
        _ => Answer::Failed,
    }
}

/// Whether the app asks again at its next start: after a yes, not after a no, and as it was
/// when the desktop only failed.
pub fn remembered(before: bool, a: &Answer) -> bool {
    match a {
        Answer::Held(_) => true,
        Answer::No => false,
        Answer::Failed => before,
    }
}

/// Whether the page offers its command for the shortcuts: where the desktop can also show
/// them to be changed (the interface's second version), so the command always does something.
/// On an older portal the tray's item asks, once.
pub fn page_may_ask(version: u32) -> bool {
    version >= 2
}

fn options(pairs: &[(&str, glib::Variant)]) -> HashMap<String, glib::Variant> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// The path of the request a call answers on: the portal derives it from the caller's name and the token.
fn request_path(unique: &str, token: &str) -> String {
    format!("/org/freedesktop/portal/desktop/request/{}/{token}", unique.trim_start_matches(':').replace('.', "_"))
}

/// A shortcut the desktop says was pressed: its id, and the token that lets a window take the focus when the desktop gave one.
pub fn pressed(params: &glib::Variant) -> Option<(String, Option<String>)> {
    if params.n_children() < 4 {
        return None;
    }
    let id = params.child_value(1).get::<String>()?;
    let token = glib::VariantDict::new(Some(&params.child_value(3))).lookup_value("activation_token", None).and_then(|v| v.get::<String>()).filter(|t| !t.is_empty());
    WANTED.iter().any(|(w, _, _)| *w == id).then_some((id, token))
}

/// The keys the desktop bound, as it words them ("Ctrl+Alt+K"), from the answer to a bind.
pub fn bound(results: &glib::Variant) -> Vec<(String, String)> {
    let Some(list) = glib::VariantDict::new(Some(results)).lookup_value("shortcuts", None) else { return Vec::new() };
    (0..list.n_children())
        .filter_map(|i| {
            let one = list.child_value(i);
            let id = one.child_value(0).get::<String>()?;
            let keys = glib::VariantDict::new(Some(&one.child_value(1))).lookup_value("trigger_description", None).and_then(|v| v.get::<String>()).unwrap_or_default();
            Some((id, keys))
        })
        .collect()
}

pub struct Shortcuts {
    conn: gio::DBusConnection,
    version: u32,
    /// The portal's session that holds the app's shortcuts, once they are bound.
    session: RefCell<Option<String>>,
    /// A bind is on its way: the desktop may be showing its dialog.
    asking: Cell<bool>,
    /// Each request and session of a connection needs a token of its own.
    count: Cell<u32>,
}

impl Shortcuts {
    /// Reads whether the desktop has global shortcuts, and listens for a press. It starts no
    /// portal that is not running, and waits a fifth of a second at most: the first window
    /// tells its page what this app can do.
    pub fn new(conn: &gio::DBusConnection, app_id: &str, on_press: impl Fn(&str, Option<String>) + 'static) -> Rc<Self> {
        // A connection of the app's own for the portal. The desktop keeps shortcuts per app, and
        // an app says who it is in its first word to the portal on a connection (a program
        // started outside the desktop's launcher has no name otherwise); on the connection the
        // toolkit shares, the toolkit may have spoken to the portal already, and the name
        // would be refused. (Without a connection of its own the shared one is used.)
        let own = gio::dbus_address_get_for_bus_sync(gio::BusType::Session, gio::Cancellable::NONE).ok().and_then(|address| {
            let flags = gio::DBusConnectionFlags::AUTHENTICATION_CLIENT | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION;
            gio::DBusConnection::for_address_sync(&address, flags, None, gio::Cancellable::NONE).ok()
        });
        if let Some(c) = &own {
            c.set_exit_on_close(false);
        }
        let conn = &own.unwrap_or_else(|| conn.clone());
        let _ = conn.call_sync(Some(PORTAL), PATH, "org.freedesktop.host.portal.Registry", "Register", Some(&(app_id, options(&[])).to_variant()), None, gio::DBusCallFlags::NO_AUTO_START, 200, gio::Cancellable::NONE);
        let version = conn
            .call_sync(Some(PORTAL), PATH, "org.freedesktop.DBus.Properties", "Get", Some(&(IFACE, "version").to_variant()), None, gio::DBusCallFlags::NO_AUTO_START, 200, gio::Cancellable::NONE)
            .ok()
            .and_then(|r| r.child_value(0).as_variant())
            .and_then(|v| v.get::<u32>())
            .unwrap_or(0);
        if version > 0 {
            #[allow(deprecated)]
            conn.signal_subscribe(Some(PORTAL), Some(IFACE), Some("Activated"), Some(PATH), None, gio::DBusSignalFlags::NONE, move |_, _, _, _, _, params| {
                if let Some((id, token)) = pressed(params) {
                    on_press(&id, token);
                }
            });
        }
        Rc::new(Self { conn: conn.clone(), version, session: RefCell::new(None), asking: Cell::new(false), count: Cell::new(0) })
    }

    pub fn keys(&self) -> Keys {
        keys(self.version, self.session.borrow().is_some())
    }

    pub fn page_may_ask(&self) -> bool {
        page_may_ask(self.version)
    }

    fn token(&self, what: &str) -> String {
        self.count.set(self.count.get() + 1);
        format!("keel_{what}{}", self.count.get())
    }

    /// One call of the portal that answers on a request: `done` gets the answer's code (0: done,
    /// 1: the owner said no, 2: it could not be done) and its results.
    #[allow(deprecated)]
    fn request(self: &Rc<Self>, method: &'static str, token: &str, args: glib::Variant, done: impl Fn(u32, glib::Variant) + 'static) {
        let unique = self.conn.unique_name().map(|n| n.to_string()).unwrap_or_default();
        let sub = Rc::new(Cell::new(None));
        let (s2, c2) = (sub.clone(), self.conn.clone());
        let id = self.conn.signal_subscribe(Some(PORTAL), Some("org.freedesktop.portal.Request"), Some("Response"), Some(&request_path(&unique, token)), None, gio::DBusSignalFlags::NONE, move |_, _, _, _, _, params| {
            if let Some(id) = s2.take() {
                c2.signal_unsubscribe(id);
            }
            done(params.child_value(0).get::<u32>().unwrap_or(2), params.child_value(1));
        });
        sub.set(Some(id));
        let (s3, c3, me) = (sub, self.conn.clone(), self.clone());
        self.conn.call(Some(PORTAL), PATH, IFACE, method, Some(&args), None, gio::DBusCallFlags::NONE, -1, gio::Cancellable::NONE, move |r| {
            // A call the portal refused answers on no request.
            if let Err(e) = r {
                if let Some(id) = s3.take() {
                    c3.signal_unsubscribe(id);
                }
                me.asking.set(false);
                eprintln!("keel-desktop: the desktop refused {method}: {e}");
            }
        });
    }

    /// Asks the desktop for the app's shortcuts: a session, then the bind, which the desktop
    /// answers at once when the owner agreed to them before and with a dialog of its own when
    /// not. `done` hears whether they are held now, and the keys.
    pub fn bind(self: &Rc<Self>, done: impl Fn(Answer) + 'static) {
        if self.version == 0 || self.session.borrow().is_some() || self.asking.replace(true) {
            return;
        }
        let (me, done) = (self.clone(), Rc::new(done));
        let (request, session) = (self.token("session"), self.token("keys"));
        let create = (options(&[("handle_token", request.to_variant()), ("session_handle_token", session.to_variant())]),).to_variant();
        self.request("CreateSession", &request, create, move |code, results| {
            let handle = glib::VariantDict::new(Some(&results)).lookup_value("session_handle", None).and_then(|v| v.get::<String>());
            let Some(path) = handle.as_deref().filter(|_| code == 0).and_then(|h| glib::variant::ObjectPath::try_from(h.to_string()).ok()) else {
                me.asking.set(false);
                // No session: the owner was asked nothing.
                return done(Answer::Failed);
            };
            let wanted: Vec<(&str, HashMap<String, glib::Variant>)> = WANTED.iter().map(|(id, says, keys)| (*id, options(&[("description", says.to_variant()), ("preferred_trigger", keys.to_variant())]))).collect();
            let token = me.token("bind");
            let args = (path, wanted, "", options(&[("handle_token", token.to_variant())])).to_variant();
            let (me2, done2, handle) = (me.clone(), done.clone(), handle.unwrap_or_default());
            me.request("BindShortcuts", &token, args, move |code, results| {
                me2.asking.set(false);
                if code == 0 {
                    me2.session.replace(Some(handle.clone()));
                }
                done2(answer(code, &results));
            });
        });
    }

    /// Has the desktop show the app's shortcuts, to be changed there.
    pub fn change(&self) {
        let Some(path) = self.session.borrow().as_deref().and_then(|h| glib::variant::ObjectPath::try_from(h.to_string()).ok()) else { return };
        if self.keys() != Keys::Change {
            return;
        }
        let args = (path, "", options(&[])).to_variant();
        self.conn.call(Some(PORTAL), PATH, IFACE, "ConfigureShortcuts", Some(&args), None, gio::DBusCallFlags::NONE, -1, gio::Cancellable::NONE, |r| {
            if let Err(e) = r {
                eprintln!("keel-desktop: the desktop did not show the shortcuts: {e}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_calls_have_the_portals_signatures() {
        let create = (options(&[("handle_token", "t".to_variant())]),).to_variant();
        assert_eq!(create.type_().as_str(), "(a{sv})");
        let handle = glib::variant::ObjectPath::try_from("/a/b").unwrap();
        let wanted: Vec<(&str, HashMap<String, glib::Variant>)> = WANTED.iter().map(|(id, says, _)| (*id, options(&[("description", says.to_variant())]))).collect();
        let bind = (handle.clone(), wanted, "", options(&[])).to_variant();
        assert_eq!(bind.type_().as_str(), "(oa(sa{sv})sa{sv})");
        assert_eq!((handle, "", options(&[])).to_variant().type_().as_str(), "(osa{sv})");
        assert_eq!(request_path(":1.42", "keel_bind3"), "/org/freedesktop/portal/desktop/request/1_42/keel_bind3");
        assert_eq!(("io.github.agent_sh.Keel", options(&[])).to_variant().type_().as_str(), "(sa{sv})");
    }

    #[test]
    fn only_the_owners_word_changes_what_is_remembered() {
        let none = options(&[]).to_variant();
        assert_eq!(answer(0, &none), Answer::Held(Vec::new()));
        assert_eq!(answer(1, &none), Answer::No);
        assert_eq!(answer(2, &none), Answer::Failed);
        assert!(remembered(false, &Answer::Held(Vec::new())));
        assert!(!remembered(true, &Answer::No));
        // The desktop failed: what the owner said before stands.
        assert!(remembered(true, &Answer::Failed));
        assert!(!remembered(false, &Answer::Failed));
    }

    #[test]
    fn the_page_offers_its_command_where_it_always_does_something() {
        assert!(!page_may_ask(0) && !page_may_ask(1));
        assert!(page_may_ask(2) && page_may_ask(3));
    }

    #[test]
    fn what_the_owner_can_do_follows_the_desktop() {
        assert_eq!(keys(0, false), Keys::None);
        assert_eq!(keys(0, true), Keys::None);
        assert_eq!(keys(1, false), Keys::Offer);
        assert_eq!(keys(2, false), Keys::Offer);
        assert_eq!(keys(1, true), Keys::Held);
        assert_eq!(keys(2, true), Keys::Change);
    }

    #[test]
    fn a_press_is_one_of_the_apps_own_shortcuts() {
        let session = glib::variant::ObjectPath::try_from("/s/1").unwrap();
        let press = |id: &str, opts: &[(&str, glib::Variant)]| (session.clone(), id, 7u64, options(opts)).to_variant();
        assert_eq!(pressed(&press("summon", &[])), Some(("summon".into(), None)));
        assert_eq!(pressed(&press("new-session", &[("activation_token", "tok".to_variant())])), Some(("new-session".into(), Some("tok".into()))));
        assert_eq!(pressed(&press("summon", &[("activation_token", "".to_variant())])), Some(("summon".into(), None)));
        // One the app never asked for, and a signal of another shape, do nothing.
        assert_eq!(pressed(&press("quit", &[])), None);
        assert_eq!(pressed(&("summon",).to_variant()), None);
    }

    #[test]
    fn the_bound_keys_are_read_from_the_answer() {
        let one = |id: &str, keys: &str| (id.to_string(), options(&[("trigger_description", keys.to_variant())]));
        let results = options(&[("shortcuts", vec![one("summon", "Ctrl+Alt+K"), one("new-session", "")].to_variant())]).to_variant();
        assert_eq!(bound(&results), [("summon".to_string(), "Ctrl+Alt+K".to_string()), ("new-session".to_string(), String::new())]);
        assert!(bound(&options(&[]).to_variant()).is_empty());
    }
}
