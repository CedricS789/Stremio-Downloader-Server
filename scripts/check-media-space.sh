#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/stremio-dock"
MEDIA="$ROOT/media"
STATE="$ROOT/monitor/last-warning-level"
LOG="$ROOT/monitor/storage-warning.log"

# Read configured limit from docker .env or default to 100 GB
LIMIT_GB=100
if [ -f "$ROOT/app/.env" ]; then
  VAL=$(grep -E '^MEDIA_SOFT_LIMIT_GB=' "$ROOT/app/.env" | cut -d '=' -f2 | tr -d '"\r ' || true)
  if [ -n "$VAL" ]; then
    LIMIT_GB=$VAL
  fi
fi

LIMIT=$((LIMIT_GB * 1000 * 1000 * 1000))
WARN=$((LIMIT * 8 / 10))
USED=$(du -sb "$MEDIA" | awk '{print $1}')
LEVEL=0
(( USED >= WARN )) && LEVEL=80
(( USED >= LIMIT )) && LEVEL=100
PREVIOUS=$(cat "$STATE" 2>/dev/null || echo 0)
if (( LEVEL > PREVIOUS )); then
  USED_GB=$(awk -v n="$USED" 'BEGIN {printf "%.1f", n/1000000000}')
  MESSAGE="My-Media-Dock media storage is ${USED_GB} GB; warning threshold is ${LEVEL}% (soft limit ${LIMIT_GB} GB)."
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$MESSAGE" >> "$LOG"
  logger -p user.warning -t my-media-dock-storage "$MESSAGE" || true
  printf '%s\n' "$LEVEL" > "$STATE"
elif (( USED < WARN )); then
  printf '0\n' > "$STATE"
fi
