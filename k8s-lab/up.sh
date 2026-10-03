#!/usr/bin/env bash
# Create the Kubernetes waste lab: a kind cluster on this machine, a small
# Prometheus, and workloads that waste resources in known ways.
# Dry run by default: says what it would create. With --confirm: creates it.
# Safe to run again; it only adds what is missing.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_confirm "$@"
need kind kubectl docker

cat <<TEXT
Kubernetes waste lab
  Cluster      kind cluster "$CLUSTER" (one node, a container on this machine; no cloud account is used)
  monitoring   Prometheus, scraping container CPU and memory every 15 seconds
  cloudpilot   the read-only identity from docs/cloudpilot-kube-readonly.yaml
  shop         checkout (KW1), search (KW2), reports (KW3): ask for more than they use
               web (KC1): sized right.  importer (KC2): killed once for running out of memory
               old-exports (KW4): a 5 GiB volume claim nothing mounts
  cluster-wide archive-2025 (KW5): a 10 GiB volume left Released
  Cost         nothing: it all runs in Docker here. It asks the node for about 3 CPUs and 3 GiB of memory.
TEXT

if [[ "$CONFIRM" != 1 ]]; then
  if cluster_exists; then echo; echo "The cluster already exists; --confirm would only add what is missing."; fi
  echo
  echo "Dry run: nothing was created. Run again with --confirm to create it."
  exit 0
fi

if ! cluster_exists; then
  kind create cluster --config "$HERE/kind-config.yaml" --wait 180s
fi

k apply -f "$HERE/prometheus.yaml" -f "$HERE/workloads.yaml"
# The least-access identity CloudPilot documents, so the tests can prove it is enough and no more.
k apply -f "$HERE/../docs/cloudpilot-kube-readonly.yaml"

# KW5: bind a volume that keeps its data, then delete the claim so the volume is left Released.
if [[ "$(k get pv archive-2025 -o jsonpath='{.status.phase}' 2>/dev/null || true)" != "Released" ]]; then
  k apply -f "$HERE/released-volume.yaml"
  k -n shop wait --for=jsonpath='{.status.phase}'=Bound pvc/archive-2025 --timeout=120s
  k -n shop delete pvc archive-2025 --wait=true
  k wait --for=jsonpath='{.status.phase}'=Released pv/archive-2025 --timeout=120s
fi

k -n monitoring rollout status deployment/prometheus --timeout=600s
for workload in checkout search reports web importer; do
  k -n shop rollout status "deployment/$workload" --timeout=600s
done
k -n shop wait --for=condition=complete job/export-2025 --timeout=300s

# KC2 is only a fair test once its first start has been killed and it has come back.
echo "Waiting for the importer to be killed for memory once and restart..."
for _ in $(seq 1 60); do
  reason="$(k -n shop get pods -l app=importer -o jsonpath='{.items[0].status.containerStatuses[0].lastState.terminated.reason}' 2>/dev/null || true)"
  [[ "$reason" == "OOMKilled" ]] && break
  sleep 5
done
[[ "${reason:-}" == "OOMKilled" ]] || { echo "The importer was never killed for memory; KC2 is not in place." >&2; exit 1; }

cat <<TEXT

The lab is up. Prometheus has only just started, so give it ten minutes to
collect some history, then scan and score:

  cd packages/cli
  node dist/index.js kube --context $CONTEXT --lookback-hours 1
  node dist/index.js kube --context $CONTEXT --lookback-hours 1 --answer-key ../../k8s-lab/answer-key.json

Remove it with k8s-lab/down.sh --confirm.
TEXT
