// Voice through parlar in the workbench: a mic in the session header that opens
// the talk / mute / stop card, and /talk.
import { createRoot } from "react-dom/client";
import { headerActions, slash } from "../lib/extend.ts";
import { VoiceCard, VoiceIcon, loadVoice, setVoiceOpen } from "../components/VoiceControl.tsx";

headerActions.add({ id: "voice", label: "Voice", icon: <VoiceIcon />, when: (s) => !s.parent_id, run: (s) => setVoiceOpen(s.id) });

slash.add({
  id: "talk",
  label: "Talk to this session by voice (parlar)",
  when: (c) => !!c.session && !c.session.parent_id,
  run: async (_arg, c) => {
    if (!c.session) return;
    setVoiceOpen(c.session.id);
    await fetch(`/api/sessions/${c.session.id}/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "talk" }) });
    await loadVoice(c.session.id);
  },
});

// The card lives beside the shell in a root of its own.
const el = document.body.appendChild(document.createElement("div"));
el.dataset.host = "voice";
createRoot(el).render(<VoiceCard />);
