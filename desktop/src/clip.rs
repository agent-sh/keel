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

#[derive(Default)]
pub struct Gate {
    input: Option<Instant>,
    permit: Option<Instant>,
}

impl Gate {
    /// The owner pressed a key or a button in the window.
    pub fn input(&mut self, now: Instant) {
        self.input = Some(now);
    }

    fn pressed(&self, now: Instant) -> bool {
        self.input.is_some_and(|t| now.saturating_duration_since(t) <= GESTURE)
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
