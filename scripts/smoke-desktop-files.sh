#!/usr/bin/env bash
set -euo pipefail
window=$(xdotool search --onlyvisible --name 'Aether Studio' | head -1)
export_path="$PWD/smoke-results/native-export.aether"
import_path="$PWD/smoke-results/native-import.aether"
roundtrip_path="$PWD/smoke-results/native-roundtrip.aether"
choose_path() {
  local dialog=""
  for attempt in $(seq 1 20); do
    dialog=$(xdotool search --onlyvisible --name "^$2$" | head -1 || true)
    if [[ -n "$dialog" ]]; then break; fi
    sleep 1
  done
  if [[ -z "$dialog" ]]; then
    xwininfo -root -tree
    import -window root smoke-results/native-files-failure.png
    echo 'Native file dialog did not appear' >&2
    exit 1
  fi
  xdotool windowfocus --sync "$dialog"
  sleep 1 # GTK initializes the location entry after mapping the dialog.
  xdotool key --clearmodifiers ctrl+l
  sleep 0.5
  xdotool type --clearmodifiers --delay 10 "$1"
  import -window root "smoke-results/$(basename "$1")-dialog.png"
  xdotool key --clearmodifiers Return
}
wait_for_file() {
  for attempt in $(seq 1 20); do
    if test -s "$1"; then return; fi
    sleep 1
  done
  import -window root smoke-results/native-files-failure.png
  xwininfo -root -tree
  find "$HOME" /tmp -name "*.aether*" -print 2>/dev/null || true
  echo "File not written: $1" >&2
  exit 1
}
xdotool windowfocus --sync "$window"
xdotool key --clearmodifiers ctrl+shift+e
choose_path "$export_path" "Export Aether Project"
wait_for_file "$export_path"
node --input-type=module - "$export_path" "$import_path" <<'JS'
import {readFileSync, writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const file = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(file.format, 'aether-studio');
assert.ok(file.workspace.files['main.py'].includes('from machine'));
file.project.name = 'Native Imported Project';
writeFileSync(process.argv[3], JSON.stringify(file));
JS
xdotool windowfocus --sync "$window"
xdotool key --clearmodifiers ctrl+shift+o
choose_path "$import_path" "Open Aether Project"
sleep 2
xdotool windowfocus --sync "$window"
xdotool key --clearmodifiers ctrl+shift+e
choose_path "$roundtrip_path" "Export Aether Project"
wait_for_file "$roundtrip_path"
node --input-type=module - "$roundtrip_path" <<'JS'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const file = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(file.project.name, 'Native Imported Project');
assert.equal(file.workspace.components.length, 5);
assert.equal(file.workspace.wires.length, 11);
console.log('PASS Tauri files: native save/open dialogs, filesystem permissions and project round trip');
JS
import -window root smoke-results/tauri-project-import.png
