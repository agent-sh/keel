//! The tray mark: a StatusNotifierItem with its menu, spoken over the session
//! bus the application already holds. The mark carries the count of what
//! waits on the owner. A desktop without a tray host (stock GNOME without the
//! AppIndicator extension) shows nothing; `available` says which it is, and
//! the shell then quits with its last window instead of hiding where no one
//! can find it.
use crate::daemon::Link;
use gtk::prelude::*;
use gtk::{cairo, gio, glib};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/StatusNotifierItem/Menu";
const WATCHER: &str = "org.kde.StatusNotifierWatcher";

const ITEM_XML: &str = r#"<node><interface name="org.kde.StatusNotifierItem">
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
<property name="IconPixmap" type="a(iiay)" access="read"/><property name="OverlayIconName" type="s" access="read"/>
<property name="OverlayIconPixmap" type="a(iiay)" access="read"/><property name="AttentionIconName" type="s" access="read"/>
<property name="AttentionIconPixmap" type="a(iiay)" access="read"/><property name="AttentionMovieName" type="s" access="read"/>
<property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
<property name="Menu" type="o" access="read"/>
<method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
<signal name="NewTitle"/><signal name="NewIcon"/><signal name="NewAttentionIcon"/><signal name="NewOverlayIcon"/>
<signal name="NewToolTip"/><signal name="NewStatus"><arg name="status" type="s"/></signal>
</interface></node>"#;

const MENU_XML: &str = r#"<node><interface name="com.canonical.dbusmenu">
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
<property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
<method name="GetLayout"><arg name="parentId" type="i" direction="in"/><arg name="recursionDepth" type="i" direction="in"/>
<arg name="propertyNames" type="as" direction="in"/><arg name="revision" type="u" direction="out"/><arg name="layout" type="(ia{sv}av)" direction="out"/></method>
<method name="GetGroupProperties"><arg name="ids" type="ai" direction="in"/><arg name="propertyNames" type="as" direction="in"/>
<arg name="properties" type="a(ia{sv})" direction="out"/></method>
<method name="GetProperty"><arg name="id" type="i" direction="in"/><arg name="name" type="s" direction="in"/><arg name="value" type="v" direction="out"/></method>
<method name="Event"><arg name="id" type="i" direction="in"/><arg name="eventId" type="s" direction="in"/><arg name="data" type="v" direction="in"/>
<arg name="timestamp" type="u" direction="in"/></method>
<method name="EventGroup"><arg name="events" type="a(isvu)" direction="in"/><arg name="idErrors" type="ai" direction="out"/></method>
<method name="AboutToShow"><arg name="id" type="i" direction="in"/><arg name="needUpdate" type="b" direction="out"/></method>
<method name="AboutToShowGroup"><arg name="ids" type="ai" direction="in"/><arg name="updatesNeeded" type="ai" direction="out"/><arg name="idErrors" type="ai" direction="out"/></method>
<signal name="ItemsPropertiesUpdated"><arg name="updatedProps" type="a(ia{sv})"/><arg name="removedProps" type="a(ias)"/></signal>
<signal name="LayoutUpdated"><arg name="revision" type="u"/><arg name="parent" type="i"/></signal>
<signal name="ItemActivationRequested"><arg name="id" type="i"/><arg name="timestamp" type="u"/></signal>
</interface></node>"#;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pick {
    Open,
    New,
    Pause,
    Resume,
    Start,
    Quit,
    QuitAll,
}

/// What the mark and its menu show.
#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub needs: u32,
    pub paused: bool,
    pub link: Link,
    /// The daemon's address is not this machine's: there is nothing here to start.
    pub refused: bool,
}

/// The first line of the menu and the mark's tooltip.
pub fn headline(s: &Shown) -> String {
    match s.link {
        Link::Down => "Keel is not running".into(),
        Link::Restarting => "Keel is restarting".into(),
        Link::Up if s.needs == 0 => "Nothing needs you".into(),
        Link::Up if s.needs == 1 => "1 needs you".into(),
        Link::Up => format!("{} need you", s.needs),
    }
}

/// The count as the mark's badge says it: nothing for none, `9+` past nine.
pub fn badge(needs: u32) -> Option<String> {
    match needs {
        0 => None,
        1..=9 => Some(needs.to_string()),
        _ => Some("9+".into()),
    }
}

