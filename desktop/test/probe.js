// The end-to-end check's own script in the top frame of the app's page (KEEL_DESKTOP_PROBE):
// it shows a session's HTML artifact in the frame the Artifacts panel uses, tries to leave the
// daemon's origin and its page paths when asked, asks the app for the clipboard at a press and
// without one, and says where the page is. It reports on the app's standard output.
(() => {
  // (The measuring channel of whichever engine draws the page.)
  const say = (s) => { try { if (window.__keelProbe) window.__keelProbe(s); else window.webkit.messageHandlers.probe.postMessage(s); } catch (e) {} };
  // What goes wrong in the page is said too (a script or a style that did not load, an error of
  // the page's own): a page that came back empty is then not a riddle.
  addEventListener("error", (e) => {
    const t = e.target;
    say(`ERR ${t && t !== window ? `${t.tagName} ${t.src || t.href || ""}` : `${e.message} ${e.filename}:${e.lineno}`}`.slice(0, 300));
  }, true);
  addEventListener("unhandledrejection", (e) => say(`ERR rejection ${String((e.reason && e.reason.message) || e.reason).slice(0, 200)}`));
  // A page that asks for the desktop's dialog of the app's shortcuts by itself, with no press of
  // the owner's, a moment after every load: the app must not act on it.
  setTimeout(() => { try { if (window.keelShell) { window.keelShell.post({ t: "shortcuts" }); say("ASKED-KEYS"); } } catch (e) {} }, 1500);
  // The page's Find: which bar is open (a conversation's or the app's page's) and what it counts.
  const findSaid = () => {
    const b = document.querySelector("[data-testid=find-bar]");
    if (!b) return "-";
    const n = b.querySelector("[data-testid=find-count]");
    return `${b.dataset.page ? "page" : "conversation"}:${(n ? n.textContent : "").trim().replace(/\s+/g, "_") || "empty"}`;
  };
  let shown = false;
  let raw = "";
  let went = false;
  let frame = null;
  setInterval(async () => {
    const at = document.activeElement;
    say(`AT ${location.origin}${location.pathname} shell=${typeof window.keelShell} band=${!!document.querySelector("[data-testid=daemon-away]")} scale=${getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim()} active=${at ? at.dataset.testid || at.tagName : ""} imgs=${document.querySelectorAll("[data-testid=attachments] img").length} draft=${(document.querySelector("textarea") || { value: "" }).value.length} note=${!!document.querySelector("[data-testid=shell-note]")} win=${window.keelShell ? window.keelShell.window : "-"} inbox=${!!document.querySelector("[data-testid=inbox-panel]")} keys=${!!window.keelShell?.can?.shortcuts} gc=${typeof globalThis.gc} find=${findSaid()} popped=${!!document.querySelector("[data-testid=panel-popped]")} panelwin=${!!document.querySelector("[data-testid=panel-window]")}`);
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
  // Where the Dock back button of a panel's own window is, for the check's pointer (as the attach button's).
  let dockAt = "";
  setInterval(() => {
    const b = document.querySelector("[data-testid=panel-dock-here]");
    if (!b) return;
    const r = b.getBoundingClientRect();
    const at = `${Math.round(r.left + r.width / 2)} ${Math.round(r.top + r.height / 2)} ${innerWidth} ${innerHeight}`;
    if (at !== dockAt && r.width > 0) { dockAt = at; say(`DOCK ${at}`); }
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
  // The microphone: what the page itself asks of the engine (dictation does) and how the engine answered, and the
  // check's own requests at a press (F2: with no word to the app first; F3: with the word, as a camera too; Shift F3: with the word, twice at once).
  const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const kinds = (c) => `audio=${!!(c && c.audio)} video=${!!(c && c.video)}`;
  const mic = async (tag, c) => {
    try { const st = await gum(c); say(`MIC ${tag} granted ${kinds(c)} tracks=${st.getTracks().map((t) => t.kind).join("+")}`); st.getTracks().forEach((t) => t.stop()); return true; }
    catch (err) { say(`MIC ${tag} refused ${kinds(c)} ${err && err.name}`); return false; }
  };
  if (gum) navigator.mediaDevices.getUserMedia = (c) => {
    say(`MIC page asked ${kinds(c)}`);
    return gum(c).then((st) => { say(`MIC page granted ${kinds(c)} tracks=${st.getTracks().map((t) => t.kind).join("+")}`); return st; }, (err) => { say(`MIC page refused ${kinds(c)} ${err && err.name}`); throw err; });
  };
  // The app's answers to the page's own word about the microphone (dictation says it before it asks the engine).
  addEventListener("keel-shell", (e) => { const m = e.detail && e.detail.mic; if (m && m.id < 9000) say(`MIC told ok=${m.ok}`); });
  const announce = (id) => new Promise((done) => {
    const on = (e) => { if (e.detail && e.detail.mic && e.detail.mic.id === id) { removeEventListener("keel-shell", on); say(`MIC announced id=${id} ok=${e.detail.mic.ok}`); done(); } };
    addEventListener("keel-shell", on);
    window.keelShell.post({ t: "microphone", id });
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
    // The microphone with no word to the app first: refused.
    if (e.key === "F2") void mic("unannounced", { audio: true });
    // With the word, a camera as well is refused.
    if (e.key === "F3" && !e.shiftKey) void (async () => { await announce(9101); await mic("camera", { audio: true, video: true }); })();
    // With the word, two audio requests at once: the engine that asks every time gives one and refuses the other.
    if (e.key === "F3" && e.shiftKey) void (async () => { await announce(9102); await Promise.all([mic("first", { audio: true }), mic("second", { audio: true })]); })();
    // A copy at this press, and one four seconds later that no press allowed.
    if (e.key === "F7") { copy(9001, "copied-by-the-check"); setTimeout(() => copy(9002, "planted-without-a-press"), 4000); }
    // A paste at this press, of a picture no larger than the page keeps one.
    if (e.key === "F5") window.keelShell.post({ t: "paste", id: 9005, edge: 1568 });
    // A paste at this press, and one four seconds later.
    if (e.key === "F6") { window.keelShell.post({ t: "paste", id: 9003 }); setTimeout(() => window.keelShell.post({ t: "paste", id: 9004 }), 4000); }
  }, true);
})();
