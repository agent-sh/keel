// An approval card on a terminal: the request shown whole before anything
// asks about it, as the daemon gives it to every client (src/safety/card.ts).
// A terminal cannot mark a character, so each hidden one is written out as
// its code point, and what the text holds that can mislead is said in words.
import { createInterface } from "node:readline/promises";
import { cardLines, holdSaid, type CardForm } from "../safety/card.ts";
import { clean, line, type Client } from "./client.ts";

export const shortId = (id: string) => id.slice(0, 8);

// The form of one card, from the daemon that owns it.
export const formOf = async (c: Client, a: { id: string; session_id: string }): Promise<CardForm> =>
  (await c.get<{ card: CardForm }>(`/api/sessions/${a.session_id}/approvals/${a.id}`)).card;

// One line of a list: the id, what it is, the start of its text, and whether it must be read first.
export function cardRow(f: CardForm, note = ""): string {
  const l = cardLines(f);
  const first = line(l.text.split("\n")[0] ?? "").slice(0, 120);
  return `${f.id}  ${clean(l.head)}: ${first}${f.lines > 1 || first.length < l.text.length ? " ..." : ""}${f.hold.length ? "  [read it first]" : ""}${note}`;
}

// The whole request: a heading, why it is asked and what misleads, then every line of its text.
export function cardShown(f: CardForm, note = ""): { head: string[]; text: string[] } {
  const l = cardLines(f);
  return {
    head: [`?? approval ${shortId(f.id)}: ${clean(l.head)}${note}`, ...l.notes.map((n) => `   ${clean(n)}`)],
    text: clean(l.text).replace(/\n$/, "").split("\n").map((t) => `   | ${t}`),
  };
}

const tty = () => !!process.stdin.isTTY && !!process.stderr.isTTY;
export const interactive = tty;

// Shows the request. On a terminal a text taller than the window goes through
// the pager ($PAGER, else less), so its start is not scrolled away unread; the
// heading stays on screen after it.
export function showCard(f: CardForm, note = ""): void {
  const s = cardShown(f, note);
  const rows = process.stdout.rows ?? 0;
  const cols = Math.max(20, process.stdout.columns ?? 80);
  const tall = s.text.reduce((n, t) => n + Math.max(1, Math.ceil(t.length / cols)), 0);
  if (process.stdout.isTTY && tty() && rows > 0 && tall + s.head.length + 3 > rows) {
    const pager = (process.env.PAGER?.trim() || "less -R").split(/\s+/);
    try {
      const r = Bun.spawnSync(pager, { stdin: Buffer.from([...s.head, ...s.text].join("\n") + "\n"), stdout: "inherit", stderr: "inherit" });
      if (r.exitCode === 0) {
        for (const h of s.head) console.log(h);
        console.log(`   (${f.lines} line${f.lines === 1 ? "" : "s"}, shown in the pager)`);
        return;
      }
    } catch { /* no pager: the text is printed */ }
  }
  for (const h of [...s.head, ...s.text]) console.log(h);
}

// One line typed at the terminal.
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// Why --yes alone does not cover a card.
export const whyHeld = (f: CardForm) => holdSaid(f).replace(/^Open the request to read it first: /, "").replace(/\.$/, "");
