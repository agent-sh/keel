# Reads the tray menu as `gdbus ... GetLayout` prints it (stdin) and, for the line whose label starts with
# argv[1], decodes its "icon-data": a PNG, which is saved to argv[2]. Prints "W x H" and the pixel at the
# middle of the picture, eight pixels right of it (the ring) and the corner, each as #rrggbb/alpha.
# Prints nothing for a line without a picture. Standard library only.
import re, struct, sys, zlib

text = sys.stdin.read()
# One item is "<(id, {properties}, @av [])>", its properties in no fixed order.
m = None
for item in re.findall(r"<\(\d+, \{(.*?)\}, @av \[\]\)>", text, re.S):
    label = re.search(r"'label': <'([^']*)'>", item)
    if label and label.group(1).startswith(sys.argv[1]):
        m = re.search(r"'icon-data': <\[byte ([^\]]*)\]>", item)
        break
if not m:
    sys.exit()
png = bytes(int(x, 16) for x in re.findall(r"0x[0-9a-fA-F]+", m.group(1)))
assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
pos, idat = 8, b""
while pos < len(png):
    n, kind = struct.unpack(">I4s", png[pos:pos + 8])
    body = png[pos + 8:pos + 8 + n]
    pos += 12 + n
    if kind == b"IHDR":
        w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
    if kind == b"IDAT":
        idat += body
assert depth == 8 and ctype == 6, "8-bit RGBA expected"
data, stride, rows, prev = zlib.decompress(idat), w * 4, [], bytes(w * 4)
for y in range(h):
    f, line = data[y * (stride + 1)], bytearray(data[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    for i in range(stride):
        a = line[i - 4] if i >= 4 else 0
        b = prev[i]
        c = prev[i - 4] if i >= 4 else 0
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        line[i] = (line[i] + (0, a, b, (a + b) // 2, a if pa <= pb and pa <= pc else b if pb <= pc else c)[f]) & 255
    rows.append(bytes(line))
    prev = bytes(line)
px = lambda x, y: "#%02x%02x%02x/%d" % (*rows[y][x * 4:x * 4 + 3], rows[y][x * 4 + 3])
open(sys.argv[2], "wb").write(png)
print(w, "x", h, px(w // 2, h // 2), px(w // 2 + 8, h // 2), px(0, 0))
