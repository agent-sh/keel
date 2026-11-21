//! One app per desktop session. The first launch owns the application's name
//! on the session bus and serves a small interface of its own there; a later
//! launch calls it with its words (a keel:// link, --new) and the desktop's
//! activation token, then ends. The running app raises its window.
use crate::APP_ID;
use gtk::prelude::*;
use gtk::{gio, glib};

const PATH: &str = "/io/github/agent_sh/Keel/Shell";
const IFACE: &str = "io.github.agent_sh.Keel.Shell";
const XML: &str = r#"<node><interface name="io.github.agent_sh.Keel.Shell">
<method name="Run"><arg name="words" type="as" direction="in"/><arg name="activation_token" type="s" direction="in"/></method>
</interface></node>"#;

/// The words a running app acts on: where this launch should lead. The rest
/// (which daemon, which keel program) belongs to the first launch alone.
pub fn words(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--url" | "--state-dir" | "--keel" => {
                it.next();
            }
            "--devtools" | "--hidden" | "--shortcut" => {}
            "--window" => {
                out.push(a.clone());
                out.extend(it.next().cloned());
            }
            _ => out.push(a.clone()),
        }
    }
    out
}

/// The token the desktop gave this launch, so the running app's window may take the focus.
fn launch_token() -> String {
    std::env::var("XDG_ACTIVATION_TOKEN").or_else(|_| std::env::var("DESKTOP_STARTUP_ID")).unwrap_or_default()
}

/// True when a running app took this launch.
pub fn hand_over(args: &[String]) -> bool {
    let Ok(conn) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else { return false };
    let params = (words(args), launch_token()).to_variant();
    conn.call_sync(Some(APP_ID), PATH, IFACE, "Run", Some(&params), None, gio::DBusCallFlags::NO_AUTO_START, 4000, gio::Cancellable::NONE).is_ok()
}

/// Serves later launches: `on_run(words, token)`.
pub fn serve(conn: &gio::DBusConnection, on_run: impl Fn(Vec<String>, Option<String>) + 'static) -> Result<(), glib::Error> {
    let info = gio::DBusNodeInfo::for_xml(XML)?.lookup_interface(IFACE).expect("the shell's interface");
    conn.register_object(PATH, &info)
        .method_call(move |_, _, _, _, method, params, inv| {
            if method == "Run" {
                let words = params.child_value(0).get::<Vec<String>>().unwrap_or_default();
                let token = params.child_value(1).get::<String>().filter(|t| !t.is_empty());
                inv.return_value(None);
                on_run(words, token);
            } else {
                inv.return_value(None);
            }
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_launch_hands_over_where_to_go_only() {
        let args: Vec<String> = ["--url", "http://127.0.0.1:1", "--devtools", "keel://session/abc", "--state-dir", "/x", "--new", "--window", "/s/a", "--hidden"].iter().map(|s| s.to_string()).collect();
        assert_eq!(words(&args), ["keel://session/abc", "--new", "--window", "/s/a"]);
        assert!(words(&[]).is_empty());
    }
}