/// The menu, top to bottom: id, label (empty for a line), enabled, what it picks.
pub fn menu(s: &Shown) -> Vec<(i32, String, bool, Option<Pick>)> {
    let mut m = vec![(1, headline(s), false, None), (2, String::new(), true, None), (3, "Open Keel".into(), true, Some(Pick::Open))];
    match s.link {
        Link::Up => {
            m.push((4, "New Session".into(), true, Some(Pick::New)));
            m.push((5, String::new(), true, None));
            m.push(if s.paused { (6, "Resume Notifications".into(), true, Some(Pick::Resume)) } else { (7, "Pause Notifications for an Hour".into(), true, Some(Pick::Pause)) });
        }
        Link::Down if !s.refused => m.push((8, "Start Keel".into(), true, Some(Pick::Start))),
        Link::Down => {}
        Link::Restarting => {}
    }
    m.push((9, String::new(), true, None));
    m.push((10, "Quit".into(), true, Some(Pick::Quit)));
    if s.link == Link::Up {
        m.push((11, "Quit and Stop the Daemon".into(), true, Some(Pick::QuitAll)));
    }
    m
}

/// The mark's name in the icon theme: a symbolic icon, so the panel paints it
/// in its own ink, light or dark.
pub const SYMBOLIC: &str = "io.github.agent_sh.Keel-symbolic";

