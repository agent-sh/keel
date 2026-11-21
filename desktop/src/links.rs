//! keel:// links and the paths of the page they lead to. A link is turned into
//! one of a closed set of paths; anything else is refused, so a link from
//! another program can only open a place of the page, never run or load
//! something of its choosing.

/// A page path the shell may open: `/`, `/s/<id>`, `/p/<id>`,
/// `/settings[/<section>]`, each with an optional query of plain words.
pub fn page_path(p: &str) -> Option<String> {
    if p.len() > 600 {
        return None;
    }
    let (path, query) = match p.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (p, None),
    };
    let word = |s: &str, extra: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    let ok = match path.strip_prefix('/')?.split('/').collect::<Vec<_>>().as_slice() {
        [""] => true,
        ["s", id] | ["p", id] => word(id, "_-.~%"),
        ["settings"] => true,
        ["settings", section] => word(section, "_-"),
        _ => false,
    };
    if !ok || query.is_some_and(|q| !q.chars().all(|c| c.is_ascii_alphanumeric() || "_-.~%=&+".contains(c))) {
        return None;
    }
    Some(p.to_string())
}

/// `keel://session/<id>[?approval=..|e=..]`, `keel://s/<id>`, `keel://new`,
/// `keel://inbox`, `keel://settings[/<section>]`, `keel://project/<id>`.
pub fn link_path(link: &str) -> Option<String> {
    let rest = link.strip_prefix("keel://").or_else(|| link.strip_prefix("keel:"))?;
    let (place, query) = match rest.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    let parts: Vec<&str> = place.trim_matches('/').split('/').collect();
    let path = match parts.as_slice() {
        ["new"] | [""] | ["open"] => "/".to_string(),
        ["inbox"] => "/?inbox=1".to_string(),
        ["session", id] | ["s", id] => format!("/s/{id}"),
        ["project", id] | ["p", id] => format!("/p/{id}"),
        ["settings"] => "/settings".to_string(),
        ["settings", section] => format!("/settings/{section}"),
        _ => return None,
    };
    let full = match query {
        Some(q) if !q.is_empty() && !path.contains('?') => format!("{path}?{q}"),
        _ => path,
    };
    page_path(&full)
}

/// An address for the owner's browser: http or https only.
pub fn web_url(u: &str) -> Option<&str> {
    let lower = u.get(..8)?.to_ascii_lowercase();
    ((lower.starts_with("http://") || lower.starts_with("https://")) && u.len() < 4000 && !u.chars().any(|c| c.is_control() || c == ' ')).then_some(u)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_lead_to_page_paths() {
        assert_eq!(link_path("keel://session/01a1ffe5-99ea").as_deref(), Some("/s/01a1ffe5-99ea"));
        assert_eq!(link_path("keel://s/abc?approval=ap_1").as_deref(), Some("/s/abc?approval=ap_1"));
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
            "keel://session/abc#frag",
            "https://example.com/",
            "keel://settings/a/b",
            "keel://session/<script>",
        ] {
            assert_eq!(link_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn page_paths_are_a_closed_set() {
        for good in ["/", "/?inbox=1", "/s/abc", "/s/01a1-ff?e=ev_1&approval=x", "/p/proj", "/settings", "/settings/models"] {
            assert!(page_path(good).is_some(), "{good}");
        }
        for bad in ["", "s/abc", "//evil.example/", "/api/drain", "/s/", "/s/a/b", "/settings/a/b", "/s/a?x=javascript:alert(1)", "/ws", "/s/a?q=a b"] {
            assert!(page_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_web_addresses_go_to_the_browser() {
        assert!(web_url("https://example.com/a?b=c").is_some());
        assert!(web_url("HTTP://example.com/").is_some());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "keel://new", "ftp://x/", "https://exa mple.com", "http://x\n/"] {
            assert!(web_url(bad).is_none(), "{bad}");
        }
    }
}
