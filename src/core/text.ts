// Terminal escapes out of text: CSI sequences, OSC ended by BEL or ESC \, and
// two-character escapes. Pure; the page and the daemon both use it.
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

// The encoding of file bytes: a byte-order mark names UTF-8 or UTF-16 in
// either byte order, else the declared charset, else UTF-8. One rule for every
// path that reads bytes as text (Read, read_file, attachments), so none
// misreads a file another reads right.
export function textEncoding(b: Uint8Array, charset?: string): { encoding: string; bom: boolean } {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: "utf-8", bom: true };
  if (b[0] === 0xff && b[1] === 0xfe) return { encoding: "utf-16le", bom: true };
  if (b[0] === 0xfe && b[1] === 0xff) return { encoding: "utf-16be", bom: true };
  return { encoding: charset?.toLowerCase() || "utf-8", bom: false };
}

// File bytes to text in that encoding, the mark dropped from the text. `fatal`
// throws a TypeError on bytes invalid in it; an unknown charset throws a
// RangeError. `encoding` is the decoder's canonical name ("utf8" reads utf-8).
export function decodeText(b: Uint8Array, opts: { charset?: string; fatal?: boolean } = {}): { text: string; encoding: string; bom: boolean } {
  const { encoding, bom } = textEncoding(b, opts.charset);
  const dec = new TextDecoder(encoding, { fatal: opts.fatal });
  return { text: dec.decode(b), encoding: dec.encoding, bom };
}
