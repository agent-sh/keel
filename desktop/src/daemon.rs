//! Finding the daemon, following it across its restarts, and starting it.
//!
//! The app is a program of the daemon's own account on its own machine, so
//! the daemon admits it the way it admits a local page: by who owns the
//! loopback socket. It therefore sends no token. Only when a daemon proven to
//! be this account's refuses a call (it cannot read who owns the socket) is
//! the state folder's token sent, to that daemon alone. A listener that merely
//! sits on the daemon's port never sees it, and an address that is not this
//! machine's is not spoken to at all. Nothing is added to admission.
use crate::http;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_URL: &str = "http://127.0.0.1:47960";
/// The daemon's unit, as `keel service` writes it.
pub const UNIT: &str = "keel-bun.service";
/// A daemon that went away comes back within this when it restarts itself;
/// past it the app says the daemon is not running.
pub const RESTART_GRACE: Duration = Duration::from_secs(12);
/// The daemon's output kept by the app when it starts one: one file of this size and the one before it.
const LOG_MAX: u64 = 2 << 20;

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
    /// Why the app does not speak to the address it was given.
    Refused(String),
    Needs(u32),
    Notify { key: String, alert: String, title: String, body: String, urgent: bool, ack: Option<u64> },
    Withdraw(String),
    Snooze(Option<i64>),
}

/// Where the daemon is and where it keeps its state.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub url: String,
    pub state_dir: PathBuf,
    /// Named by the owner (the command line or KEEL_URL), not found.
    pub named: bool,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn env_url() -> Option<String> {
    std::env::var("KEEL_URL").ok().filter(|u| !u.is_empty())
}

/// The daemon's state folder as the daemon itself picks it.
pub fn state_dir(w: &Where) -> PathBuf {
    w.state_dir.clone().or_else(|| env_path("KEEL_STATE_DIR")).unwrap_or_else(|| env_path("XDG_STATE_HOME").unwrap_or_else(|| home().join(".local/state")).join("keel-bun"))
}

fn alive(pid: u64) -> bool {
    !cfg!(target_os = "linux") || Path::new(&format!("/proc/{pid}")).exists()
}

/// The account a process runs as.
fn owner(pid: u64) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(format!("/proc/{pid}")).ok().map(|m| m.uid())
}

fn me() -> u32 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(u32::MAX)
}

/// What a live daemon wrote in a note: its pid, its address and, in the service's note, its state folder.
pub fn noted(text: &str, alive: impl Fn(u64) -> bool) -> Option<(u64, String, Option<PathBuf>)> {
    let v: Value = serde_json::from_str(text).ok()?;
    let pid = v.get("pid")?.as_u64()?;
    let url = v.get("url")?.as_str()?;
    alive(pid).then(|| (pid, url.trim_end_matches('/').to_string(), v.get("state_dir").and_then(Value::as_str).map(PathBuf::from)))
}

fn service_note() -> PathBuf {
    env_path("XDG_RUNTIME_DIR").unwrap_or_else(|| home().join(".cache")).join("keel-bun/service.json")
}

/// The daemon's address, as the command line finds it: the one named, then
/// KEEL_URL, then the one the state folder's daemon recorded, then the
/// service's daemon (only when no folder was named), then the default bind.
pub fn find(w: &Where) -> Found {
    let trim = |u: &str| u.trim_end_matches('/').to_string();
    let dir = state_dir(w);
    if let Some(u) = w.url.clone().or_else(env_url) {
        return Found { url: trim(&u), state_dir: dir, named: true };
    }
    if let Some((_, url, _)) = fs::read_to_string(dir.join("daemon.lock")).ok().and_then(|t| noted(&t, alive)) {
        return Found { url, state_dir: dir, named: false };
    }
    if w.state_dir.is_none() && env_path("KEEL_STATE_DIR").is_none() {
        if let Some((_, url, Some(state))) = fs::read_to_string(service_note()).ok().and_then(|t| noted(&t, alive)) {
            return Found { url, state_dir: state, named: false };
        }
    }
    Found { url: DEFAULT_URL.to_string(), state_dir: dir, named: false }
}

/// An address of this machine: the app speaks to no other.
pub fn loopback(url: &str) -> bool {
    let Ok(host) = http::authority(url) else { return false };
    let name = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(h, _)| h),
    };
    let lower = name.to_ascii_lowercase();
    lower == "localhost" || lower.ends_with(".localhost") || lower == "::1" || (lower.starts_with("127.") && lower.split('.').count() == 4 && lower.split('.').all(|p| p.parse::<u8>().is_ok()))
}

