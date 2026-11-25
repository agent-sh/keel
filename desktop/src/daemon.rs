//! Finding the daemon, following it across its restarts, and starting it.
//!
//! The app is a program of the daemon's own account on its own machine, so
//! the daemon admits it the way it admits a local page: by who owns the
//! loopback socket. It therefore sends no token. Only when a daemon proven to
//! be this account's refuses a call (it cannot read who owns the socket) is
//! the state folder's token sent, to that daemon alone: the state folder's
//! lock must name a live process of this account by its pid and by when it
//! was born (a pid alone is given to another process once its own has gone),
//! and the socket listening on the port must be this account's. A listener
//! that merely sits on the daemon's port never sees it, and an address that
//! is not this machine's is not spoken to at all. Nothing is added to
//! admission.
use crate::http;
use serde_json::Value;
use std::fs;
use std::io;
use std::net::{IpAddr, ToSocketAddrs};
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

impl Link {
    /// The state in the words every place of the app says it: the title bar, the tray, the
    /// calm page, and the page inside the window, which is told them. Nothing for `Up`.
    pub fn said(&self) -> &'static str {
        match self {
            Link::Up => "",
            Link::Restarting => "Keel is restarting",
            Link::Down => "Keel is not running",
        }
    }
}

/// The state of a listed session, as the frame says it: the three the list is made of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Dot {
    /// It waits on the owner.
    Need,
    /// An alert of it is unread.
    Unread,
    /// It works.
    Work,
}

impl Dot {
    pub fn of(state: &str) -> Option<Self> {
        match state {
            "need" => Some(Dot::Need),
            "unread" => Some(Dot::Unread),
            "work" => Some(Dot::Work),
            _ => None,
        }
    }
}

/// A session the tray's menu lists: its id, its title, its state and the word for it, as the daemon says them.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub id: String,
    pub title: String,
    /// None for a state this app does not know: the line has no dot.
    pub state: Option<Dot>,
    pub word: String,
}

/// The most the menu lists.
pub const LISTED: usize = 5;

/// The sessions of a frame: those that have an id of the page's shape and nothing else, at most `LISTED`.
fn listed(v: &Value) -> Vec<Listed> {
    let s = |l: &Value, k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    v.get("list")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|l| Listed { id: s(l, "id"), title: s(l, "title"), state: Dot::of(&s(l, "state")), word: s(l, "word") }).filter(|l| crate::links::page_path(&format!("/s/{}", l.id)).is_some()).take(LISTED).collect())
        .unwrap_or_default()
}

/// The daemon's words on where a reminder reaches, when it says it is this desktop only.
fn reach(v: &Value) -> Option<String> {
    v.get("reach").and_then(Value::as_str).filter(|r| !r.trim().is_empty()).map(|r| r.chars().take(120).collect())
}

#[derive(Clone, Debug)]
pub enum Event {
    Link { link: Link, url: String },
    /// Why the app does not speak to the address it was given.
    Refused(String),
    /// One frame: what waits on the owner and the sessions the tray's menu lists, so the two never differ.
    Needs { n: u32, unread: u32, list: Vec<Listed>, reach: Option<String> },
    /// `ack` and `stream` go back to the daemon once the notification is on screen.
    Notify { key: String, alert: String, title: String, body: String, icon: String, urgent: bool, silent: bool, ack: Option<u64>, stream: String },
    Withdraw(String),
    Snooze(Option<i64>),
    /// Whether this app is the one the daemon hands the alerts to (another shell attached first takes them).
    Takes(bool),
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

/// What a live daemon wrote in a note: its pid, when it was born, its address and, in the service's note, its state folder.
#[derive(Clone, Debug, PartialEq)]
pub struct Noted {
    pub pid: u64,
    pub born: Option<String>,
    pub url: String,
    pub state_dir: Option<PathBuf>,
}

pub fn noted(text: &str, alive: impl Fn(u64) -> bool) -> Option<Noted> {
    let v: Value = serde_json::from_str(text).ok()?;
    let pid = v.get("pid")?.as_u64()?;
    let url = v.get("url")?.as_str()?;
    alive(pid).then(|| Noted {
        pid,
        born: v.get("born").and_then(Value::as_str).map(String::from),
        url: url.trim_end_matches('/').to_string(),
        state_dir: v.get("state_dir").and_then(Value::as_str).map(PathBuf::from),
    })
}

/// What names one process for as long as the machine is up, as the daemon writes it in its
/// lock (src/core/pid.ts): the boot's id, and the clock ticks since boot at which it started.
pub fn born_in(stat: &str, boot: &str) -> Option<String> {
    let ticks = stat.get(stat.rfind(')')? + 2..)?.split(' ').nth(19)?;
    (!ticks.is_empty() && !boot.trim().is_empty()).then(|| format!("{}:{ticks}", boot.trim()))
}

fn born(pid: u64) -> Option<String> {
    born_in(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?, &fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?)
}

/// The accounts of the sockets listening on `port`, from the kernel's table of TCP sockets
/// (/proc/net/tcp and tcp6, as the daemon's own admission reads them): state 0A is listening,
/// the local port is the hexadecimal after the colon, the account is the eighth column.
pub fn listen_uids(table: &str, port: u16) -> Vec<u32> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            let local = f.get(1)?.rsplit_once(':')?.1;
            (f.get(3) == Some(&"0A") && u16::from_str_radix(local, 16).ok()? == port).then(|| f.get(7)?.parse().ok()).flatten()
        })
        .collect()
}

