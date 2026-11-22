// The end-to-end check's own script in the top frame of the app's page (KEEL_DESKTOP_PROBE):
// it shows a session's HTML artifact in the frame the Artifacts panel uses, tries to leave the
// daemon's origin and its page paths when asked, asks the app for the clipboard at a press and
// without one, and says where the page is. It reports on the app's standard output.
(() => {
  const say = (s) => { try { window.webkit.messageHandlers.probe.postMessage(s); } catch (e) {} };
  let shown = false;
  let raw = "";
  setInterval(async () => {
    const at = document.activeElement;
    say(`AT ${location.origin}${location.pathname} shell=${typeof window.keelShell} band=${!!document.querySelector("[data-testid=daemon-away]")} scale=${getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim()} active=${at ? at.dataset.testid || at.tagName : ""} imgs=${document.querySelectorAll("[data-testid=attachments] img").length}`);
    const m = location.pathname.match(/^\/s\/([\w-]+)$/);
    if (!m || shown) return;
    const r = await fetch(`/api/sessions/${m[1]}/artifacts`).then((x) => x.json()).catch(() => null);
    const a = r && r.artifacts && r.artifacts.find((x) => x.name === "shell-probe.html");
    if (!a) return;
    shown = true;
    // As ui/src/components/ArtifactsPanel.tsx shows an HTML artifact.
    raw = `/api/sessions/${a.session_id}/artifacts/raw?path=${encodeURIComponent(a.path)}`;
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("data-content-frame", "");
    f.referrerPolicy = "no-referrer";
    f.src = raw;
    f.style.cssText = "position:fixed;right:1rem;bottom:1rem;width:22rem;height:12rem;z-index:99;background:#fff";
    document.body.append(f);
    say("FRAME shown");
    setTimeout(() => f.remove(), 45000);
  }, 1000);
  // The app's answers to what this script asked of the clipboard.
  addEventListener("keel-shell", (e) => {
    const d = e.detail || {};
    if (d.copied && d.copied.id >= 9000) say(`COPIED id=${d.copied.id} ok=${d.copied.ok}`);
    if (d.pasted && d.pasted.id >= 9000) say(`PASTED id=${d.pasted.id} refused=${!!d.pasted.refused} text=${JSON.stringify(d.pasted.text ?? null)} images=${(d.pasted.images || []).length}${d.pasted.images && d.pasted.images[0] ? ` size=${d.pasted.images[0].width}x${d.pasted.images[0].height} from=${(d.pasted.from || []).join("x")} chars=${d.pasted.images[0].data.length}` : ""}`);
  });
  const copy = (id, text) => { window.keelShell.post({ t: "copying" }); window.keelShell.post({ t: "copy", id, text }); };
  addEventListener("keydown", (e) => {
    // Another origin.
    if (e.key === "F8") { say("LEAVING"); location.href = "http://127.0.0.1:FOREIGN_PORT/foreign"; }
    // The daemon's own origin, but no place of the page: the artifact's raw address, a sandboxed document.
    if (e.key === "F9" && raw) { say("GOING-RAW"); location.href = raw; }
    // The same address as a file to keep: a download, and the page stays.
    if (e.key === "F10" && raw) { say("GOING-DOWNLOAD"); location.href = `${raw}&download=1`; }
    // A copy at this press, and one four seconds later that no press allowed.
    if (e.key === "F7") { copy(9001, "copied-by-the-check"); setTimeout(() => copy(9002, "planted-without-a-press"), 4000); }
    // A paste at this press, of a picture no larger than the page keeps one.
    if (e.key === "F5") window.keelShell.post({ t: "paste", id: 9005, edge: 1568 });
    // A paste at this press, and one four seconds later.
    if (e.key === "F6") { window.keelShell.post({ t: "paste", id: 9003 }); setTimeout(() => window.keelShell.post({ t: "paste", id: 9004 }), 4000); }
  }, true);
})();
