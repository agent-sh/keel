//! What the shell remembers between runs: the window's size and the
//! page's last colors (so the title bar and the first frame match the page
//! before it has loaded). One small JSON file in the shell's own folder.
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub dark: bool,
    pub bg: String,
    pub panel: String,
    pub fg: String,
    pub muted: String,
    pub line: String,
    pub need: String,
    pub scale: f64,
}

impl Look {
    /// The page's tokens (ui/src/styles.css) as sRGB, for before the page has said its own.
    pub fn of(dark: bool) -> Self {
        if dark {
            Self { dark, bg: "#16191e".into(), panel: "#101317".into(), fg: "#e6e9ee".into(), muted: "#b1b6bf".into(), line: "#2a2e36".into(), need: "#a98bf5".into(), scale: 1.0 }
        } else {
            Self { dark, bg: "#f2f4f7".into(), panel: "#e2e5ea".into(), fg: "#16191f".into(), muted: "#474c56".into(), line: "#d2d5db".into(), need: "#7a3fe0".into(), scale: 1.0 }
        }
    }
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa`: the only form of color the shell puts in its style.
pub fn hex(s: &str) -> Option<&str> {
    let h = s.strip_prefix('#')?;
    (matches!(h.len(), 3 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit())).then_some(s)
}

#[derive(Clone, Debug)]
pub struct Prefs {
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
    pub look: Look,
    /// The owner agreed to the app's global shortcuts: they are asked for again at each start
    /// (the desktop answers without a dialog), until the owner says no there.
    pub shortcuts: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { width: 1320, height: 860, maximized: false, look: Look::of(false), shortcuts: false }
    }
}

/// The shell's own folder: KEEL_DESKTOP_DIR, else under the XDG data home.
pub fn dir() -> PathBuf {
    let env = |n: &str| std::env::var_os(n).filter(|v| !v.is_empty()).map(PathBuf::from);
    env("KEEL_DESKTOP_DIR").unwrap_or_else(|| env("XDG_DATA_HOME").unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")).join("keel-desktop"))
}

impl Prefs {
    pub fn parse(text: &str) -> Self {
        let d = Self::default();
        let Ok(v) = serde_json::from_str::<Value>(text) else { return d };
        let int = |k: &str, min: i64, or: i32| v.get(k).and_then(Value::as_i64).filter(|n| *n >= min && *n <= 16000).map_or(or, |n| n as i32);
        let base = Look::of(v.pointer("/look/dark").and_then(Value::as_bool).unwrap_or(false));
        let color = |k: &str, or: &str| v.pointer(&format!("/look/{k}")).and_then(Value::as_str).and_then(hex).unwrap_or(or).to_string();
        Self {
            width: int("width", 480, d.width),
            height: int("height", 320, d.height),
            maximized: v.get("maximized").and_then(Value::as_bool).unwrap_or(false),
            shortcuts: v.get("shortcuts").and_then(Value::as_bool).unwrap_or(false),
            look: Look {
                dark: base.dark,
                bg: color("bg", &base.bg),
                panel: color("panel", &base.panel),
                fg: color("fg", &base.fg),
                muted: color("muted", &base.muted),
                line: color("line", &base.line),
                need: color("need", &base.need),
                scale: v.pointer("/look/scale").and_then(Value::as_f64).filter(|s| (0.5..=3.0).contains(s)).unwrap_or(1.0),
            },
        }
    }

    pub fn load() -> Self {
        fs::read_to_string(dir().join("shell.json")).map(|t| Self::parse(&t)).unwrap_or_default()
    }

    pub fn text(&self) -> String {
        let l = &self.look;
        json!({ "width": self.width, "height": self.height, "maximized": self.maximized, "shortcuts": self.shortcuts,
            "look": { "dark": l.dark, "bg": l.bg, "panel": l.panel, "fg": l.fg, "muted": l.muted, "line": l.line, "need": l.need, "scale": l.scale } })
        .to_string()
    }

    /// Whole or not at all: written beside, then moved into place.
    pub fn save(&self) {
        let d = dir();
        let _ = fs::create_dir_all(&d);
        let tmp = d.join("shell.json.tmp");
        if fs::write(&tmp, self.text()).is_ok() {
            let _ = fs::rename(tmp, d.join("shell.json"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_saved_is_read_back() {
        let mut p = Prefs::default();
        p.width = 1920;
        p.height = 1040;
        p.maximized = true;
        p.look = Look { scale: 1.2, ..Look::of(true) };
        let q = Prefs::parse(&p.text());
        assert_eq!((q.width, q.height, q.maximized), (1920, 1040, true));
        assert_eq!(q.look, p.look);
    }

    #[test]
    fn a_damaged_file_gives_the_defaults() {
        let d = Prefs::default();
        for text in ["", "not json", "[]", r#"{"width":-5,"height":99999999,"zoom":"big"}"#, r#"{"width":10,"zoom":900}"#] {
            let p = Prefs::parse(text);
            assert_eq!((p.width, p.height), (d.width, d.height), "{text}");
        }
    }

    #[test]
    fn only_plain_colors_reach_the_style() {
        let p = Prefs::parse(r##"{"look":{"dark":true,"bg":"red; } window { background: url(x)","fg":"#fff","line":"#12345"}}"##);
        let d = Look::of(true);
        assert_eq!(p.look.bg, d.bg);
        assert_eq!(p.look.fg, "#fff");
        assert_eq!(p.look.line, d.line);
        assert!(hex("#a1b2c3").is_some() && hex("#a1b2c3d4").is_some() && hex("a1b2c3").is_none() && hex("#zzz").is_none());
    }
}
