// A text for a session of another harness: what that harness receives of it,
// and whether the harness would act on it instead of reading it.
//
// The agent view delivers a text by pasting it into a terminal, through Codex's
// own queue, or as a command-line argument of a resume. Its terminal path drops
// control characters and turns a carriage return into a line break, and a
// harness drops invisible characters. A check that read the text before those
// changes would miss what they uncover ("\u0001!touch x" arrives as "!touch x"),
// so every change is made here first: the bytes judged are the bytes queued.

export type OutsideText = { text: string; changed: number };

// Unicode's default-ignorable code points and the interlinear annotation
// characters, plus every control character other than tab and line feed.
function dropped(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  return (
    cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x3164 || cp === 0xfeff || cp === 0xffa0 ||
    (cp >= 0x115f && cp <= 0x1160) || (cp >= 0x17b4 && cp <= 0x17b5) || (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfff0 && cp <= 0xfffb) || (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff)
  );
}

// The text as the outside session will read it; an Error when nothing is left.
export function outsideText(raw: string): OutsideText {
  let text = "";
  let changed = 0;
  const chars = [...raw];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "\r" && chars[i + 1] === "\n") continue;
    if (c === "\r" || c === "\u0085" || c === "\u2028" || c === "\u2029") {
      text += "\n";
      changed++;
    } else if (c === "\n" || c === "\t") text += c;
    else if (dropped(c.codePointAt(0)!)) changed++;
    else text += c;
  }
  if (!text.trim()) throw new Error("the text is empty once the characters a delivery drops are taken out");
  return { text, changed };
}

// An @ at the start or after a character that is not a letter or digit,
// followed by a non-space: @path, @server:resource. me@example.com is not one.
export function hasMention(text: string): boolean {
  const c = [...text];
  return c.some((ch, i) => ch === "@" && (i === 0 || !/[\p{L}\p{N}]/u.test(c[i - 1]!)) && !!c[i + 1] && !/\s/.test(c[i + 1]!));
}

// Codex's own reading of a tool mention ($skill-name, $app-slug, also inside a
// link): a $ followed by a letter, digit, _, - or :, except the environment
// variable names Codex itself skips.
const CODEX_ENV = new Set(["PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "XDG_CONFIG_HOME"]);
export function hasCodexMention(text: string): boolean {
  for (const m of text.matchAll(/\$([A-Za-z0-9_:-]+)/g)) if (!CODEX_ENV.has(m[1]!.toUpperCase())) return true;
  return false;
}

// Why the harness of `kind` would act on this text instead of reading it, if
// it would. Every line counts: a delivery that submits line by line makes each
// line a message.
export function harnessCommand(text: string, kind: string): string | undefined {
  for (const line of text.split("\n")) {
    const first = line.trimStart()[0];
    if (first === "!") return "a line that starts with ! is a shell command to the session's harness";
    if (first === "/") return "a line that starts with / is a command to the session's harness, which can change its permissions and modes";
    if (first === "-") return "a line that starts with - is read as command-line flags when the text resumes an ended session";
  }
  if (hasMention(text)) return "an @ mention makes the session's harness read a file or an MCP resource as the owner's input";
  if (kind === "codex" && hasCodexMention(text)) return "a $ mention makes Codex invoke that skill or attach that app, even one it would not choose on its own";
  return undefined;
}

// Whether a prompt option's label plainly says no.
const NO = new Set(["no", "nope", "deny", "denied", "reject", "rejected", "cancel", "canceled", "cancelled", "decline", "declined", "stop", "stopped"]);
export function saysNo(label: string): boolean {
  const first = label.trim().split(/[^\p{L}\p{N}']+/u).find(Boolean) ?? "";
  return NO.has(first.toLowerCase());
}

export type Choice = { value: string; label: string };
export type Prompt = { id: string; kind?: string; title?: string; body?: string; choices?: Choice[] };

// Names exactly what was read: the prompt's text and its whole menu, so the
// same request id with another menu is not the prompt that was read.
export function promptHash(p: Prompt): string {
  const menu = (p.choices ?? []).map((c) => `${c.value}\u001f${c.label}\n`).join("");
  return new Bun.CryptoHasher("sha256").update(`${p.body ?? ""}\0${menu}`).digest("hex").slice(0, 16);
}

// The option an answer sends, and whether that option is an allow. Only an
// option that plainly says no is a deny; a decision the option contradicts is
// refused rather than trusted.
export function pickChoice(p: Prompt, decision: "allow" | "deny", choice?: string): { value: string; label: string; allows: boolean } {
  const choices = p.choices ?? [];
  const list = () => choices.map((c) => `${c.value} = ${c.label}`).join("; ");
  let value = choice;
  if (!value) {
    if (choices.some((c) => c.value === decision)) value = decision;
    else {
      const hits = choices.filter((c) => (decision === "allow" ? c.label.trim().toLowerCase().startsWith("yes") : saysNo(c.label)));
      if (hits.length !== 1) throw new Error(`this prompt has no one plain ${decision === "allow" ? "yes" : "no"}; name the option with choice (${list()})`);
      value = hits[0]!.value;
    }
  }
  const hit = choices.find((c) => c.value === value);
  if (!hit) throw new Error(`option ${value} is not offered by this prompt (${list()})`);
  const allows = !saysNo(hit.label);
  if (allows !== (decision === "allow")) throw new Error(`option ${value} (${hit.label}) is ${allows ? "not a plain no" : "a no"}, but the decision is ${decision}`);
  return { value: hit.value, label: hit.label, allows };
}
