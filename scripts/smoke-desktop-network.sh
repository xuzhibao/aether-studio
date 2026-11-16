#!/usr/bin/env bash
set -euo pipefail
node scripts/websocket-peer.mjs > smoke-results/websocket-peer.log 2>&1 &
peer_pid=$!
trap 'kill "$peer_pid" 2>/dev/null || true' EXIT
window=$(xdotool search --onlyvisible --name '^Aether Studio$' | head -1)
wait_for_file() {
  for attempt in $(seq 1 50); do
    if test -s "$1"; then return; fi
    sleep 0.2
  done
  import -window root smoke-results/websocket-failure.png
  echo "Missing WebSocket output: $1" >&2
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
wait_for_file smoke-results/websocket-url.txt
command_palette 'Manage devices'
# Endpoint starts focused. Select the second registered transport with the keyboard.
xdotool key --clearmodifiers shift+Tab End Tab
sleep 0.5
xdotool type --clearmodifiers --delay 20 "$(cat smoke-results/websocket-url.txt)"
xdotool key --clearmodifiers Return
sleep 2
import -window root smoke-results/websocket-connected.png
xdotool key --clearmodifiers Escape
command_palette 'Open Serial Monitor'
import -window root smoke-results/websocket-before-send.png
xdotool mousemove 420 1030 click 1
xdotool type --clearmodifiers --delay 20 'smoke-native-websocket'
xdotool key --clearmodifiers Return
wait_for_file smoke-results/websocket-received.json
sleep 2
import -window root smoke-results/websocket-roundtrip.png
command_palette 'Disconnect device transport'
wait_for_file smoke-results/websocket-closes.json
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.deepEqual(JSON.parse(readFileSync('smoke-results/websocket-received.json', 'utf8')), [{ text: 'smoke-native-websocket\n', binary: true }]);
assert.deepEqual(JSON.parse(readFileSync('smoke-results/websocket-closes.json', 'utf8')), [1000]);
console.log('PASS Tauri WebSocket: plugin parameters, real local network send/reply and normal disconnect; no hardware');
JS
