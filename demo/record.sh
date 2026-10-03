#!/usr/bin/env bash
# Record the full demo set in one go, so it can be replayed with no network:
#   scan --explain, and the two ask questions.
# Usage: demo/record.sh [recording-dir] [extra cloudpilot flags, e.g. --redact-account]
# Records one region (CLOUDPILOT_REGION, default ap-south-1). Set CLOUDPILOT_REGION=all for every region.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"   # so the CLI finds .env with the model key
DIR="${1:-recordings/demo}"
shift || true
CLOUDPILOT=(node packages/cli/dist/index.js)
REGION="${CLOUDPILOT_REGION:-ap-south-1}"
LIVE=(--profile "${CLOUDPILOT_PROFILE:-cloudpilot-readonly}" --record "$DIR" "$@")
if [[ "$REGION" == "all" ]]; then LIVE+=(--all-regions); else LIVE+=(--region "$REGION"); fi

echo "== 1/3 scan --explain"
"${CLOUDPILOT[@]}" scan "${LIVE[@]}" --explain > /dev/null
echo "== 2/3 ask: what to fix first"
"${CLOUDPILOT[@]}" ask "${LIVE[@]}" "What should I fix first, and what is the risk?" > /dev/null
echo "== 3/3 ask: is the instance idle"
"${CLOUDPILOT[@]}" ask "${LIVE[@]}" "Is the running instance really idle? Check its CPU over the last 12 hours." > /dev/null

echo
echo "Recorded to $DIR. Replay with: demo/replay.sh $DIR"
