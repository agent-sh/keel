//! What the app puts beside the page, whatever engine draws it: the
//! capability object a page reads to know it runs in the app, and the calm
//! page shown while the daemon is away. An engine gives its own way for a
//! page to post a message to the app: `post`, a JavaScript expression over
//! the string `s`.
use crate::daemon::Link;
use crate::view::{Away, Can};
use crate::prefs::Look;

/// Injected before the page's own scripts, in the top frame of the daemon's
/// own origin only. The page reads `window.keelShell` (ui/src/lib/shell.ts);
/// it is never told by its user agent. `post` is the page's way to the app,
/// and the app answers with `keel-shell` events.
///
/// The engine's message channel is open to every frame of the web view, a
/// sandboxed preview of model-written HTML included. So every message carries
/// `key`, a value of this window alone that lives in this closure: a frame
/// that cannot reach the top frame's script cannot send a message the app
/// acts on.
///
/// The origin tested is the document's own (`self.origin`), not its
/// address's: a document the daemon serves sandboxed (an artifact's raw
/// address) keeps the address and has an opaque origin, and gets nothing.
pub fn bridge(engine: &str, window: &str, can: Can, post: &str, key: &str, origin: &str) -> String {
    format!(
        r#"(() => {{
  if (window.top !== window || window.keelShell || self.origin !== {origin}) return;
  const key = {key};
  const post = (m) => {{ try {{ const s = JSON.stringify({{ ...m, key }}); {post}; }} catch (e) {{}} }};
  Object.defineProperty(window, "keelShell", {{ value: Object.freeze({{
    name: "keel-desktop", version: "{version}", engine: "{engine}", platform: "{platform}", window: "{window}",
    can: Object.freeze({{ titlebar: true, windows: true, links: true, notifications: true, tray: {tray}, saving: true, shortcuts: {shortcuts} }}), post,
  }}) }});
  // A new document is in the window: what the one before said it does with the app is gone
  // with it, until this one's page says so itself.
  post({{ t: "can" }});
}})();"#,
        tray = can.tray,
        shortcuts = can.shortcuts,
        version = env!("CARGO_PKG_VERSION"),
        platform = std::env::consts::OS,
        key = serde_json::Value::String(key.to_string()),
        origin = serde_json::Value::String(origin.to_string()),
    )
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The words of the page for a state of the daemon: headline, line under it, whether the
/// button shows, whether the bar that says something is under way shows.
pub fn words(a: &Away) -> (&'static str, &'static str, bool, bool) {
    if a.refused {
        return ("This Keel is on another machine", "The app opens the Keel of this machine. Open that address in a browser, or start the app without it.", false, false);
    }
    if a.failing {
        return ("Keel's page does not open", "Keel answers, but its page fails to load. The app keeps trying.", false, true);
    }
    match (&a.link, a.starting) {
        (Link::Restarting, _) => (Link::Restarting.said(), "Your sessions carry on where they were. This window comes back by itself.", false, true),
        (_, true) => ("Starting Keel", "The daemon is coming up. This takes a moment.", false, true),
        (Link::Down, _) => (Link::Down.said(), "The daemon runs your sessions and keeps them. Start it to pick up where you left off.", true, false),
        (Link::Up, _) => ("Opening Keel", "", false, true),
    }
}

