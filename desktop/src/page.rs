//! What the app puts beside the page, whatever engine draws it: the
//! capability object a page reads to know it runs in the app, and the calm
//! page shown while the daemon is away. An engine gives its own way for a
//! page to post a message to the app: `post`, a JavaScript expression over
//! the string `s`.
use crate::daemon::Link;
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
pub fn bridge(engine: &str, window: &str, tray: bool, post: &str, key: &str, origin: &str) -> String {
    format!(
        r#"(() => {{
  if (window.top !== window || window.keelShell || location.origin !== {origin}) return;
  const key = {key};
  const post = (m) => {{ try {{ const s = JSON.stringify({{ ...m, key }}); {post}; }} catch (e) {{}} }};
  Object.defineProperty(window, "keelShell", {{ value: Object.freeze({{
    name: "keel-desktop", version: "{version}", engine: "{engine}", platform: "{platform}", window: "{window}",
    can: Object.freeze({{ titlebar: true, windows: true, links: true, notifications: true, tray: {tray} }}), post,
  }}) }});
}})();"#,
        version = env!("CARGO_PKG_VERSION"),
        platform = std::env::consts::OS,
        key = serde_json::Value::String(key.to_string()),
        origin = serde_json::Value::String(origin.to_string()),
    )
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The words of the page for a state of the daemon: headline, line under it, whether the button shows.
pub fn words(link: &Link, starting: bool) -> (&'static str, &'static str, bool) {
    match (link, starting) {
        (Link::Restarting, _) => ("Keel is restarting", "Your sessions carry on where they were. This window comes back by itself.", false),
        (_, true) => ("Starting Keel", "The daemon is coming up. This takes a moment.", false),
        (Link::Down, _) => ("Keel is not running", "The daemon runs your sessions and keeps them. Start it to pick up where you left off.", true),
        (Link::Up, _) => ("Opening Keel", "", false),
    }
}

/// The page shown while the daemon is away: the product's mark, what is
/// happening in one line, and one button. `setState` moves it between its
/// states without a reload, so nothing flashes.
pub fn away(l: &Look, link: &Link, starting: bool, url: &str, note: &str, post: &str, key: &str) -> String {
    let (head, line, button) = words(link, starting);
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
<div class="act"><button id="start" type="button" {hide_button}>Start Keel</button><div class="bar" id="bar" role="progressbar" aria-label="Working" {hide_bar}></div></div>
<p class="note" id="note" {hide_note}>{note}</p>
<div class="where" id="where">{url}</div>
</main><script>
const $ = (id) => document.getElementById(id);
const post = (m) => {{ const s = JSON.stringify({{ ...m, key: {key} }}); {post}; }};
$("start").addEventListener("click", () => post({{ t: "start" }}));
window.setState = (s) => {{
  $("head").textContent = s.head; $("line").textContent = s.line;
  $("start").hidden = !s.button; $("bar").hidden = s.button;
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
        hide_bar = if button { "hidden" } else { "" },
        hide_note = if note.is_empty() { "hidden" } else { "" },
        note = esc(note), url = esc(url), post = post, key = serde_json::Value::String(key.to_string()),
    )
}

/// The same state as a call of the away page's `setState`.
pub fn away_state(link: &Link, starting: bool, url: &str, note: &str) -> String {
    let (head, line, button) = words(link, starting);
    format!("window.setState && window.setState({})", serde_json::json!({ "head": head, "line": line, "button": button, "note": note, "url": url }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_away_page_says_one_thing_per_state() {
        assert_eq!(words(&Link::Down, false), ("Keel is not running", "The daemon runs your sessions and keeps them. Start it to pick up where you left off.", true));
        assert!(!words(&Link::Restarting, false).2);
        assert!(!words(&Link::Restarting, true).2);
        assert_eq!(words(&Link::Down, true).0, "Starting Keel");
    }

    #[test]
    fn what_is_shown_is_text_not_markup() {
        let html = away(&Look::of(true), &Link::Down, false, "http://127.0.0.1:1/<b>", "could not start: <script>alert(1)</script>", "send(s)", "k1");
        assert!(html.contains("send(s)"));
        assert!(!html.contains("<script>alert(1)"));
        assert!(html.contains("&lt;script&gt;alert(1)"));
        assert!(html.contains("http://127.0.0.1:1/&lt;b&gt;"));
        assert!(away_state(&Link::Down, false, "u", "a\"b</script>").contains(r#"a\"b"#));
    }

    #[test]
    fn the_bridge_names_the_shell() {
        let b = bridge("webkit", "main", true, "send(s)", "k1", "http://127.0.0.1:47960");
        assert!(b.contains(r#"window: "main""#) && b.contains("tray: true") && b.contains("keelShell") && b.contains(r#"engine: "webkit""#) && b.contains("send(s)"));
    }

    #[test]
    fn the_bridge_is_for_the_daemons_origin_and_keys_every_message() {
        let b = bridge("webkit", "main", true, "send(s)", "secret\"-key", "http://127.0.0.1:47960");
        assert!(b.contains(r#"location.origin !== "http://127.0.0.1:47960""#));
        // The key is a string of the script, whatever it holds, and goes into every message.
        assert!(b.contains(r#"const key = "secret\"-key";"#) && b.contains("...m, key"));
        let a = away(&Look::of(false), &Link::Down, false, "u", "", "send(s)", "k2");
        assert!(a.contains(r#"key: "k2""#));
    }
}
