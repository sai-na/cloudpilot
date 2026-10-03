#!/usr/bin/env bash
# Remove the Kubernetes waste lab.
# Dry run by default: says what it would delete. With --confirm: deletes the cluster.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_confirm "$@"
need kind

if ! cluster_exists; then
  echo "There is no kind cluster \"$CLUSTER\": nothing to remove."
  exit 0
fi

echo "This deletes the kind cluster \"$CLUSTER\" and everything in it:"
k get deployments,jobs,persistentvolumeclaims,persistentvolumes --all-namespaces 2>/dev/null | sed 's/^/  /' || true

if [[ "$CONFIRM" != 1 ]]; then
  echo
  echo "Dry run: nothing was deleted. Run again with --confirm to delete it."
  exit 0
fi

kind delete cluster --name "$CLUSTER"
echo "Removed."
