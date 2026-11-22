// A stand-in for the desktop's accessibility bus, for the end-to-end check: it owns the name on
// the workspace's own session bus and holds the two words a program reads there (is accessibility
// on, is a screen reader on). The check sets the screen reader's word through it, as a desktop's
// own switch does, and every program that listens is told. Run: gjs -m a11y-host.js
import Gio from "gi://Gio";
import GLib from "gi://GLib";

const xml = `<node><interface name="org.a11y.Status">
<property name="IsEnabled" type="b" access="readwrite"/>
<property name="ScreenReaderEnabled" type="b" access="readwrite"/>
</interface></node>`;

const words = { IsEnabled: false, ScreenReaderEnabled: false };
let exported;
const told = (name) => exported.emit_property_changed(name, new GLib.Variant("b", words[name]));
const status = {
  get IsEnabled() { return words.IsEnabled; },
  set IsEnabled(v) { words.IsEnabled = v; told("IsEnabled"); },
  get ScreenReaderEnabled() { return words.ScreenReaderEnabled; },
  set ScreenReaderEnabled(v) { words.ScreenReaderEnabled = v; told("ScreenReaderEnabled"); print(`READER ${v}`); },
};
exported = Gio.DBusExportedObject.wrapJSObject(xml, status);
Gio.bus_own_name(Gio.BusType.SESSION, "org.a11y.Bus", Gio.BusNameOwnerFlags.NONE,
  (conn) => exported.export(conn, "/org/a11y/bus"), () => print("READY"), () => { print("LOST"); loop.quit(); });
const loop = new GLib.MainLoop(null, false);
loop.run();
