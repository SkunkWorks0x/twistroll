#!/bin/bash
# pm2-manage.sh
#
# Wrapper for the pm2-supervised TWiSTroll server. Reads ecosystem.config.cjs
# which loads .env and runs tsx directly (bypasses npm for faster crash-restart).
#
# Commands:
#   ./scripts/pm2-manage.sh start      # launch under pm2 (idempotent)
#   ./scripts/pm2-manage.sh stop       # stop but keep in registry
#   ./scripts/pm2-manage.sh restart    # restart (picks up .env changes)
#   ./scripts/pm2-manage.sh status     # list + last exit codes
#   ./scripts/pm2-manage.sh logs       # tail combined logs (Ctrl+C to stop)
#   ./scripts/pm2-manage.sh monit      # live cpu/mem/restarts dashboard
#   ./scripts/pm2-manage.sh delete     # remove from registry (stop + clear history)
#   ./scripts/pm2-manage.sh save       # persist list (survives pm2 daemon restart)
#
# First-time setup (once per machine):
#   ./scripts/pm2-manage.sh start
#   ./scripts/pm2-manage.sh save
#   # Optional — OS-level autostart on boot (will ask for sudo):
#   pm2 startup
#
# Memory guardrail: pm2 restarts if RSS > 1500MB (per data/diagnostics/
# oom-hunt-findings.md the server plateaus at 282MB; 1500MB is well above
# natural working set but well under the 2GB V8 cap).
#
# CRITICAL: do NOT run this while `npm run dev` is also running on the
# same machine. pm2 binds to the same ports and will fail/fight.

set -e
CMD="${1:-status}"
cd "$(dirname "$0")/.."

case "$CMD" in
  start)
    # Check ports aren't already taken by a non-pm2 process
    if lsof -ti :3000 >/dev/null 2>&1 || lsof -ti :3001 >/dev/null 2>&1; then
      # If the holder is pm2, fine — we're idempotent. Otherwise bail.
      if ! pm2 describe twistroll >/dev/null 2>&1; then
        echo "❌ Ports 3000/3001 already held by a non-pm2 process." >&2
        echo "   Run 'lsof -ti :3000 :3001' to find it, then kill it and retry." >&2
        exit 1
      fi
    fi
    pm2 start ecosystem.config.cjs
    pm2 status
    echo ""
    echo "✅ Server under pm2 supervision."
    echo "   Logs: ./scripts/pm2-manage.sh logs"
    echo "   Monit: ./scripts/pm2-manage.sh monit"
    ;;
  stop)
    pm2 stop twistroll 2>/dev/null || echo "(not running)"
    ;;
  restart)
    pm2 restart twistroll --update-env
    ;;
  status)
    pm2 status
    ;;
  logs)
    pm2 logs twistroll --lines 100
    ;;
  monit)
    pm2 monit
    ;;
  delete)
    pm2 delete twistroll 2>/dev/null || echo "(not in registry)"
    ;;
  save)
    pm2 save
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    echo "Usage: $0 {start|stop|restart|status|logs|monit|delete|save}" >&2
    exit 2
    ;;
esac
