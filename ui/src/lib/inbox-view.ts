// What the Inbox opens on when a command asks for one of its views (the
// palette's "Show activity"): the view and the Activity list's filter are
// left here for the panel to take when it opens, since the panel mounts only
// then. Asked while the Inbox is already open, it switches the view in place.
export type ActivityAsk = { failures?: boolean };
type Ask = { tab: "inbox" | "activity"; activity?: ActivityAsk };
let asked: Ask | null = null;
const EVENT = "keel:inbox-view";

export function showInboxView(ask: Ask) {
  asked = ask;
  // Open already: the panel takes the ask in place. Else the inbox's own command opens it.
  if (document.querySelector('[data-testid="inbox-panel"]')) dispatchEvent(new Event(EVENT));
  else dispatchEvent(new Event("keel:inbox"));
}
// The ask, once: whoever takes it shows it.
export const peekInboxView = () => asked;
export const takeInboxView = () => { const a = asked; asked = null; return a; };
export const onInboxView = (f: () => void) => { addEventListener(EVENT, f); return () => removeEventListener(EVENT, f); };
