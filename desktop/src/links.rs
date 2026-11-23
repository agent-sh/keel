//! keel:// links and the paths of the page they lead to. A link is turned into
//! one of a closed set of paths; anything else is refused, so a link from
//! another program can only open a place of the page, never run or load
//! something of its choosing.

/// An id as the daemon makes them: letters, digits, dash and underscore. No
/// percent, dot or tilde, so no id can spell another path.
fn id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A page path the shell may open: `/`, `/s/<id>`, `/p/<id>`,
/// `/settings[/<section>]`. The only queries are the ones the daemon itself
/// writes for an alert's click: `inbox=1`, `approval=<id>`, `e=<id>`.
pub fn page_path(p: &str) -> Option<String> {
    if p.len() > 300 {
        return None;
    }
    let (path, query) = match p.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (p, None),
    };
    let ok = match path.strip_prefix('/')?.split('/').collect::<Vec<_>>().as_slice() {
        [""] => true,
        ["s", x] | ["p", x] => id(x),
        ["settings"] => true,
        ["settings", section] => id(section),
        _ => false,
    };
    let query_ok = query.is_none_or(|q| {
        q.split('&').all(|pair| match pair.split_once('=') {
            Some(("inbox", "1")) => true,
            Some(("approval" | "e", v)) => id(v),
            _ => false,
        })
    });
    (ok && query_ok).then(|| p.to_string())
}

/// `keel://session/<id>`, `keel://s/<id>`, `keel://new`, `keel://inbox`,
/// `keel://settings[/<section>]`, `keel://project/<id>`. A link names a place
/// and nothing more: it carries no query, so it cannot point at an approval
/// or hand the page anything to act on.
pub fn link_path(link: &str) -> Option<String> {
    let rest = link.strip_prefix("keel://").or_else(|| link.strip_prefix("keel:"))?;
    if rest.contains(['?', '#']) {
        return None;
    }
    let parts: Vec<&str> = rest.trim_matches('/').split('/').collect();
    let path = match parts.as_slice() {
        ["new"] | [""] | ["open"] => "/".to_string(),
        ["inbox"] => "/?inbox=1".to_string(),
        ["session", x] | ["s", x] => format!("/s/{x}"),
        ["project", x] | ["p", x] => format!("/p/{x}"),
        ["settings"] => "/settings".to_string(),
        ["settings", section] => format!("/settings/{section}"),
        _ => return None,
    };
    page_path(&path)
}

/// Whether the main frame may show `uri` while the daemon's page is up: a
/// place of the page at the daemon's origin, and nothing else the daemon
/// serves (an artifact's raw address is a sandboxed document; an API answer is
/// no page).
pub fn main_frame_may_show(uri: &str, origin: &str) -> bool {
    !origin.is_empty() && uri.strip_prefix(origin).is_some_and(|rest| page_path(rest.split('#').next().unwrap_or(rest)).is_some())
}

/// Whether a file offered from `url` is one of the daemon's own: its origin, under its API.
/// Not the content it serves for others (a session's port behind its portal), not a script's
/// own bytes (`blob:`, `data:`), not another origin.
pub fn keepable(url: &str, origin: &str) -> bool {
    !origin.is_empty() && url.strip_prefix(origin).is_some_and(|rest| rest.starts_with("/api/"))
}

/// `scheme://host:port` of an address.
pub fn origin(u: &str) -> String {
    u.split('/').take(3).collect::<Vec<_>>().join("/")
}

/// A path without its query: what a launch or a link may name.
pub fn place(path: &str) -> &str {
    path.split(['?', '#']).next().unwrap_or(path)
}

/// Whether one more window of a single session may open.
pub fn room_for_window(open: usize, most: usize) -> bool {
    open < most
}

/// An address for the owner's browser: http or https only.
pub fn web_url(u: &str) -> Option<&str> {
    let lower = u.get(..8)?.to_ascii_lowercase();
    ((lower.starts_with("http://") || lower.starts_with("https://")) && u.len() < 4000 && !u.chars().any(|c| c.is_control() || c == ' ')).then_some(u)
}

