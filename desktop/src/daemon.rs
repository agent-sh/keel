//! Finding the daemon, following it across its restarts, and starting it.
//!
//! The shell is a program of the daemon's own account on its own machine, so
//! the daemon admits it the way it admits a local page: by who owns the
//! loopback socket. Where the daemon cannot read that (it then asks for the
//! access token), the shell sends the token it reads from the state folder,
//! which only the owner's account can read. Nothing is added to admission.
use crate::http;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_URL: &str = "http://127.0.0.1:47960";
/// A daemon that went away comes back within this when it restarts itself;
/// past it the shell says the daemon is not running.
pub const RESTART_GRACE: Duration = Duration::from_secs(12);

/// What the command line and the environment named.
#[derive(Clone, Default, Debug)]
pub struct Where {
    pub url: Option<String>,
    pub state_dir: Option<PathBuf>,
    pub keel: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Link {
    /// The daemon answers.
    Up,
    /// It answered a moment ago: a restart or an upgrade is under way.
    Restarting,
    /// Nothing answers.
    Down,
}

#[derive(Clone, Debug)]
pub enum Event {
    Link { link: Link, url: String },
    Needs(u32),
    Notify { key: String, alert: String, title: String, body: String, urgent: bool },
    Withdraw(String),
    Snooze(Option<i64>),
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The daemon's state folder as the daemon itself picks it.
pub fn state_dir(w: &Where) -> PathBuf {
    w.state_dir.clone().or_else(|| env_path("KEEL_STATE_DIR")).unwrap_or_else(|| env_path("XDG_STATE_HOME").unwrap_or_else(|| home().join(".local/state")).join("keel-bun"))
}

fn alive(pid: u64) -> bool {
    !cfg!(target_os = "linux") || Path::new(&format!("/proc/{pid}")).exists()
}

/// The address a live daemon wrote in a note (`{ pid, url }`).
pub fn noted(text: &str, alive: impl Fn(u64) -> bool) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let pid = v.get("pid")?.as_u64()?;
    let url = v.get("url")?.as_str()?;
    alive(pid).then(|| url.trim_end_matches('/').to_string())
}

/// The daemon's address, as the command line finds it: the one named, then
/// KEEL_URL, then the one the state folder's daemon recorded, then the
/// service's daemon (only when no folder was named), then the default bind.
pub fn find(w: &Where) -> String {
    let trim = |u: &str| u.trim_end_matches('/').to_string();
    if let Some(u) = &w.url {
        return trim(u);
    }
    if let Ok(u) = std::env::var("KEEL_URL") {
        if !u.is_empty() {
            return trim(&u);
        }
    }
    if let Some(u) = fs::read_to_string(state_dir(w).join("daemon.lock")).ok().and_then(|t| noted(&t, alive)) {
        return u;
    }
    if w.state_dir.is_none() && env_path("KEEL_STATE_DIR").is_none() {
        let note = env_path("XDG_RUNTIME_DIR").unwrap_or_else(|| home().join(".cache")).join("keel-bun/service.json");
        if let Some(u) = fs::read_to_string(note).ok().and_then(|t| noted(&t, alive)) {
            return u;
        }
    }
    DEFAULT_URL.to_string()
}

/// The access token of the state folder, when this account can read it.
pub fn token(w: &Where) -> Option<String> {
    fs::read_to_string(state_dir(w).join("api-token")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn healthy(url: &str, token: Option<&str>) -> bool {
    http::request(url, "GET", "/api/health", None, token, Duration::from_millis(1500))
        .ok()
        .filter(|r| r.status == 200)
        .and_then(|r| serde_json::from_str::<Value>(&r.body).ok())
        .is_some_and(|v| v.get("pid").is_some_and(Value::is_number))
}

fn told(event: &str, data: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(data).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(match event {
        "hello" => Event::Needs(v.get("needs")?.as_u64()? as u32),
        "needs" => Event::Needs(v.get("n")?.as_u64()? as u32),
        "notify" => Event::Notify { key: s("key"), alert: s("alert"), title: s("title"), body: s("body"), urgent: v.get("urgency").and_then(Value::as_u64) == Some(2) },
        "withdraw" => Event::Withdraw(s("key")),
        "snooze" => Event::Snooze(v.get("until_ms").and_then(Value::as_i64)),
        _ => return None,
    })
}

/// Follows the daemon for the life of the shell, on a thread of its own.
pub fn watch(w: Where, engine: &'static str, tell: impl Fn(Event) + Send + 'static) {
    thread::spawn(move || {
        let mut last_up: Option<Instant> = None;
        let mut said: Option<(Link, String)> = None;
        let mut say = |link: Link, url: &str, tell: &dyn Fn(Event)| {
            if said.as_ref().is_some_and(|(l, u)| *l == link && u == url) {
                return;
            }
            said = Some((link.clone(), url.to_string()));
            tell(Event::Link { link, url: url.to_string() });
        };
        loop {
            let url = find(&w);
            let token = token(&w);
            if healthy(&url, token.as_deref()) {
                say(Link::Up, &url, &tell);
                let path = format!("/api/shell/events?engine={engine}&version={}", env!("CARGO_PKG_VERSION"));
                let hello = http::stream(&url, &path, token.as_deref(), Duration::from_secs(20), |event, data| {
                    if let Some(e) = told(event, data) {
                        tell(e);
                        // A hello carries the snooze as well as the count.
                        if event == "hello" {
                            if let Some(e) = told("snooze", &serde_json::from_str::<Value>(data).map(|v| serde_json::json!({ "until_ms": v.get("snooze_until") }).to_string()).unwrap_or_default()) {
                                tell(e);
                            }
                        }
                    }
                    true
                });
                if hello.is_err() {
                    // A daemon without the shell's stream (an older build): it is followed by its
                    // health alone, and it goes on showing its notifications itself.
                    while healthy(&url, token.as_deref()) {
                        thread::sleep(Duration::from_secs(2));
                    }
                }
                last_up = Some(Instant::now());
                say(Link::Restarting, &url, &tell);
            } else if last_up.is_some_and(|t| t.elapsed() < RESTART_GRACE) {
                say(Link::Restarting, &url, &tell);
            } else {
                say(Link::Down, &url, &tell);
            }
            thread::sleep(Duration::from_millis(if last_up.is_some_and(|t| t.elapsed() < RESTART_GRACE) { 250 } else { 800 }));
        }
    });
}

/// The keel binary: the one named, KEEL_BIN, the one beside this program,
/// then the owner's PATH.
pub fn keel_bin(w: &Where) -> Option<PathBuf> {
    let beside = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("keel")));
    let named = [w.keel.clone(), env_path("KEEL_BIN"), beside, Some(home().join(".local/bin/keel"))];
    if let Some(p) = named.into_iter().flatten().find(|p| p.is_file()) {
        return Some(p);
    }
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join("keel")).find(|p| p.is_file()))
}

