#!/usr/bin/env bash
# Replay the recorded demo set. Makes no network calls.
# Usage: demo/replay.sh [recording-dir] [extra cloudpilot flags, e.g. --redact-account]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-recordings/demo}"
shift || true
[[ "$DIR" = /* ]] || DIR="$ROOT/$DIR"
CLOUDPILOT=(node "$ROOT/packages/cli/dist/index.js")

"${CLOUDPILOT[@]}" scan --replay "$DIR" --explain "$@"
echo
"${CLOUDPILOT[@]}" ask --replay "$DIR" "$@" "What should I fix first, and what is the risk?"
echo
"${CLOUDPILOT[@]}" ask --replay "$DIR" "$@" "Is the running instance really idle? Check its CPU over the last 12 hours."
