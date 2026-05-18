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

has_env() {
  var_name="$1"
  eval "value=\${$var_name-}"
  [ -n "$value" ]
}

printf 'TWiST Sentinel hosted/server preflight\n'
printf '======================================\n\n'

os_name="$(uname -s 2>/dev/null || printf 'unknown')"
printf 'OS: %s\n' "$os_name"
case "$os_name" in
  Darwin)
    pass "Darwin detected; system-audio/avfoundation can work locally"
    ;;
  Linux)
    warn "Linux detected; system-audio/avfoundation will not work here. Use YouTube/replay or local Mac relay."
    ;;
  *)
    warn "Unknown OS; system-audio/avfoundation is only expected on macOS"
    ;;
esac
printf '\n'

if has_env "DEEPGRAM_API_KEY"; then
  pass "DEEPGRAM_API_KEY present"
else
  fail_msg "DEEPGRAM_API_KEY missing"
fi

if has_env "ANTHROPIC_API_KEY"; then
  pass "ANTHROPIC_API_KEY present"
elif has_env "CLOUD_API_KEY"; then
  pass "CLOUD_API_KEY present as Anthropic fallback"
else
  fail_msg "ANTHROPIC_API_KEY or CLOUD_API_KEY missing"
fi

if has_env "TAVILY_API_KEY"; then
  pass "TAVILY_API_KEY present"
else
  fail_msg "TAVILY_API_KEY missing"
fi

printf '\nServer dependencies:\n'
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

printf '\nResult:\n'
if [ "$fail" -eq 0 ]; then
  pass "hosted/server preflight passed"
else
  fail_msg "hosted/server preflight failed"
fi

exit "$fail"
