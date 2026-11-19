// Terminal escapes out of text: CSI sequences, OSC ended by BEL or ESC \, and
// two-character escapes. Pure; the page and the daemon both use it.
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

// File bytes to text, by their byte-order mark: UTF-8 (mark dropped from the
// text, reported as `bom`), UTF-16 in either byte order, else UTF-8. One
// decoder for every path that reads a file as text, so none misreads one.
export function decodeText(b: Uint8Array): { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be"; bom: boolean } {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(b), encoding: "utf-8", bom: true };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(b), encoding: "utf-16le", bom: true };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(b), encoding: "utf-16be", bom: true };
  return { text: new TextDecoder("utf-8").decode(b), encoding: "utf-8", bom: false };
}