/// The arguments that start the daemon where the shell looks for it.
pub fn serve_args(w: &Where) -> Vec<String> {
    let mut args = vec!["serve".to_string()];
    if let Some(bind) = w.url.as_deref().and_then(|u| http::authority(u).ok()) {
        args.extend(["--bind".to_string(), bind.to_string()]);
    }
    if let Some(d) = &w.state_dir {
        args.extend(["--state-dir".to_string(), d.display().to_string()]);
    }
    args
}

/// Starts the daemon as a process of its own: it outlives the shell.
pub fn start(w: &Where, log: &Path) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    let bin = keel_bin(w).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the keel program was not found beside the app or on the PATH"))?;
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir)?;
    }
    let out = fs::OpenOptions::new().create(true).append(true).open(log)?;
    let mut child = Command::new(bin).args(serve_args(w)).stdin(Stdio::null()).stdout(out.try_clone()?).stderr(out).process_group(0).spawn()?;
    // Reaped when it ends, so it never lingers as a dead entry of the shell.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// A call to the daemon off the main thread; the answer comes back through `done`.
pub fn call(w: &Where, method: &'static str, path: String, body: Option<String>, done: impl FnOnce(Option<Value>) + Send + 'static) {
    let w = w.clone();
    thread::spawn(move || {
        let url = find(&w);
        let r = http::request(&url, method, &path, body.as_deref(), token(&w).as_deref(), Duration::from_secs(5)).ok();
        done(r.filter(|r| r.status / 100 == 2).and_then(|r| serde_json::from_str(&r.body).ok()));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_of_a_live_daemon_gives_its_address() {
        assert_eq!(noted(r#"{"pid":7,"url":"http://127.0.0.1:1234/"}"#, |_| true).as_deref(), Some("http://127.0.0.1:1234"));
        assert_eq!(noted(r#"{"pid":7,"url":"http://127.0.0.1:1234"}"#, |_| false), None);
        assert_eq!(noted(r#"{"pid":7}"#, |_| true), None);
        assert_eq!(noted("not json", |_| true), None);
    }

    #[test]
    fn the_named_address_wins() {
        let w = Where { url: Some("http://127.0.0.1:5/".into()), ..Default::default() };
        assert_eq!(find(&w), "http://127.0.0.1:5");
    }

    #[test]
    fn serve_is_started_where_the_shell_looks() {
        assert_eq!(serve_args(&Where::default()), ["serve"]);
        let w = Where { url: Some("http://127.0.0.1:48000".into()), state_dir: Some("/x/state".into()), keel: None };
        assert_eq!(serve_args(&w), ["serve", "--bind", "127.0.0.1:48000", "--state-dir", "/x/state"]);
    }

    #[test]
    fn the_stream_is_read_into_events() {
        assert!(matches!(told("hello", r#"{"pid":1,"needs":3,"snooze_until":null}"#), Some(Event::Needs(3))));
        assert!(matches!(told("needs", r#"{"n":0}"#), Some(Event::Needs(0))));
        match told("notify", r#"{"key":"s1","alert":"a1","title":"T","body":"B","urgency":2,"kind":"approval"}"#) {
            Some(Event::Notify { key, alert, title, body, urgent }) => assert_eq!((key.as_str(), alert.as_str(), title.as_str(), body.as_str(), urgent), ("s1", "a1", "T", "B", true)),
            other => panic!("{other:?}"),
        }
        assert!(matches!(told("snooze", r#"{"until_ms":null}"#), Some(Event::Snooze(None))));
        assert!(matches!(told("snooze", r#"{"until_ms":99}"#), Some(Event::Snooze(Some(99)))));
        assert!(told("unknown", "{}").is_none());
        assert!(told("needs", "garbage").is_none());
    }
}