/// The page shown while the daemon is away: the product's mark, what is
/// happening in one line, and one button. `setState` moves it between its
/// states without a reload, so nothing flashes.
pub fn away(l: &Look, a: &Away, post: &str, key: &str) -> String {
    let (head, line, button, bar) = words(a);
    let (url, note) = (a.url.as_str(), a.note.as_str());
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Keel</title><style>
:root {{ color-scheme: {scheme}; }}
html, body {{ height: 100%; margin: 0; }}
body {{ background: {bg}; color: {fg}; font: {font}px/1.5 "IBM Plex Sans Variable", "IBM Plex Sans", "Inter", system-ui, sans-serif; display: grid; place-items: center; -webkit-user-select: none; user-select: none; cursor: default; }}
main {{ width: min(26rem, 86vw); display: grid; justify-items: start; gap: 0; transform: translateY(-6vh); }}
svg {{ width: 2.75rem; height: 2.75rem; display: block; margin-bottom: 1.5rem; }}
h1 {{ font-size: 1.5rem; line-height: 1.25; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 0.5rem; }}
p {{ margin: 0; color: {muted}; max-width: 24rem; }}
.act {{ height: 2.25rem; margin-top: 1.5rem; display: flex; align-items: center; gap: 0.875rem; }}
button {{ font: inherit; font-weight: 600; height: 2.25rem; padding: 0 1rem; border: 0; border-radius: 0.5rem; background: {fg}; color: {bg}; cursor: pointer; transition: opacity 120ms ease; }}
button:hover {{ opacity: 0.86; }}
button:focus-visible {{ outline: 2px solid {need}; outline-offset: 2px; }}
.bar {{ width: 9rem; height: 2px; border-radius: 2px; background: {line}; overflow: hidden; }}
.bar::after {{ content: ""; display: block; width: 40%; height: 100%; border-radius: 2px; background: {need}; animation: slide 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite; }}
@keyframes slide {{ 0% {{ transform: translateX(-100%); }} 100% {{ transform: translateX(250%); }} }}
@media (prefers-reduced-motion: reduce) {{ .bar::after {{ animation: none; width: 100%; opacity: 0.5; }} }}
.note {{ margin-top: 1rem; font-size: 0.8125rem; color: {muted}; }}
.where {{ margin-top: 2.5rem; padding-top: 0.875rem; border-top: 1px solid {line}; width: 100%; font: 0.75rem/1.4 "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace; color: {muted}; opacity: 0.8; }}
[hidden] {{ display: none !important; }}
</style></head><body><main data-testid="shell-away">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Keel"><rect width="32" height="32" rx="8" fill="#0e6a80"/><path d="M6 11.5h20c-1.1 4.9-5 7.6-10 7.6s-8.9-2.7-10-7.6z" fill="#f4faf9"/><path d="M14.6 18.6h2.8l-.7 6.4h-1.4z" fill="#f4faf9"/></svg>
<h1 id="head">{head}</h1><p id="line">{sub}</p>
<div class="act" id="act" {hide_act}><button id="start" type="button" {hide_button}>Start Keel</button><div class="bar" id="bar" role="progressbar" aria-label="Working" {hide_bar}></div></div>
<p class="note" id="note" {hide_note}>{note}</p>
<div class="where" id="where">{url}</div>
</main><script>
const $ = (id) => document.getElementById(id);
const post = (m) => {{ const s = JSON.stringify({{ ...m, key: {key} }}); {post}; }};
$("start").addEventListener("click", () => post({{ t: "start" }}));
window.setState = (s) => {{
  $("head").textContent = s.head; $("line").textContent = s.line;
  $("start").hidden = !s.button; $("bar").hidden = !s.bar; $("act").hidden = !s.button && !s.bar;
  $("note").textContent = s.note || ""; $("note").hidden = !s.note;
  if (s.url) $("where").textContent = s.url;
  if (s.button) $("start").focus();
}};
if (!$("start").hidden) $("start").focus();
</script></body></html>"##,
        scheme = if l.dark { "dark" } else { "light" },
        bg = l.bg, fg = l.fg, muted = l.muted, line = l.line, need = l.need,
        font = (16.0 * l.scale).round(),
        head = head, sub = line,
        hide_button = if button { "" } else { "hidden" },
        hide_bar = if bar { "" } else { "hidden" },
        hide_act = if button || bar { "" } else { "hidden" },
        hide_note = if note.is_empty() { "hidden" } else { "" },
        note = esc(note), url = esc(url), post = post, key = serde_json::Value::String(key.to_string()),
    )
}

/// The same state as a call of the away page's `setState`.
pub fn away_state(a: &Away) -> String {
    let (head, line, button, bar) = words(a);
    format!("window.setState && window.setState({})", serde_json::json!({ "head": head, "line": line, "button": button, "bar": bar, "note": a.note, "url": a.url }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(link: Link, starting: bool, refused: bool) -> Away {
        Away { link, starting, url: "http://127.0.0.1:1/<b>".into(), note: "could not start: <script>alert(1)</script>".into(), refused, failing: false }
    }

    #[test]
    fn the_away_page_says_one_thing_per_state() {
        assert_eq!(words(&state(Link::Down, false, false)), ("Keel is not running", "The daemon runs your sessions and keeps them. Start it to pick up where you left off.", true, false));
        assert_eq!((words(&state(Link::Restarting, false, false)).2, words(&state(Link::Restarting, false, false)).3), (false, true));
        assert!(!words(&state(Link::Restarting, true, false)).2);
        // The daemon answers and its page keeps failing: said, with no button (there is nothing to start).
        let failing = words(&Away { failing: true, ..state(Link::Up, false, false) });
        assert_eq!((failing.0, failing.2, failing.3), ("Keel's page does not open", false, true));
        assert_eq!(words(&state(Link::Down, true, false)).0, "Starting Keel");
    }

    // One state, one word: the calm page heads a daemon that is away with the words the title bar,
    // the tray and the page inside the window say (Link::said); the bar once said "Reconnecting".
    #[test]
    fn the_away_page_says_the_state_in_the_words_of_the_bar() {
        for link in [Link::Down, Link::Restarting] {
            assert_eq!(words(&state(link.clone(), false, false)).0, link.said());
        }
        assert_eq!((Link::Restarting.said(), Link::Down.said(), Link::Up.said()), ("Keel is restarting", "Keel is not running", ""));
    }

    // The review's case: with an address that is not this machine's, the first page offered Start.
    #[test]
    fn a_refused_address_has_no_start_and_says_so_in_the_first_page() {
        let a = state(Link::Down, false, true);
        let (head, _, button, bar) = words(&a);
        assert_eq!((head, button, bar), ("This Keel is on another machine", false, false));
        let html = away(&Look::of(false), &a, "send(s)", "k1");
        assert!(html.contains("This Keel is on another machine"));
        assert!(html.contains(r#"<button id="start" type="button" hidden>"#));
        assert!(html.contains(r#"id="bar" role="progressbar" aria-label="Working" hidden"#));
        assert!(away_state(&a).contains(r#""button":false"#));
    }

    #[test]
    fn what_is_shown_is_text_not_markup() {
        let html = away(&Look::of(true), &state(Link::Down, false, false), "send(s)", "k1");
        assert!(html.contains("send(s)"));
        assert!(!html.contains("<script>alert(1)"));
        assert!(html.contains("&lt;script&gt;alert(1)"));
        assert!(html.contains("http://127.0.0.1:1/&lt;b&gt;"));
        let mut a = state(Link::Down, false, false);
        a.note = "a\"b</script>".into();
        assert!(away_state(&a).contains(r#"a\"b"#));
    }

    #[test]
    fn the_bridge_names_the_shell() {
        let b = bridge("webkit", "main", Can { tray: true, shortcuts: false }, "send(s)", "k1", "http://127.0.0.1:47960");
        assert!(b.contains(r#"window: "main""#) && b.contains("tray: true") && b.contains("keelShell") && b.contains(r#"engine: "webkit""#) && b.contains("send(s)"));
    }

    // The review's case: a sandboxed document of the daemon's origin (an artifact's raw address
    // in the main frame) keeps the address's origin in `location` and got the object.
    #[test]
    fn the_bridge_is_for_documents_of_the_daemons_origin_and_keys_every_message() {
        let b = bridge("webkit", "main", Can { tray: true, shortcuts: false }, "send(s)", "secret\"-key", "http://127.0.0.1:47960");
        assert!(b.contains(r#"self.origin !== "http://127.0.0.1:47960""#));
        assert!(!b.contains("location.origin"));
        // The key is a string of the script, whatever it holds, and goes into every message.
        assert!(b.contains(r#"const key = "secret\"-key";"#) && b.contains("...m, key"));
        let a = away(&Look::of(false), &state(Link::Down, false, false), "send(s)", "k2");
        assert!(a.contains(r#"key: "k2""#));
    }
}
