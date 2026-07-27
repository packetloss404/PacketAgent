#!/usr/bin/env bash
# One-step launcher for PacketAgent (macOS / Linux).
# Installs dependencies on first run, loads .env, checks for an AI provider,
# opens the browser, and starts the dev server.

set -e

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "Installing dependencies (one-time, ~1 minute)..."
  npm install
fi

if [ -f .env ]; then
  # Safe .env parser: never source the file (which would shell-execute any
  # $(...) or backticks in values). Match the PowerShell launcher's behavior:
  # parse line by line, strip surrounding quotes, ignore comments and blanks.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if [[ "$line" != *=* ]]; then
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    # Trim whitespace around key
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # Strip matched surrounding single or double quotes from value
    if [[ "$value" == \"*\" ]] || [[ "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -n "$key" ]]; then
      export "$key=$value"
    fi
  done < .env
fi

node scripts/preflight.mjs

echo "Opening http://localhost:7341/builder in your browser..."
(
  sleep 3
  if command -v open >/dev/null 2>&1; then
    open http://localhost:7341/builder >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:7341/builder >/dev/null 2>&1 || true
  fi
) &

npm run dev