/// Pixels for the tray, ARGB32 in network byte order as it asks: the count on
/// a badge, and under it the keel itself only when `mark` is set (a desktop
/// whose icon theme does not have the symbolic icon; its ink is then light,
/// for a dark panel).
fn pixmap(size: i32, s: &Shown, mark: bool) -> Option<(i32, i32, Vec<u8>)> {
    let mut surface = cairo::ImageSurface::create(cairo::Format::ARgb32, size, size).ok()?;
    {
        let c = cairo::Context::new(&surface).ok()?;
        let k = size as f64 / 32.0;
        c.scale(k, k);
        if mark {
            let dim = if s.link == Link::Up { 0.96 } else { 0.5 };
            c.set_source_rgba(0.96, 0.98, 0.98, dim);
            // The hull and the fin of ui/public/icon.svg, a little larger: the mark has no plate behind it here.
            c.translate(16.0, 17.0);
            c.scale(1.28, 1.28);
            c.translate(-16.0, -17.5);
            c.move_to(6.0, 11.5);
            c.rel_line_to(20.0, 0.0);
            c.rel_curve_to(-1.1, 4.9, -5.0, 7.6, -10.0, 7.6);
            c.rel_curve_to(-5.0, 0.0, -8.9, -2.7, -10.0, -7.6);
            c.close_path();
            c.move_to(14.6, 18.6);
            c.rel_line_to(2.8, 0.0);
            c.rel_line_to(-0.7, 6.4);
            c.rel_line_to(-1.4, 0.0);
            c.close_path();
            c.fill().ok()?;
            c.identity_matrix();
            c.scale(k, k);
        }
        if let (Some(text), Link::Up) = (badge(s.needs), &s.link) {
            let (cx, cy, r) = (22.5, 9.5, 8.5);
            c.set_source_rgba(0.478, 0.247, 0.878, 1.0);
            c.arc(cx, cy, r, 0.0, std::f64::consts::TAU);
            c.fill().ok()?;
            c.set_source_rgba(1.0, 1.0, 1.0, 1.0);
            c.select_font_face("sans-serif", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
            c.set_font_size(if text.len() > 1 { 9.5 } else { 12.5 });
            let e = c.text_extents(&text).ok()?;
            c.move_to(cx - e.width() / 2.0 - e.x_bearing(), cy - e.height() / 2.0 - e.y_bearing());
            c.show_text(&text).ok()?;
        } else if mark && s.paused && s.link == Link::Up {
            // Paused: two short bars where the badge sits.
            c.set_source_rgba(0.96, 0.98, 0.98, 0.96);
            c.rectangle(20.5, 4.0, 2.4, 8.0);
            c.rectangle(25.0, 4.0, 2.4, 8.0);
            c.fill().ok()?;
        }
    }
    surface.flush();
    let stride = surface.stride() as usize;
    let data = surface.data().ok()?;
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size as usize {
        for x in 0..size as usize {
            let p = &data[y * stride + x * 4..y * stride + x * 4 + 4];
            let px = u32::from_ne_bytes([p[0], p[1], p[2], p[3]]);
            let a = (px >> 24) & 0xff;
            let un = |v: u32| if a == 0 { 0 } else { ((v * 255 + a / 2) / a).min(255) as u8 };
            out.extend_from_slice(&[a as u8, un((px >> 16) & 0xff), un((px >> 8) & 0xff), un(px & 0xff)]);
        }
    }
    Some((size, size, out))
}

/// What the tray is told to draw. With the symbolic icon in the theme: its
/// name, and pixels only for the count laid over it. Without: the drawn mark.
pub fn icons(s: &Shown, symbolic: bool) -> (&'static str, Vec<(i32, i32, Vec<u8>)>, Vec<(i32, i32, Vec<u8>)>) {
    let sizes = [24, 48];
    if symbolic {
        let over = if s.needs > 0 && s.link == Link::Up { sizes.iter().filter_map(|z| pixmap(*z, s, false)).collect() } else { Vec::new() };
        (SYMBOLIC, Vec::new(), over)
    } else {
        ("", sizes.iter().filter_map(|z| pixmap(*z, s, true)).collect(), Vec::new())
    }
}

pub struct Tray {
    conn: gio::DBusConnection,
    shown: Rc<RefCell<Shown>>,
    revision: Rc<Cell<u32>>,
    available: Rc<Cell<bool>>,
}

impl Tray {
    pub fn new(conn: &gio::DBusConnection, symbolic: bool, on_pick: impl Fn(Pick) + 'static, on_host: impl Fn(bool) + 'static) -> Result<Self, glib::Error> {
        let shown = Rc::new(RefCell::new(Shown { needs: 0, paused: false, link: Link::Down, refused: false }));
        let revision = Rc::new(Cell::new(1u32));
        let available = Rc::new(Cell::new(false));
        let on_pick = Rc::new(on_pick);

        let item = gio::DBusNodeInfo::for_xml(ITEM_XML)?.lookup_interface("org.kde.StatusNotifierItem").expect("the item's interface");
        let (s, pick) = (shown.clone(), on_pick.clone());
        conn.register_object(ITEM_PATH, &item)
            .method_call(move |_, _, _, _, method, _, inv| {
                if method == "Activate" || method == "SecondaryActivate" {
                    pick(Pick::Open);
                }
                inv.return_value(None);
            })
            .property(move |_, _, _, _, name| {
                let s = s.borrow();
                let none: Vec<(i32, i32, Vec<u8>)> = Vec::new();
                let (icon, pixels, over) = icons(&s, symbolic);
                match name {
                    "Category" => "ApplicationStatus".to_variant(),
                    "Id" => "keel".to_variant(),
                    "Title" => "Keel".to_variant(),
                    "Status" => (if s.needs > 0 && s.link == Link::Up { "NeedsAttention" } else { "Active" }).to_variant(),
                    "WindowId" => 0i32.to_variant(),
                    "IconName" | "AttentionIconName" => icon.to_variant(),
                    "IconPixmap" | "AttentionIconPixmap" => pixels.to_variant(),
                    "OverlayIconPixmap" => over.to_variant(),
                    "ToolTip" => ("", none, "Keel", headline(&s).as_str()).to_variant(),
                    "ItemIsMenu" => false.to_variant(),
                    "Menu" => glib::variant::ObjectPath::try_from(MENU_PATH).expect("a path").to_variant(),
                    _ => "".to_variant(),
                }
            })
            .build()?;

        let menu_info = gio::DBusNodeInfo::for_xml(MENU_XML)?.lookup_interface("com.canonical.dbusmenu").expect("the menu's interface");
        let (s, rev) = (shown.clone(), revision.clone());
        let props = |label: &str, enabled: bool| -> HashMap<String, glib::Variant> {
            let mut p = HashMap::new();
            if label.is_empty() {
                p.insert("type".to_string(), "separator".to_variant());
            } else {
                p.insert("label".to_string(), label.to_variant());
                p.insert("enabled".to_string(), enabled.to_variant());
            }
            p.insert("visible".to_string(), true.to_variant());
            p
        };
        conn.register_object(MENU_PATH, &menu_info)
            .method_call(move |_, _, _, _, method, params, inv| {
                let shown = s.borrow().clone();
                let items = menu(&shown);
                match method {
                    "GetLayout" => {
                        let parent = params.child_value(0).get::<i32>().unwrap_or(0);
                        let children: Vec<glib::Variant> = if parent == 0 {
                            items.iter().map(|(id, label, on, _)| (*id, props(label, *on), Vec::<glib::Variant>::new()).to_variant()).collect()
                        } else {
                            Vec::new()
                        };
                        let mut root = HashMap::new();
                        root.insert("children-display".to_string(), "submenu".to_variant());
                        let node = match items.iter().find(|i| i.0 == parent) {
                            Some((id, label, on, _)) => (*id, props(label, *on), children),
                            None => (0, root, children),
                        };
                        inv.return_value(Some(&(rev.get(), node).to_variant()));
                    }
                    "GetGroupProperties" => {
                        let ids = params.child_value(0).get::<Vec<i32>>().unwrap_or_default();
                        let all: Vec<(i32, HashMap<String, glib::Variant>)> = items.iter().filter(|i| ids.is_empty() || ids.contains(&i.0)).map(|(id, label, on, _)| (*id, props(label, *on))).collect();
                        inv.return_value(Some(&(all,).to_variant()));
                    }
                    "GetProperty" => {
                        let id = params.child_value(0).get::<i32>().unwrap_or(0);
                        let name = params.child_value(1).get::<String>().unwrap_or_default();
                        let v = items.iter().find(|i| i.0 == id).and_then(|(_, label, on, _)| props(label, *on).remove(&name)).unwrap_or_else(|| "".to_variant());
                        inv.return_value(Some(&(v,).to_variant()));
                    }
                    "Event" => {
                        let id = params.child_value(0).get::<i32>().unwrap_or(0);
                        let event = params.child_value(1).get::<String>().unwrap_or_default();
                        inv.return_value(None);
                        if event == "clicked" {
                            if let Some(p) = items.iter().find(|i| i.0 == id).and_then(|i| i.3) {
                                on_pick(p);
                            }
                        }
                    }
                    "EventGroup" => {
                        let events = params.child_value(0);
                        let picked: Vec<Pick> = (0..events.n_children())
                            .filter_map(|n| {
                                let e = events.child_value(n);
                                let (id, event) = (e.child_value(0).get::<i32>()?, e.child_value(1).get::<String>()?);
                                (event == "clicked").then(|| items.iter().find(|i| i.0 == id).and_then(|i| i.3)).flatten()
                            })
                            .collect();
                        inv.return_value(Some(&(Vec::<i32>::new(),).to_variant()));
                        picked.into_iter().for_each(|p| on_pick(p));
                    }
                    "AboutToShow" => inv.return_value(Some(&(false,).to_variant())),
                    "AboutToShowGroup" => inv.return_value(Some(&(Vec::<i32>::new(), Vec::<i32>::new()).to_variant())),
                    _ => inv.return_value(None),
                }
            })
            .property(|_, _, _, _, name| match name {
                "Version" => 3u32.to_variant(),
                "TextDirection" => "ltr".to_variant(),
                "Status" => "normal".to_variant(),
                _ => Vec::<String>::new().to_variant(),
            })
            .build()?;

        // The tray host comes and goes (a shell extension turned on, a panel restarted): the item is offered each time one appears.
        let (c, av, on_host) = (conn.clone(), available.clone(), Rc::new(on_host));
        let (av2, on_host2) = (available.clone(), on_host.clone());
        gio::bus_watch_name_on_connection(
            conn,
            WATCHER,
            gio::BusNameWatcherFlags::NONE,
            move |_, _, _| {
                let (av, on_host) = (av.clone(), on_host.clone());
                c.call(Some(WATCHER), "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem", Some(&(ITEM_PATH,).to_variant()), None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE, move |r| {
                    av.set(r.is_ok());
                    on_host(r.is_ok());
                });
            },
            move |_, _| {
                av2.set(false);
                on_host2(false);
            },
        );
        Ok(Self { conn: conn.clone(), shown, revision, available })
    }

    /// True while a tray host shows the mark.
    pub fn available(&self) -> bool {
        self.available.get()
    }

    pub fn shown(&self) -> Shown {
        self.shown.borrow().clone()
    }

    pub fn show(&self, next: Shown) {
        if *self.shown.borrow() == next {
            return;
        }
        let before = self.shown.replace(next.clone());
        let emit = |path: &str, iface: &str, name: &str, v: Option<glib::Variant>| {
            let _ = self.conn.emit_signal(None, path, iface, name, v.as_ref());
        };
        let item = "org.kde.StatusNotifierItem";
        emit(ITEM_PATH, item, "NewIcon", None);
        emit(ITEM_PATH, item, "NewAttentionIcon", None);
        emit(ITEM_PATH, item, "NewOverlayIcon", None);
        emit(ITEM_PATH, item, "NewToolTip", None);
        emit(ITEM_PATH, item, "NewStatus", Some((if next.needs > 0 && next.link == Link::Up { "NeedsAttention" } else { "Active" },).to_variant()));
        if menu(&before) != menu(&next) {
            self.revision.set(self.revision.get() + 1);
            emit(MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated", Some((self.revision.get(), 0i32).to_variant()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(needs: u32, paused: bool, link: Link) -> Shown {
        Shown { needs, paused, link, refused: false }
    }

    #[test]
    fn the_headline_says_what_waits() {
        assert_eq!(headline(&s(0, false, Link::Up)), "Nothing needs you");
        assert_eq!(headline(&s(1, false, Link::Up)), "1 needs you");
        assert_eq!(headline(&s(4, false, Link::Up)), "4 need you");
        assert_eq!(headline(&s(4, false, Link::Restarting)), "Keel is restarting");
        assert_eq!(headline(&s(4, false, Link::Down)), "Keel is not running");
    }

    #[test]
    fn the_badge_counts_to_nine() {
        assert_eq!(badge(0), None);
        assert_eq!(badge(3).as_deref(), Some("3"));
        assert_eq!(badge(9).as_deref(), Some("9"));
        assert_eq!(badge(27).as_deref(), Some("9+"));
    }

    #[test]
    fn the_menu_follows_the_daemon() {
        let picks = |sh: &Shown| menu(sh).into_iter().filter_map(|i| i.3).collect::<Vec<_>>();
        assert_eq!(picks(&s(0, false, Link::Up)), [Pick::Open, Pick::New, Pick::Pause, Pick::Quit, Pick::QuitAll]);
        assert_eq!(picks(&s(0, true, Link::Up)), [Pick::Open, Pick::New, Pick::Resume, Pick::Quit, Pick::QuitAll]);
        assert_eq!(picks(&s(2, false, Link::Down)), [Pick::Open, Pick::Start, Pick::Quit]);
        assert_eq!(picks(&s(2, false, Link::Restarting)), [Pick::Open, Pick::Quit]);
        // An address the app does not speak to: nothing to start there.
        assert_eq!(picks(&Shown { refused: true, ..s(0, false, Link::Down) }), [Pick::Open, Pick::Quit]);
        // Ids are one per item, so a click on an old menu never picks another item.
        let ids: Vec<i32> = menu(&s(0, false, Link::Up)).iter().map(|i| i.0).collect();
        let mut sorted = ids.clone();
        sorted.dedup();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn the_mark_is_drawn_at_its_size() {
        let (w, h, px) = pixmap(24, &s(3, false, Link::Up), true).unwrap();
        assert_eq!((w, h, px.len()), (24, 24, 24 * 24 * 4));
        // Something is drawn, and the badge adds its own color.
        assert!(px.chunks(4).any(|p| p[0] > 200));
        let plain = pixmap(24, &s(0, false, Link::Up), true).unwrap().2;
        assert_ne!(px, plain);
    }

    // The review's case: fixed near-white ink was invisible on a light panel.
    #[test]
    fn the_panel_paints_the_mark_and_pixels_carry_only_the_count() {
        let (name, pixels, over) = icons(&s(0, false, Link::Up), true);
        assert_eq!((name, pixels.len(), over.len()), (SYMBOLIC, 0, 0));
        let (name, pixels, over) = icons(&s(2, false, Link::Up), true);
        assert_eq!((name, pixels.len(), over.len()), (SYMBOLIC, 0, 2));
        // The overlay is the badge alone: nothing is drawn where the mark's hull is.
        let (size, _, px) = &over[0];
        let at = |x: i32, y: i32| px[((y * size + x) * 4) as usize];
        assert_eq!(at(6, 14), 0);
        assert!(at(17, 7) > 200);
        // No count while the daemon is away, and the drawn mark only where the theme has no symbolic icon.
        assert_eq!(icons(&s(2, false, Link::Down), true).2.len(), 0);
        let (name, pixels, over) = icons(&s(2, false, Link::Up), false);
        assert_eq!((name, pixels.len(), over.len()), ("", 2, 0));
    }
}
