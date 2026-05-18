#!/usr/bin/env bash
set -u

fail=0

pass() {
  printf 'PASS: %s\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1"
}

fail_msg() {
  printf 'FAIL: %s\n' "$1"
  fail=1
}

printf 'TWiST Sentinel local Mac audio preflight\n'
printf '=======================================\n\n'

os_name="$(uname -s 2>/dev/null || printf 'unknown')"
printf 'OS: %s\n\n' "$os_name"

if command -v ffmpeg >/dev/null 2>&1; then
  pass "ffmpeg found: $(command -v ffmpeg)"
else
  fail_msg "ffmpeg not found on PATH"
fi

if command -v yt-dlp >/dev/null 2>&1; then
  pass "yt-dlp found: $(command -v yt-dlp)"
else
  fail_msg "yt-dlp not found on PATH"
fi

if [ "$os_name" != "Darwin" ]; then
  warn "avfoundation system-audio capture is macOS-only; this preflight is intended for Oliver's Mac."
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  printf '\nInstall ffmpeg before checking BlackHole.\n'
  exit "$fail"
fi

printf '\nRunning AVFoundation device probe:\n'
printf 'ffmpeg -f avfoundation -list_devices true -i ""\n\n'

probe_output="$(ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true)"
printf '%s\n' "$probe_output"

printf '\nDevice check:\n'
if printf '%s\n' "$probe_output" | grep -Fq "BlackHole 2ch"; then
  pass "BlackHole 2ch detected"
else
  fail_msg "BlackHole 2ch not found in AVFoundation device list"
  printf '\nNext step:\n'
  printf '  brew install --cask blackhole-2ch\n'
  printf '  reboot\n'
fi

printf '\nResult:\n'
if [ "$fail" -eq 0 ]; then
  pass "local audio preflight passed"
else
  fail_msg "local audio preflight failed"
fi

exit "$fail"

