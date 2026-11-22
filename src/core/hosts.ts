// A host on this machine or a private network: the web tools do not reach
// it, and the daemon's own git does not fetch from it for a confined session.
// By the name alone (nothing is resolved): an address that is inside however
// it is written, localhost, and a name with no dot, which resolves on the
// local network.
export function privateHost(hostname: string): boolean {
  const bytes = addressBytes(hostname);
  if (bytes) return internalBytes(bytes);
  return !hostname.includes(".") || /^(localhost|.*\.localhost)\.?$/i.test(hostname);
}

// ---- an address, by its bytes ----

// An address is written in many ways: an IPv4 one dotted, as one number, with
// hex or octal parts, short (127.1); an IPv6 one compressed or written out,
// zero-padded, in upper case, with a dotted tail, in brackets, with a zone;
// and an IPv4 one inside an IPv6 one. A resolver and the kernel take them
// all, so nothing is decided on the text: it is parsed to bytes (4 for IPv4,
// 16 for IPv6), judged by them, and connected to by the one text of them.
// Nothing for a text that is not an address.
export function addressBytes(text: string): Uint8Array | null {
  let a = text.trim();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  // (A zone names an interface of this machine, not another address.)
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (!a || a.length > 64) return null;
  return a.includes(":") ? six(a) : four(a.replace(/\.$/, ""));
}

// IPv4 as inet_aton(3) reads it: one to four parts, each decimal, hex (0x) or octal (a leading 0); the last part
// fills the bytes that are left.
function four(a: string): Uint8Array | null {
  const parts = a.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]{1,8}$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]{0,11}$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]{0,9}$/.test(p)) n = Number(p);
    else return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  const out = new Uint8Array(4);
  nums.forEach((n, i) => (out[i] = n));
  for (let i = 3, v = last; i >= nums.length; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
}

// IPv6 as inet_pton(3) reads it: groups of one to four hex digits, one `::` for a run of zero groups, and a dotted
// quad for the last 32 bits.
function six(a: string): Uint8Array | null {
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const groups = (text: string): number[] | null => {
    if (!text) return [];
    const out: number[] = [];
    const parts = text.split(":");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.includes(".")) {
        // (Only as the very last part, plain decimal.)
        const q = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(p);
        if (!q || i !== parts.length - 1) return null;
        const b = q.slice(1).map(Number);
        if (b.some((n) => n > 255)) return null;
        out.push((b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const left = groups(halves[0]!), right = halves.length === 2 ? groups(halves[1]!) : [];
  if (!left || !right) return null;
  // (A dotted quad ends the address: none in the left half when there is a right one.)
  if (halves.length === 2 && halves[0]!.includes(".")) return null;
  const n = left.length + right.length;
  if (halves.length === 2 ? n > 7 : n !== 8) return null;
  const all = [...left, ...Array(8 - n).fill(0), ...right];
  const out = new Uint8Array(16);
  all.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 255; });
  return out;
}

// The one text of an address: IPv4 dotted; IPv6 in lower case with its longest run of zero groups compressed; an
// IPv4 address mapped into IPv6 (::ffff:a.b.c.d) as the IPv4 address it is.
export function addressText(b: Uint8Array): string {
  if (b.length === 4) return b.join(".");
  if (b.subarray(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return b.subarray(12).join(".");
  const g = Array.from({ length: 8 }, (_, i) => (b[i * 2]! << 8) | b[i * 2 + 1]!);
  let at = -1, len = 0;
  for (let i = 0; i < 8; i++) { let j = i; while (j < 8 && g[j] === 0) j++; if (j - i > len && j - i > 1) { at = i; len = j - i; } }
  const h = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  return at < 0 ? h(g) : `${h(g.slice(0, at))}::${h(g.slice(at + len))}`;
}

// IPv4 that is not the public internet: this network (0/8), private (10/8, 172.16/12, 192.168/16), carrier
// (100.64/10), loopback (127/8), link-local with the cloud metadata address (169.254/16), protocol assignments and
// test networks (192.0/16 as before), benchmarking (198.18/15), multicast and reserved (224/3).
const inside4 = (x: number, y: number) => x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
  || (x === 192 && y === 0) || (x === 192 && y === 168) || (x === 198 && (y === 18 || y === 19)) || x >= 224;

// The IPv4 address an IPv6 one carries, which is where it ends up: mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96),
// 6to4 (2002::/16). Nothing for any other address.
export function carried(b: Uint8Array): Uint8Array | null {
  if (b.length !== 16) return null;
  const zero = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return b.slice(12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12);
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
}

// Whether an address, by its bytes, is not on the public internet.
export function internalBytes(b: Uint8Array): boolean {
  if (b.length === 4) return inside4(b[0]!, b[1]!);
  // An IPv4 address carried in an IPv6 one is the IPv4 address.
  const v4 = carried(b);
  if (v4) return inside4(v4[0]!, v4[1]!);
  // The rest of ::/8 is reserved: unspecified, loopback, IPv4-compatible, translated (::ffff:0:a.b.c.d), local NAT64 (64:ff9b:1::/48).
  if (b[0] === 0) return true;
  // Teredo (2001::/32) and documentation (2001:db8::/32).
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  // Unique local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10), multicast (ff00::/8).
  return (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0x80) === 0x80) || b[0] === 0xff;
}

// An address (not a name) that is not on the public internet: this machine's
// loopback, a private or carrier network, link-local (the cloud metadata
// address among them), multicast and the reserved ranges. A proxy asks it
// of the address a name resolved to, since a public name can point inside.
// A text that is not an address is nothing to connect to.
export function internalAddress(address: string): boolean {
  const bytes = addressBytes(address);
  return !bytes || internalBytes(bytes);
}
