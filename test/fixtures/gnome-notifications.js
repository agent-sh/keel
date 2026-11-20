// A private-bus stand-in. Like GNOME, the action goes only to the original
// caller's unique bus name, not to another client listening for a broadcast.
const { Gio, GLib } = imports.gi;
const name = "org.freedesktop.Notifications";
const path = "/org/freedesktop/Notifications";
const contract = `<node><interface name="${name}">
  <method name="GetCapabilities"><arg type="as" direction="out"/></method>
  <method name="Notify">
    <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
    <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
    <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
  </method>
  <method name="Click"><arg type="u" direction="in"/></method>
</interface></node>`;
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const notes = new Map();
let next = 1;
const mode = ARGV[0];
const supportsActions = mode !== "no-actions";
const object = Gio.DBusExportedObject.wrapJSObject(contract, {
  GetCapabilities() { return supportsActions ? ["actions"] : []; },
  NotifyAsync([, replace, , title, body, actions], invocation) {
    if (!supportsActions && actions.length) {
      invocation.return_dbus_error(`${name}.Unsupported`, "notification server does not support actions");
      return;
    }
    const id = replace || next++;
    notes.set(id, { sender: invocation.get_sender(), actions });
    print(JSON.stringify({ id, replace, title, body, actions }));
    if (mode === "notify-error") invocation.return_dbus_error(`${name}.Failed`, "reply failed after showing the notification");
    else invocation.return_value(new GLib.Variant("(u)", [id]));
  },
  ClickAsync([id], invocation) {
    const note = notes.get(id);
    if (!note?.actions.includes("default")) {
      invocation.return_dbus_error("org.freedesktop.Notifications.NoAction", "Notify did not register a default action");
      return;
    }
    bus.emit_signal(note.sender, path, name, "ActivationToken", new GLib.Variant("(us)", [id, "synthetic-token"]));
    bus.emit_signal(note.sender, path, name, "ActionInvoked", new GLib.Variant("(us)", [id, "default"]));
    invocation.return_value(new GLib.Variant("()", []));
  },
});
object.export(bus, path);
const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, () => print("ready"), () => loop.quit());
loop.run();
