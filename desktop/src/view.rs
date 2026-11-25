//! The seam between the product and the engine that draws the page.
//!
//! Everything the app does that is not the web view itself lives on the
//! near side of this file: finding or starting the daemon and following it
//! (daemon.rs), the tray mark (tray.rs), notifications and their click
//! (notify.rs), one instance and keel:// links (instance.rs, links.rs), what
//! is remembered (prefs.rs), and the decisions between them (main.rs). None
//! of it names an engine. On the far side is one implementation of `Engine`
//! and `View` (window.rs: GTK 4 and WebKitGTK). A second engine implements
//! these two traits and nothing else changes; desktop/README.md lists what
//! that takes.
use crate::daemon::Link;
use crate::prefs::Look;
use std::rc::Rc;

/// What a window asks of the application.
#[derive(Debug)]
pub enum Ask {
    /// Start the daemon (the one button of the away page, or of the title bar).
    Start,
    /// Open this address in the owner's browser (the owner clicked a link).
    External(String),
    /// Open this path of the page in a window of its own.
    Window(String),
    /// The page's colors and text size, for the title bar and the first frame.
    Look(Look),
    /// The owner asked for the app's global shortcuts (the desktop shows its dialog).
    Shortcuts,
    /// The owner closed the window.
    Close,
    /// The page in a window of its own asks to close it (a side panel docked back). The main
    /// window is not closed this way.
    Dock,
    /// A load of the page failed: the daemon went away under it.
    Lost,
    /// The daemon says it is up and its page keeps failing to load: said in the window.
    Failing,
    /// A line for the app's log (the end-to-end check reads it).
    Note(&'static str, serde_json::Value),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Showing {
    /// Nothing loaded yet, or a page that must be loaded again.
    Nothing,
    /// The daemon's page.
    App,
    /// The calm page for a daemon that is away.
    Away,
}

/// What the calm page says while the daemon is away.
#[derive(Clone, Debug, PartialEq)]
pub struct Away {
    pub link: Link,
    pub starting: bool,
    pub url: String,
    pub note: String,
    /// The address is not this machine's: the app does not speak to it, and offers no start.
    pub refused: bool,
    /// The daemon answers and its page keeps failing to load.
    pub failing: bool,
}

/// How long a window waits before it asks for the daemon's page again after a load of it
/// failed, by how many failed in a row: at once the first time, then longer each time, ten
/// seconds at most. (A daemon that answers its health check and not its page, or something
/// else on its port, was otherwise asked for the page as fast as it could refuse it.)
pub fn retry_after(failed: u32) -> std::time::Duration {
    match failed {
        0 | 1 => std::time::Duration::ZERO,
        n => std::time::Duration::from_millis((500u64 << (n - 2).min(5)).min(10_000)),
    }
}

/// From this many failed loads in a row the window says so (`Ask::Failing`), instead of
/// standing empty between two tries.
pub const FAILS_SAID: u32 = 3;

/// A page that stops is loaded again this many times in a minute, and no more.
const RELOADS: usize = 3;
/// How long a page loaded again has to say its first word to the app, and how many times one
/// that said nothing is loaded anew.
pub const SPEAKS_WITHIN: std::time::Duration = std::time::Duration::from_secs(10);
const RENEWS: u32 = 2;

/// What a window does next about its page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    /// Load the page anew, and watch it for its first word (the watch's number).
    Renew(u32),
    /// Leave it: the bar says the page keeps stopping, with the button that loads it again.
    Leave,
}

/// What a window knows of a page whose process ended, or that came back and says nothing. One
/// rule for both engines: the page is loaded anew a few times in a minute and told why when it
/// first speaks; one that says nothing within `SPEAKS_WITHIN` is loaded anew, twice at most;
/// after either limit it is left with the bar's button, and the button's load is watched too.
#[derive(Default)]
pub struct Recovery {
    stops: Vec<std::time::Instant>,
    stopped: bool,
    /// The page is to be told it was loaded again, when it first speaks.
    owed: bool,
    /// The watch that is on: an older one that fires does nothing.
    watch: Option<u32>,
    watches: u32,
    renews: u32,
    /// When the app's own page (the calm page while the daemon is away) was put back, of late.
    own: Vec<std::time::Instant>,
}

impl Recovery {
    fn arm(&mut self) -> u32 {
        self.watches += 1;
        self.watch = Some(self.watches);
        self.watches
    }

    fn leave(&mut self) -> Step {
        self.stopped = true;
        self.owed = false;
        self.watch = None;
        Step::Leave
    }

    /// The page's process ended.
    pub fn ended(&mut self, now: std::time::Instant) -> Step {
        self.stops.retain(|t| now.saturating_duration_since(*t) < std::time::Duration::from_secs(60));
        self.stops.push(now);
        if self.stops.len() > RELOADS {
            return self.leave();
        }
        self.owed = true;
        Step::Renew(self.arm())
    }

