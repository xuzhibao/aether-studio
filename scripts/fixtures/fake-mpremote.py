#!/usr/bin/env python3
# File-backed fake of the mpremote CLI surface used by Aether.
# It never opens a serial port: AETHER_FAKE_MPREMOTE_LOG records the exact argv, and the mode selects
# success, failure or a long-running process for cancellation tests. Test fixture only.
import hashlib
import json
import os
import sys
import time

args = sys.argv[1:]
log_path = os.environ.get("AETHER_FAKE_MPREMOTE_LOG", "")
mode = os.environ.get("AETHER_FAKE_MPREMOTE_MODE", "ok")


def log(entry):
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")


def say(text):
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def fail(text, code=2):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()
    sys.exit(code)


if args in (["--version"], ["version"]):
    log({"argv": args, "version": True})
    say("mpremote 9.9.9")
    sys.exit(0)

if len(args) != 4 or args[0] != "connect" or not args[1].startswith("port:") or args[2] != "run":
    fail("fake mpremote: unexpected argv " + json.dumps(args))
port = args[1][len("port:"):]
file = args[3]
if not port or port.lower() in ("auto", "list"):
    fail("fake mpremote: port must be explicit: " + json.dumps(port))
try:
    with open(file, "rb") as handle:
        data = handle.read()
except OSError as error:
    fail("fake mpremote: cannot read script: " + str(error), 4)
file_sha256 = hashlib.sha256(data).hexdigest()
log({"argv": args, "port": port, "file": file, "fileSha256": file_sha256, "size": len(data), "mode": mode})
say("[fake-mpremote] connect port:" + port)
if mode == "fail":
    fail("could not open port " + port, 3)
if mode == "exit7":
    fail("script raised an error", 7)
if mode == "slow":
    say("[fake-mpremote] running " + file)
    time.sleep(300)
    sys.exit(0)
say("[fake-mpremote] ran " + file + " (" + str(len(data)) + " bytes, sha256 " + file_sha256[:12] + ")")
sys.exit(0)
