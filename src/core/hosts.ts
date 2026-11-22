// A host on this machine or a private network: the web tools do not reach
// it, and the daemon's own git does not fetch from it for a confined session.
// By the name alone (nothing is resolved): a loopback, link-local or private
// address, localhost, and a name with no dot, which resolves on the local
// network.
const PRIVATE_HOST = /^(localhost|.*\.localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i;
export const privateHost = (hostname: string) => !hostname.includes(".") || PRIVATE_HOST.test(hostname);

// An address (not a name) that is not on the public internet: this machine's
// loopback, a private or carrier network, link-local (the cloud metadata
// address among them), multicast and the reserved ranges. A proxy asks it
// of the address a name resolved to, since a public name can point inside.
export function internalAddress(address: string): boolean {
  let a = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) a = dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) { const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16); a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    if ([x, y, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true;
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
      || (x === 192 && y === 0) || (x === 192 && y === 168) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  if (!a.includes(":")) return true; // not an address at all: nothing to connect to
  // ::, ::1, unique local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10), multicast (ff00::/8).
  return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89a-f]/.test(a) || /^ff/.test(a);
}
