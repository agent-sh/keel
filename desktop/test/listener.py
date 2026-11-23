#!/usr/bin/env python3
"""A stranger on a port, for the end-to-end check: answers every request with STATUS and says,
a line a request, whether it carried an Authorization header (never its value).
With `health` it answers the daemon's health path as a daemon would, so the app goes on to its other calls.
With `health,drop` it also closes every other connection with no answer at all (a load that fails).
With `health,late FILE` its page speaks to the app as the daemon's does, but only once FILE exists
(it asks every second): a page that comes to speak late, whenever the check says.
usage: listener.py PORT STATUS SECONDS [health[,drop|,late FILE]]"""
import os
import socket, sys, time
port, status, secs = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
mode = sys.argv[4].split(",") if len(sys.argv) > 4 else []
health, drop, late = "health" in mode, "drop" in mode, "late" in mode
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
for _ in range(100):  # the daemon that had the port may still be letting go of it
    try:
        s.bind(("127.0.0.1", port))
        break
    except OSError:
        time.sleep(0.1)
else:
    sys.exit(f"could not bind port {port}")
s.listen(16)
end = time.time() + secs
body = b"<script>try{webkit.messageHandlers.keel.postMessage(JSON.stringify({t:'window',path:'/settings'}))}catch(e){}</script>foreign"
flag = sys.argv[5] if late else ""
if late:
    body = b"<script>const t = setInterval(async () => { try { if (await (await fetch('/speak')).text() === 'yes') { clearInterval(t); window.keelShell.post({ t: 'can', paste: true, saving: true }) } } catch (e) {} }, 1000)</script>late"
while time.time() < end:
    s.settimeout(max(0.1, end - time.time()))
    try:
        c, _ = s.accept()
    except socket.timeout:
        break
    try:
        c.settimeout(2)
        d = c.recv(8192).decode("latin1")
        line = d.split("\r\n")[0]
        auth = any(h.lower().startswith("authorization:") for h in d.split("\r\n"))
        print(f"REQUEST {line} authorization={'yes' if auth else 'no'}", flush=True)
        if health and line.startswith("GET /api/health"):
            ok = b'{"pid":1}'
            c.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(ok)}\r\nConnection: close\r\n\r\n".encode() + ok)
        elif drop:
            pass
        elif late and line.startswith("GET /speak"):
            say = b"yes" if os.path.exists(flag) else b"no"
            c.sendall(f"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {len(say)}\r\nConnection: close\r\n\r\n".encode() + say)
        else:
            c.sendall(f"HTTP/1.1 {status} X\r\nContent-Type: text/html\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    except OSError:
        pass
    finally:
        c.close()
print("END", flush=True)
