// Open on phone (src/integrations/mobile/open.ts): the session menu sends this session to the paired
// phone, and the words of the answer are said at the menu's button: sent and confirmed, sent but not
// confirmed (the phone may be offline), or why nothing was sent.
import { announce } from "./announce.ts";
import { api, failed } from "./store.ts";
import { tipSay } from "./tips.ts";

export async function openOnPhone(sessionId: string, at: Element | null | undefined): Promise<void> {
  tipSay(at, "Sending to the phone…", 8000);
  let words: string;
  let bad = false;
  try {
    words = (await api<{ words: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/open-on-phone`, { method: "POST" })).words;
  } catch (e) {
    words = failed(e, { at: "open-on-phone" });
    bad = true;
  }
  tipSay(at, words, 6000);
  announce(words, bad ? "alert" : "status");
}
