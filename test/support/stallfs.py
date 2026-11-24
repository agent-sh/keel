#!/usr/bin/env python3
# A FUSE mount that answers the kernel's handshake and then never answers anything else: every stat, open or
# listing of a path under it waits, as on a network file system whose server is gone. For tests only.
# usage: stallfs.py MOUNTPOINT LIFETIME_SECONDS
# It prints "mounted" once the mount is up and unmounts itself when LIFETIME_SECONDS have passed, which
# also ends the waits (they fail with ENOTCONN). Needs /dev/fuse and fusermount3 (no root).
import array, os, socket, struct, subprocess, sys, threading

mount, life = sys.argv[1], float(sys.argv[2])
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
env = dict(os.environ, _FUSE_COMMFD=str(b.fileno()))
p = subprocess.Popen(["fusermount3", "-o", "fsname=stallfs", "--", mount], env=env, pass_fds=[b.fileno()])
_, anc, _, _ = a.recvmsg(1, socket.CMSG_LEN(4))
fd = array.array("i", anc[0][2])[0]
p.wait()

def end():
    threading.Event().wait(life)
    subprocess.run(["fusermount3", "-uz", "--", mount])
    os._exit(0)

threading.Thread(target=end, daemon=True).start()
print("mounted", flush=True)
while True:
    try:
        buf = os.read(fd, 4 << 20)
    except OSError as e:
        if e.errno in (2, 4, 11):  # a request taken back before it was read, a signal
            continue
        os._exit(0)  # ENODEV: the mount is gone
    _, op, uniq, *_rest = struct.unpack("<IIQQIIII", buf[:40])
    if op == 26:  # FUSE_INIT
        minor = struct.unpack("<II", buf[44:52])[0]
        out = (struct.pack("<IIIIHHIIHHII", 7, min(minor, 31), 1 << 17, 0, 16, 12, 1 << 20, 1, 256, 0, 0, 0) + b"\0" * 28)[:64]
        os.write(fd, struct.pack("<IiQ", 16 + len(out), 0, uniq) + out)