fn listeners(port: u16) -> Vec<u32> {
    ["/proc/net/tcp", "/proc/net/tcp6"].iter().filter_map(|t| fs::read_to_string(t).ok()).flat_map(|t| listen_uids(&t, port)).collect()
}

fn port_of(url: &str) -> u16 {
    http::authority(url).ok().and_then(|a| a.rsplit_once(':')).and_then(|(_, p)| p.parse().ok()).unwrap_or(80)
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
    if let Some(n) = fs::read_to_string(dir.join("daemon.lock")).ok().and_then(|t| noted(&t, alive)) {
        return Found { url: n.url, state_dir: dir, named: false };
    }
    if w.state_dir.is_none() && env_path("KEEL_STATE_DIR").is_none() {
        if let Some(Noted { url, state_dir: Some(state), .. }) = fs::read_to_string(service_note()).ok().and_then(|t| noted(&t, alive)) {
            return Found { url, state_dir: state, named: false };
        }
    }
    Found { url: DEFAULT_URL.to_string(), state_dir: dir, named: false }
}

/// The host of an address, without its port or brackets.
fn host_of(url: &str) -> Option<String> {
    let host = http::authority(url).ok()?;
    Some(match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or("").to_string(),
        None => host.rsplit_once(':').map_or(host, |(h, _)| h).to_string(),
    })
}

/// Whether every address a name resolved to is this machine's own loopback (and there is one).
pub fn all_here(addrs: &[IpAddr]) -> bool {
    !addrs.is_empty() && addrs.iter().all(IpAddr::is_loopback)
}

/// An address of this machine: the app speaks to no other. A loopback
/// address as written, or `localhost` and a name under it, which are taken
/// at their word only after they resolve: every address they resolve to must
/// be a loopback one (a hosts file can point such a name anywhere).
pub fn loopback(url: &str) -> bool {
    let Some(host) = host_of(url) else { return false };
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    let lower = host.to_ascii_lowercase();
    if lower != "localhost" && !lower.ends_with(".localhost") {
        return false;
    }
    (lower.as_str(), port_of(url)).to_socket_addrs().is_ok_and(|a| all_here(&a.map(|s| s.ip()).collect::<Vec<_>>()))
}

/// Why the app does not speak to an address, when it does not.
pub fn refusal(url: &str) -> Option<String> {
    (!loopback(url)).then(|| format!("{url} is not an address of this machine."))
}

/// Whether the state folder's token may be sent to the daemon at `url`: only
/// after it refused a call for want of it, and only when the folder's own
/// lock names, at that same address, a live process of this account that was
/// born when the lock says (`process` gives a pid's account and birth), and
/// every socket listening on the port is this account's.
pub fn may_send_token(status: u16, url: &str, lock: Option<&Noted>, process: impl Fn(u64) -> Option<(u32, String)>, listening: &[u32], me: u32) -> bool {
    (status == 401 || status == 403)
        && loopback(url)
        && !listening.is_empty()
        && listening.iter().all(|uid| *uid == me)
        && lock.is_some_and(|l| l.url == url && l.born.as_ref().is_some_and(|b| process(l.pid).is_some_and(|(uid, born)| uid == me && born == *b)))
}

