// A stand-in notification service for the end-to-end check: it owns
// org.freedesktop.Notifications on the session bus, prints what it is asked to
// show, and clicks a notification when told to (test.Click), as the desktop
// would: the activation token, then the action. Run: gjs -m notify-host.js
import Gio from "gi://Gio";
import GLib from "gi://GLib";

const xml = `<node><interface name="org.freedesktop.Notifications">
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
<signal name="ActivationToken"><arg type="u"/><arg type="s"/></signal>
</interface><interface name="test.Notifications">
<method name="Click"><arg type="u" direction="in"/></method>
<method name="Shown"><arg type="s" direction="out"/></method>
</interface></node>`;

let next = 1;
const shown = new Map();
let conn;
const emit = (name, sig, args) => conn.emit_signal(null, "/org/freedesktop/Notifications", "org.freedesktop.Notifications", name, new GLib.Variant(sig, args));
const service = {
  GetCapabilities: () => ["actions", "body", "persistence"],
  GetServerInformation: () => ["stand-in", "keel-desktop test", "1", "1.2"],
  Notify(app, replaces, icon, summary, body, actions, hints, _expire) {
    const id = replaces && shown.has(replaces) ? replaces : next++;
    const entry = hints["desktop-entry"]?.deepUnpack?.() ?? "";
    shown.set(id, { app, icon, summary, body, actions, entry, urgency: hints.urgency?.deepUnpack?.() ?? null });
    print(`NOTIFY ${JSON.stringify({ id, replaces, ...shown.get(id) })}`);
    return id;
  },
  CloseNotification(id) {
    if (shown.delete(id)) { print(`CLOSE ${id}`); emit("NotificationClosed", "(uu)", [id, 3]); }
  },
};
const control = {
  Click(id) {
    emit("ActivationToken", "(us)", [id, `stand-in-token-${id}`]);
    emit("ActionInvoked", "(us)", [id, "default"]);
    print(`CLICK ${id}`);
  },
  Shown: () => JSON.stringify([...shown].map(([id, n]) => ({ id, ...n }))),
};
const info = Gio.DBusNodeInfo.new_for_xml(xml);
const a = Gio.DBusExportedObject.wrapJSObject(info.interfaces[0], service);
const b = Gio.DBusExportedObject.wrapJSObject(info.interfaces[1], control);
Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.Notifications", Gio.BusNameOwnerFlags.NONE,
  (c) => { conn = c; a.export(c, "/org/freedesktop/Notifications"); b.export(c, "/org/freedesktop/Notifications"); },
  () => print("READY"), () => { print("LOST"); loop.quit(); });
const loop = new GLib.MainLoop(null, false);
loop.run();
