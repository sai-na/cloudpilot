# Shared settings for the Kubernetes lab scripts. Source this, don't run it.
# Works with the bash 3.2 that ships with macOS.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER="cloudpilot-lab"
CONTEXT="kind-$CLUSTER"

# Every kubectl call names the lab's context, so these scripts can never touch
# whatever cluster your kubectl happens to point at.
k() { kubectl --context "$CONTEXT" "$@"; }

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; }

CONFIRM=0
parse_confirm() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --confirm) CONFIRM=1 ;;
      *) echo "Unknown argument: $arg (the only option is --confirm)" >&2; exit 2 ;;
    esac
  done
}

need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || { echo "This needs $tool on your PATH." >&2; exit 1; }
  done
}