fn token_for(found: &Found, status: u16) -> Option<String> {
    if status != 401 && status != 403 {
        return None;
    }
    let lock = fs::read_to_string(found.state_dir.join("daemon.lock")).ok().and_then(|t| noted(&t, alive));
    if !may_send_token(status, &found.url, lock.as_ref(), |pid| Some((owner(pid)?, born(pid)?)), &listeners(port_of(&found.url)), me()) {
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

fn told(event: &str, data: &str, stream: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(data).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(match event {
        "hello" => Event::Needs { n: v.get("needs")?.as_u64()? as u32, unread: v.get("unread").and_then(Value::as_u64).unwrap_or(0) as u32, list: listed(&v), reach: reach(&v) },
        "needs" => Event::Needs { n: v.get("n")?.as_u64()? as u32, unread: v.get("unread").and_then(Value::as_u64).unwrap_or(0) as u32, list: listed(&v), reach: reach(&v) },
        "notify" => Event::Notify { key: s("key"), alert: s("alert"), title: s("title"), body: s("body"), icon: s("icon"), urgent: v.get("urgency").and_then(Value::as_u64) == Some(2), silent: v.get("sound").and_then(Value::as_bool) == Some(false), ack: v.get("ack").and_then(Value::as_u64), stream: stream.to_string() },
        "withdraw" => Event::Withdraw(s("key")),
        "snooze" => Event::Snooze(v.get("until_ms").and_then(Value::as_i64)),
        "takes" => Event::Takes(v.get("takes")?.as_bool()?),
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
            if let Some(why) = refusal(&found.url) {
                say(Link::Down, &found.url, &tell);
                tell(Event::Refused(why));
                thread::sleep(Duration::from_secs(5));
                continue;
            }
            if healthy(&found.url) {
                say(Link::Up, &found.url, &tell);
                // A first call tells whether this daemon wants the token (it does not, on a machine that can say who owns a socket).
                let token = ask(&found, "GET", "/api/shell", None, Duration::from_secs(3)).ok().and_then(|(_, t)| t);
                // `acks=1`: the app shows what it is handed and says so each time (the daemon shows what it hears nothing about).
                let path = format!("/api/shell/events?engine={engine}&version={}&acks=1", env!("CARGO_PKG_VERSION"));
                // What this stream's hello gave it: an alert of this stream is acknowledged with it.
                let mut stream = String::new();
                let hello = http::stream(&found.url, &path, token.as_deref(), Duration::from_secs(20), |event, data| {
                    if event == "hello" {
                        let v = serde_json::from_str::<Value>(data).unwrap_or_default();
                        stream = v.get("stream").and_then(Value::as_str).unwrap_or("").to_string();
                        if let Some(e) = told("snooze", &serde_json::json!({ "until_ms": v.get("snooze_until") }).to_string(), &stream) {
                            tell(e);
                        }
                        // (A daemon that does not say hands the alerts to every app that acknowledges.)
                        tell(Event::Takes(v.get("takes").and_then(Value::as_bool).unwrap_or(true)));
                    }
                    if let Some(e) = told(event, data, &stream) {
                        tell(e);
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
    /// Nothing is started: the address named is not this machine's, and the app would not speak to a daemon there.
    Refused,
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
    if w.url.as_deref().or(env_url).is_some_and(|u| !loopback(u)) {
        return Plan::Refused;
    }
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

/// Starts the daemon as a process of its own: it outlives the app. Off the
/// caller's thread (asking the service manager can take a while); `done` is
/// told whether the start was made.
pub fn start(w: &Where, log: &Path, done: impl FnOnce(io::Result<()>) + Send + 'static) {
    let (w, log) = (w.clone(), log.to_path_buf());
    thread::spawn(move || done(start_now(&w, &log)));
}

fn start_now(w: &Where, log: &Path) -> io::Result<()> {
    let plan = start_plan(w, env_url().as_deref(), env_path("KEEL_STATE_DIR").is_some(), unit_installed(), service_manager());
    let (args, scope) = match plan {
        Plan::Refused => return Err(io::Error::new(io::ErrorKind::InvalidInput, "the address is not this machine's")),
        Plan::Unit => {
            let done = Command::new("systemctl").args(["--user", "start", UNIT]).stdin(Stdio::null()).status()?;
            return if done.success() { Ok(()) } else { Err(io::Error::other(format!("systemctl --user start {UNIT} failed"))) };
        }
        Plan::Serve { args, scope } => (args, scope),
    };
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
        let n = noted(r#"{"pid":7,"born":"boot:99","url":"http://127.0.0.1:1234/"}"#, |_| true).unwrap();
        assert_eq!((n.pid, n.url.as_str(), n.born.as_deref(), n.state_dir.clone()), (7, "http://127.0.0.1:1234", Some("boot:99"), None));
        assert_eq!(noted(r#"{"pid":7,"url":"http://127.0.0.1:1234","state_dir":"/s"}"#, |_| true).and_then(|n| n.state_dir), Some(PathBuf::from("/s")));
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
        for ok in ["http://127.0.0.1:47960", "http://[::1]:47960", "http://127.8.9.1:2"] {
            assert!(loopback(ok), "{ok}");
        }
        for no in ["http://example.com:47960", "http://10.0.0.5:47960", "http://127.0.0.1.evil.example:1", "http://localhost.evil.example", "https://127.0.0.1:1", "http://1270.0.0.1:1", "http://[::2]:1", ""] {
            assert!(!loopback(no), "{no}");
        }
        assert!(refusal("http://10.0.0.9:44825").is_some_and(|w| w.contains("10.0.0.9:44825")));
        assert!(refusal("http://127.0.0.1:47960").is_none());
    }

    // The review's case: a name under localhost was taken at its word; it is taken at what it resolves to.
    #[test]
    fn a_name_is_this_machine_only_when_every_address_it_resolves_to_is() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(all_here(&[ip("127.0.0.1"), ip("::1")]));
        assert!(!all_here(&[ip("127.0.0.1"), ip("10.0.0.9")]));
        assert!(!all_here(&[ip("192.168.1.4")]));
        assert!(!all_here(&[]));
    }

    #[test]
    fn a_process_is_named_by_its_boot_and_its_start() {
        let stat = "4242 (keel (serve) x) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 9 0 777123 1000 200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        assert_eq!(born_in(stat, "b00t-1d\n").as_deref(), Some("b00t-1d:777123"));
        assert_eq!(born_in("garbage", "b00t"), None);
        assert_eq!(born_in(stat, ""), None);
    }

    #[test]
    fn the_sockets_listening_on_a_port_have_owners() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:BB58 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0\n\
   1: 0100007F:BB58 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1001        0 12346 1 0000000000000000 20 4 30 10 -1\n\
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 12347 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(listen_uids(table, 0xBB58), [1000]);
        assert_eq!(listen_uids(table, 0x1F90), [1002]);
        assert!(listen_uids(table, 9).is_empty());
        assert!(listen_uids("", 9).is_empty());
    }

    // The review's cases: a listener on the daemon's port while the daemon is down got the token on
    // every poll; and a lock left by a crash, whose pid was since given to another process of this
    // account, got it too.
    #[test]
    fn the_token_goes_only_to_this_accounts_daemon_after_it_asked() {
        let url = "http://127.0.0.1:47960";
        let lock = Noted { pid: 42, born: Some("boot:500".into()), url: url.to_string(), state_dir: None };
        let daemon = |pid: u64| (pid == 42).then(|| (1000u32, "boot:500".to_string()));
        let mine = [1000u32];
        // Never unasked: a health poll, a call that was answered, a stranger's 500.
        for status in [200, 204, 404, 500, 0] {
            assert!(!may_send_token(status, url, Some(&lock), daemon, &mine, 1000), "{status}");
        }
        assert!(may_send_token(403, url, Some(&lock), daemon, &mine, 1000));
        assert!(may_send_token(401, url, Some(&lock), daemon, &mine, 1000));
        // No lock, a dead process, another account's process, another address.
        assert!(!may_send_token(403, url, None, daemon, &mine, 1000));
        assert!(!may_send_token(403, url, Some(&Noted { pid: 7, ..lock.clone() }), daemon, &mine, 1000));
        assert!(!may_send_token(403, url, Some(&lock), |_| Some((1001, "boot:500".to_string())), &mine, 1000));
        assert!(!may_send_token(403, url, Some(&Noted { url: "http://127.0.0.1:1".into(), ..lock.clone() }), daemon, &mine, 1000));
        // The pid is alive and this account's, but it is not the process the lock was written by:
        // born at another time, in another boot, or the lock does not say when.
        assert!(!may_send_token(403, url, Some(&lock), |_| Some((1000, "boot:90210".to_string())), &mine, 1000));
        assert!(!may_send_token(403, url, Some(&lock), |_| Some((1000, "other-boot:500".to_string())), &mine, 1000));
        assert!(!may_send_token(403, url, Some(&Noted { born: None, ..lock.clone() }), daemon, &mine, 1000));
        // The socket on the port is another account's, or one of two is, or none is seen.
        assert!(!may_send_token(403, url, Some(&lock), daemon, &[1001], 1000));
        assert!(!may_send_token(403, url, Some(&lock), daemon, &[1000, 1001], 1000));
        assert!(!may_send_token(403, url, Some(&lock), daemon, &[], 1000));
        // Another machine, whatever it says.
        let far = "http://example.com:47960";
        assert!(!may_send_token(403, far, Some(&Noted { url: far.into(), ..lock.clone() }), daemon, &mine, 1000));
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
        // The review's case: an address that is not this machine's. The app would not speak to a
        // daemon there, so it starts none (it ran `serve --bind 10.0.0.9:44825` before).
        assert_eq!(start_plan(&bare, Some("http://10.0.0.9:44825"), false, false, true), Plan::Refused);
        assert_eq!(start_plan(&Where { url: Some("http://10.0.0.9:44825".into()), ..Default::default() }, None, false, true, true), Plan::Refused);
        // A state folder from the environment is the daemon's to read; it still keeps the service out of it.
        assert_eq!(start_plan(&bare, None, true, true, false), Plan::Serve { args: vec!["serve".into()], scope: false });
    }

    #[test]
    fn the_stream_is_read_into_events() {
        assert!(matches!(told("hello", r#"{"pid":1,"needs":3,"snooze_until":null}"#, ""), Some(Event::Needs { n: 3, unread: 0, list, reach: None }) if list.is_empty()));
        assert!(matches!(told("needs", r#"{"n":0}"#, ""), Some(Event::Needs { n: 0, .. })));
        // The count and the list come in one frame; an id that is not the page's shape is left out, and no more than five are kept.
        let many = (0..8).map(|i| format!(r#"{{"id":"s{i}","title":"T{i}","state":"need","word":"Needs you"}}"#)).collect::<Vec<_>>().join(",");
        match told("needs", &format!(r#"{{"n":2,"unread":4,"reach":"No phone paired: reminders reach this desktop only","list":[{{"id":"../x","title":"bad","word":"w"}},{many}]}}"#), "") {
            Some(Event::Needs { n, unread, list, reach }) => {
                assert_eq!(reach.as_deref(), Some("No phone paired: reminders reach this desktop only"));
                assert_eq!((n, unread, list.len()), (2, 4, 5));
                assert_eq!(list[0], Listed { id: "s0".into(), title: "T0".into(), state: Some(Dot::Need), word: "Needs you".into() });
            }
            other => panic!("{other:?}"),
        }
        match told("notify", r#"{"key":"s1","alert":"a1","title":"T","body":"B","icon":"/x/face.png","urgency":2,"sound":false,"kind":"approval","ack":9}"#, "st-1") {
            Some(Event::Notify { key, alert, title, body, icon, urgent, silent, ack, stream }) => assert_eq!((key.as_str(), alert.as_str(), title.as_str(), body.as_str(), icon.as_str(), urgent, silent, ack, stream.as_str()), ("s1", "a1", "T", "B", "/x/face.png", true, true, Some(9), "st-1")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(told("snooze", r#"{"until_ms":null}"#, ""), Some(Event::Snooze(None))));
        assert!(matches!(told("snooze", r#"{"until_ms":99}"#, ""), Some(Event::Snooze(Some(99)))));
        assert!(matches!(told("takes", r#"{"takes":true}"#, ""), Some(Event::Takes(true))));
        assert!(told("takes", "{}", "").is_none());
        assert!(told("unknown", "{}", "").is_none());
        assert!(told("needs", "garbage", "").is_none());
    }
}
