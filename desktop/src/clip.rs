//! When the app touches the clipboard for the page. The engine grants the
//! page nothing: no frame reads or writes the clipboard through it. The page
//! of the daemon's own origin asks the app instead (a keyed message), and the
//! app answers only when the owner has just pressed a key or a button in that
//! window: a paste is read at that press, and a copy is allowed by it.
use std::time::{Duration, Instant};

/// How long after the owner's press a request counts as that press's.
pub const GESTURE: Duration = Duration::from_secs(1);
/// How long a copy the press allowed may take to arrive (its text may have to be fetched first).
pub const PERMIT: Duration = Duration::from_secs(30);
/// How long the microphone stays allowed after the owner's press said the page is about to ask for it
/// (the page asks as the press is handled; the engine's own prompt may take a moment). The Qt engine's
/// program has the same time (MIC_MS in ../qt/main.cpp).
pub const MIC: Duration = Duration::from_secs(10);
/// How long after the owner's press in a window a file the page offers is kept (the daemon has
/// to answer first). The Qt engine's program has the same time (KEEP_MS in ../qt/main.cpp).
pub const KEEP: Duration = Duration::from_secs(10);
/// How long after the page announced a file it may arrive (the daemon answers first).
pub const ANNOUNCED: Duration = Duration::from_secs(10);

/// The size a picture is handed to the page at: its own, or scaled down so its longer side is
/// `edge` (the size the page keeps a picture at: it would scale a larger one down itself).
pub fn fit(width: i32, height: i32, edge: i32) -> (i32, i32) {
    let long = width.max(height);
    if edge <= 0 || long <= edge || width <= 0 || height <= 0 {
        return (width, height);
    }
    let scale = edge as f64 / long as f64;
    (((width as f64 * scale).round() as i32).max(1), ((height as f64 * scale).round() as i32).max(1))
}

/// The form a clipboard's picture is asked for in, when its formats name one: the first of
/// these it offers, else whatever picture form it names.
pub fn picture_format<'a>(mimes: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    const WANTED: [&str; 6] = ["image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "image/gif"];
    let offered: Vec<&str> = mimes.filter(|m| m.starts_with("image/")).collect();
    WANTED.iter().find_map(|w| offered.iter().find(|m| *m == w).copied()).or_else(|| offered.first().copied())
}

#[derive(Default)]
pub struct Gate {
    input: Option<Instant>,
    permit: Option<Instant>,
    /// Until when the microphone may be given, once.
    mic: Option<Instant>,
    /// The file the page announced, and until when it may arrive.
    saving: Option<(String, Instant)>,
    /// The page of this load announces its files (said.rs `Can`).
    announces: bool,
}

impl Gate {
    /// The owner pressed a key or a button in the window.
    pub fn input(&mut self, now: Instant) {
        self.input = Some(now);
    }

    /// Whether the owner pressed a key or a button in the window just now.
    pub fn pressed(&self, now: Instant) -> bool {
        self.input.is_some_and(|t| now.saturating_duration_since(t) <= GESTURE)
    }

    /// Whether the page in the window announces a file before it offers one. Said by the
    /// app's own script as a document starts (it does not, yet), then by the page itself.
    pub fn announces(&mut self, on: bool) {
        self.announces = on;
        if !on {
            self.saving = None;
        }
    }

    /// The page says it is about to ask for the microphone, at the owner's press: one request is allowed for a while.
    pub fn arm_mic(&mut self, now: Instant) -> bool {
        if self.pressed(now) {
            self.mic = Some(now + MIC);
        }
        self.pressed(now)
    }

    /// The engine's request for the microphone: allowed once, by the press that announced it.
    pub fn take_mic(&mut self, now: Instant) -> bool {
        self.mic.take().is_some_and(|until| now <= until)
    }

    /// The page announced a file at `url`: taken at the owner's own press, for one file.
    pub fn announce(&mut self, url: &str, now: Instant) -> bool {
        if self.pressed(now) {
            self.saving = Some((url.to_string(), now + ANNOUNCED));
        }
        self.pressed(now)
    }

    /// A file to keep, offered from `url`. From a page that announces its files: only the one
    /// file it announced, a moment before, at the owner's press. A frame of content can say
    /// nothing to the app, so a script in one keeps nothing, whatever the owner is pressing in
    /// the page meanwhile. From a page of before the announcement: the owner pressed in the
    /// window a moment before.
    pub fn may_keep(&mut self, url: &str, now: Instant) -> bool {
        if !self.announces {
            return self.input.is_some_and(|t| now.saturating_duration_since(t) <= KEEP);
        }
        match self.saving.take() {
            Some((said, until)) if said == url && now <= until => true,
            other => {
                self.saving = other.filter(|(_, until)| now <= *until);
                false
            }
        }
    }

    /// A paste: the clipboard is read only at the owner's own press.
    pub fn may_read(&self, now: Instant) -> bool {
        self.pressed(now)
    }

    /// The page says a copy is coming, at the owner's press: one write is allowed for a while.
    pub fn arm(&mut self, now: Instant) -> bool {
        if self.pressed(now) {
            self.permit = Some(now + PERMIT);
        }
        self.pressed(now)
    }

