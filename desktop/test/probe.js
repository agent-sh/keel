// The end-to-end check's own script in the top frame of the app's page (KEEL_DESKTOP_PROBE):
// it shows a session's HTML artifact in the frame the Artifacts panel uses, tries to leave the
// daemon's origin and its page paths when asked, asks the app for the clipboard at a press and
// without one, and says where the page is. It reports on the app's standard output.
(() => {
  // (The measuring channel of whichever engine draws the page.)
  const say = (s) => { try { if (window.__keelProbe) window.__keelProbe(s); else window.webkit.messageHandlers.probe.postMessage(s); } catch (e) {} };
  let shown = false;
  let raw = "";
  let went = false;
  let frame = null;
  setInterval(async () => {
    const at = document.activeElement;
    say(`AT ${location.origin}${location.pathname} shell=${typeof window.keelShell} band=${!!document.querySelector("[data-testid=daemon-away]")} scale=${getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim()} active=${at ? at.dataset.testid || at.tagName : ""} imgs=${document.querySelectorAll("[data-testid=attachments] img").length} draft=${(document.querySelector("textarea") || { value: "" }).value.length} note=${!!document.querySelector("[data-testid=shell-note]")} win=${window.keelShell ? window.keelShell.window : "-"} inbox=${!!document.querySelector("[data-testid=inbox-panel]")} keys=${!!window.keelShell?.can?.shortcuts}`);
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
    // (And as the panel's frame is taken off the page when the page stops it: ui/src/components/ContentFrame.tsx.)
    f.addEventListener("keel-frame-stopped", () => { say("FRAME stopped"); f.remove(); });
    document.body.append(f);
    frame = f;
    say("FRAME shown");
    setTimeout(() => f.remove(), 45000);
  }, 1000);
  // Where the attach button is, for the check's pointer: its middle and the page's size, said
  // when they change. (The page reaches the window's left, right and bottom edges, so the
  // check finds the button from those.)
  let attachAt = "";
  setInterval(() => {
    const b = document.querySelector("[data-testid=attach]");
    if (!b) return;
    const r = b.getBoundingClientRect();
    const at = `${Math.round(r.left + r.width / 2)} ${Math.round(r.top + r.height / 2)} ${innerWidth} ${innerHeight}`;
    if (at !== attachAt && r.width > 0) { attachAt = at; say(`ATTACH ${at}`); }
  }, 1000);
  // The files the message box holds (pictures and others), said when their number changes: for the file dialog's case.
  let filesHeld = -1;
  setInterval(() => {
    const n = document.querySelectorAll("[data-testid=attachments] > *").length;
    if (n !== filesHeld) { filesHeld = n; say(`FILES ${n}`); }
  }, 1000);
  // The paste keys as the app hands them to the page (the Qt engine's window).
  addEventListener("keel-shell", (e) => { if (e.detail && e.detail.paste) say("PASTE-KEY handed to the page"); });
  // F4: the artifact's frame is shown anew (each run of the paste race has a frame of its own).
  addEventListener("keydown", (e) => { if (e.key === "F4") { if (frame) frame.remove(); shown = false; } }, true);
  // The review's loop case: on a session titled for it, a content frame (as an artifact's, or as
  // the preview's) whose script asks for the keyboard as fast as it can. What each side got is
  // said twice a second.
  let loop = "";
  let frameChars = 0, frameFocus = 0, offered = 0;
  addEventListener("message", (e) => { if (e.data && e.data.frameChars !== undefined) { frameChars = e.data.frameChars; frameFocus = e.data.frameFocus; offered = e.data.offered || 0; } });
  setInterval(async () => {
    const m = location.pathname.match(/^\/s\/([\w-]+)$/);
    if (!m) return;
    if (loop !== m[1]) {
      const title = await fetch(`/api/sessions/${m[1]}?events=0`).then((x) => x.json()).then((x) => x.session.title).catch(() => "");
      const kind = /takes the keyboard \((artifact|preview)\)/.exec(title);
      if (!kind || loop === m[1]) return;
      loop = m[1];
      frameChars = frameFocus = offered = 0;
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", kind[1] === "preview" ? "allow-scripts allow-forms allow-modals allow-popups allow-downloads" : "allow-scripts");
      f.setAttribute("data-content-frame", "");
      f.setAttribute("allow", "focus-without-user-activation 'none'");
      f.style.cssText = "position:fixed;right:1rem;bottom:14rem;width:20rem;height:8rem;z-index:99;background:#fff";
      // (The preview's frame may keep files: it also offers some all the while, one of the
      // daemon's own and one its script made. None may be kept: the owner pressed no link.)
      // (One of the daemon's own that answers as a file to keep, asked for in a frame of the
      // frame's own so that nothing navigates; and one its script made.)
      const offers = kind[1] !== "preview" ? "" : `setInterval(() => { const n = document.createElement('iframe'); n.src = ${JSON.stringify(`${location.origin}/api/sessions/${m[1]}/export?format=md`)}; n.hidden = true; document.body.append(n); setTimeout(() => n.remove(), 350); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['from a frame'])); a.download = 'from-a-frame.html'; document.body.append(a); a.click(); a.remove(); off += 2; }, 400);`;
      f.srcdoc = "<body><input id=i autofocus><script>let foc = 0, off = 0; const i = document.getElementById('i'); addEventListener('focus', () => foc++); setInterval(() => { window.focus(); i.focus(); i.click(); }, 0); setInterval(() => parent.postMessage({ frameChars: i.value.length, frameFocus: foc, offered: off }, '*'), 200);" + offers + "</" + "script></body>";
      document.body.append(f);
      // (As the page's own frames do when the page stops one that keeps taking the keyboard.)
      f.addEventListener("keel-frame-stopped", () => { say("LOOP stopped"); f.remove(); });
      setInterval(() => { if (location.pathname !== `/s/${m[1]}`) f.remove(); }, 500);
      say(`LOOP shown kind=${kind[1]}`);
    }
    const box = document.querySelector("textarea");
    say(`LOOP at=${m[1]} box=${box ? box.value.length : -1} frameChars=${frameChars} frameFocus=${frameFocus} offered=${offered} active=${document.activeElement ? document.activeElement.tagName : ""}`);
  }, 500);
  // Calls between browsers: a local page has no use for them, and they must find no address here.
  setTimeout(() => {
    if (typeof RTCPeerConnection === "undefined") return say("RTC none");
    try {
      const pc = new RTCPeerConnection();
      let n = 0;
      pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) n++; };
      pc.createDataChannel("probe");
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
      setTimeout(() => { say(`RTC candidates=${n}`); pc.close(); }, 4000);
    } catch (e) { say("RTC none"); }
  }, 3000);
  // The app's answers to what this script asked of the clipboard.
  addEventListener("keel-shell", (e) => {
    const d = e.detail || {};
    if (d.copied && d.copied.id >= 9000) say(`COPIED id=${d.copied.id} ok=${d.copied.ok}`);
    if (d.pasted && d.pasted.id >= 9000) say(`PASTED id=${d.pasted.id} refused=${!!d.pasted.refused} text=${JSON.stringify(d.pasted.text ?? null)} images=${(d.pasted.images || []).length}${d.pasted.images && d.pasted.images[0] ? ` size=${d.pasted.images[0].width}x${d.pasted.images[0].height} from=${(d.pasted.from || []).join("x")} chars=${d.pasted.images[0].data.length}` : ""} failed=${!!d.pasted.failed}`);
  });
  const copy = (id, text) => { window.keelShell.post({ t: "copying" }); window.keelShell.post({ t: "copy", id, text }); };
  addEventListener("keydown", (e) => {
    // Another origin.
    if (e.key === "F8") { say("LEAVING"); location.href = "http://127.0.0.1:FOREIGN_PORT/foreign"; }
    // The daemon's own origin, but no place of the page: the artifact's raw address, a sandboxed document.
    if (e.key === "F9" && raw) { say("GOING-RAW"); location.href = raw; }
    // The same address as a file to keep: a download, and the page stays. A second press offers
    // the file as the page offers one: a link to keep it, which is no navigation.
    if (e.key === "F10" && raw && !went) { went = true; say("GOING-DOWNLOAD"); location.href = `${raw}&download=1`; }
    else if (e.key === "F10" && raw) { say("OFFERING"); const a = document.createElement("a"); a.href = `${raw}&download=1`; a.download = "shell-probe.html"; document.body.append(a); a.click(); a.remove();
      // And once more by itself, when the owner's press is long past: a script keeps no file.
      setTimeout(() => { say("OFFERING-LATE"); const b = document.createElement("a"); b.href = `${raw}&download=1`; b.download = "shell-probe.html"; document.body.append(b); b.click(); b.remove(); }, 12000); }
    // A copy at this press, and one four seconds later that no press allowed.
    if (e.key === "F7") { copy(9001, "copied-by-the-check"); setTimeout(() => copy(9002, "planted-without-a-press"), 4000); }
    // A paste at this press, of a picture no larger than the page keeps one.
    if (e.key === "F5") window.keelShell.post({ t: "paste", id: 9005, edge: 1568 });
    // A paste at this press, and one four seconds later.
    if (e.key === "F6") { window.keelShell.post({ t: "paste", id: 9003 }); setTimeout(() => window.keelShell.post({ t: "paste", id: 9004 }), 4000); }
  }, true);
})();
