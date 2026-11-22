// Another app with the keyboard, for the end-to-end check of focus. On the key "t" it asks the
// desktop for an activation token, as a launcher that has just had the owner's input does, and
// writes it to the file it was given.
import Gtk from "gi://Gtk?version=4.0";
import Gdk from "gi://Gdk?version=4.0";
import GLib from "gi://GLib";
const out = ARGV[0];
const app = new Gtk.Application({ application_id: "io.github.agent_sh.KeelCheckOther" });
app.connect("activate", () => {
  const win = new Gtk.ApplicationWindow({ application: app, title: "Another app", default_width: 900, default_height: 600 });
  win.set_child(new Gtk.Label({ label: "Another app has the keyboard" }));
  const keys = new Gtk.EventControllerKey();
  keys.connect("key-pressed", (_c, keyval) => {
    if (keyval !== Gdk.KEY_t) return false;
    const token = Gdk.Display.get_default().get_app_launch_context().get_startup_notify_id(null, []);
    GLib.file_set_contents(out, token ?? "");
    print(`TOKEN ${token ? "given" : "none"}`);
    return true;
  });
  win.add_controller(keys);
  win.present();
  print("READY");
});
app.run([]);
