//! Native notifications, spoken straight to the desktop's notification
//! service (org.freedesktop.Notifications): one per session, the next
//! replaces it, and a click comes back with the alert it was about and, where
//! the desktop gives one, the token that lets the window come to the front.
//!
//! The daemon hands an alert over only for as long as the app proves it showed
//! it: `shown(ack)` runs once the service returned an id, and never when it
//! did not. Many sessions alerting at once become one notification that says
//! how many, not a column of them.
use gtk::prelude::*;
use gtk::{gio, glib};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
/// More sessions than this alerting together are told as one notification.
pub const SEPARATE: usize = 3;
/// The key of the one notification that stands for many.
const MANY: &str = "\u{1}many";

#[derive(Default)]
struct Shown {
    /// key -> the service's id, to replace and to take down.
    ids: HashMap<String, u32>,
    /// id -> the alert a click on it is about ("" for the one that stands for many: it opens the inbox).
    alerts: HashMap<u32, String>,
    /// id -> the activation token that came with its click.
    tokens: HashMap<u32, String>,
    /// The sessions with an alert up, shown each by itself or together.
    keys: BTreeSet<String>,
    many: bool,
    markup: bool,
}

pub struct Notifier {
    conn: gio::DBusConnection,
    shown: Rc<RefCell<Shown>>,
    on_shown: Rc<dyn Fn((u64, String))>,
}

/// The hints of one notification: whose it is, how urgent, and whether it keeps quiet
/// (the owner turned its sound off in Settings > Alerts).
pub fn hints(app_id: &str, urgent: bool, silent: bool) -> HashMap<String, glib::Variant> {
    let mut h = HashMap::from([("desktop-entry".to_string(), app_id.to_variant()), ("urgency".to_string(), (if urgent { 2u8 } else { 1u8 }).to_variant())]);
    if silent {
        h.insert("suppress-sound".to_string(), true.to_variant());
    }
    h
}

/// The picture a notification carries: the daemon's own file for the session's helper (its face), when it is a
/// picture on this machine's disk, else the app's own icon. Never a name or an address the daemon was handed.
pub fn icon_of(app_id: &str, icon: &str) -> String {
    let p = std::path::Path::new(icon);
    let picture = p.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp"));
    if p.is_absolute() && picture && !icon.contains('\0') && p.is_file() { icon.to_string() } else { app_id.to_string() }
}

