// Commands: one registry feeds the palette, the keymap and the shortcut sheet.
// A feature lane adds its own with registerCommand; nothing else needs editing.
import type { ReactNode } from "react";

export type Command = {
  id: string;
  label: string;
  group?: string; // heading in the palette and the shortcut sheet
  keys?: string; // "mod+k", "mod+shift+o", "alt+m", "escape"; mod is Ctrl, or Cmd on a Mac
  icon?: ReactNode;
  words?: string; // extra words the palette matches
  when?: () => boolean; // shown and bound only when true
  run: () => void;
  inInput?: boolean; // the shortcut also fires while typing in a field
};

const commands = new Map<string, Command>();
const subs = new Set<() => void>();
let version = 0;
export function registerCommand(...list: Command[]) {
  for (const c of list) commands.set(c.id, c);
  version++;
  subs.forEach((f) => f());
}
export const allCommands = () => [...commands.values()].filter((c) => !c.when || c.when());
export const commandsVersion = () => version;
export const onCommands = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const runCommand = (id: string) => commands.get(id)?.run();

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// The message box's own keys, named once for the box and the shortcut sheet.
export const QUEUE_KEYS = "mod+shift+enter";
// What sends and what makes a new line, by the owner's "Send with" setting.
export const SEND_KEYS = (enterSends: boolean) => (enterSends ? { send: "enter", newline: "shift+enter" } : { send: "mod+enter", newline: "enter" });

function matches(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop()!;
  const mod = parts.includes("mod");
  const want = {
    ctrl: parts.includes("ctrl") || (mod && !isMac),
    meta: parts.includes("meta") || (mod && isMac),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.altKey !== want.alt) return false;
  // Shifted punctuation reports the shifted character; compare by code for those.
  const k = e.key.toLowerCase();
  const codeKey = e.code.replace(/^Key|^Digit/, "").toLowerCase();
  const named: Record<string, string> = { "[": "bracketleft", "]": "bracketright", "/": "slash", ",": "comma", ".": "period", "\\": "backslash", "=": "equal", "-": "minus" };
  const hit = k === key || codeKey === key || (named[key] && e.code.toLowerCase() === named[key]);
  return !!hit && e.shiftKey === want.shift;
}

export function installKeymap() {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    for (const c of allCommands()) {
      if (!c.keys) continue;
      if (typing && !c.inInput && !/mod|ctrl|meta|alt/.test(c.keys)) continue;
      if (c.keys.split(" ").some((k) => matches(e, k))) {
        e.preventDefault();
        c.run();
        return;
      }
    }
  };
  // One Escape press acts once. A held key repeats its keydown (and the first
  // one may already have taken the page to the parent or closed a menu), so
  // every Escape keydown after the first, until the key comes up, is dropped
  // before anything sees it: the body, the controls and the message box alike.
  let escDown = false;
  const onEscDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (e.repeat || escDown) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    escDown = true;
  };
  const onEscUp = (e: KeyboardEvent) => { if (e.key === "Escape") escDown = false; };
  const onBlur = () => { escDown = false; };
  addEventListener("keydown", onEscDown, true);
  addEventListener("keyup", onEscUp, true);
  addEventListener("blur", onBlur);
  addEventListener("keydown", onKey);
  return () => {
    removeEventListener("keydown", onEscDown, true);
    removeEventListener("keyup", onEscUp, true);
    removeEventListener("blur", onBlur);
    removeEventListener("keydown", onKey);
  };
}

// "mod+shift+o" -> ["Ctrl", "Shift", "O"] (or the Mac symbols).
export function keyLabel(spec: string): string[] {
  return spec.split(" ")[0]!.split("+").map((p) => {
    const l = p.toLowerCase();
    if (l === "mod") return isMac ? "⌘" : "Ctrl";
    if (l === "shift") return isMac ? "⇧" : "Shift";
    if (l === "alt") return isMac ? "⌥" : "Alt";
    if (l === "ctrl") return isMac ? "⌃" : "Ctrl";
    if (l === "escape") return "Esc";
    if (l === "enter") return "Enter";
    if (l === "end") return "End";
    if (l === "arrowup") return "↑";
    if (l === "arrowdown") return "↓";
    return p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1);
  });
}

// Palette and picker matching: every word of the query must appear in the
// text, word starts score higher; a short tight subsequence ("nsess" for
// "new session") is the fallback.
// Case and accents fold as the daemon's search folds them (École = ecole).
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

export function fuzzy(query: string, text: string): number {
  const q = fold(query).trim();
  if (!q) return 1;
  const s = fold(text);
  let total = 0;
  for (const w of q.split(/\s+/)) {
    const at = s.indexOf(w);
    if (at < 0) { total = -1; break; }
    const boundary = at === 0 || /[\s/_.:(-]/.test(s[at - 1]!);
    total += 100 + w.length * 10 - Math.min(at, 60) + (boundary ? 80 : 0);
  }
  if (total > 0) return total;
  let j = 0, first = -1, score = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) continue;
    if (first < 0) first = i;
    score += i === 0 || /[\s/_.-]/.test(s[i - 1]!) ? 6 : 1;
    j++;
    if (i - first > q.length * 3) return 0;
  }
  return j === q.length ? score : 0;
}
