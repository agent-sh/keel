//! The tray mark: a StatusNotifierItem with its menu, spoken over the session
//! bus the application already holds. The mark carries the count of what
//! waits on the owner. A desktop without a tray host (stock GNOME without the
//! AppIndicator extension) shows nothing; `available` says which it is, and
//! the shell then quits with its last window instead of hiding where no one
//! can find it.
use crate::daemon::{Dot, Link, Listed};
use crate::shortcut::Keys;
use gtk::prelude::*;
use gtk::{cairo, gio, glib};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/StatusNotifierItem/Menu";
const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SETTINGS: &str = "org.freedesktop.portal.Settings";

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

#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    Open,
    /// A session of the list: it opens in the window.
    Session(String),
    /// Every unread alert is read.
    MarkRead,
    New,
    Pause,
    Resume,
    Start,
    Shortcuts,
    Quit,
    QuitAll,
}

/// The panel's theme where the desktop tells it (the settings portal's color scheme), else unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Panel {
    Unknown,
    Light,
    Dark,
}

impl Panel {
    /// The portal's `color-scheme`: 1 is dark, 2 is light, 0 no preference.
    pub fn of(scheme: u32) -> Self {
        match scheme {
            1 => Panel::Dark,
            2 => Panel::Light,
            _ => Panel::Unknown,
        }
    }
}

/// The dot before a session's line: its state, drawn for the panel it stands in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Icon {
    pub dot: Dot,
    pub panel: Panel,
}

/// One line of the menu: id, label (empty for a line), enabled, what it picks, the dot before it.
pub type Item = (i32, String, bool, Option<Pick>, Option<Icon>);

/// What the mark and its menu show.
#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub needs: u32,
    /// The sessions that need the owner, then the unread, then the working, as the daemon sent them with the count.
    pub list: Vec<Listed>,
    /// Unread alerts in all.
    pub unread: u32,
    pub paused: bool,
    pub link: Link,
    /// The daemon's address is not this machine's: there is nothing here to start.
    pub refused: bool,
    /// Another program attached to the daemon as its app before this one: the alerts go there.
    pub elsewhere: bool,
    /// What the owner can do about the app's global shortcuts on this desktop.
    pub keys: Keys,
    /// The panel's theme, which the dots are drawn for.
    pub panel: Panel,
}

/// The first line of the menu and the mark's tooltip.
pub fn headline(s: &Shown) -> String {
    match s.link {
        Link::Down | Link::Restarting => s.link.said().into(),
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

/// A title as the menu shows it: one plain line. Whatever the daemon sent, a control character or a
/// line break is a space and the characters that reorder text are gone. A menu reads `_` as the mark
/// of a key, so it is doubled; nothing else in a label is markup to the menu.
pub fn plain(title: &str) -> String {
    let one: String = title.chars().filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c }).collect();
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    let one = if one.is_empty() { "Untitled session".to_string() } else { one };
    let cut: String = if one.chars().count() > 60 { format!("{}…", one.chars().take(59).collect::<String>().trim_end()) } else { one };
    cut.replace('_', "__")
}

/// A session's line: its title and its state word.
fn line(l: &Listed) -> String {
    let word = plain(&l.word);
    if l.word.trim().is_empty() { plain(&l.title) } else { format!("{} · {word}", plain(&l.title)) }
}

/// The id of a session's item: one per session, from its id, so a click on a menu that has changed
/// never picks another session. Above the fixed items' ids; a clash moves on to the next free one.
fn item_id(id: &str, taken: &[i32]) -> i32 {
    let mut h: u32 = 2166136261;
    for b in id.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    let mut n = 1000 + (h % 1_000_000) as i32;
    while taken.contains(&n) {
        n += 1;
    }
    n
}