/// A body as text for a service that reads markup: what a session wrote stays words.
pub fn plain(body: &str, markup: bool) -> String {
    if markup { body.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;") } else { body.to_string() }
}

/// Whether an alert for `key` is shown by itself or as part of the one that stands for many.
pub fn together(keys: &BTreeSet<String>, many: bool, key: &str) -> bool {
    many || (!keys.contains(key) && keys.len() >= SEPARATE)
}

/// The words of the notification that stands for many.
pub fn many_words(count: usize, latest: &str) -> (String, String) {
    (format!("{count} sessions need you"), format!("Latest: {latest}"))
}

impl Notifier {
    /// `on_click(alert, token)` runs when the owner clicks a notification (an
    /// empty alert: the one for many). `on_shown(ack)` runs when the service
    /// took a notification the daemon wants acknowledged.
    #[allow(deprecated)]
    pub fn new(conn: &gio::DBusConnection, on_click: impl Fn(String, Option<String>) + 'static, on_shown: impl Fn((u64, String)) + 'static) -> Self {
        let shown = Rc::new(RefCell::new(Shown::default()));
        let s = shown.clone();
        conn.signal_subscribe(Some(NAME), Some(NAME), None, Some(PATH), None, gio::DBusSignalFlags::NONE, move |_, _, _, _, signal, params| {
            let Some(id) = params.child_value(0).get::<u32>() else { return };
            match signal {
                // The token comes just before the click it belongs to.
                "ActivationToken" => {
                    if let Some(t) = params.child_value(1).get::<String>() {
                        s.borrow_mut().tokens.insert(id, t);
                    }
                }
                "ActionInvoked" => {
                    let (alert, token) = {
                        let mut sh = s.borrow_mut();
                        (sh.alerts.get(&id).cloned(), sh.tokens.remove(&id))
                    };
                    if let Some(alert) = alert {
                        on_click(alert, token);
                    }
                }
                "NotificationClosed" => {
                    let mut sh = s.borrow_mut();
                    sh.alerts.remove(&id);
                    sh.tokens.remove(&id);
                    let gone: Vec<String> = sh.ids.iter().filter(|(_, v)| **v == id).map(|(k, _)| k.clone()).collect();
                    for k in gone {
                        sh.ids.remove(&k);
                        if k == MANY {
                            sh.keys.clear();
                            sh.many = false;
                        } else {
                            sh.keys.remove(&k);
                        }
                    }
                }
                _ => {}
            }
        });
        // Whether the service reads markup in a body: then what a session wrote is escaped.
        let s = shown.clone();
        conn.call(Some(NAME), PATH, NAME, "GetCapabilities", None, None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE, move |r| {
            if let Some(caps) = r.ok().and_then(|v| v.child_value(0).get::<Vec<String>>()) {
                s.borrow_mut().markup = caps.iter().any(|c| c == "body-markup");
            }
        });
        Self { conn: conn.clone(), shown, on_shown: Rc::new(on_shown) }
    }

    fn send(&self, app_id: &str, slot: &str, alert: &str, title: &str, body: &str, icon: &str, urgent: bool, silent: bool, ack: Option<(u64, String)>) {
        let (replaces, markup) = {
            let sh = self.shown.borrow();
            (sh.ids.get(slot).copied().unwrap_or(0), sh.markup)
        };
        let args = ("Keel", replaces, icon_of(app_id, icon).as_str(), title, plain(body, markup).as_str(), vec!["default", "Open"], hints(app_id, urgent, silent), -1i32).to_variant();
        let (s, slot, alert, on_shown) = (self.shown.clone(), slot.to_string(), alert.to_string(), self.on_shown.clone());
        self.conn.call(Some(NAME), PATH, NAME, "Notify", Some(&args), None, gio::DBusCallFlags::NONE, 5000, gio::Cancellable::NONE, move |r| {
            // Only a notification the service took is acknowledged: with no service, or one that refused, the daemon shows the alert itself.
            if let Some(id) = r.ok().and_then(|v| v.child_value(0).get::<u32>()) {
                {
                    let mut sh = s.borrow_mut();
                    sh.ids.insert(slot, id);
                    sh.alerts.insert(id, alert);
                }
                if let Some(ack) = ack {
                    on_shown(ack);
                }
            }
        });
    }

    pub fn show(&self, app_id: &str, key: &str, alert: &str, title: &str, body: &str, icon: &str, urgent: bool, silent: bool, ack: Option<(u64, String)>) {
        let (as_many, count, singles) = {
            let mut sh = self.shown.borrow_mut();
            let as_many = together(&sh.keys, sh.many, key);
            sh.keys.insert(key.to_string());
            let singles: Vec<u32> = if as_many && !sh.many { sh.ids.iter().filter(|(k, _)| k.as_str() != MANY).map(|(_, id)| *id).collect() } else { Vec::new() };
            if as_many && !sh.many {
                sh.ids.retain(|k, _| k == MANY);
                sh.many = true;
            }
            (as_many, sh.keys.len(), singles)
        };
        if as_many {
            for id in singles {
                self.close(id);
            }
            let (head, line) = many_words(count, title);
            self.send(app_id, MANY, "", &head, &line, "", urgent, silent, ack);
        } else {
            self.send(app_id, key, alert, title, body, icon, urgent, silent, ack);
        }
    }

    pub fn withdraw(&self, key: &str) {
        let (close, left) = {
            let mut sh = self.shown.borrow_mut();
            sh.keys.remove(key);
            if sh.many {
                if sh.keys.is_empty() {
                    sh.many = false;
                    (sh.ids.remove(MANY), 0)
                } else {
                    (None, sh.keys.len())
                }
            } else {
                (sh.ids.remove(key), 0)
            }
        };
        if let Some(id) = close {
            self.shown.borrow_mut().alerts.remove(&id);
            self.close(id);
        } else if left > 0 {
            let (head, _) = many_words(left, "");
            self.send(crate::APP_ID, MANY, "", &head, "", "", false, false, None);
        }
    }

    /// Takes down every notification the app showed: after it quits nothing would answer their click.
    pub fn withdraw_all(&self) {
        let ids: Vec<u32> = {
            let mut sh = self.shown.borrow_mut();
            sh.keys.clear();
            sh.many = false;
            sh.ids.drain().map(|(_, id)| id).collect()
        };
        for id in ids {
            self.close(id);
        }
    }

    fn close(&self, id: u32) {
        self.conn.call(Some(NAME), PATH, NAME, "CloseNotification", Some(&(id,).to_variant()), None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE, |_| {});
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notification_names_its_app_and_urgency() {
        let h = hints("io.example.App", true, false);
        assert_eq!(h["desktop-entry"].get::<String>().as_deref(), Some("io.example.App"));
        assert_eq!(h["urgency"].get::<u8>(), Some(2));
        assert_eq!(hints("io.example.App", false, false)["urgency"].get::<u8>(), Some(1));
        // Sound is the service's own unless the owner turned it off.
        assert!(!h.contains_key("suppress-sound"));
        assert_eq!(hints("io.example.App", false, true)["suppress-sound"].get::<bool>(), Some(true));
    }

    #[test]
    fn the_icon_is_the_daemons_picture_on_this_disk_else_the_apps_own() {
        let dir = std::env::temp_dir().join(format!("keel-icon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let face = dir.join("avatar.png");
        std::fs::write(&face, b"png").unwrap();
        let text = dir.join("note.txt");
        std::fs::write(&text, b"x").unwrap();
        let app = "io.example.App";
        assert_eq!(icon_of(app, face.to_str().unwrap()), face.to_str().unwrap());
        // No picture, no such file, a relative path, a file that is no picture, an address: the app's own icon.
        assert_eq!(icon_of(app, ""), app);
        assert_eq!(icon_of(app, dir.join("none.png").to_str().unwrap()), app);
        assert_eq!(icon_of(app, "avatar.png"), app);
        assert_eq!(icon_of(app, text.to_str().unwrap()), app);
        assert_eq!(icon_of(app, "https://example.com/a.png"), app);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_call_has_the_services_signature() {
        let args = ("Keel", 0u32, "io.example.App", "t", "b", vec!["default", "Open"], hints("io.example.App", false, false), -1i32).to_variant();
        assert_eq!(args.type_().as_str(), "(susssasa{sv}i)");
    }

    #[test]
    fn what_a_session_wrote_is_never_markup() {
        assert_eq!(plain("<b>rm -rf</b> & more", true), "&lt;b&gt;rm -rf&lt;/b&gt; &amp; more");
        assert_eq!(plain("<b>rm -rf</b> & more", false), "<b>rm -rf</b> & more");
    }

    // The review's case: forty sessions alerting at once gave forty notifications.
    #[test]
    fn many_sessions_alerting_together_are_one_notification() {
        let mut keys = BTreeSet::new();
        let mut separate = 0;
        let mut many = false;
        for n in 0..40 {
            let key = format!("s{n}");
            if together(&keys, many, &key) { many = true } else { separate += 1 }
            keys.insert(key);
        }
        assert_eq!(separate, SEPARATE);
        assert!(many);
        // A session that already has its own notification replaces it, however many others there are.
        let three: BTreeSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert!(!together(&three, false, "a"));
        assert!(together(&three, false, "d"));
        assert_eq!(many_words(40, "Approve Bash").0, "40 sessions need you");
    }
}
