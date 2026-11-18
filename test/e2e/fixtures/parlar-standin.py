#!/usr/bin/env python3
"""A stand-in for the parlar program: no daemon, no mic, no speaker.

It answers the commands Keel runs (`mcp`, `hook <event>`, `ctl ...`) and writes
each one, with what it was given, to parlar.log beside itself. A background wait
(`hook wait`, `hook wait-parked`) blocks until a test writes the owner's speech
to the file `speech` beside it; the first wait to take the file prints it on
stderr and exits 2, as parlar's waiter does. While it waits it leaves a file
`waiting.<pid>`, so a test can see the process. The conversation is the files
`focus` (the session that has the voice: `ctl talk`, `ctl focus`, or a test
playing parlar's indicator) and `active` (on: `ctl talk`; `ctl off` ends it and
keeps the focus, as parlard does). `ctl watch` prints a phase line each time
either changes, and leaves `watching.<pid>`. With a file `refuse` beside it every
`ctl` fails the way parlar's does when its daemon is down.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def log(line):
    with open(os.path.join(HERE, "parlar.log"), "a") as f:
        f.write(line + "\n")


def mcp():
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        method, mid = msg.get("method"), msg.get("id")
        if method == "initialize":
            result = {
                "protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "parlar", "version": "0"},
                "instructions": "stand-in",
            }
        elif method == "tools/list":
            result = {"tools": [{"name": "say", "description": "Speak.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}
        elif method == "tools/call":
            session = (msg["params"].get("_meta") or {}).get("sessionId", "")
            text = msg["params"].get("arguments", {}).get("text", "")
            log("say %s %s" % (session, text))
            known = set((read("known") or "").splitlines())
            focus = read("focus") or ""
            out_text = "Said."
            if session == focus or session not in known:
                pending = take_pending()
                if pending:
                    out_text += "\nThe user said meanwhile:\n" + pending.strip()
            result = {"content": [{"type": "text", "text": out_text}], "isError": False}
        elif mid is None:
            continue
        else:
            result = {}
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}) + "\n")
        sys.stdout.flush()


def read(name):
    try:
        return open(os.path.join(HERE, name)).read()
    except OSError:
        return None


def take_pending():
    pending = os.path.join(HERE, "pending")
    mine = pending + ".%d" % os.getpid()
    try:
        os.rename(pending, mine)
    except OSError:
        return None
    with open(mine) as f:
        data = f.read()
    os.remove(mine)
    return data


def wait():
    speech = os.path.join(HERE, "speech")
    mine = speech + ".%d" % os.getpid()
    marker = os.path.join(HERE, "waiting.%d" % os.getpid())
    open(marker, "w").close()
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            os.rename(speech, mine)
        except OSError:
            time.sleep(0.05)
            continue
        with open(mine) as f:
            sys.stderr.write(f.read())
        os.remove(mine)
        os.remove(marker)
        sys.exit(2)
    os.remove(marker)
    sys.exit(0)


def watch():
    open(os.path.join(HERE, "watching.%d" % os.getpid()), "w").close()
    seen = None
    while True:
        now = (read("focus"), read("active") is not None)
        if now != seen:
            seen = now
            sys.stdout.write(json.dumps({"ui": "phase", "phase": "ready" if now[1] else "stopped", "mic_muted": False, "voice_off": False}) + "\n")
            sys.stdout.write(json.dumps({"ui": "levels", "user": 0.0, "agent": 0.0}) + "\n")
            sys.stdout.flush()
        time.sleep(0.05)


def main():
    args = sys.argv[1:]
    if args[:1] == ["mcp"]:
        log("mcp " + " ".join(args[1:]))
        return mcp()
    if args[:1] == ["hook"]:
        hook_input = json.loads(sys.stdin.read() or "null") or {}
        sid = hook_input.get("session_id", "")
        log("hook %s %s %s" % (" ".join(args[1:]), sid, hook_input.get("cwd", "")))
        if args[1] == "session-start" and sid:
            with open(os.path.join(HERE, "known"), "a") as f:
                f.write(sid + "\n")
        if args[1] == "stop":
            pending = take_pending()
            if pending:
                sys.stdout.write(json.dumps({"decision": "block", "reason": pending}) + "\n")
                sys.stdout.flush()
        if args[1] in ("wait", "wait-parked"):
            return wait()
        return
    if args[:1] == ["ctl"]:
        log("ctl " + " ".join(args[1:]))
        if os.path.exists(os.path.join(HERE, "refuse")):
            sys.stderr.write("Error: the voice daemon is not running\n")
            sys.exit(1)
        if args[1] == "talk":
            with open(os.path.join(HERE, "focus"), "w") as f:
                f.write(args[args.index("--session") + 1])
            open(os.path.join(HERE, "active"), "w").close()
        if args[1] == "focus":
            with open(os.path.join(HERE, "focus"), "w") as f:
                f.write(args[2])
        if args[1] == "watch":
            return watch()
        muted = os.path.join(HERE, "muted")
        if args[1] == "mute":
            open(muted, "w").close()
        if args[1] == "unmute" and os.path.exists(muted):
            os.remove(muted)
        if args[1] == "off" and os.path.exists(os.path.join(HERE, "active")):
            os.remove(os.path.join(HERE, "active"))
        if args[1] == "state":
            focus = read("focus") or ""
            active = read("active") is not None
            print(json.dumps({"kind": "state", "phase": "ready" if active else "stopped", "active": active, "mic_muted": os.path.exists(muted), "voice_off": False,
                              "sessions": [{"session": focus, "focused": True}] if focus else []}, indent=2))
        else:
            print(json.dumps({"kind": "ok"}))
        return


main()
