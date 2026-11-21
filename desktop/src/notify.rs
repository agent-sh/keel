//! Native notifications, spoken straight to the desktop's notification
//! service (org.freedesktop.Notifications): one per key, the next replaces
//! it, and a click comes back with the alert it was about and, where the
//! desktop gives one, the token that lets the window come to the front.
use gtk::prelude::*;
use gtk::{gio, glib};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

#[derive(Default)]
struct Shown {
    /// key -> the service's id, to replace and to take down.
    ids: HashMap<String, u32>,
    /// id -> the alert a click on it is about.
    alerts: HashMap<u32, String>,
    /// id -> the activation token that came with its click.
    tokens: HashMap<u32, String>,
}

pub struct Notifier {
    conn: gio::DBusConnection,
    shown: Rc<RefCell<Shown>>,
}

/// The hints of one notification: whose it is, and how urgent.
pub fn hints(app_id: &str, urgent: bool) -> HashMap<String, glib::Variant> {
    HashMap::from([("desktop-entry".to_string(), app_id.to_variant()), ("urgency".to_string(), (if urgent { 2u8 } else { 1u8 }).to_variant())])
}

impl Notifier {
    /// `on_click(alert, token)` runs when the owner clicks a notification.
    #[allow(deprecated)]
    pub fn new(conn: &gio::DBusConnection, on_click: impl Fn(String, Option<String>) + 'static) -> Self {
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
                    sh.ids.retain(|_, v| *v != id);
                }
                _ => {}
            }
        });
        Self { conn: conn.clone(), shown }
    }

    pub fn show(&self, app_id: &str, key: &str, alert: &str, title: &str, body: &str, urgent: bool) {
        let replaces = self.shown.borrow().ids.get(key).copied().unwrap_or(0);
        let args = ("Keel", replaces, app_id, title, body, vec!["default", "Open"], hints(app_id, urgent), -1i32).to_variant();
        let (s, key, alert) = (self.shown.clone(), key.to_string(), alert.to_string());
        self.conn.call(Some(NAME), PATH, NAME, "Notify", Some(&args), None, gio::DBusCallFlags::NONE, 5000, gio::Cancellable::NONE, move |r| {
            if let Some(id) = r.ok().and_then(|v| v.child_value(0).get::<u32>()) {
                let mut sh = s.borrow_mut();
                sh.ids.insert(key, id);
                sh.alerts.insert(id, alert);
            }
        });
    }

    pub fn withdraw(&self, key: &str) {
        let id = self.shown.borrow_mut().ids.remove(key);
        if let Some(id) = id {
            self.shown.borrow_mut().alerts.remove(&id);
            self.close(id);
        }
    }

    /// Takes down every notification the shell showed: after it quits nothing would answer their click.
    pub fn withdraw_all(&self) {
        let ids: Vec<u32> = self.shown.borrow_mut().ids.drain().map(|(_, id)| id).collect();
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
        let h = hints("io.example.App", true);
        assert_eq!(h["desktop-entry"].get::<String>().as_deref(), Some("io.example.App"));
        assert_eq!(h["urgency"].get::<u8>(), Some(2));
        assert_eq!(hints("io.example.App", false)["urgency"].get::<u8>(), Some(1));
    }

    #[test]
    fn the_call_has_the_services_signature() {
        let args = ("Keel", 0u32, "io.example.App", "t", "b", vec!["default", "Open"], hints("io.example.App", false), -1i32).to_variant();
        assert_eq!(args.type_().as_str(), "(susssasa{sv}i)");
    }
}
