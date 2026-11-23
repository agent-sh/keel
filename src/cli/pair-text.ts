// The words of a pairing in a terminal, kept apart from src/cli/mobile.ts: keel attach
// prints them and loads no daemon code (src/cli/index.test.ts).
import { renderUnicodeCompact } from "uqr";

// What a pairing prints: its QR drawn in the terminal, the links, and the
// code a person types on a phone that cannot scan (keel pair, /pair in keel attach).
export function pairText(made: { url: string; link: string; hermes: string; typed: string }, ttl: number, svg?: string): string {
  return [
    renderUnicodeCompact(made.link, { border: 2 }),
    `Pair link (Keel app): ${made.link}`,
    `For the Hermes app: ${made.hermes}`,
    ...(made.typed ? [`On a phone that cannot scan, type the address ${made.url} and the code ${made.typed}`] : []),
    ...(svg ? [`Saved QR SVG: ${svg}`] : []),
    `The code is good once, for ${ttl} s.`,
  ].join("\n");
}
