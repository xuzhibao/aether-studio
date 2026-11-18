#!/usr/bin/env python3
# File-backed fake of the mpremote CLI surface used by Aether.
# It never opens a serial port: AETHER_FAKE_MPREMOTE_LOG records the exact argv, and the mode selects
# success, failure or a long-running process for cancellation tests.
#
# Read-only file browsing mirrors mpremote 1.29.0 exactly:
#   fs ls :/dir  ->  "ls :/dir" header, then "{:12} {name}{'/' if directory}"
#   fs cp :/f local  ->  copies the virtual file to the local path
# The virtual tree comes from AETHER_FAKE_MPREMOTE_FS (JSON) or the built-in tree below.
import hashlib
import json
import os
import sys
import time

args = sys.argv[1:]
log_path = os.environ.get("AETHER_FAKE_MPREMOTE_LOG", "")
mode = os.environ.get("AETHER_FAKE_MPREMOTE_MODE", "ok")
fs_mode = os.environ.get("AETHER_FAKE_MPREMOTE_FS_MODE", "ok")
mode_file = os.environ.get("AETHER_FAKE_MPREMOTE_FS_MODE_FILE", "")
if mode_file:
    try:
        with open(mode_file, "r", encoding="utf-8") as handle:
            fs_mode = handle.read().strip() or "ok"
    except OSError:
        fs_mode = "ok"


def log(entry):
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def say(text):
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def fail(text, code=2):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()
    sys.exit(code)


DEFAULT_TREE = {
    "/": [
        ["boot.py", "file", 0],
        ["lib", "dir", 0],
        ["main.py", "file", 214],
        ["空 目录", "dir", 0],
        ["数据 记录.txt", "file", 35],
    ],
    "/lib": [["helper.py", "file", 27], ["sub dir", "dir", 0]],
    "/lib/sub dir": [["深 层.py", "file", 11]],
    "/空 目录": [],
}
DEFAULT_CONTENT = {
    "/main.py": "print('hello from the fake board')\n",
    "/boot.py": "",
    "/数据 记录.txt": "temperature,pressure\r\n21.5,1013.2\r\n",
    "/lib/helper.py": "def helper():\n    return 1\n",
    "/lib/sub dir/深 层.py": "print('deep')\n",
}


def filesystem():
    path = os.environ.get("AETHER_FAKE_MPREMOTE_FS", "")
    if not path:
        return DEFAULT_TREE, DEFAULT_CONTENT
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    tree = {key: [list(item) for item in value] for key, value in data.get("tree", {}).items()}
    return tree, data.get("content", {})


def filesystem_command(rest):
    tree, content = filesystem()
    command = rest[0]
    paths = rest[1:]
    if command == "ls":
        path = paths[0] if paths else "/"
        if path not in tree:
            fail("ls: " + path + ": No such file or directory.", 3)
        if fs_mode == "garbage":
            say("not an ls line at all")
            return 0
        say("ls :" + path)
        if fs_mode == "mismatch":
            say("ls :/somewhere-else")
        for name, kind, size in tree[path]:
            say("{:12} {}{}".format(size, name, "/" if kind == "dir" else ""))
        if fs_mode == "mismatch":
            say("ls :/somewhere-else")
        return 0
    if command == "cp":
        if len(paths) != 2:
            fail("fake mpremote: cp needs a source and a destination", 2)
        source, destination = paths
        if not source.startswith(":") or destination.startswith(":"):
            fail("fake mpremote: only device -> local copies are supported: " + json.dumps(paths))
        remote = source[1:]
        if remote not in content:
            fail("cp: " + remote + ": No such file or directory.", 4)
        if fs_mode == "slow":
            say("cp " + source + " " + destination)
            time.sleep(300)
            return 0
        data = content[remote].encode("utf-8")
        with open(destination, "wb") as handle:
            handle.write(data)
        say("cp " + source + " " + destination)
        if fs_mode == "fail":
            fail("cp: device disconnected during transfer", 5)
        return 0
    fail("fake mpremote: unsupported filesystem command " + json.dumps(command), 2)


if args in (["--version"], ["version"]):
    log({"argv": args, "version": True})
    say("mpremote 9.9.9")
    sys.exit(0)

# connect port:<name> [resume] fs <command> <args...>
if len(args) >= 5 and args[0] == "connect" and args[1].startswith("port:") and args[3] == "fs":
    port = args[1][len("port:"):]
    if not port or port.lower() in ("auto", "list"):
        fail("fake mpremote: port must be explicit: " + json.dumps(port))
    if args[2] != "resume":
        fail("fake mpremote: file browsing must use resume: " + json.dumps(args))
    log({"argv": args, "port": port, "fs": args[4], "mode": fs_mode})
    sys.exit(filesystem_command(args[4:]))

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
