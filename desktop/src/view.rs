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
    /// The owner closed the window.
    Close,
    /// A load of the page failed: the daemon went away under it.
    Lost,
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

/// How a window is opened.
pub struct Opening {
    /// The app's window, or a session's own.
    pub main: bool,
    pub size: (i32, i32),
    pub maximized: bool,
    pub look: Look,
    /// Whether a tray shows the app's mark (the page is told).
    pub tray: bool,
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
    /// page then leaves that to the title bar; any other loss it shows itself).
    fn daemon_away(&self);
    /// Shows the calm page for a daemon that is away; one already showing changes its words in place.
    fn away(&self, look: &Look, link: &Link, starting: bool, url: &str, note: &str);
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