/// Whether the state folder's token may be sent to the daemon at `url`: only
/// after it refused a call for want of it, and only when the folder's own lock
/// names a live process of this account at that same address.
pub fn may_send_token(status: u16, url: &str, lock: Option<(u64, String)>, owner: impl Fn(u64) -> Option<u32>, me: u32) -> bool {
    (status == 401 || status == 403) && loopback(url) && lock.is_some_and(|(pid, at)| at == url && owner(pid) == Some(me))
}

fn token_for(found: &Found, status: u16) -> Option<String> {
    let lock = fs::read_to_string(found.state_dir.join("daemon.lock")).ok().and_then(|t| noted(&t, alive)).map(|(pid, url, _)| (pid, url));
    if !may_send_token(status, &found.url, lock, owner, me()) {
        return None;
    }
    fs::read_to_string(found.state_dir.join("api-token")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// One call. Without a token first; with it only when `may_send_token` allows.
pub fn ask(found: &Found, method: &str, path: &str, body: Option<&str>, timeout: Duration) -> io::Result<(http::Resp, Option<String>)> {
    if !loopback(&found.url) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not an address of this machine"));
    }
    let first = http::request(&found.url, method, path, body, None, timeout)?;
    match token_for(found, first.status) {
        Some(token) => Ok((http::request(&found.url, method, path, body, Some(&token), timeout)?, Some(token))),
        None => Ok((first, None)),
    }
}

/// The daemon's own answer on its health path, which takes no token from anyone.
fn healthy(url: &str) -> bool {
    http::request(url, "GET", "/api/health", None, None, Duration::from_millis(1500))
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
        "notify" => Event::Notify { key: s("key"), alert: s("alert"), title: s("title"), body: s("body"), urgent: v.get("urgency").and_then(Value::as_u64) == Some(2), ack: v.get("ack").and_then(Value::as_u64) },
        "withdraw" => Event::Withdraw(s("key")),
        "snooze" => Event::Snooze(v.get("until_ms").and_then(Value::as_i64)),
        _ => return None,
    })
}

/// Follows the daemon for the life of the app, on a thread of its own.
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
            let found = find(&w);
            if !loopback(&found.url) {
                say(Link::Down, &found.url, &tell);
                tell(Event::Refused(format!("The app opens a daemon on this machine only, and {} is not one. Open that one in a browser.", found.url)));
                thread::sleep(Duration::from_secs(5));
                continue;
            }
            if healthy(&found.url) {
                say(Link::Up, &found.url, &tell);
                // A first call tells whether this daemon wants the token (it does not, on a machine that can say who owns a socket).
                let token = ask(&found, "GET", "/api/shell", None, Duration::from_secs(3)).ok().and_then(|(_, t)| t);
                // `acks=1`: the app shows what it is handed and says so each time (the daemon shows what it hears nothing about).
                let path = format!("/api/shell/events?engine={engine}&version={}&acks=1", env!("CARGO_PKG_VERSION"));
                let hello = http::stream(&found.url, &path, token.as_deref(), Duration::from_secs(20), |event, data| {
                    if let Some(e) = told(event, data) {
                        tell(e);
                    }
                    if event == "hello" {
                        let v = serde_json::from_str::<Value>(data).unwrap_or_default();
                        if let Some(e) = told("snooze", &serde_json::json!({ "until_ms": v.get("snooze_until") }).to_string()) {
                            tell(e);
                        }
                    }
                    true
                });
                if hello.is_err() {
                    // A daemon without the app's stream (an older build): it is followed by its
                    // health alone, and it goes on showing its notifications itself.
                    while healthy(&found.url) {
                        thread::sleep(Duration::from_secs(2));
                    }
                }
                last_up = Some(Instant::now());
                // The daemon closed the stream but answers (it detached an app that said nothing in time): attach again, say nothing.
                if healthy(&found.url) {
                    thread::sleep(Duration::from_millis(400));
                    continue;
                }
                say(Link::Restarting, &found.url, &tell);
            } else if last_up.is_some_and(|t| t.elapsed() < RESTART_GRACE) {
                say(Link::Restarting, &found.url, &tell);
            } else {
                say(Link::Down, &found.url, &tell);
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
    on_path("keel")
}

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file()))
}

/// How the daemon is started.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// The owner's service runs it: `systemctl --user start <unit>`.
    Unit,
    /// `keel <args>` as a process of its own: in a scope of the service manager,
    /// or in a session of its own, so nothing that stops the app takes it.
    Serve { args: Vec<String>, scope: bool },
}