    /// The time a watch gave the page has passed. None: the page spoke, or a newer watch is on.
    pub fn silent(&mut self, watch: u32) -> Option<Step> {
        if self.watch != Some(watch) {
            return None;
        }
        if self.renews < RENEWS {
            self.renews += 1;
            return Some(Step::Renew(self.arm()));
        }
        Some(self.leave())
    }

    /// The page's own first word. Whether it is owed the word that it was loaded again. A page
    /// that was left and speaks now (loaded again some other way: a link, a moved daemon) is
    /// left no more, and the bar says so no more.
    pub fn spoke(&mut self) -> bool {
        self.watch = None;
        self.renews = 0;
        self.stopped = false;
        std::mem::take(&mut self.owed)
    }

    /// The process of the app's own page ended. How long to wait before it is put back: at
    /// once three times in a minute, then each time a place in the minute is free again, so a
    /// page that keeps ending is put back no more than three times a minute.
    pub fn own_ended(&mut self, now: std::time::Instant) -> std::time::Duration {
        let minute = std::time::Duration::from_secs(60);
        // (A put-back still to come counts: its time is ahead of now.)
        self.own.retain(|t| now.saturating_duration_since(*t) < minute);
        let at = if self.own.len() < RELOADS { now } else { (self.own[self.own.len() - RELOADS] + minute).max(now) };
        self.own.push(at);
        at.saturating_duration_since(now)
    }

    /// The owner pressed the bar's button. None: the page was not left. Else the page is loaded
    /// anew and watched again (its watch's number): one that stays silent is left again.
    pub fn again(&mut self) -> Option<u32> {
        if !self.stopped {
            return None;
        }
        self.stopped = false;
        self.stops.clear();
        self.renews = 0;
        Some(self.arm())
    }

    pub fn stopped(&self) -> bool {
        self.stopped
    }

