//! A global shortcut that brings the window up, through the desktop portal
//! (org.freedesktop.portal.GlobalShortcuts): the only way an app gets one on
//! Wayland. The desktop asks the owner once and they pick the keys there. A
//! desktop without the portal has no global shortcut; there the owner binds
//! a key of the desktop's own to `keel-desktop`, which raises the running app.
use gtk::prelude::*;
use gtk::{gio, glib};
use std::collections::HashMap;

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";

fn options(pairs: &[(&str, glib::Variant)]) -> HashMap<String, glib::Variant> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// The path of the request a call answers on: the portal derives it from the caller's name and the token.
fn request_path(conn: &gio::DBusConnection, token: &str) -> String {
    let me = conn.unique_name().map(|n| n.trim_start_matches(':').replace('.', "_")).unwrap_or_default();
    format!("/org/freedesktop/portal/desktop/request/{me}/{token}")
}

/// Asks the portal for one shortcut, "summon". Quiet when there is no portal.
#[allow(deprecated)]
pub fn bind(conn: &gio::DBusConnection, on_summon: impl Fn() + 'static) {
    let c = conn.clone();
    conn.call(Some(PORTAL), PATH, "org.freedesktop.DBus.Properties", "Get", Some(&(IFACE, "version").to_variant()), None, gio::DBusCallFlags::NONE, 2000, gio::Cancellable::NONE, move |r| {
        if r.is_err() {
            return;
        }
        // The session is made, then the shortcut is bound to it; each answer comes as a Response signal on the request's path.
        let (c2, token) = (c.clone(), "keel_session");
        c.signal_subscribe(Some(PORTAL), Some("org.freedesktop.portal.Request"), Some("Response"), Some(&request_path(&c, token)), None, gio::DBusSignalFlags::NONE, move |_, _, _, _, _, params| {
            let Some(session) = glib::VariantDict::new(Some(&params.child_value(1))).lookup_value("session_handle", None).and_then(|v| v.get::<String>()) else { return };
            let Ok(handle) = glib::variant::ObjectPath::try_from(session) else { return };
            let shortcut = ("summon", options(&[("description", "Show Keel".to_variant()), ("preferred_trigger", "CTRL+ALT+K".to_variant())]));
            c2.call(Some(PORTAL), PATH, IFACE, "BindShortcuts", Some(&(handle, vec![shortcut], "", options(&[("handle_token", "keel_bind".to_variant())])).to_variant()), None, gio::DBusCallFlags::NONE, -1, gio::Cancellable::NONE, |_| {});
        });
        c.call(Some(PORTAL), PATH, IFACE, "CreateSession", Some(&(options(&[("handle_token", token.to_variant()), ("session_handle_token", "keel".to_variant())]),).to_variant()), None, gio::DBusCallFlags::NONE, -1, gio::Cancellable::NONE, |_| {});
    });
    conn.signal_subscribe(Some(PORTAL), Some(IFACE), Some("Activated"), Some(PATH), None, gio::DBusSignalFlags::NONE, move |_, _, _, _, _, params| {
        if params.child_value(1).get::<String>().as_deref() == Some("summon") {
            on_summon();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_calls_have_the_portals_signatures() {
        let create = (options(&[("handle_token", "t".to_variant())]),).to_variant();
        assert_eq!(create.type_().as_str(), "(a{sv})");
        let handle = glib::variant::ObjectPath::try_from("/a/b").unwrap();
        let shortcut = ("summon", options(&[("description", "Show Keel".to_variant())]));
        let bind = (handle, vec![shortcut], "", options(&[])).to_variant();
        assert_eq!(bind.type_().as_str(), "(oa(sa{sv})sa{sv})");
    }
}
