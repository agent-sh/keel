//! What a page says to the app, whatever engine carries it. An engine's
//! channel is open to every frame of its web view, a sandboxed preview of
//! model-written HTML included, so a message is acted on only when it holds
//! the value of its window alone (page.rs puts it in the top frame's script
//! of the daemon's own origin, and in the app's away page).
use crate::prefs::Look;
use crate::view::Ask;
use serde_json::Value;

/// What a message from the page asks, once its key was checked. `None` for anything else.
pub fn asked(m: &Value, key: &str) -> Option<Asked1> {
    if key.is_empty() || m.get("key").and_then(Value::as_str) != Some(key) {
        return None;
    }
    let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let id = || m.get("id").and_then(Value::as_u64).unwrap_or(0);
    match m.get("t").and_then(Value::as_str)? {
        "start" => Some(Asked1::Ask(Ask::Start)),
        "window" => Some(Asked1::Ask(Ask::Window(s("path")))),
        // (`edge`: the longer side the page keeps a picture at.)
        "paste" => Some(Asked1::Paste(id(), m.get("edge").and_then(Value::as_i64).filter(|e| (64..=16384).contains(e)).map(|e| e as i32))),
        "copying" => Some(Asked1::Copying),
        "copy" => Some(Asked1::Copy(id(), s("text"))),
        "look" => {
            let base = Look::of(m.get("dark").and_then(Value::as_bool).unwrap_or(false));
            let color = |k: &str, or: &str| m.get(k).and_then(Value::as_str).and_then(crate::prefs::hex).unwrap_or(or).to_string();
            Some(Asked1::Ask(Ask::Look(Look {
                dark: base.dark,
                bg: color("bg", &base.bg),
                panel: color("panel", &base.panel),
                fg: color("fg", &base.fg),
                muted: color("muted", &base.muted),
                line: color("line", &base.line),
                need: color("need", &base.need),
                scale: m.get("scale").and_then(Value::as_f64).filter(|s| (0.5..=3.0).contains(s)).unwrap_or(1.0),
            })))
        }
        _ => None,
    }
}

/// A checked message: something for the application, or the page's use of the clipboard
/// (each with the number its answer carries back).
#[derive(Debug)]
pub enum Asked1 {
    Ask(Ask),
    /// The owner pasted and the paste event carried nothing: what the clipboard holds
    /// (a picture no larger than the edge the page named).
    Paste(u64, Option<i32>),
    /// A copy is coming, said at the owner's press.
    Copying,
    Copy(u64, String),
}

#[cfg(test)]
mod tests {
    use super::*;

    // The reviewer's reproduction: model-written HTML in a sandboxed frame posted these with no key.
    #[test]
    fn a_message_without_the_windows_key_is_not_acted_on() {
        let key = "k-123";
        for raw in [
            r#"{"t":"window","path":"/s/abc"}"#,
            r##"{"t":"look","dark":true,"bg":"#ff0000","scale":3}"##,
            r#"{"t":"start"}"#,
            r#"{"t":"paste","id":1}"#,
            r#"{"t":"copying"}"#,
            r#"{"t":"copy","id":2,"text":"planted"}"#,
            r#"{"t":"window","path":"/s/abc","key":"guess"}"#,
            r#"{"t":"window","path":"/s/abc","key":""}"#,
        ] {
            assert!(asked(&serde_json::from_str(raw).unwrap(), key).is_none(), "{raw}");
        }
        assert!(asked(&serde_json::from_str(r#"{"t":"window","path":"/s/abc","key":""}"#).unwrap(), "").is_none());
    }

    #[test]
    fn a_keyed_message_is_read_and_a_link_for_the_browser_is_not_a_message() {
        let m = |raw: &str| asked(&serde_json::from_str(raw).unwrap(), "k-123");
        assert!(matches!(m(r#"{"t":"window","path":"/s/abc","key":"k-123"}"#), Some(Asked1::Ask(Ask::Window(p))) if p == "/s/abc"));
        assert!(matches!(m(r#"{"t":"start","key":"k-123"}"#), Some(Asked1::Ask(Ask::Start))));
        assert!(matches!(m(r#"{"t":"paste","id":7,"key":"k-123"}"#), Some(Asked1::Paste(7, None))));
        assert!(matches!(m(r#"{"t":"paste","id":7,"edge":1568,"key":"k-123"}"#), Some(Asked1::Paste(7, Some(1568)))));
        assert!(matches!(m(r#"{"t":"paste","id":7,"edge":1,"key":"k-123"}"#), Some(Asked1::Paste(7, None))));
        assert!(matches!(m(r#"{"t":"copying","key":"k-123"}"#), Some(Asked1::Copying)));
        assert!(matches!(m(r#"{"t":"copy","id":8,"text":"words","key":"k-123"}"#), Some(Asked1::Copy(8, t)) if t == "words"));
        assert!(matches!(m(r#"{"t":"look","dark":true,"bg":"red","key":"k-123"}"#), Some(Asked1::Ask(Ask::Look(l))) if l.dark && l.bg == Look::of(true).bg));
        // No message opens the browser: only the owner's click on a link does.
        assert!(m(r#"{"t":"external","url":"https://x.example/","key":"k-123"}"#).is_none());
    }
}
