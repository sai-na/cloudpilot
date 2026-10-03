#!/usr/bin/env bash
# Build the Docker image and prove it works with no network at all.
#
#   scripts/docker-smoke.sh
#
# It replays the recorded scan in packages/cli/test/fixtures/lab inside a
# container started with --network none and the recording mounted read-only,
# then checks the exit code and the 10 recorded findings. It also checks that
# the container is not root, that kubectl is present, and that the container
# really has no network interface but loopback.
#
# Needs only bash (3.2 is fine) and a running Docker. It is not part of
# `npm test`, which must run without Docker.
#
# IMAGE: tag to build and test. Default cloudpilot:smoke.
# SKIP_BUILD=1: test the image already tagged IMAGE.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-cloudpilot:smoke}"
FIXTURE="$ROOT/packages/cli/test/fixtures/lab"
EXPECTED_FINDINGS=10

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cloudpilot-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

[[ -d "$FIXTURE" ]] || fail "recording not found at $FIXTURE"
docker info >/dev/null 2>&1 || fail "Docker is not running"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "Building $IMAGE ..."
  docker build -t "$IMAGE" "$ROOT"
fi

# 1. The entrypoint is cloudpilot.
if docker run --rm --network none "$IMAGE" scan --help >"$WORK/help.txt" 2>&1; then
  grep -q "Usage: cloudpilot scan" "$WORK/help.txt" || fail "scan --help did not print its usage"
  pass "docker run $IMAGE scan --help"
else
  cat "$WORK/help.txt" >&2
  fail "scan --help exited non-zero"
fi

# 2. The container is not root.
uid="$(docker run --rm --network none --entrypoint id "$IMAGE" -u)"
[[ "$uid" != "0" ]] || fail "the container runs as root (uid 0)"
pass "runs as uid $uid, not root"

# 3. The container has no network: only the loopback interface.
nics="$(docker run --rm --network none --entrypoint ls "$IMAGE" /sys/class/net | tr '\n' ' ')"
[[ "$nics" == "lo " ]] || fail "expected only the loopback interface, found: $nics"
pass "--network none leaves only the loopback interface"

# 4. kubectl is there and is the client the cluster scan will use.
docker run --rm --network none --entrypoint kubectl "$IMAGE" version --client >"$WORK/kubectl.txt" 2>&1 \
  || fail "kubectl --client did not run: $(cat "$WORK/kubectl.txt")"
pass "$(grep 'Client Version' "$WORK/kubectl.txt")"

# `cloudpilot kube` with no kubeconfig must fail inside kubectl, not because
# kubectl is missing.
docker run --rm --network none "$IMAGE" kube >"$WORK/kube.txt" 2>&1 && fail "kube with no kubeconfig should not succeed"
if grep -q "was not found on your PATH" "$WORK/kube.txt"; then
  fail "cloudpilot kube could not find kubectl: $(cat "$WORK/kube.txt")"
fi
pass "cloudpilot kube reaches kubectl (and stops because there is no kubeconfig)"

# 5. The recorded scan replays with no network, read-only recording.
set +e
docker run --rm --network none -v "$FIXTURE:/recording:ro" "$IMAGE" \
  scan --replay /recording --json >"$WORK/scan.json" 2>"$WORK/scan.err"
status=$?
set -e
[[ "$status" -eq 0 ]] || { cat "$WORK/scan.err" >&2; fail "replay exited $status, expected 0"; }
grep -q "^REPLAY MODE:" "$WORK/scan.err" || fail "no REPLAY MODE banner on stderr"
pass "scan --replay exited 0 with --network none"

# Count the findings with the image's own node, so the host needs no jq.
count="$(docker run --rm -i --network none --entrypoint node "$IMAGE" -e \
  'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(r.findings.length)' <"$WORK/scan.json")"
[[ "$count" == "$EXPECTED_FINDINGS" ]] || fail "expected $EXPECTED_FINDINGS findings, got $count"
pass "$count findings reported, as recorded"

echo "PASS: $IMAGE works with no network"