/// Where a file is saved in a folder: under its own name, or the next free
/// one (`name (2).ext`). `taken` says whether a path is already used.
pub fn free_name(folder: &std::path::Path, suggested: &str, taken: impl Fn(&std::path::Path) -> bool) -> std::path::PathBuf {
    let name = std::path::Path::new(suggested).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty() && n != "." && n != "..").unwrap_or_else(|| "download".into());
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut path = folder.join(&name);
    let mut n = 1;
    while taken(&path) {
        n += 1;
        path = folder.join(format!("{stem} ({n}){ext}"));
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    // The review's case: a preview frame saved a file made by its own script.
    #[test]
    fn a_file_is_kept_only_from_the_daemons_own_api() {
        let o = "http://127.0.0.1:47950";
        assert!(keepable("http://127.0.0.1:47950/api/attachments/7?name=a.png", o));
        assert!(keepable("http://127.0.0.1:47950/api/sessions/s/artifacts/raw?path=%2Fa&download=1", o));
        for no in [
            "blob:null/2b7c8a5e-1c1d-4b0e-9d5e-0f5a3c1f7a11",
            "blob:http://127.0.0.1:47950/2b7c8a5e-1c1d-4b0e-9d5e-0f5a3c1f7a11",
            "data:text/plain,hello",
            "http://127.0.0.1:47950/portal/s/k/5173/x.bin",
            "http://127.0.0.1:47950/fleet-portal/m/s/k/5173/x.bin",
            "http://127.0.0.1:47950.evil.example/api/x",
            "http://127.0.0.1:4795/api/x",
            "http://127.0.0.1:5173/api/x",
            "https://example.com/api/x",
            "http://127.0.0.1:47950/apix",
            "",
        ] {
            assert!(!keepable(no, o), "{no}");
        }
        assert!(!keepable("http://127.0.0.1:47950/api/x", ""));
    }

    #[test]
    fn links_lead_to_page_paths() {
        assert_eq!(link_path("keel://session/01a1ffe5-99ea").as_deref(), Some("/s/01a1ffe5-99ea"));
        assert_eq!(link_path("keel://s/abc_1-Z").as_deref(), Some("/s/abc_1-Z"));
        assert_eq!(link_path("keel://new").as_deref(), Some("/"));
        assert_eq!(link_path("keel://").as_deref(), Some("/"));
        assert_eq!(link_path("keel://inbox").as_deref(), Some("/?inbox=1"));
        assert_eq!(link_path("keel://settings/safety").as_deref(), Some("/settings/safety"));
        assert_eq!(link_path("keel://project/p1/").as_deref(), Some("/p/p1"));
        assert_eq!(link_path("keel:session/abc").as_deref(), Some("/s/abc"));
    }

    #[test]
    fn links_to_anything_else_are_refused() {
        for bad in [
            "keel://session/../../etc/passwd",
            "keel://session/a/b",
            "keel://run?cmd=rm",
            "keel://session/a b",
            "keel://session/abc?next=http://evil.example/",
            // The review's cases: an id that spells a path, and a link that carries a query or an approval.
            "keel://session/%2e%2e%2fapi%2fdrain",
            "keel://session/a.b",
            "keel://session/~root",
            "keel://new?prompt=rm",
            "keel://session/abc?approval=ap_1",
            "keel://s/abc?e=ev1",
            "keel://session/abc#frag",
            "https://example.com/",
            "keel://settings/a/b",
            "keel://session/<script>",
        ] {
            assert_eq!(link_path(bad), None, "{bad}");
        }
    }

    // The review's case: the main frame at an artifact's raw address got the app's object.
    #[test]
    fn the_main_frame_shows_places_of_the_page_only() {
        let o = "http://127.0.0.1:47960";
        for ok in ["http://127.0.0.1:47960/", "http://127.0.0.1:47960/s/abc", "http://127.0.0.1:47960/s/abc?e=ev1#x", "http://127.0.0.1:47960/settings/models"] {
            assert!(main_frame_may_show(ok, o), "{ok}");
        }
        for no in [
            "http://127.0.0.1:47960/api/sessions/abc/artifacts/raw?path=%2Fx%2Fevil.html",
            "http://127.0.0.1:47960/api/health",
            "http://127.0.0.1:47961/",
            "http://127.0.0.1:47960.evil.example/",
            "http://127.0.0.1:47960",
            "about:blank",
            "",
        ] {
            assert!(!main_frame_may_show(no, o), "{no}");
        }
        assert!(!main_frame_may_show("http://127.0.0.1:47960/", ""));
    }

    // The review's case: a frame's script opened window after window.
    #[test]
    fn session_windows_are_capped() {
        assert_eq!(place("/s/abc?approval=ap_1&e=x"), "/s/abc");
        assert_eq!(place("/s/abc#x"), "/s/abc");
        assert!(room_for_window(0, 8) && room_for_window(7, 8));
        assert!(!room_for_window(8, 8) && !room_for_window(40, 8));
    }

    #[test]
    fn page_paths_are_a_closed_set() {
        for good in ["/", "/?inbox=1", "/s/abc", "/s/01a1-ff?e=ev_1&approval=x", "/s/abc?approval=ap-1", "/p/proj", "/settings", "/settings/models"] {
            assert!(page_path(good).is_some(), "{good}");
        }
        for bad in ["", "s/abc", "//evil.example/", "/api/drain", "/s/", "/s/a/b", "/settings/a/b", "/s/a?x=javascript:alert(1)", "/ws", "/s/a?q=a b", "/s/%2e%2e", "/s/a.b", "/s/a~b", "/?prompt=x", "/s/a?approval=", "/s/a?inbox=2", "/s/a?e=x&next=y"] {
            assert!(page_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_saved_file_never_replaces_another_or_leaves_the_folder() {
        let folder = std::path::Path::new("/d");
        assert_eq!(free_name(folder, "notes.md", |_| false), folder.join("notes.md"));
        assert_eq!(free_name(folder, "notes.md", |p| p.ends_with("notes.md")), folder.join("notes (2).md"));
        assert_eq!(free_name(folder, "archive.tar.gz", |p| !p.to_string_lossy().contains("(3)")), folder.join("archive.tar (3).gz"));
        assert_eq!(free_name(folder, "../../etc/passwd", |_| false), folder.join("passwd"));
        assert_eq!(free_name(folder, "", |_| false), folder.join("download"));
        assert_eq!(free_name(folder, "..", |_| false), folder.join("download"));
        assert_eq!(free_name(folder, ".bashrc", |_| false), folder.join(".bashrc"));
    }

    #[test]
    fn only_web_addresses_go_to_the_browser() {
        assert!(web_url("https://example.com/a?b=c").is_some());
        assert!(web_url("HTTP://example.com/").is_some());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "keel://new", "ftp://x/", "https://exa mple.com", "http://x\n/"] {
            assert!(web_url(bad).is_none(), "{bad}");
        }
    }

    // The table the other engine's program is held to as well (keel-desktop-qt --self-test).
    #[test]
    fn the_shared_table_of_paths_is_decided_as_it_says() {
        let mut n = 0;
        for line in include_str!("../test/paths.txt").lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let (want, path) = line.split_at(3);
            assert_eq!(page_path(path).is_some(), want == "ok ", "{line}");
            assert_eq!(main_frame_may_show(&format!("http://127.0.0.1:1{path}"), "http://127.0.0.1:1"), want == "ok ", "{line}");
            n += 1;
        }
        assert!(n > 30);
    }

    #[test]
    fn the_main_frame_origin_is_scheme_host_and_port() {
        assert_eq!(origin("http://127.0.0.1:47960/s/abc?e=1"), "http://127.0.0.1:47960");
        assert_eq!(origin("http://127.0.0.1:47961/"), "http://127.0.0.1:47961");
        assert_ne!(origin("http://127.0.0.1:47960/"), origin("http://127.0.0.1:47961/"));
    }
}
