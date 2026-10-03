# Kubernetes waste lab

A small cluster with waste planted in it, and the list of what a scan must
find. It is how `cloudpilot kube` is checked: the same method as the AWS lab
in [`docs/waste-lab.md`](../docs/waste-lab.md), but it runs on your own
machine in [kind](https://kind.sigs.k8s.io) and costs nothing.

## What is in it

| ID | What | Expected finding |
|---|---|---|
| KW1 | `checkout`, 2 replicas, requests 500m CPU and uses none; its 64Mi memory request is sized right | Lower the CPU request to 10m, $22.61 a month. Memory untouched |
| KW2 | `search`, requests 1Gi memory and uses under 1Mi; its 20m CPU request is small | Lower the memory request to 32Mi, $3.00 a month. CPU untouched |
| KW3 | `reports`, 3 replicas, requests 300m CPU and 512Mi and uses neither | Lower both, $24.43 a month |
| KW4 | `old-exports`, a 5 GiB volume claim whose only pod finished long ago | Unused claim, $0.20 a month |
| KW5 | `archive-2025`, a 10 GiB volume whose claim was deleted | Released volume, $0.40 a month |
| KC1 | `web`, uses the CPU and memory it requests | Nothing: it must not be reported |
| KC2 | `importer`, killed once for running out of memory, idle since | Nothing: its memory must not be lowered, whatever the usage graph shows |

The lab's own Prometheus carries the label `cloudpilot/ignore=true`, so it is
left out and the report says so.

[`answer-key.json`](answer-key.json) holds the expected findings with their
exact fix commands and costs. The costs follow from
[`workloads.yaml`](workloads.yaml) and the default prices; each entry shows
the sum.

## Run it

You need Docker (or Colima), `kind` and `kubectl`.

```sh
k8s-lab/up.sh              # says what it would create
k8s-lab/up.sh --confirm    # creates it; about two minutes
```

Prometheus starts empty, so wait ten minutes for some history. Then:

```sh
cd packages/cli && npm run build
node dist/index.js kube --context kind-cloudpilot-lab --lookback-hours 1
node dist/index.js kube --context kind-cloudpilot-lab --lookback-hours 1 --answer-key ../../k8s-lab/answer-key.json
npm run test:kube-lab      # the live tests
```

The second command scores the scan: every item found, every cost within 1%,
every fix command exact, and nothing reported that is not in the key.

The live tests include ones that run CloudPilot in the lab as a pod. Those
need the image on the lab's node as well, and without it they skip, naming the
two commands that build and load it.

The live tests also check `apply` for real: one of them creates a namespace
of its own (`cloudpilot-apply-test`), applies a resize to a throwaway
deployment in it, puts the request back and removes the namespace again. The
lab's own seeded workloads are left untouched, and the scan test asserts
that.

```sh
k8s-lab/down.sh --confirm  # deletes the cluster
```

Every script names the lab's own kubectl context on every call, so it cannot
touch another cluster your kubectl points at.

## The offline copy

`packages/cli/test/fixtures/kube-lab.json` is a recording of what this lab's
API server and Prometheus answered, so the ordinary test suite checks the
same answer key with no cluster running. Re-record it when the reads change:

```sh
cd packages/cli && npx tsx test/kube-lab/record-fixture.ts > test/fixtures/kube-lab.json
```

The capture in the root README holds a second recording of this lab, in
`demo/cluster-lab`; re-record that one too, as
[`demo/README.md`](../demo/README.md#the-capture-in-the-readme) says.
