// A stand-in for the desktop portal's global shortcuts, for the end-to-end check: it owns the
// portal's name on the workspace's own session bus and speaks the interface as its
// specification has it (a session, a bind that answers on a request, the Activated signal). The
// owner's part is played by two files in the folder it is given: `answer` ("no" refuses the
// next dialog; "fail" is a desktop that could not do it) and `granted` (written at a yes: the
// next bind is answered with no dialog, as a desktop that remembers does). The check presses a
// shortcut through `Press`. It says which connection named itself and which one asked.
// It proves the app's side of the conversation, not a desktop's own portal.
// Run: gjs -m portal-host.js FOLDER
import Gio from "gi://Gio";
import GLib from "gi://GLib";

const dir = ARGV[0];
const PATH = "/org/freedesktop/portal/desktop";
const text = (name) => { try { return new TextDecoder().decode(GLib.file_get_contents(`${dir}/${name}`)[1]).trim(); } catch { return ""; } };
const str = (v) => (v instanceof GLib.Variant ? v.deepUnpack() : v);
const requestPath = (sender, token) => `${PATH}/request/${sender.slice(1).replaceAll(".", "_")}/${token}`;
// "CTRL+ALT+K" as a desktop words it: Ctrl+Alt+K
const worded = (keys) => String(keys).split("+").map((k) => (k.length > 1 ? k[0] + k.slice(1).toLowerCase() : k)).join("+");

let conn;
let held = null; // the session that holds the shortcuts
const answer = (sender, path, code, results) =>
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
    conn.emit_signal(sender, path, "org.freedesktop.portal.Request", "Response", new GLib.Variant("(ua{sv})", [code, results]));
    return GLib.SOURCE_REMOVE;
  });

const shortcuts = {
  get version() { return 2; },
  CreateSessionAsync([options], invocation) {
    const sender = invocation.get_sender();
    const path = requestPath(sender, str(options.handle_token));
    const session = `${PATH}/session/${sender.slice(1).replaceAll(".", "_")}/${str(options.session_handle_token)}`;
    print(`CREATE ${session} ${sender}`);
    invocation.return_value(new GLib.Variant("(o)", [path]));
    answer(sender, path, 0, { session_handle: new GLib.Variant("s", session) });
  },
  BindShortcutsAsync([session, wanted, _parent, options], invocation) {
    const sender = invocation.get_sender();
    const path = requestPath(sender, str(options.handle_token));
    invocation.return_value(new GLib.Variant("(o)", [path]));
    const silent = text("granted") === "yes";
    const failed = !silent && text("answer") === "fail";
    const yes = !failed && (silent || text("answer") !== "no");
    const bound = wanted.map(([id, o]) => [id, { description: new GLib.Variant("s", str(o.description) ?? ""), trigger_description: new GLib.Variant("s", worded(str(o.preferred_trigger) ?? "")) }]);
    print(`BIND ${silent ? "silent" : "dialog"} ${failed ? "fail" : yes ? "yes" : "no"} ${wanted.map(([id, o]) => `${id}=${worded(str(o.preferred_trigger) ?? "")}`).join(" ")}`);
    if (yes) { held = session; GLib.file_set_contents(`${dir}/granted`, "yes"); }
    answer(sender, path, failed ? 2 : yes ? 0 : 1, yes ? { shortcuts: new GLib.Variant("a(sa{sv})", bound) } : {});
  },
  ConfigureShortcutsAsync([session], invocation) {
    print(`CONFIGURE ${session === held ? "held" : "unknown"}`);
    invocation.return_value(null);
  },
};
const registry = {
  RegisterAsync([app], invocation) { print(`REGISTER ${app} ${invocation.get_sender()}`); invocation.return_value(null); },
};
const check = {
  // The owner presses a shortcut somewhere on the desktop.
  Press(id, token) {
    print(`PRESS ${id} ${held ? "sent" : "nobody holds it"}`);
    if (held) conn.emit_signal(null, PATH, "org.freedesktop.portal.GlobalShortcuts", "Activated",
      new GLib.Variant("(osta{sv})", [held, id, Math.floor(Date.now() / 1000), token ? { activation_token: new GLib.Variant("s", token) } : {}]));
  },
};

const wrap = (xml, o) => Gio.DBusExportedObject.wrapJSObject(`<node>${xml}</node>`, o);
const exported = [
  wrap(`<interface name="org.freedesktop.portal.GlobalShortcuts">
<method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="BindShortcuts"><arg type="o" direction="in"/><arg type="a(sa{sv})" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="ConfigureShortcuts"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method>
<signal name="Activated"><arg type="o"/><arg type="s"/><arg type="t"/><arg type="a{sv}"/></signal>
<property name="version" type="u" access="read"/></interface>`, shortcuts),
  wrap(`<interface name="org.freedesktop.host.portal.Registry">
<method name="Register"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method></interface>`, registry),
  wrap(`<interface name="io.github.agent_sh.Keel.Check">
<method name="Press"><arg type="s" direction="in"/><arg type="s" direction="in"/></method></interface>`, check),
];
Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.portal.Desktop", Gio.BusNameOwnerFlags.NONE,
  (c) => { conn = c; for (const e of exported) e.export(c, PATH); }, () => print("READY"), () => { print("LOST"); loop.quit(); });
const loop = new GLib.MainLoop(null, false);
loop.run();