/// What "Start Keel" does. With a service unit installed and nothing named
/// that says otherwise, the service starts it: the app never puts a second,
/// empty Keel on the default state folder beside the owner's own. Otherwise
/// the daemon is started where the app will look: on the address it was given
/// (the command line or KEEL_URL) and the state folder it was given.
pub fn start_plan(w: &Where, env_url: Option<&str>, env_state: bool, unit: bool, service_manager: bool) -> Plan {
    let named = w.url.is_some() || w.state_dir.is_some() || env_url.is_some() || env_state;
    if unit && !named {
        return Plan::Unit;
    }
    let mut args = vec!["serve".to_string()];
    if let Some(bind) = w.url.as_deref().or(env_url).and_then(|u| http::authority(u).ok()) {
        args.extend(["--bind".to_string(), bind.to_string()]);
    }
    if let Some(d) = &w.state_dir {
        args.extend(["--state-dir".to_string(), d.display().to_string()]);
    }
    Plan::Serve { args, scope: service_manager }
}

fn unit_installed() -> bool {
    env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config")).join("systemd/user").join(UNIT).is_file()
}

/// The service manager of this account can be asked for a scope.
fn service_manager() -> bool {
    env_path("XDG_RUNTIME_DIR").is_some_and(|d| d.join("systemd/private").exists()) && on_path("systemd-run").is_some()
}

/// Starts the daemon as a process of its own: it outlives the app.
pub fn start(w: &Where, log: &Path) -> io::Result<()> {
    let plan = start_plan(w, env_url().as_deref(), env_path("KEEL_STATE_DIR").is_some(), unit_installed(), service_manager());
    if plan == Plan::Unit {
        let done = Command::new("systemctl").args(["--user", "start", UNIT]).stdin(Stdio::null()).status()?;
        return if done.success() { Ok(()) } else { Err(io::Error::other(format!("systemctl --user start {UNIT} failed"))) };
    }
    let Plan::Serve { args, scope } = plan else { unreachable!() };
    let bin = keel_bin(w).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the keel program was not found beside the app or on the PATH"))?;
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir)?;
    }
    // The daemon's output, bounded: this file and the one before it.
    if fs::metadata(log).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = fs::rename(log, log.with_extension("log.1"));
    }
    let out = fs::OpenOptions::new().create(true).append(true).open(log)?;
    let mut cmd = if scope {
        let mut c = Command::new("systemd-run");
        c.args(["--user", "--scope", "--collect", "--quiet", "--"]).arg(&bin);
        c
    } else if let Some(setsid) = on_path("setsid") {
        let mut c = Command::new(setsid);
        c.arg(&bin);
        c
    } else {
        Command::new(&bin)
    };
    let mut child = cmd.args(args).stdin(Stdio::null()).stdout(out.try_clone()?).stderr(out).spawn()?;
    // Reaped when it ends, so it never lingers as a dead entry of the app.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// A call to the daemon off the main thread; the answer comes back through `done`.
