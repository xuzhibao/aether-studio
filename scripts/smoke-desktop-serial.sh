#!/usr/bin/env bash
set -euo pipefail
python3 scripts/serial-peer.py > smoke-results/serial-peer.log 2>&1 &
peer_pid=$!
trap 'kill "$peer_pid" 2>/dev/null || true' EXIT
window=$(xdotool search --onlyvisible --name '^Aether Studio$' | head -1)
wait_for_file() {
  for attempt in $(seq 1 50); do
    if test -s "$1"; then return; fi
    sleep 0.2
  done
  import -window root smoke-results/serial-failure.png
  echo "Missing serial test output: $1" >&2
  exit 1
}
command_palette() {
  xdotool windowfocus --sync "$window"
  xdotool key --clearmodifiers ctrl+k
  sleep 0.5
  xdotool type --clearmodifiers --delay 15 "$1"
  xdotool key --clearmodifiers Return
  sleep 1
}
wait_for_file smoke-results/serial-port.txt
command_palette 'Manage devices'
# Devices initially focuses the port input; Enter submits its connection form.
xdotool type --clearmodifiers --delay 20 "$(cat smoke-results/serial-port.txt)"
xdotool key --clearmodifiers Return
sleep 2
import -window root smoke-results/serial-connected.png
xdotool key --clearmodifiers Escape
command_palette 'Open Serial Monitor'
import -window root smoke-results/serial-before-send.png
# Fixed CI viewport: the Serial Monitor transmit input is in the bottom row.
xdotool mousemove 420 1030 click 1
xdotool type --clearmodifiers --delay 20 'smoke-native-serial'
xdotool key --clearmodifiers Return
wait_for_file smoke-results/serial-transmitted.bin
wait_for_file smoke-results/serial-replied.txt
sleep 2
import -window root smoke-results/serial-roundtrip.png
command_palette 'Disconnect device transport'
wait_for_file smoke-results/serial-disconnected.txt
python3 - <<'PY'
from pathlib import Path
assert Path('smoke-results/serial-transmitted.bin').read_bytes() == b'smoke-native-serial\n'
print('PASS Tauri serial: UI connection, actual OS PTY write/reply and explicit disconnect; no physical hardware')
PY
