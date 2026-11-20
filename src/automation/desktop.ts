import { pumpLines, readText } from "../core/proc.ts";

// GNOME sends ActionInvoked and ActivationToken to the unique bus name that
// called Notify. A second gdbus process cannot receive them. Keep one Gio
// connection for all notifications and close it when the daemon's pipe ends.
const worker = String.raw`
const { Gio, GLib } = imports.gi;
const service = "org.freedesktop.Notifications";
const proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION,
  Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES, null, service, "/org/freedesktop/Notifications", service, null);
const send = (msg) => print(JSON.stringify(msg));
const call = (method, type, args) =>
  proxy.call_sync(method, new GLib.Variant(type, args), Gio.DBusCallFlags.NONE, 5000, null).deepUnpack();
const byKey = new Map(), byId = new Map();
const forget = (id) => {
  const note = byId.get(id);
  if (note) byKey.delete(note.key);
  byId.delete(id);
};
proxy.connect("notify::g-name-owner", () => { byKey.clear(); byId.clear(); });
proxy.connect("g-signal", (_proxy, _sender, signal, params) => {
  const [id, value] = params.deepUnpack();
  const note = byId.get(id);
  if (!note) return;
  if (signal === "NotificationClosed") forget(id);
  else if (signal === "ActivationToken") note.token = value;
  else if (signal === "ActionInvoked" && value === "default" && note.alert) {
    send({ alert: note.alert, token: note.token });
    note.alert = null;
  }
});
// GLib 2.80 moved the Unix streams into a separate typelib.
let UnixInputStream;
try { UnixInputStream = imports.gi.GioUnix.InputStream; } catch (_) { UnixInputStream = Gio.UnixInputStream; }
const input = new Gio.DataInputStream({ base_stream: new UnixInputStream({ fd: 0 }) });
const loop = new GLib.MainLoop(null, false);
const read = () => input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
  const [line] = stream.read_line_finish_utf8(res);
  if (line === null) return loop.quit();
  const req = JSON.parse(line);
  const old = byKey.get(req.key) ?? 0;
  try {
    if (req.alert) {
      const hints = {
        "suppress-sound": new GLib.Variant("b", true),
        "urgency": new GLib.Variant("y", req.urgency),
        "desktop-entry": new GLib.Variant("s", "keel"),
        "category": new GLib.Variant("s", "keel." + req.kind),
      };
      const [id] = call("Notify", "(susssasa{sv}i)", ["Keel", old, "", req.title, req.body, ["default", "Open Keel"], hints, -1]);
      forget(old);
      byKey.set(req.key, id);
      byId.set(id, { key: req.key, alert: req.alert });
    } else if (old) {
      forget(old);
      call("CloseNotification", "(u)", [old]);
    }
    send({ seq: req.seq });
  } catch (e) {
    send({ seq: req.seq, error: e.message });
  }
  read();
});
read();
loop.run();
`;

type Request = { key: string; alert?: string; title?: string; body?: string; urgency?: number; kind?: string };

export function desktopNotifications(activate: (alert: string, token?: string) => void) {
  const p = Bun.spawn(["gjs", "-c", worker], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.unref();
  const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let seq = 0;
  let ended: Error | undefined;
  const stderr = readText(p.stderr).catch(() => "");
  void pumpLines(p.stdout, (line) => {
    const res = JSON.parse(line);
    if (res.alert) return activate(res.alert, res.token);
    const req = waiting.get(res.seq);
    waiting.delete(res.seq);
    if (res.error) req?.reject(new Error(`desktop notification failed: ${res.error}`));
    else req?.resolve();
  }).catch((e: Error) => {
    ended = e;
    p.kill();
  }).then(async () => {
    const err = (await stderr).trim();
    ended ??= new Error(`desktop notification helper exited${err ? `: ${err}` : ""}`);
    for (const req of waiting.values()) req.reject(ended);
    waiting.clear();
  });
  return {
    get ended() { return ended !== undefined; },
    send(req: Request) {
      if (ended) return Promise.reject(ended);
      const id = ++seq;
      return new Promise<void>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        try {
          p.stdin.write(JSON.stringify({ ...req, seq: id }) + "\n");
          p.stdin.flush();
        } catch (e) {
          waiting.delete(id);
          reject(e);
        }
      });
    },
  };
}
