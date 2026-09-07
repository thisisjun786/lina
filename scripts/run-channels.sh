#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

load_env() {
  local line
  local key
  local value

  [[ -f .env.discord ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "invalid .env.discord line" >&2
      return 2
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < .env.discord
}

load_env
if [[ -z "${DISCORD_BOT_TOKEN:-}" || -z "${DISCORD_CHANNEL_ID:-}" ]]; then
  echo "DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are required" >&2
  exit 2
fi

NO_LOOP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-loop)
      NO_LOOP=1
      shift
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

child=""
sleeper=""
stopping=0

request_stop() {
  local signal="$1"

  stopping=1
  if [[ -n "$child" ]]; then
    kill -"$signal" "$child" 2>/dev/null || true
  fi
  if [[ -n "$sleeper" ]]; then
    kill -TERM "$sleeper" 2>/dev/null || true
  fi
}

pause() {
  sleep "$1" &
  sleeper=$!
  if wait "$sleeper"; then
    :
  fi
  sleeper=""
}

stop_child() {
  local i=0

  [[ -n "$child" ]] || return 0
  kill -TERM "$child" 2>/dev/null || true
  while kill -0 "$child" 2>/dev/null && ((i < 50)); do
    pause 0.1
    i=$((i + 1))
  done
  if kill -0 "$child" 2>/dev/null; then
    kill -KILL "$child" 2>/dev/null || true
  fi
  wait "$child" 2>/dev/null || true
}

trap 'request_stop INT' INT
trap 'request_stop TERM' TERM

attempt=0
backoff=(1 2 3 4 30 60)
while :; do
  [[ "$stopping" -eq 0 ]] || exit 0
  attempt=$((attempt + 1))
  echo "[run-channels] attempt $attempt: bun packages/lina-channels/src/discord-bridge.ts"
  [[ "$stopping" -eq 0 ]] || exit 0
  bun packages/lina-channels/src/discord-bridge.ts &
  child=$!

  while kill -0 "$child" 2>/dev/null; do
    pause 0.1
    if [[ "$stopping" -eq 1 ]]; then
      stop_child
      child=""
      exit 0
    fi
  done

  if wait "$child"; then
    code=0
  else
    code=$?
  fi
  child=""

  [[ "$stopping" -eq 0 ]] || exit 0
  if [[ "$NO_LOOP" -eq 1 || "$code" -eq 1 || "$code" -eq 2 ]]; then
    exit "$code"
  fi

  index=$((attempt < 6 ? attempt - 1 : 5))
  echo "[run-channels] restarting in ${backoff[$index]}s"
  pause "${backoff[$index]}"
  [[ "$stopping" -eq 0 ]] || exit 0
done