/// The menu, top to bottom: id, label (empty for a line), enabled, what it picks.
pub fn menu(s: &Shown) -> Vec<Item> {
    let mut m: Vec<Item> = vec![(1, headline(s), false, None, None), (2, String::new(), true, None, None)];
    // The sessions that wait, from the frame the count came in; none while the daemon is away.
    if s.link == Link::Up && !s.list.is_empty() {
        let mut taken: Vec<i32> = Vec::new();
        for l in &s.list {
            let id = item_id(&l.id, &taken);
            taken.push(id);
            m.push((id, line(l), true, Some(Pick::Session(l.id.clone())), l.state.map(|dot| Icon { dot, panel: s.panel })));
        }
        if s.unread > 0 {
            m.push((15, "Mark All as Read".into(), true, Some(Pick::MarkRead), None));
        }
        m.push((16, String::new(), true, None, None));
    }
    m.push((3, "Open Keel".into(), true, Some(Pick::Open), None));
    match s.link {
        Link::Up => {
            m.push((4, "New Session".into(), true, Some(Pick::New), None));
            m.push((5, String::new(), true, None, None));
            m.push(if s.paused { (6, "Resume Notifications".into(), true, Some(Pick::Resume), None) } else { (7, "Pause Notifications for an Hour".into(), true, Some(Pick::Pause), None) });
            if s.elsewhere {
                m.push((12, "Another Keel app shows the notifications".into(), false, None, None));
            }
        }
        Link::Down if !s.refused => m.push((8, "Start Keel".into(), true, Some(Pick::Start), None)),
        Link::Down => {}
        Link::Restarting => {}
    }
    // The desktop's dialog for the app's global shortcuts: asked for, or shown to be changed.
    match s.keys {
        Keys::Offer => m.push((13, "Set Global Shortcuts…".into(), true, Some(Pick::Shortcuts), None)),
        Keys::Change => m.push((14, "Change Global Shortcuts…".into(), true, Some(Pick::Shortcuts), None)),
        Keys::None | Keys::Held => {}
    }
    m.push((9, String::new(), true, None, None));
    m.push((10, "Quit".into(), true, Some(Pick::Quit), None));
    if s.link == Link::Up {
        m.push((11, "Quit and Stop the Daemon".into(), true, Some(Pick::QuitAll), None));
    }
    m
}

/// The state palette of ui/src/styles.css as sRGB (its --dot-* tokens, converted from oklch;
/// src/desktop-palette.test.ts holds the two to each other). The first is the fill, the second the
/// ring around it where the theme gives one (the light theme's yellow, which the rail's grey does not
/// set off by its fill alone). The unread dot is the ink of the theme.
fn dot_colors(i: Icon) -> ([u8; 3], Option<[u8; 3]>) {
    let hex = |v: u32| [(v >> 16) as u8, (v >> 8) as u8, v as u8];
    match (i.dot, i.panel) {
        (Dot::Work, Panel::Dark) => (hex(DARK_WORK), None),
        (Dot::Need, Panel::Dark) => (hex(DARK_NEED), None),
        (Dot::Unread, Panel::Dark) => (hex(DARK_UNREAD), None),
        (Dot::Work, _) => (hex(LIGHT_WORK), None),
        (Dot::Need, _) => (hex(LIGHT_NEED), Some(hex(LIGHT_NEED_EDGE))),
        (Dot::Unread, Panel::Light) => (hex(LIGHT_UNREAD), None),
        // A panel that does not say its theme: a grey that stands off both.
        (Dot::Unread, Panel::Unknown) => (hex(NEUTRAL_UNREAD), None),
    }
}
const LIGHT_WORK: u32 = 0x0071e0; // --dot-work
const LIGHT_NEED: u32 = 0xebb500; // --dot-need
const LIGHT_NEED_EDGE: u32 = 0x966800; // --dot-need-edge
const LIGHT_UNREAD: u32 = 0x11161f; // --dot-unread (the ink, --fg)
const DARK_WORK: u32 = 0x49a9ff; // --dot-work at night
const DARK_NEED: u32 = 0xefcc36; // --dot-need at night
const DARK_UNREAD: u32 = 0xf8f8f8; // --dot-unread at night
const NEUTRAL_UNREAD: u32 = 0x8a909b;

/// The dot's picture's side, in pixels: the menu draws its icons 16 wide, so twice that for a sharp screen.
const DOT: i32 = 32;

/// A dot as a PNG, which is what the menu's `icon-data` is. Made once for each state and panel.
fn dot_png(i: Icon) -> Vec<u8> {
    thread_local! { static MADE: RefCell<HashMap<Icon, Vec<u8>>> = RefCell::new(HashMap::new()); }
    MADE.with(|m| m.borrow_mut().entry(i).or_insert_with(|| draw_dot(i).unwrap_or_default()).clone())
}

