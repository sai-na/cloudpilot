# Daily report

CloudPilot can check your account every day without you, and write to you
only when there is something new to decide. Nothing to open, nothing to
remember to run.

It runs in your own AWS account, from a CloudFormation template you can read
before you deploy it: [`daily-report.yaml`](daily-report.yaml).

For a Kubernetes cluster, the cluster can watch itself instead: see
[Watch a cluster from inside it](#watch-a-cluster-from-inside-it).

## Set it up

In AWS CloudShell, or anywhere with the AWS CLI and credentials:

```sh
curl -fsSLO https://raw.githubusercontent.com/sai-na/cloudpilot/main/deploy/daily-report.yaml
aws cloudformation deploy \
  --stack-name cloudpilot-daily \
  --template-file daily-report.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Email=you@example.com
```

AWS then emails you a link to confirm the address. Reports only arrive once
you have clicked it.

To get the first report now instead of waiting for the schedule:

```sh
aws codebuild start-build --project-name cloudpilot-daily
```

## What you receive

- **The first run** sends the whole report: every finding, its evidence, its
  monthly cost, the fix command and what about that fix cannot be undone.
- **After that** you get an email only on a day something new appears, and it
  lists only what is new. The subject line carries the count and the monthly
  cost, so most days you can decide from the inbox.
- **A day with nothing new sends nothing.**
- **If the scan itself fails** you get an email saying so. Silence always
  means nothing new, never a broken job.

## What it creates

| Resource | What it is for |
|---|---|
| CodeBuild project | Runs `npx @meruapps/cloudpilot` on the smallest Linux machine |
| IAM role for the scan | CloudPilot's [read-only policy](../docs/cloudpilot-readonly-policy.json), plus writing its own log, reading and writing one state file, and publishing to the one email topic |
| S3 bucket | Holds one object, the previous scan, so the next run knows what is new. Encrypted, with public access blocked |
| SNS topic | Emails the report to the address you gave |
| CloudWatch log group | The job's own log, deleted after 30 days |
| Two EventBridge rules and a role | One starts the scan on the schedule; the other emails you when a scan fails |

Nothing here can change, stop or delete anything else in your account. A test
in this repository fails if the template's permissions grow beyond that list.

AWS charges for what the stack uses: a few build minutes a run, a few
kilobytes in S3, and the emails.

## Settings

| Parameter | Default | Meaning |
|---|---|---|
| `Email` | none, required | Where the report goes |
| `Schedule` | `rate(1 day)` | Any EventBridge schedule, for example `cron(0 3 * * ? *)` for 03:00 UTC |
| `Region` | empty | Scan one region only. Empty scans every region enabled for the account |
| `PackageSpec` | `@meruapps/cloudpilot` | The package to run. Pin a version with `@meruapps/cloudpilot@0.1.0` |

Change one by running the deploy command again with a different
`--parameter-overrides`.

## Stop it

```sh
bucket=$(aws cloudformation describe-stacks --stack-name cloudpilot-daily \
  --query "Stacks[0].Outputs[?OutputKey=='StateBucket'].OutputValue" --output text)
aws s3 rm "s3://$bucket" --recursive
aws cloudformation delete-stack --stack-name cloudpilot-daily
```

The bucket is emptied first because CloudFormation will not delete a bucket
that still holds the saved scan.

# Watch a cluster from inside it

`cloudpilot watch --kube` scans a cluster again and again and tells a webhook
only when something new appears. Run on a laptop it needs your kubeconfig;
[`kube-watch.yaml`](kube-watch.yaml) runs it as a Deployment in the cluster
instead, so nobody has to keep a terminal open. Read the manifest before you
apply it: it is one short file, and every object it creates is in it.

## Set it up

You need a cluster, `kubectl` pointed at it, and a Slack, Discord or other
https webhook URL. CloudPilot's image is not published anywhere, so you build
it and put it where your cluster can pull it.

**1. Build the image**, from the root of this repository:

```sh
docker build -t cloudpilot:local .
```

**2. Get it into the cluster.** For a [kind](https://kind.sigs.k8s.io)
cluster (the one route tested in this repository):

```sh
kind load docker-image cloudpilot:local --name <your-kind-cluster>
```

For any other cluster, tag it for a registry you control and push it there
(`docker tag`, `docker push`), with an image pull secret if the registry needs
one. Use the name you pushed in the next step.

**3. Fill in `kube-watch.yaml`.** Three things in it are yours to fill in, each
marked `EDIT` (a fourth `EDIT`, how often to scan, already works as it stands):

- `image:` is a name Kubernetes cannot pull, on purpose, so that nothing is
  fetched from anywhere until you put yours there (`cloudpilot:local` for the
  kind route above).
- `CLOUDPILOT_CLUSTER_NAME` is the **name of this cluster as your team's
  kubectl knows it**: the context name on their own machines, as
  `kubectl config get-contexts` shows it. See [Name the cluster](#name-the-cluster).
  Left as shipped, the pod stops with a message saying so.
- The Role and RoleBinding for Prometheus name the namespace and the
  `<service>:<port>` of yours. Without them the pod can still list everything
  else, and the report says requests were not compared with real use.

**4. Apply it and give it the webhook.** The URL is a secret, so it is not in
the file: you create it yourself, with the one command below. The pod waits for
it and starts once it exists.

```sh
kubectl apply -f deploy/kube-watch.yaml
kubectl -n cloudpilot create secret generic cloudpilot-webhook \
  --from-literal=url='https://hooks.slack.com/services/...'
```

Several webhooks can go in the one value, comma-separated.

**5. See that it works.**

```sh
kubectl -n cloudpilot logs deploy/cloudpilot-watch
```

The first lines say `Watching cluster <name> every 6h, read-only` and `Reading
cluster <name> from inside it, as this pod's service account (read-only)...`.
The first round sends the whole report once; after that, a message goes out
only on a round that finds something new, and the log says `Nothing new` on the
others.

## What it creates

| Object | What it is for |
|---|---|
| Namespace `cloudpilot`, held to the `restricted` Pod Security Standard as v1.37 defines it | Where it runs. The pod below meets that standard, so the cluster can enforce it. Pinning the version keeps a cluster upgrade from changing what is admitted here |
| ServiceAccount `cloudpilot`, ClusterRole and ClusterRoleBinding `cloudpilot-readonly` | Its identity, and the access in the next section |
| Role and RoleBinding in your Prometheus's namespace | GET on that one service, through the API server |
| Deployment `cloudpilot-watch` | One pod running `cloudpilot watch --kube --every 6h` |

These are the same names and rules as
[`docs/cloudpilot-kube-readonly.yaml`](../docs/cloudpilot-kube-readonly.yaml), so if
you applied that file first, applying this one leaves its identity as it was (the
namespace only gains the Pod Security label). A test in this repository fails if the
access in the two files differs, or if the manifest grows an object beyond the
Deployment.

The Secret `cloudpilot-webhook` is the one thing the manifest does not create.

## What it can and cannot read

It can **list**, in every namespace: Namespaces, Pods, Services, PersistentVolumeClaims,
PersistentVolumes, Deployments, ReplicaSets, StatefulSets and DaemonSets. It can
**GET** one service's proxy, your Prometheus, to ask for usage history.

It cannot read Secrets or ConfigMaps, read logs, open a shell in a pod, or use any verb
that creates, changes or deletes anything. Asked of the API server on the kind lab in
this repository, as `--as=system:serviceaccount:cloudpilot:cloudpilot`,
`kubectl auth can-i` answers `yes` to listing Pods and Deployments in every namespace,
and `no` to: `delete`, `patch`, `update` and `create` on Deployments, `delete` and
`create` on Pods, `create` on `pods/exec`, `get` on `pods/log`, `delete` on
PersistentVolumeClaims, PersistentVolumes and Namespaces, `list` on Secrets, `get` on
ConfigMaps, `create` on ClusterRoleBindings, and `get` on the service proxy of
`kube-dns` in `kube-system`. Only `get` on `prometheus:9090`'s proxy in `monitoring` is `yes`.

Two things to know about what listing returns. A Pod's spec includes environment
variables written into it as plain values (not the contents of a Secret they
refer to), so a secret pasted directly into a Pod's `env:` is readable by
anything that can list Pods, as it is by every tool with that access. CloudPilot
uses names, requests and volume claims, and nothing else leaves the cluster
except the message to your webhook: finding titles, resource names and costs,
and for a generic webhook each finding's evidence and fix commands (see
[Tell your team what is new](../packages/cli/README.md#tell-your-team-what-is-new)).

## Name the cluster

Inside a pod there is no kubeconfig, so there is no context name for CloudPilot
to read, and it must be told one: `CLOUDPILOT_CLUSTER_NAME` in the manifest (or
`--cluster-name <name>` on the command line). Without a name, inside a cluster,
it stops with a message before it reads anything.

Use the **kubectl context name your team uses for this cluster on their own
machines**. Every fix command CloudPilot prints carries `--context <name>`, so
that a command pasted into the wrong terminal cannot reach a different cluster.
A name nobody's kubectl knows makes every pasted fix fail with "context not
found", which is safe but useless; the name of another cluster would aim the
fix at that one. The name must be one word without spaces, quotes or shell
characters (an EKS ARN such as `arn:aws:eks:eu-west-1:123456789012:cluster/prod`
is fine). It also names the saved baseline and appears in every message.

## Settings

| What | Where | Default |
|---|---|---|
| Cluster name | `CLOUDPILOT_CLUSTER_NAME` in the Deployment | none: the pod stops until you set it |
| How often | `args:` in the Deployment: `--every <interval>`, from `15m` to `7d` | `6h` |
| Webhook | The Secret `cloudpilot-webhook`, key `url` | none: create it |
| Prices, one namespace, a Prometheus that is not found | More `args:`, for example `--namespace shop`, `--prometheus monitoring/prometheus:9090`, `--cpu-hour-usd 0.05` | see `cloudpilot watch --help` |

Change one by editing the manifest and applying it again, or with `kubectl -n
cloudpilot edit deployment cloudpilot-watch`; the pod is replaced.

A webhook behind a private certificate authority is refused, as it would be
anywhere: mount your CA certificate into the pod and point `NODE_EXTRA_CA_CERTS`
at the file. A plain `http` URL is refused except to `localhost`.

## What it asks for, and why

| | Request | Limit |
|---|---|---|
| CPU | 10m | none |
| Memory | 80Mi | 256Mi |

Measured on the kind lab in this repository (20 running pods, 6 namespaces read, with the watcher and the test receiver among them), over three
15-minute rounds, from the container's own cgroup on the node:

| | Measured |
|---|---|
| Memory, highest the container reached (`memory.peak`) | 67.6 MiB, the first scan, with start-up |
| Memory, held between scans (anonymous memory) | 44 MiB after the first scan, 47 MiB after the third |
| Memory, working-set peak as the lab's Prometheus recorded it | 51.2 MiB |
| CPU, total for start-up and three scans | 1.70 CPU-seconds, so about a second per scan and well under 1m averaged over a round |
| CPU throttling | none (there is no CPU limit) |

The memory request is that 67.6 MiB peak plus the 15% CloudPilot's own rule adds
to a peak, rounded to 80Mi. The CPU request is 10m, the least a request is ever
suggested at: a scan is a second of CPU every few hours. The 256Mi memory limit
is room for a larger cluster's lists, not a figure it was seen to use. With these
requests a scan of the lab, with the watch running, still finds exactly its five
findings and none for the watcher.

## Stop it

To stop watching and keep the read-only identity:

```sh
kubectl -n cloudpilot delete deployment cloudpilot-watch
```

To remove everything the manifest created, including the namespace (and so the
Secret) and the access in `monitoring`:

```sh
kubectl delete -f deploy/kube-watch.yaml
```

That deletes the identity from `docs/cloudpilot-kube-readonly.yaml` too if you
applied it, because the two share their objects.

## Limits

- **The baseline lives in an `emptyDir`.** It is how the watch knows what it has
  already told you, and it is gone whenever the pod is: a restart, a rescheduling,
  a new image or an edit to the Deployment. The next pod sends its **first report
  again**, every finding, once. Silence still only ever means nothing is new, but a
  restart is not silent. (A volume that survives would need storage this manifest
  does not ask your cluster for.)
- **One pod, no failover.** If its node is lost, nothing watches until the pod is
  rescheduled, and then it reports again as above.
- **It scans itself.** Its own pod is a workload like any other, and is judged on the
  same rules once Prometheus holds enough history of it. The requests above are what
  keep it from being a finding.
- **It is sized for a small cluster.** The figures above were measured on a lab with
  20 running pods. A scan holds the cluster's lists in memory, so a much larger cluster
  needs more memory than 80Mi; watch for the pod being killed for running out of memory
  (`kubectl -n cloudpilot describe pod`) and raise the request and limit if it is.
- **Nothing here checks the name you gave.** CloudPilot cannot ask the cluster what your
  team calls it.
- **No probes and no network policy.** It is a loop with no port to check. If your cluster
  denies egress by default, allow the pod to reach the API server and your webhook.