pub fn call(w: &Where, method: &'static str, path: String, body: Option<String>, done: impl FnOnce(Option<Value>) + Send + 'static) {
    let w = w.clone();
    thread::spawn(move || {
        let r = ask(&find(&w), method, &path, body.as_deref(), Duration::from_secs(5)).ok().map(|(r, _)| r);
        done(r.filter(|r| r.status / 100 == 2).and_then(|r| serde_json::from_str(&r.body).ok()));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_of_a_live_daemon_gives_its_address() {
        assert_eq!(noted(r#"{"pid":7,"url":"http://127.0.0.1:1234/"}"#, |_| true), Some((7, "http://127.0.0.1:1234".to_string(), None)));
        assert_eq!(noted(r#"{"pid":7,"url":"http://127.0.0.1:1234","state_dir":"/s"}"#, |_| true).and_then(|n| n.2), Some(PathBuf::from("/s")));
        assert_eq!(noted(r#"{"pid":7,"url":"http://127.0.0.1:1234"}"#, |_| false), None);
        assert_eq!(noted(r#"{"pid":7}"#, |_| true), None);
        assert_eq!(noted("not json", |_| true), None);
    }

    #[test]
    fn the_named_address_wins() {
        let w = Where { url: Some("http://127.0.0.1:5/".into()), ..Default::default() };
        let f = find(&w);
        assert_eq!((f.url.as_str(), f.named), ("http://127.0.0.1:5", true));
    }

    #[test]
    fn only_this_machine_is_spoken_to() {
        for ok in ["http://127.0.0.1:47960", "http://localhost:1", "http://keel.localhost:8080", "http://[::1]:47960", "http://127.8.9.1:2"] {
            assert!(loopback(ok), "{ok}");
        }
        for no in ["http://example.com:47960", "http://10.0.0.5:47960", "http://127.0.0.1.evil.example:1", "http://localhost.evil.example", "https://127.0.0.1:1", "http://1270.0.0.1:1", "http://[::2]:1", ""] {
            assert!(!loopback(no), "{no}");
        }
    }

    // The review's case: a listener on the daemon's port while the daemon is down got the token on every poll.
    #[test]
    fn the_token_goes_only_to_this_accounts_daemon_after_it_asked() {
        let url = "http://127.0.0.1:47960";
        let lock = || Some((42u64, url.to_string()));
        let mine = |pid: u64| (pid == 42).then_some(1000u32);
        // Never unasked: a health poll, a call that was answered, a stranger's 500.
        for status in [200, 204, 404, 500, 0] {
            assert!(!may_send_token(status, url, lock(), mine, 1000), "{status}");
        }
        assert!(may_send_token(403, url, lock(), mine, 1000));
        assert!(may_send_token(401, url, lock(), mine, 1000));
        // A listener that is not the state folder's daemon: no lock, a dead or foreign process, another address.
        assert!(!may_send_token(403, url, None, mine, 1000));
        assert!(!may_send_token(403, url, Some((7, url.to_string())), mine, 1000));
        assert!(!may_send_token(403, url, lock(), |_| Some(1001), 1000));
        assert!(!may_send_token(403, url, Some((42, "http://127.0.0.1:1".to_string())), mine, 1000));
        // Another machine, whatever it says.
        assert!(!may_send_token(403, "http://example.com:47960", Some((42, "http://example.com:47960".to_string())), mine, 1000));
    }

    #[test]
    fn start_goes_to_the_service_unless_something_else_was_named() {
        let bare = Where::default();
        assert_eq!(start_plan(&bare, None, false, true, true), Plan::Unit);
        // No unit: a daemon of its own, in a scope when the service manager is there.
        assert_eq!(start_plan(&bare, None, false, false, true), Plan::Serve { args: vec!["serve".into()], scope: true });
        assert_eq!(start_plan(&bare, None, false, false, false), Plan::Serve { args: vec!["serve".into()], scope: false });
        // With KEEL_URL set the daemon is started where the app will watch, not on the default bind.
        assert_eq!(start_plan(&bare, Some("http://127.0.0.1:48000"), false, true, false), Plan::Serve { args: vec!["serve".into(), "--bind".into(), "127.0.0.1:48000".into()], scope: false });
        let w = Where { url: Some("http://127.0.0.1:48001".into()), state_dir: Some("/x/state".into()), keel: None };
        assert_eq!(start_plan(&w, Some("http://127.0.0.1:48000"), false, true, true), Plan::Serve { args: vec!["serve".into(), "--bind".into(), "127.0.0.1:48001".into(), "--state-dir".into(), "/x/state".into()], scope: true });
        // A state folder from the environment is the daemon's to read; it still keeps the service out of it.
        assert_eq!(start_plan(&bare, None, true, true, false), Plan::Serve { args: vec!["serve".into()], scope: false });
    }

    #[test]
    fn the_stream_is_read_into_events() {
        assert!(matches!(told("hello", r#"{"pid":1,"needs":3,"snooze_until":null}"#), Some(Event::Needs(3))));
        assert!(matches!(told("needs", r#"{"n":0}"#), Some(Event::Needs(0))));
        match told("notify", r#"{"key":"s1","alert":"a1","title":"T","body":"B","urgency":2,"kind":"approval","ack":9}"#) {
            Some(Event::Notify { key, alert, title, body, urgent, ack }) => assert_eq!((key.as_str(), alert.as_str(), title.as_str(), body.as_str(), urgent, ack), ("s1", "a1", "T", "B", true, Some(9))),
            other => panic!("{other:?}"),
        }
        assert!(matches!(told("snooze", r#"{"until_ms":null}"#), Some(Event::Snooze(None))));
        assert!(matches!(told("snooze", r#"{"until_ms":99}"#), Some(Event::Snooze(Some(99)))));
        assert!(told("unknown", "{}").is_none());
        assert!(told("needs", "garbage").is_none());
    }
}