    /// The copy itself: allowed once, by the press that announced it.
    pub fn take(&mut self, now: Instant) -> bool {
        self.permit.take().is_some_and(|until| now <= until)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The review's case: a 2700 by 2600 picture was encoded whole on the main loop.
    #[test]
    fn a_large_picture_is_handed_over_at_the_size_the_page_keeps() {
        assert_eq!(fit(2700, 2600, 1568), (1568, 1510));
        assert_eq!(fit(1000, 4000, 1568), (392, 1568));
        assert_eq!(fit(1568, 900, 1568), (1568, 900));
        assert_eq!(fit(40, 30, 1568), (40, 30));
        assert_eq!(fit(30000, 2, 1568), (1568, 1));
        assert_eq!(fit(800, 600, 0), (800, 600));
    }

    // The review's case: bytes that are no picture, offered as one, read as an empty clipboard.
    #[test]
    fn a_clipboard_that_offers_a_picture_is_known_by_its_formats() {
        assert_eq!(picture_format(["text/plain", "image/jpeg", "image/png"].into_iter()), Some("image/png"));
        assert_eq!(picture_format(["image/jpeg"].into_iter()), Some("image/jpeg"));
        assert_eq!(picture_format(["text/plain", "image/x-xcf"].into_iter()), Some("image/x-xcf"));
        assert_eq!(picture_format(["text/plain", "text/html", "UTF8_STRING"].into_iter()), None);
        assert_eq!(picture_format(std::iter::empty()), None);
    }

    // A script in a frame asked for the microphone with no press of the owner's: refused. With one, once.
    #[test]
    fn the_microphone_is_given_once_at_the_owners_press_and_not_after_it_lapsed() {
        let t0 = Instant::now();
        let mut g = Gate::default();
        assert!(!g.arm_mic(t0));
        assert!(!g.take_mic(t0));
        g.input(t0);
        assert!(g.arm_mic(t0 + Duration::from_millis(200)));
        assert!(g.take_mic(t0 + Duration::from_secs(1)));
        assert!(!g.take_mic(t0 + Duration::from_secs(2)), "once");
        g.input(t0 + Duration::from_secs(30));
        assert!(g.arm_mic(t0 + Duration::from_secs(30)));
        assert!(!g.take_mic(t0 + Duration::from_secs(41)), "lapsed");
    }

    // The review's case: a script in a preview frame saved a file with no press.
    #[test]
    fn a_file_is_kept_only_a_moment_after_the_owners_press() {
        let t0 = Instant::now();
        let mut gate = Gate::default();
        let u = "http://127.0.0.1:1/api/a";
        assert!(!gate.may_keep(u, t0));
        gate.input(t0);
        assert!(gate.may_keep(u, t0 + Duration::from_secs(3)));
        assert!(gate.may_keep(u, t0 + KEEP));
        assert!(!gate.may_keep(u, t0 + KEEP + Duration::from_millis(1)));
    }

    // The review's case: any key the owner pressed opened ten seconds in which a preview frame
    // could save a file. A page that announces its files keeps the one it announced, once.
    #[test]
    fn a_page_that_announces_its_files_keeps_only_the_one_it_announced() {
        let t = Instant::now();
        let (mine, other) = ("http://127.0.0.1:1/api/attachments/7?name=a.png", "http://127.0.0.1:1/api/attachments/8?name=b.png");
        let mut g = Gate::default();
        g.announces(true);
        // The owner types in the page: nothing was announced, so nothing is kept.
        g.input(t);
        assert!(!g.may_keep(mine, t + Duration::from_millis(100)));
        // Announced with no press of the owner's: not taken.
        assert!(!g.announce(mine, t + GESTURE + Duration::from_secs(1)));
        assert!(!g.may_keep(mine, t + GESTURE + Duration::from_secs(1)));
        // Announced at the owner's press: that address, once; another address does not use it up.
        let p = t + Duration::from_secs(60);
        g.input(p);
        assert!(g.announce(mine, p + Duration::from_millis(5)));
        assert!(!g.may_keep(other, p + Duration::from_millis(40)));
        assert!(g.may_keep(mine, p + Duration::from_millis(80)));
        assert!(!g.may_keep(mine, p + Duration::from_millis(90)));
        // And not after its time.
        g.input(p);
        assert!(g.announce(mine, p));
        assert!(!g.may_keep(mine, p + ANNOUNCED + Duration::from_millis(1)));
        // A new document says again what it does.
        g.announces(false);
        g.input(p);
        assert!(g.may_keep(mine, p + Duration::from_secs(1)));
    }

    #[test]
    fn a_paste_is_read_only_at_the_owners_press() {
        let t = Instant::now();
        let mut g = Gate::default();
        assert!(!g.may_read(t));
        g.input(t);
        assert!(g.may_read(t + Duration::from_millis(50)));
        assert!(g.may_read(t + GESTURE));
        // The review's timing: a read asked for 1.8 s after a click is not that click's.
        assert!(!g.may_read(t + Duration::from_millis(1800)));
    }

    // The review's case: the page wrote the clipboard a few seconds after the owner had used it.
    #[test]
    fn a_copy_needs_a_press_and_is_allowed_once() {
        let t = Instant::now();
        let mut g = Gate::default();
        assert!(!g.take(t));
        g.input(t);
        // No copy was announced at the press: nothing may be written later.
        assert!(!g.take(t + Duration::from_secs(3)));
        // Announced too late, it is not the press's either.
        assert!(!g.arm(t + Duration::from_secs(3)));
        assert!(!g.take(t + Duration::from_secs(3)));
        // Announced at the press, the text may arrive after it was fetched, once.
        g.input(t + Duration::from_secs(10));
        assert!(g.arm(t + Duration::from_secs(10)));
        assert!(g.take(t + Duration::from_secs(14)));
        assert!(!g.take(t + Duration::from_secs(14)));
        // And not for ever.
        g.input(t + Duration::from_secs(20));
        assert!(g.arm(t + Duration::from_secs(20)));
        assert!(!g.take(t + Duration::from_secs(20) + PERMIT + Duration::from_secs(1)));
    }
}
