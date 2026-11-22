// The end-to-end check's own script in the top frame of the app's page (KEEL_DESKTOP_PROBE):
// it shows a session's HTML artifact in the frame the Artifacts panel uses, tries to leave the
// daemon's origin when asked, and says where the page is. It reports on the app's standard output.
(() => {
  const say = (s) => { try { window.webkit.messageHandlers.probe.postMessage(s); } catch (e) {} };
  let shown = false;
  setInterval(async () => {
    const at = document.activeElement;
    say(`AT ${location.origin}${location.pathname} shell=${typeof window.keelShell} band=${!!document.querySelector("[data-testid=daemon-away]")} scale=${getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim()} active=${at ? at.dataset.testid || at.tagName : ""}`);
    const m = location.pathname.match(/^\/s\/([\w-]+)$/);
    if (!m || shown) return;
    const r = await fetch(`/api/sessions/${m[1]}/artifacts`).then((x) => x.json()).catch(() => null);
    const a = r && r.artifacts && r.artifacts.find((x) => x.name === "shell-probe.html");
    if (!a) return;
    shown = true;
    // As ui/src/components/ArtifactsPanel.tsx shows an HTML artifact.
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.referrerPolicy = "no-referrer";
    f.src = `/api/sessions/${a.session_id}/artifacts/raw?path=${encodeURIComponent(a.path)}`;
    f.style.cssText = "position:fixed;right:1rem;bottom:1rem;width:22rem;height:12rem;z-index:99;background:#fff";
    document.body.append(f);
    say("FRAME shown");
    setTimeout(() => f.remove(), 6000);
  }, 1000);
  addEventListener("keydown", (e) => {
    if (e.key === "F8") { say("LEAVING"); location.href = "http://127.0.0.1:FOREIGN_PORT/foreign"; }
  }, true);
})();
