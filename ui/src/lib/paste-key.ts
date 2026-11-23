// The paste keys in the desktop app's Chromium window. That engine lets a
// frame of content the owner pressed in a moment ago take the keyboard by
// script, and the page answers a moment later (lib/frames.ts): a paste keyed
// in between would hand the clipboard to the frame. So there the app takes
// the paste keys from the engine and tells the page, and the page decides
// where the paste goes at that very moment:
//   - the keyboard is in a frame of content by the owner's own act: the app
//     lets the engine paste there;
//   - else the element of the page that has the keyboard gets what the
//     clipboard holds, read by the app: a `keel-paste` event first (the
//     message box takes a picture from it), then a paste event that carries
//     the text (for an element with a paste handler of its own), then the
//     text itself, put in at the caret as a paste would.
// A frame that took the keyboard by itself gets nothing: it is answered
// first (and stopped), and the clipboard never passes through the engine.
import { pasteTarget } from "./frames.ts";
import { MAX_EDGE } from "./images.ts";
import { shell, shellPaste, type Pasted } from "./shell.ts";

// Told on the element that has the keyboard; its detail is the app's answer (null: none came
// in time). A listener that takes it (a picture, a failure it says) prevents the default.
export const PASTED = "keel-paste";

const takesText = (el: HTMLElement): boolean =>
  el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !el.readOnly && !el.disabled && /^(text|search|url|tel|email|password|number|)$/.test(el.type));

// The text put in at the caret, as a paste puts it (one step of undo, the element's own events).
export function insertText(el: HTMLElement, text: string): void {
  if (document.execCommand("insertText", false, text)) return;
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
  el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
}

export async function pasteKey(): Promise<void> {
  if (!shell) return;
  const at = pasteTarget();
  if (at === "frame") return void shell.post({ t: "paste-through" });
  if (!at) return;
  const got = await shellPaste(MAX_EDGE);
  if (got?.refused) return;
  // The answer came a moment later: the keyboard is where it was (a frame that took it
  // meanwhile is answered here too), or the owner has moved on and nothing is pasted.
  if (pasteTarget() !== at) return;
  if (!at.dispatchEvent(new CustomEvent<Pasted | null>(PASTED, { detail: got, bubbles: true, cancelable: true }))) return;
  if (!got?.text) return;
  const data = new DataTransfer();
  data.setData("text/plain", got.text);
  if (!at.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))) return;
  if (takesText(at)) insertText(at, got.text);
}