    /// How many times the page was loaded anew for saying nothing, since it last spoke.
    pub fn renews(&self) -> u32 {
        self.renews
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_that_keeps_failing_is_asked_for_less_and_less_often() {
        let waits: Vec<u64> = (0..10).map(|n| retry_after(n).as_millis() as u64).collect();
        assert_eq!(waits, [0, 0, 500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
        assert_eq!(retry_after(u32::MAX), std::time::Duration::from_secs(10));
        // The window says so before its waits are long.
        assert!(retry_after(FAILS_SAID) <= std::time::Duration::from_secs(1));
    }

    // The review's case: a page that needs more than the heap's bound was loaded again without end.
    #[test]
    fn a_page_that_keeps_ending_is_loaded_again_three_times_in_a_minute() {
        let t0 = std::time::Instant::now();
        let at = |s: u64| t0 + std::time::Duration::from_secs(s);
        let mut r = Recovery::default();
        assert!(matches!(r.ended(at(0)), Step::Renew(_)));
        assert!(matches!(r.ended(at(5)), Step::Renew(_)));
        assert!(matches!(r.ended(at(10)), Step::Renew(_)));
        assert_eq!(r.ended(at(15)), Step::Leave);
        assert!(r.stopped());
        // The button, and a minute on the old endings no longer count.
        assert!(r.again().is_some() && !r.stopped());
        assert!(matches!(r.ended(at(80)), Step::Renew(_)));
    }

    #[test]
    fn a_page_that_says_nothing_is_loaded_anew_twice_then_left_and_the_buttons_load_is_watched_too() {
        let mut r = Recovery::default();
        let Step::Renew(w1) = r.ended(std::time::Instant::now()) else { panic!("not loaded again") };
        let Some(Step::Renew(w2)) = r.silent(w1) else { panic!("not loaded anew") };
        // The first watch, firing late, does nothing more.
        assert_eq!(r.silent(w1), None);
        let Some(Step::Renew(w3)) = r.silent(w2) else { panic!("not loaded anew a second time") };
        assert_eq!(r.silent(w3), Some(Step::Leave));
        assert!(r.stopped() && r.silent(w3).is_none());
        // The owner's Load again is watched like any other load: silent again, it is left again.
        let w4 = r.again().expect("the button loads the page");
        assert!(!r.stopped());
        let Some(Step::Renew(w5)) = r.silent(w4) else { panic!("the button's load was not watched") };
        let Some(Step::Renew(w6)) = r.silent(w5) else { panic!() };
        assert_eq!(r.silent(w6), Some(Step::Leave));
        // The button does nothing for a page that was not left.
        let mut fine = Recovery::default();
        assert_eq!(fine.again(), None);
    }

    #[test]
    fn a_page_that_speaks_is_told_once_and_no_longer_watched() {
        let mut r = Recovery::default();
        let Step::Renew(w) = r.ended(std::time::Instant::now()) else { panic!() };
        assert!(r.spoke());
        assert!(!r.spoke());
        assert_eq!(r.silent(w), None);
        // The button's load owes the page no word: the owner pressed it.
        let mut left = Recovery::default();
        for _ in 0..4 {
            left.ended(std::time::Instant::now());
        }
        assert!(left.stopped() && left.again().is_some() && !left.spoke());
    }

    // The review's case: a page that was left and then loaded and spoke kept the bar until its button.
    #[test]
    fn a_left_page_that_speaks_is_left_no_more() {
        let mut r = Recovery::default();
        let t0 = std::time::Instant::now();
        for s in 0..4 {
            r.ended(t0 + std::time::Duration::from_secs(s));
        }
        assert!(r.stopped());
        r.spoke();
        assert!(!r.stopped());
        // The button then does nothing of its own: the page is not left.
        assert_eq!(r.again(), None);
    }

    // The review's case: the app's own page was put back at once however often its process ended.
    #[test]
    fn the_apps_own_page_is_put_back_three_times_a_minute_at_most() {
        let t0 = std::time::Instant::now();
        let at = |s: u64| t0 + std::time::Duration::from_secs(s);
        let secs = |d: std::time::Duration| d.as_secs();
        let mut r = Recovery::default();
        assert_eq!([secs(r.own_ended(at(0))), secs(r.own_ended(at(1))), secs(r.own_ended(at(2)))], [0, 0, 0]);
        // The fourth waits for the first to leave the minute, the fifth for the second.
        assert_eq!(secs(r.own_ended(at(3))), 57);
        assert_eq!(secs(r.own_ended(at(4))), 57);
        // Long after, at once again.
        assert_eq!(secs(r.own_ended(at(300))), 0);
        // The page's own rule is apart: its endings do not count here.
        let mut p = Recovery::default();
        p.ended(at(0));
        assert_eq!(secs(p.own_ended(at(0))), 0);
    }
}

/// How a window is opened.
/// What depends on the desktop the app runs on: whether a tray shows its mark, and whether
/// the desktop has global shortcuts for apps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Can {
    pub tray: bool,
    pub shortcuts: bool,
}

pub struct Opening {
    /// The app's window, or a session's own.
    pub main: bool,
    pub size: (i32, i32),
    pub maximized: bool,
    pub look: Look,
    /// What the page is told this app can do here.
    pub can: Can,
    pub devtools: bool,
}

pub type Asked = Rc<dyn Fn(&Rc<dyn View>, Ask)>;

/// One window showing the page.
pub trait View {
    /// A number of its own, to tell windows apart.
    fn id(&self) -> u32;
    fn is_main(&self) -> bool;
    fn showing(&self) -> Showing;
    /// The page it shows is stale: it is loaded again when the daemon answers.
    fn forget(&self);
    /// The path to open once the daemon answers.
    fn wanted(&self) -> String;
    fn want(&self, path: &str);
    /// Loads the page at a path of the daemon at `base`.
    fn load(&self, base: &str, path: &str);
    /// Tells the loaded page to go to a path, without a reload.
    /// `clicked`: the owner clicked the notification of that very place. Anything else
    /// (a link, a second launch, the tray) brought them there without choosing where the keyboard is.
    fn go(&self, path: &str, clicked: bool);
    /// Tells the loaded page the daemon answers again, so it joins it at once.
    fn daemon_back(&self);
    /// Tells the loaded page the app itself shows that the daemon is away (the
    /// page then leaves that to the title bar; any other loss it shows itself), and in
    /// which words, so the page says the state as the title bar does.
    fn daemon_away(&self, link: &Link);
    /// Shows the calm page for a daemon that is away; one already showing changes its words in place.
    fn away(&self, look: &Look, state: &Away);
    /// The daemon's state beside the window's controls, while the page is up without its daemon.
    fn link(&self, link: &Link);
    fn look(&self, look: &Look);
    /// Raises the window. With the desktop's activation token of the request
    /// it takes the focus; without one the desktop decides.
    fn present(&self, token: Option<&str>);
    /// Out of sight, the page kept as it is.
    fn hide(&self);
    fn close(&self);
    /// Width, height, maximized: what is remembered.
    fn size(&self) -> (i32, i32, bool);
}

/// The engine: it opens windows, styles what the app itself draws around the
/// page, and puts the page's capability object (`window.keelShell`, see
/// page.rs) on every page it loads.
pub trait Engine {
    /// The name the page and the daemon are told: "webkit".
    fn name(&self) -> &'static str;
    fn open(&self, opening: Opening, ask: Asked) -> Rc<dyn View>;
    /// The app's own widgets take the page's look.
    fn look(&self, look: &Look);
    /// Asks the owner before something that cannot be taken back; `answer(true)` when they agree.
    fn confirm(&self, question: &str, detail: &str, agree: &str, answer: Box<dyn FnOnce(bool)>);
}