fn draw_dot(i: Icon) -> Option<Vec<u8>> {
    let mut surface = cairo::ImageSurface::create(cairo::Format::ARgb32, DOT, DOT).ok()?;
    {
        let c = cairo::Context::new(&surface).ok()?;
        let (fill, ring) = dot_colors(i);
        let (mid, r) = (DOT as f64 / 2.0, DOT as f64 * 0.3);
        let rgb = |c: &cairo::Context, v: [u8; 3]| c.set_source_rgb(v[0] as f64 / 255.0, v[1] as f64 / 255.0, v[2] as f64 / 255.0);
        if let Some(edge) = ring {
            rgb(&c, edge);
            c.arc(mid, mid, r, 0.0, std::f64::consts::TAU);
            c.fill().ok()?;
            rgb(&c, fill);
            c.arc(mid, mid, r - 2.0, 0.0, std::f64::consts::TAU);
        } else {
            rgb(&c, fill);
            c.arc(mid, mid, r, 0.0, std::f64::consts::TAU);
        }
        c.fill().ok()?;
    }
    surface.flush();
    let stride = surface.stride() as usize;
    let data = surface.data().ok()?;
    // Cairo's premultiplied pixels in the machine's order, as the straight RGBA a PNG holds.
    let mut rgba = Vec::with_capacity((DOT * DOT * 4) as usize);
    for y in 0..DOT as usize {
        for x in 0..DOT as usize {
            let p = &data[y * stride + x * 4..y * stride + x * 4 + 4];
            let px = u32::from_ne_bytes([p[0], p[1], p[2], p[3]]);
            let a = (px >> 24) & 0xff;
            let un = |v: u32| if a == 0 { 0 } else { ((v * 255 + a / 2) / a).min(255) as u8 };
            rgba.extend_from_slice(&[un((px >> 16) & 0xff), un((px >> 8) & 0xff), un(px & 0xff), a as u8]);
        }
    }
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_bytes(&glib::Bytes::from_owned(rgba), gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, DOT, DOT, DOT * 4);
    pixbuf.save_to_bufferv("png", &[]).ok()
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
        let shown = Rc::new(RefCell::new(Shown { needs: 0, list: Vec::new(), unread: 0, paused: false, link: Link::Down, refused: false, elsewhere: false, keys: Keys::None, panel: Panel::Unknown }));
        let revision = Rc::new(Cell::new(1u32));
        let available = Rc::new(Cell::new(false));
        let on_pick = Rc::new(on_pick);

        let item = gio::DBusNodeInfo::for_xml(ITEM_XML)?.lookup_interface("org.kde.StatusNotifierItem").expect("the item's interface");
        let (s, pick) = (shown.clone(), on_pick.clone());
        conn.register_object(ITEM_PATH, &item)
            .method_call(move |_, _, _, _, method, _, inv| {
                // A press on the mark shows the window; the middle button starts a session.
                match method {
                    "Activate" => pick(Pick::Open),
                    "SecondaryActivate" => pick(Pick::New),
                    _ => {}
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
        let props = |label: &str, enabled: bool, icon: Option<Icon>| -> HashMap<String, glib::Variant> {
            let mut p = HashMap::new();
            if label.is_empty() {
                p.insert("type".to_string(), "separator".to_variant());
            } else {
                p.insert("label".to_string(), label.to_variant());
                p.insert("enabled".to_string(), enabled.to_variant());
                if let Some(icon) = icon.map(dot_png).filter(|png| !png.is_empty()) {
                    p.insert("icon-data".to_string(), icon.to_variant());
                }
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
                            items.iter().map(|(id, label, on, _, icon)| (*id, props(label, *on, *icon), Vec::<glib::Variant>::new()).to_variant()).collect()
                        } else {
                            Vec::new()
                        };
                        let mut root = HashMap::new();
                        root.insert("children-display".to_string(), "submenu".to_variant());
                        let node = match items.iter().find(|i| i.0 == parent) {
                            Some((id, label, on, _, icon)) => (*id, props(label, *on, *icon), children),
                            None => (0, root, children),
                        };
                        inv.return_value(Some(&(rev.get(), node).to_variant()));
                    }
                    "GetGroupProperties" => {
                        let ids = params.child_value(0).get::<Vec<i32>>().unwrap_or_default();
                        let all: Vec<(i32, HashMap<String, glib::Variant>)> = items.iter().filter(|i| ids.is_empty() || ids.contains(&i.0)).map(|(id, label, on, _, icon)| (*id, props(label, *on, *icon))).collect();
                        inv.return_value(Some(&(all,).to_variant()));
                    }
                    "GetProperty" => {
                        let id = params.child_value(0).get::<i32>().unwrap_or(0);
                        let name = params.child_value(1).get::<String>().unwrap_or_default();
                        let v = items.iter().find(|i| i.0 == id).and_then(|(_, label, on, _, icon)| props(label, *on, *icon).remove(&name)).unwrap_or_else(|| "".to_variant());
                        inv.return_value(Some(&(v,).to_variant()));
                    }
                    "Event" => {
                        let id = params.child_value(0).get::<i32>().unwrap_or(0);
                        let event = params.child_value(1).get::<String>().unwrap_or_default();
                        inv.return_value(None);
                        if event == "clicked" {
                            if let Some(p) = items.iter().find(|i| i.0 == id).and_then(|i| i.3.clone()) {
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
                                (event == "clicked").then(|| items.iter().find(|i| i.0 == id).and_then(|i| i.3.clone())).flatten()
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
        let (c, sh, rev) = (conn.clone(), shown.clone(), revision.clone());
        watch_panel(conn, move |panel| {
            let now = sh.borrow().clone();
            apply(&c, &sh, &rev, Shown { panel, ..now });
        });
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
        // The panel's theme is the portal's to say, not the caller's.
        let panel = self.shown.borrow().panel;
        apply(&self.conn, &self.shown, &self.revision, Shown { panel, ..next });
    }
}

/// Reads the desktop's color scheme from the settings portal and follows its changes. A desktop
/// with no portal, or one that does not say, leaves the panel unknown.
fn watch_panel(conn: &gio::DBusConnection, on: impl Fn(Panel) + 'static) {
    let on = Rc::new(on);
    let scheme = |v: &glib::Variant| -> Option<u32> {
        let mut v = v.clone();
        while v.type_().is_variant() {
            v = v.as_variant()?;
        }
        v.get::<u32>()
    };
    let (read, again) = (on.clone(), on.clone());
    conn.call(Some(PORTAL), PORTAL_PATH, SETTINGS, "Read", Some(&("org.freedesktop.appearance", "color-scheme").to_variant()), None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE, move |r| {
        if let Some(n) = r.ok().and_then(|v| v.child_value(0).as_variant()).and_then(|v| scheme(&v)) {
            read(Panel::of(n));
        }
    });
    #[allow(deprecated)]
    let _ = conn.signal_subscribe(Some(PORTAL), Some(SETTINGS), Some("SettingChanged"), Some(PORTAL_PATH), Some("org.freedesktop.appearance"), gio::DBusSignalFlags::NONE, move |_, _, _, _, _, p| {
        if p.child_value(1).get::<String>().as_deref() == Some("color-scheme") {
            if let Some(n) = scheme(&p.child_value(2)) {
                again(Panel::of(n));
            }
        }
    });
}

/// Puts `next` on show: the mark and the menu are told what changed.
fn apply(conn: &gio::DBusConnection, shown: &RefCell<Shown>, revision: &Cell<u32>, next: Shown) {
    {
        if *shown.borrow() == next {
            return;
        }
        let before = shown.replace(next.clone());
        let emit = |path: &str, iface: &str, name: &str, v: Option<glib::Variant>| {
            let _ = conn.emit_signal(None, path, iface, name, v.as_ref());
        };
        let item = "org.kde.StatusNotifierItem";
        emit(ITEM_PATH, item, "NewIcon", None);
        emit(ITEM_PATH, item, "NewAttentionIcon", None);
        emit(ITEM_PATH, item, "NewOverlayIcon", None);
        emit(ITEM_PATH, item, "NewToolTip", None);
        emit(ITEM_PATH, item, "NewStatus", Some((if next.needs > 0 && next.link == Link::Up { "NeedsAttention" } else { "Active" },).to_variant()));
        if menu(&before) != menu(&next) {
            revision.set(revision.get() + 1);
            emit(MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated", Some((revision.get(), 0i32).to_variant()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(needs: u32, paused: bool, link: Link) -> Shown {
        Shown { needs, list: Vec::new(), unread: 0, paused, link, refused: false, elsewhere: false, keys: Keys::None, panel: Panel::Unknown }
    }

    fn listed(id: &str, title: &str, word: &str) -> Listed {
        Listed { id: id.into(), title: title.into(), state: Some(Dot::Need), word: word.into() }
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
        // Another program attached first and takes the alerts: the menu says so, on a line that does nothing.
        let told = menu(&Shown { elsewhere: true, ..s(0, false, Link::Up) });
        assert!(told.iter().any(|(_, label, enabled, pick, _)| label == "Another Keel app shows the notifications" && !enabled && pick.is_none()));
        assert!(!menu(&s(0, false, Link::Up)).iter().any(|(_, label, _, _, _)| label.starts_with("Another")));
        // The desktop's global shortcuts: offered where it has them, shown to be changed once held, with the daemon up or not.
        assert_eq!(picks(&Shown { keys: Keys::Offer, ..s(0, false, Link::Up) }), [Pick::Open, Pick::New, Pick::Pause, Pick::Shortcuts, Pick::Quit, Pick::QuitAll]);
        assert_eq!(picks(&Shown { keys: Keys::Change, ..s(0, false, Link::Down) }), [Pick::Open, Pick::Start, Pick::Shortcuts, Pick::Quit]);
        assert_eq!(picks(&Shown { keys: Keys::Held, ..s(0, false, Link::Restarting) }), [Pick::Open, Pick::Quit]);
        let label = |k: Keys| menu(&Shown { keys: k, ..s(0, false, Link::Up) }).into_iter().find(|i| i.3 == Some(Pick::Shortcuts)).map(|i| i.1);
        assert_eq!(label(Keys::Offer).as_deref(), Some("Set Global Shortcuts…"));
        assert_eq!(label(Keys::Change).as_deref(), Some("Change Global Shortcuts…"));
        // An address the app does not speak to: nothing to start there.
        assert_eq!(picks(&Shown { refused: true, ..s(0, false, Link::Down) }), [Pick::Open, Pick::Quit]);
        // Ids are one per item, so a click on an old menu never picks another item.
        let ids: Vec<i32> = menu(&s(0, false, Link::Up)).iter().map(|i| i.0).collect();
        let mut sorted = ids.clone();
        sorted.dedup();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn the_menu_lists_the_sessions_of_the_frame() {
        let some = |list: Vec<Listed>, unread: u32, link: Link| Shown { list, unread, ..s(2, false, link) };
        let two = vec![listed("s1", "Fix the build", "Needs you"), listed("s2", "Rename the tables", "Needs you")];
        let m = menu(&some(two.clone(), 0, Link::Up));
        let labels: Vec<&str> = m.iter().map(|i| i.1.as_str()).collect();
        assert_eq!(&labels[..5], ["2 need you", "", "Fix the build · Needs you", "Rename the tables · Needs you", ""]);
        assert_eq!(m[2].3, Some(Pick::Session("s1".into())));
        assert_eq!(m[3].3, Some(Pick::Session("s2".into())));
        // Mark all as read is there while something is unread, and only then.
        assert!(!labels.contains(&"Mark All as Read"));
        assert!(menu(&some(two.clone(), 3, Link::Up)).iter().any(|i| i.3 == Some(Pick::MarkRead)));
        // None listed: no lines and no separator for them, the menu is what it was. None while the daemon is away.
        let none = menu(&some(Vec::new(), 0, Link::Up));
        assert_eq!(none.iter().map(|i| i.1.as_str()).take(3).collect::<Vec<_>>(), ["2 need you", "", "Open Keel"]);
        assert!(!menu(&some(two, 3, Link::Restarting)).iter().any(|i| matches!(i.3, Some(Pick::Session(_) | Pick::MarkRead))));
        // An item's id comes from its session, so it is the same wherever the session stands in the list.
        let id = |l: Vec<Listed>, sid: &str| menu(&some(l, 0, Link::Up)).into_iter().find(|i| i.3 == Some(Pick::Session(sid.into()))).map(|i| i.0);
        assert_eq!(id(vec![listed("a", "A", "w"), listed("b", "B", "w")], "b"), id(vec![listed("b", "B", "w")], "b"));
        assert_ne!(item_id("a", &[]), item_id("a", &[item_id("a", &[])]));
    }

    #[test]
    fn a_session_line_has_the_dot_of_its_state_and_nothing_else_has() {
        let line = |state: Option<Dot>, panel: Panel| {
            let l = Listed { state, ..listed("s1", "Fix the build", "w") };
            menu(&Shown { list: vec![l], panel, ..s(1, false, Link::Up) })
        };
        let m = line(Some(Dot::Work), Panel::Dark);
        assert_eq!(m.iter().filter_map(|i| i.4).collect::<Vec<_>>(), [Icon { dot: Dot::Work, panel: Panel::Dark }]);
        assert!(m.iter().find(|i| i.3 == Some(Pick::Session("s1".into()))).is_some_and(|i| i.4.is_some()));
        // A state this app does not know has no dot, and the panel's theme changes the menu, so a host draws it again.
        assert!(line(None, Panel::Dark).iter().all(|i| i.4.is_none()));
        assert_ne!(line(Some(Dot::Need), Panel::Dark), line(Some(Dot::Need), Panel::Light));
        assert_eq!(Panel::of(1), Panel::Dark);
        assert_eq!(Panel::of(2), Panel::Light);
        assert_eq!(Panel::of(0), Panel::Unknown);
        assert_eq!(Dot::of("unread"), Some(Dot::Unread));
        assert_eq!(Dot::of("fail"), None);
    }

    // The dot as a host reads it: a PNG of the menu's size, in the palette's colour of the state.
    #[test]
    fn the_dots_are_pngs_in_the_colours_of_the_state_palette() {
        let loader = |png: &[u8]| {
            let pb = gtk::gdk_pixbuf::Pixbuf::from_read(std::io::Cursor::new(png.to_vec())).expect("a PNG");
            (pb.width(), pb.height(), pb.pixel_bytes().expect("pixels").to_vec(), pb.n_channels())
        };
        let at = |px: &[u8], ch: i32, x: i32, y: i32| px[((y * DOT + x) * ch) as usize..][..ch as usize].to_vec();
        for (dot, panel, want) in [
            (Dot::Work, Panel::Light, [0x00, 0x71, 0xe0]),
            (Dot::Work, Panel::Dark, [0x49, 0xa9, 0xff]),
            (Dot::Need, Panel::Light, [0xeb, 0xb5, 0x00]),
            (Dot::Need, Panel::Dark, [0xef, 0xcc, 0x36]),
            (Dot::Unread, Panel::Light, [0x11, 0x16, 0x1f]),
            (Dot::Unread, Panel::Dark, [0xf8, 0xf8, 0xf8]),
        ] {
            let (w, h, px, ch) = loader(&dot_png(Icon { dot, panel }));
            assert_eq!((w, h), (DOT, DOT));
            assert_eq!(&at(&px, ch, DOT / 2, DOT / 2)[..3], want, "{dot:?} on {panel:?}");
            // Round: the corner is clear.
            assert_eq!(at(&px, ch, 0, 0)[3], 0);
        }
        // The light theme's yellow has its amber ring, where the rail's grey does not set the fill off.
        let (_, _, px, ch) = loader(&dot_png(Icon { dot: Dot::Need, panel: Panel::Light }));
        assert_eq!(&at(&px, ch, DOT / 2 + (DOT as f64 * 0.3) as i32 - 1, DOT / 2)[..3], [0x96, 0x68, 0x00]);
        // Made once: the same bytes each time.
        let i = Icon { dot: Dot::Work, panel: Panel::Unknown };
        assert_eq!(dot_png(i), dot_png(i));
    }

    #[test]
    fn a_title_reaches_the_menu_as_plain_text() {
        assert_eq!(plain("Fix\nthe\tbuild\r\n"), "Fix the build");
        assert_eq!(plain("a\u{202e}b\u{200f}c"), "abc");
        assert_eq!(plain("<b>bold</b> & &amp; <img src=x>"), "<b>bold</b> & &amp; <img src=x>");
        // A menu reads an underscore as a key mark: doubled, it shows as one.
        assert_eq!(plain("snake_case _x"), "snake__case __x");
        assert_eq!(plain(" \n "), "Untitled session");
        let long = plain(&"é".repeat(100));
        assert_eq!(long.chars().count(), 60);
        assert!(long.ends_with('…'));
        assert_eq!(line(&listed("s", "T", "")), "T");
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
