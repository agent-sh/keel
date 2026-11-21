// A stand-in tray host for the end-to-end check: it owns the watcher's name on
// the session bus and takes the item an app offers, as a panel would. It
// prints one line per item. Run: gjs -m tray-host.js
import Gio from "gi://Gio";
import GLib from "gi://GLib";

const xml = `<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
<signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
</interface></node>`;

const items = [];
const watcher = {
  RegisterStatusNotifierItemAsync([service], invocation) {
    const item = service.startsWith("/") ? `${invocation.get_sender()}${service}` : service;
    items.push(item);
    print(`ITEM ${item}`);
    invocation.return_value(null);
  },
  RegisterStatusNotifierHostAsync(_p, invocation) { invocation.return_value(null); },
  get RegisteredStatusNotifierItems() { return items; },
  get IsStatusNotifierHostRegistered() { return true; },
  get ProtocolVersion() { return 0; },
};
const exported = Gio.DBusExportedObject.wrapJSObject(xml, watcher);
Gio.bus_own_name(Gio.BusType.SESSION, "org.kde.StatusNotifierWatcher", Gio.BusNameOwnerFlags.NONE,
  (conn) => exported.export(conn, "/StatusNotifierWatcher"), () => print("READY"), () => { print("LOST"); loop.quit(); });
const loop = new GLib.MainLoop(null, false);
loop.run();
