# CloudPilot

A read-only command-line agent that finds wasted AWS spend, prices it from
the AWS Price List, and prints the exact commands that would fix it. It never
runs those commands.

## Run in AWS CloudShell

Open CloudShell from the AWS console and run:

```sh
npx @meruapps/cloudpilot
```

That is the whole setup. CloudPilot uses the credentials CloudShell already
has (those of the user signed in to the console), scans every region enabled
for the account, shows progress per region, and ends with the findings and a
summary. It needs no API key and no configuration. Add `--region ap-south-1`
to scan one region, or `--html report.html` to save a report you can
download from CloudShell.

It works the same on any machine with Node 18 or later and AWS credentials:
with no `--profile` it uses the standard AWS credential chain (environment
variables, shared config, SSO, container or instance role). AWS's own SDK
prints a deprecation warning on Node 18; Node 20 or later is quieter.

### Every AWS API call it makes

CloudPilot only reads. These are all the operations it calls, and a test
fails the build if the code calls anything that is not on this list or that
is not a `Describe`, `List` or `Get`.

| Service | Operation | IAM permission | Used for |
|---|---|---|---|
| STS | `GetCallerIdentity` | none needed | The account ID shown in the report |
| EC2 | `DescribeRegions` | `ec2:DescribeRegions` | The regions enabled for the account |
| EC2 | `DescribeVolumes` | `ec2:DescribeVolumes` | Unattached and gp2 volumes |
| EC2 | `DescribeSnapshots` | `ec2:DescribeSnapshots` | Snapshots of deleted volumes |
| EC2 | `DescribeImages` | `ec2:DescribeImages` | Unused AMIs |
| EC2 | `DescribeInstances` | `ec2:DescribeInstances` | Stopped and idle instances |
| EC2 | `DescribeAddresses` | `ec2:DescribeAddresses` | Idle Elastic IPs |
| EC2 | `DescribeLaunchTemplates` | `ec2:DescribeLaunchTemplates` | Whether an AMI is still referenced |
| EC2 | `DescribeLaunchTemplateVersions` | `ec2:DescribeLaunchTemplateVersions` | Whether an AMI is still referenced |
| S3 | `ListBuckets` | `s3:ListAllMyBuckets` | The buckets in each region |
| S3 | `GetBucketLocation` | `s3:GetBucketLocation` | A bucket's region, when the listing omits it |
| S3 | `GetBucketLifecycleConfiguration` | `s3:GetLifecycleConfiguration` | Buckets with no lifecycle rule |
| S3 | `GetBucketTagging` | `s3:GetBucketTagging` | The `cloudpilot:ignore` tag |
| S3 | `ListObjectsV2` | `s3:ListBucket` | Object count and size; object contents are never read |
| S3 | `ListMultipartUploads` | `s3:ListBucketMultipartUploads` | Incomplete uploads |
| S3 | `ListParts` | `s3:ListMultipartUploadParts` | The size of an incomplete upload |
| CloudWatch | `GetMetricData` | `cloudwatch:GetMetricData` | CPU history of running instances |
| Pricing | `GetProducts` | `pricing:GetProducts` | Unit prices for what was found |

CloudShell's credentials are your console permissions, which usually allow
far more than this. To hold CloudPilot to exactly these reads, run it with a
role that has only the policy in `docs/cloudpilot-readonly-policy.json`
(`--profile <read-only profile>`). Any operation the role may not call is
reported as a skipped check instead of ending the scan.

With `--explain` or `ask`, the findings are also sent to the model provider
whose API key you set. Without those, nothing leaves AWS and your terminal.

## What it finds

| Pattern | How it is detected | Proposed fix |
|---|---|---|
| Unattached EBS volume | State `available`, no attachments | Delete it (or convert gp2 to gp3 if it must stay) |
| gp2 volume in use | Volume type gp2 | Convert to gp3 |
| Idle Elastic IP | No association | Release it |
| Stopped instance | State `stopped`, still has EBS volumes | Terminate it |
| Idle instance | CloudWatch CPU never above 5% over at least 1 hour | Terminate it |
| Orphaned snapshot | Source volume no longer exists and no AMI uses it | Delete it |
| Unused AMI | No instance and no launch template references it | Deregister it and delete its snapshots |
| Bucket without lifecycle rule | No lifecycle configuration | Add one |
| Incomplete multipart upload | Listed by `ListMultipartUploads` | Abort it |

Detection uses resource properties, not labels. Every finding carries its
evidence, a monthly cost, a rule confidence, the fix commands, a risk level
(`caution` or `dangerous`) and a note on what cannot be undone.

### Rule confidence

The confidence on a finding is a fixed property of the rule that raised it,
set by hand from how often that rule is right. It is not a probability
produced by a model.

| Rule | Rule confidence | Why |
|---|---|---|
| Unattached EBS volume | 95% | "Available with no attachments" is a plain fact; the only doubt is whether the data is still wanted |
| gp2 volume in use | 90% | gp3 is cheaper at the same baseline; a few workloads need gp2's burst behaviour |
| Idle Elastic IP | 95% | An unassociated address is billed and serves nothing |
| Stopped instance | 80% | Storage is billed, but instances are often stopped on purpose |
| Idle instance | 60%, 80% or 90% | CPU only. 60% under 6 hours of data, 80% from 6 hours, 90% from 24 hours |
| Orphaned snapshot | 80% | The source volume is gone, but the snapshot may be a deliberate backup |
| Unused AMI | 70% | Auto Scaling launch configurations and other accounts are not visible to the scan |
| Bucket without lifecycle rule | 90% | The configuration is simply absent |
| Incomplete multipart upload | 60%, 80% or 90% | 60% when part sizes are not visible, 80% when sized but under a day old (it may still be running), 90% when sized and older |

### Leaving a resource out

Tag a resource `cloudpilot:ignore` = `true` and no finding is raised for it.
Skipping is never silent: the report and the summary state how many resources
were skipped and list them. Volumes, snapshots, AMIs, instances, Elastic IPs
and buckets can be tagged; an ignored bucket takes its incomplete uploads
with it.

## Run it from source

```sh
npm install
npm run build

node dist/index.js --profile cloudpilot-readonly                      # every enabled region
node dist/index.js scan --profile cloudpilot-readonly --region ap-south-1
node dist/index.js scan --profile cloudpilot-readonly --region ap-south-1 --json
node dist/index.js scan --profile cloudpilot-readonly --html report.html --out report.md
```

`scan` is the default command. Every scan ends with a summary: built from
the findings by default, written by a model with `--explain`. `--html` writes
the report as one self-contained file (no fonts, scripts or images are
fetched) with a print layout. Its two typefaces, Archivo and Courier Prime,
are carried inside the file.

The HTML report asks for one decision instead of one per command. Each fix
has a tick box; the saving of everything ticked and the script that would do
it are always on screen and change as you tick. Fixes that can be undone
start ticked, permanent ones never do, and a finding with two ways to fix it
takes one of them at most. One button copies the script, which is commands
and comments only: CloudPilot still runs nothing.

A resource ID is shortened where it is only a label: the finding line in the
terminal, the `Resource` column of the Markdown table, the heading in HTML
(which keeps the whole ID as the hover title) and the summary `scan`
produces. The cut is at 64 characters, above the longest possible bucket
name, so only an opaque ID such as an S3 upload ID is ever shortened. Fix
commands and the finding data itself always carry the complete ID, so a
command can be copied and run as it stands, and text handed to a model,
including the MCP tool results, keeps whole IDs throughout.

### What changed since last time

A repeat scan should not make you read every finding again. CloudPilot saves
each scan to `.cloudpilot/last-scan.json`, and the next scan from the same
directory compares with it without being asked:

```
10 findings, $151.53 per month of estimated waste
Since the last scan (2026-10-02T09:00:00Z): 2 new ($59.74 a month), 1 resolved ($3.65 a month), 8 unchanged.
```

New findings are marked, and what was resolved is listed. `--only-new` lists
just the new findings, `--compare <file>` compares with a scan saved earlier
by `--json`, and `--no-compare` turns it off. With `--json` every finding is
kept and carries `isNew`, with the counts under `comparison`. A finding is
reported as resolved only where it would have been found again: not in a region
that was not scanned again, and not where a check could not run. Scans of
different accounts are not compared. When a scan covers a region the last one
did not, its findings there count as new, and the line says how many of the
new ones that explains. With no earlier scan, `--only-new` lists every finding
and says so.

The saved scan is the account as it was last seen, so a `--replay` run and a
`--redact-account` run both leave it untouched. A `--record` run saves it like
any other live run but does not compare with it, since a recording has to
replay exactly as it ran and cannot carry a baseline of its own.

To have this done every day without running anything, see the daily report in
[`deploy/`](../../deploy): it runs `scan --only-new --out report.txt` on a
schedule in your own account and emails the file when something is new. An
`--out` name ending in `.txt` gets the terminal report as plain text; any
other name gets Markdown.

### Score it against the waste lab

```sh
node dist/index.js eval --profile cloudpilot-readonly --region ap-south-1 \
  --manifest ../../lab-manifest.json
```

This scans, then compares the findings with the lab's answer key: whether
each planted resource was found, whether the monthly cost is within 1%, and
whether the fix command matches. Findings outside the answer key are listed
as possible false positives. The exit code is 1 on any miss.

### Ask questions (needs a model API key)

```sh
export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY=...
node dist/index.js scan --profile cloudpilot-readonly --region ap-south-1 --explain
node dist/index.js ask --profile cloudpilot-readonly --region ap-south-1 "what should I fix first, and what is the risk?"
```

The key can also go in a `.env` file in the directory the command is run
from. `--explain` adds a short written summary to the scan. `ask` lets the
model look things up in the scan through four read-only tools (findings, raw
inventory, prices, live CPU history) and answer in plain English. The model
explains; it does not compute. Every figure it quotes comes from the scanner,
and it has no tool that can change anything.

Three providers are supported, chosen by whichever credentials are present
or by `--provider`:

| Provider | Needs | Default model |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| `openai` | `OPENAI_API_KEY` | the newest GPT model the key can use |
| `bedrock` | `--bedrock-profile <aws profile>` and `npm install @anthropic-ai/bedrock-sdk` | Claude Haiku 4.5 |

CloudPilot works with no model at all. Without a key, `scan` and `eval`
print every finding, cost and fix command; `scan --explain` says in one line
that explanations are unavailable and shows a templated summary built from
the findings; `ask` stops with a clear message.

One model request is given two minutes and one retry, so a provider that
stops answering cannot leave a finished scan hanging for the ten minutes the
SDKs wait by default. A timeout is reported as one, and `--explain` then
shows the templated summary as it does for any other model failure. Set
`CLOUDPILOT_MODEL_TIMEOUT_MS` to change the limit, in milliseconds.

Model text is checked before it is shown. Every resource ID and dollar
amount in it must already exist in the scan data. If one does not, the text
is discarded, the value that failed is logged, and the templated summary is
shown instead.

The same works for a cluster: `kube --explain` writes the summary, and
`ask --kube` answers a question about the cluster your `kubectl` points at
(`--context <name>` for another). See [Kubernetes](#kubernetes).

```sh
node dist/index.js kube --explain
node dist/index.js ask --kube "which workload wastes the most, and is it safe to shrink?"
```

### Use it from Claude Code, Cursor or any MCP client

`cloudpilot mcp` runs CloudPilot as a Model Context Protocol server over
stdio, so an AI editor or agent can scan your account and look things up as
tools. No model API key is needed: the client's own model does the talking.

```sh
# Claude Code
claude mcp add cloudpilot -- npx -y @meruapps/cloudpilot mcp --profile cloudpilot-readonly
```

For Cursor and other clients, add it to the MCP configuration:

```json
{
  "mcpServers": {
    "cloudpilot": {
      "command": "npx",
      "args": ["-y", "@meruapps/cloudpilot", "mcp", "--profile", "cloudpilot-readonly"]
    }
  }
}
```

From a source checkout, the command is `node` with
`/path/to/packages/cli/dist/index.js mcp` as its arguments.

| Tool | What it returns |
|---|---|
| `scan` | A fresh scan: the summary and every finding with its evidence, monthly cost and fix commands. Takes an optional `region` |
| `list_findings` | The findings of the latest scan |
| `get_inventory` | Everything the scan read for one kind of resource, flagged or not |
| `get_prices` | The unit prices used |
| `get_cpu_history` | Live CloudWatch CPU figures for one instance |
| `scan_cluster` | A scan of a Kubernetes cluster through `kubectl`: what was read and at what prices, the summary, and every finding. Takes an optional `context`, `namespace`, `prometheus` and `lookback_hours` |
| `get_cluster_workloads` | Which cluster, namespaces, Prometheus and lookback the latest cluster scan covered, whatever it could not read, and every workload it read, flagged or not: replicas, and each container's requests, peak use, hours of history, and whether it was killed for running out of memory |

Every tool is marked read-only. The account tools make the same AWS calls
as the list above and nothing else, and the cluster tools only run
`kubectl get --raw`. Cluster costs use the OpenCost default prices here.
The server tells the client's model the same ground rules `ask` uses:
quote figures exactly, and present fix commands as proposals for a person.
Two things differ from `ask`. The tool results (the findings and inventory
of your account) go to whichever model your client uses. And CloudPilot
cannot check what that model then writes, so the output check does not
apply.

`--region`, `--profile`, `--redact-account` and `--replay <dir>` work here
too. With `--replay` every result starts with the `REPLAY MODE` banner, and
the cluster tools are not offered: the server replays an account only.

### Record and replay

`--record <dir>` on `scan` and `ask` runs normally and saves every AWS
response and every model event of that run. `--replay <dir>` repeats the run
from that recording with no network calls and no credentials: the clock is
pinned to the recording time, so ages, CloudWatch windows and results match
exactly. Every replay starts with a `REPLAY MODE` banner naming when and
where it was recorded, so it cannot pass for a live run. A request or a
question the recording does not hold is an error, never a silent fallback to
the network. `--live-llm` replays AWS but calls the model live, and
`--redact-account` shows the account ID as `123456789012` in output and
recordings. Recordings hold no credentials or signatures and `recordings/`
is gitignored. A recording is replayed by the CloudPilot version that made
it: requests are matched exactly, so a different version may not find them. `demo/record.sh` at the repo root records the demo set
(`scan --explain` and two questions) in one go, and `demo/replay.sh` plays it
back.

`kube` and `ask --kube` record and replay the same way, with
`--record <dir>` and `--replay <dir>`. A cluster recording holds every answer
the Kubernetes API gave to the scan's reads (and the cluster's name and API
server address), plus the model's events. A replay starts no `kubectl` at
all: it needs no `kubectl`, no kubeconfig and no network, the clock is
pinned to the recording time, and the first line of output is a banner of the
same kind, naming the cluster instead of the account: `REPLAY MODE: recorded
<time> from cluster <context>, 4 namespaces. No live calls.` A read the
recording does not hold is an error naming it, never a call to the cluster. A
replay does not write `.cloudpilot/last-kube-scan-<context>.json` and does
not compare with it. It reads the context, namespace and Prometheus it was
recorded with, and uses the recorded lookback and prices unless you pass
`--lookback-hours` or the price options again (a lookback the recording did
not use asks Prometheus different questions, so it ends in the missing-read
error). `--live-llm` replays the cluster
and calls the model live, and a recorded `ask --kube` question replays by its
exact words.

An account and a cluster can be recorded into one directory. Each session
has a folder of its own (`scan/`, `ask-<hash>/` for the account; `kube/`,
`kube-ask-<hash>/` for a cluster) and a line in `manifest.json`, so recording
one never touches the other, and `scan --replay`, `kube --replay` and the two
kinds of `ask` each find only their own sessions. Account sessions keep
their `aws.json`; cluster sessions hold `kube.json` instead. A directory
that holds only clusters has no account ID in its manifest.

What a cluster recording leaves out: fields of pods and workloads that a scan
never reads and that can hold a secret (container environment, commands and
arguments, probes, and every label and annotation but `cloudpilot/ignore`,
which includes kubectl's saved copy of the manifest), and any answer that
contains something shaped like a key or a token, which the recording then
simply lacks (the run says how many). It is still a recording of your cluster:
it names its namespaces, workloads, pods, images and volumes. `--redact-account`
is not offered for clusters, and the context name and API server address are
recorded as they are; on EKS the context name holds the AWS account ID.

### Offline and emulator use

```sh
# Prices from a saved table instead of the Price List API
node dist/index.js scan --region ap-south-1 --offline --price-file ../../pricing/ap-south-1.json

# Against the Moto emulator (see emulator/README.md at the repo root)
AWS_ENDPOINT_URL=http://localhost:5050 node dist/index.js scan --region ap-south-1 \
  --offline --price-file ../../pricing/ap-south-1.json
```

`--price-file` on its own is a fallback: live prices are tried first.

## Run it in Docker

The repository has a `Dockerfile`. The image is not published anywhere, so
build it yourself, from the repository root:

```sh
docker build -t cloudpilot .
docker run --rm cloudpilot scan --help
```

The image holds the built command, its production dependencies and `kubectl`
v1.37.1, on Node 22 (Alpine). It runs as a non-root user (uid 1000) and holds
no credentials. It does not hold the AWS CLI. The `kubectl` download is
checked in the build against a SHA-256 written in the `Dockerfile`. Building
needs network and BuildKit (the default in current Docker), for `linux/amd64`
or `linux/arm64`.

The command is PID 1 in the container, where Node does not act on Ctrl-C or
`docker stop` on its own. Add `--init` to stop a long scan straight away:

```sh
docker run --rm --init cloudpilot scan --profile cloudpilot-readonly
```

### Scan an AWS account

Give the container credentials when you run it. From a shared profile on this
machine, mounted read-only:

```sh
docker run --rm -v ~/.aws:/home/node/.aws:ro cloudpilot \
  scan --profile cloudpilot-readonly --region ap-south-1
```

Or from environment variables. Naming a variable without a value passes it
on from your shell, so the secret is not on the command line:

```sh
docker run --rm \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION \
  cloudpilot scan
```

A profile that signs in through a program the image does not have (a
`credential_process`, for one) cannot work inside it. Export short-lived
credentials on the host and pass those instead:

```sh
eval "$(aws configure export-credentials --profile my-profile --format env)"
docker run --rm \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION \
  cloudpilot scan
```

The container user is uid 1000, so on Linux the mounted files must be
readable by it, and a directory mounted at `/work` must be writable by it
(`chown 1000 cloudpilot-out`, or run with `--user "$(id -u):$(id -g)"`).
Otherwise the scan runs and then fails to write the report, and the
baseline a repeat scan compares with is skipped quietly.

Files the command writes (`--html`, `--out`, and `.cloudpilot/last-scan.json`,
which a repeat scan compares with) land in `/work` inside the container and
are gone when it exits. To keep them, mount a directory there:

```sh
mkdir -p cloudpilot-out
docker run --rm -v ~/.aws:/home/node/.aws:ro -v "$PWD/cloudpilot-out:/work" cloudpilot \
  scan --profile cloudpilot-readonly --html /work/report.html
```

### Scan a cluster

`cloudpilot kube` reads through the `kubectl` in the image. Mount your
kubeconfig read-only where `kubectl` looks for it:

```sh
docker run --rm -v ~/.kube/config:/home/node/.kube/config:ro cloudpilot \
  kube --context my-cluster
```

Two things can stop this from working:

- **The API server must be reachable from inside the container.** A
  kubeconfig that points at `127.0.0.1` (kind, minikube, a port-forward)
  points at the container itself.
- **An exec plugin must exist in the image.** A kubeconfig made by
  `aws eks update-kubeconfig` has `aws eks get-token` as its credentials, and
  the image has no `aws`. The same goes for `gke-gcloud-auth-plugin`,
  `kubelogin` and the like. `kubectl` cannot run the plugin, so the scan fails.

What works instead is a kubeconfig that holds a token and calls no program.
With the identity from [`docs/cloudpilot-kube-readonly.yaml`](../../docs/cloudpilot-kube-readonly.yaml)
applied, make a one-hour token on the host, where your plugin works, and
build a kubeconfig from it:

```sh
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
kubectl config view --minify --raw \
  -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > ca.crt
TOKEN=$(kubectl create token cloudpilot -n cloudpilot --duration=1h)

KC=cloudpilot.kubeconfig
kubectl --kubeconfig "$KC" config set-cluster cloudpilot --server "$SERVER" \
  --certificate-authority=ca.crt --embed-certs=true
kubectl --kubeconfig "$KC" config set-credentials cloudpilot --token "$TOKEN"
kubectl --kubeconfig "$KC" config set-context cloudpilot --cluster cloudpilot --user cloudpilot
kubectl --kubeconfig "$KC" config use-context cloudpilot

docker run --rm -v "$PWD/$KC:/home/node/.kube/config:ro" cloudpilot kube
```

The token stops working after an hour; delete `cloudpilot.kubeconfig` and
`ca.crt` when you are done. Or skip the container: `npx @meruapps/cloudpilot
kube` on the host uses your own `kubectl` and its plugins as they are.

### Check the image

`scripts/docker-smoke.sh` builds the image and replays the recorded scan in
`test/fixtures/lab` inside a container with `--network none` and the recording
mounted read-only. It checks that the replay exits 0 and reports the 10
recorded findings, that the container is not root, and that `kubectl` is
present. It needs Docker and is not part of `npm test`.

## Options

These are the options for `scan`, `ask` and `eval`. `kube` adds its own, and
reads `--lookback-hours` with its own meaning and default: see
[Kubernetes](#kubernetes). `ask --kube` takes the `kube` options named there
in place of the AWS ones.

| Option | Meaning |
|---|---|
| `--profile <name>` | AWS profile to read with. Defaults to `AWS_PROFILE`, then the standard credential chain |
| `--region <region>` | Scan only this region |
| `--all-regions` | Scan every region enabled for the account. The default when `--region` is not given |
| `--html <file>` | `scan` only: also write a self-contained HTML report |
| `--out <file>` | `scan` only: also write the report to a file, as Markdown, or as plain text when the name ends in `.txt` |
| `--json` | `scan` only: print the result as JSON |
| `--explain` | `scan` and `kube` only: have a model write the summary |
| `--compare <file>` | `scan` only: say what changed since this earlier scan. Default: the last scan made from this directory |
| `--no-compare` | `scan` only: do not compare |
| `--only-new` | `scan` only: list only the findings that are new since the earlier scan |
| `--lookback-hours <n>` | Hours of CPU history used to judge idleness. Default 24 |
| `--price-file <path>` | Saved price table to fall back on |
| `--offline` | Use only `--price-file` for prices |
| `--provider <name>` | `anthropic`, `openai` or `bedrock`. Default: whichever key is set |
| `--model <id>` | Model for `--explain` and `ask` |
| `--bedrock-profile <name>` | AWS profile for Claude through Amazon Bedrock |
| `--record <dir>` | Run live and save the run for replay. Also for `kube` |
| `--replay <dir>` | Repeat a recorded run with no network calls. Also for `kube` |
| `--live-llm` | With `--replay`: AWS (or the cluster) from the recording, model called live |
| `--redact-account` | Show the account ID as `123456789012`. Not with `--kube` |
| `--kube` | `ask` only: ask about a Kubernetes cluster instead of the account. Takes `--context`, `--namespace`, `--prometheus`, `--lookback-hours` (default 168, not 24) and the price options, and refuses `--region`, `--all-regions`, `--profile`, `--price-file`, `--offline` and `--redact-account` |

The last scan is saved to `.cloudpilot/last-scan.json`, except by `--replay`
and `--redact-account` runs.

## Kubernetes

Kubernetes gives a workload whatever its manifest asks for and never checks
whether it needed it. `cloudpilot kube` checks:

```sh
npx @meruapps/cloudpilot kube
```

It reads the cluster your `kubectl` points at (or `--context <name>`), with
the access you already have, and reports:

| Finding | Evidence | Fix it prints |
|---|---|---|
| A workload requests more CPU or memory than it uses | The request, and the busiest five minutes (CPU) or the highest working set (memory) Prometheus holds for any of its pods, including pods already replaced | One `kubectl set resources` per container, with the old values as the way back. Reversible |
| A volume claim no pod mounts | Bound, with no running or pending pod using it | `kubectl delete persistentvolumeclaim`. Permanent |
| A volume left Released | Its claim was deleted and the volume was kept | `kubectl delete persistentvolume`. Permanent |

The suggested request is the peak plus 15%, never below 10m CPU or 32Mi of
memory. A request is only reported when it is at least twice the suggestion
and the difference is worth a restart (50m CPU, 64Mi memory). A container
that has been killed for running out of memory never has its memory lowered:
a usage graph can miss the moment it ran out, the kill on the pod's record
cannot. Deployments, StatefulSets and DaemonSets are judged; jobs and bare
pods are not, and neither is anything in the namespaces the cluster runs for
itself (`kube-system`, `kube-public`, `kube-node-lease`).

### What it needs

- **`kubectl`**, which also brings whatever sign-in your cluster uses. Every
  read is `kubectl get --raw`, which can only GET. A test fails if the code
  asks kubectl for anything else.
- **Prometheus with the kubelet's container metrics**
  (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`),
  which kube-prometheus-stack and most setups collect. It is found among the
  cluster's services and queried through the API server, so nothing needs
  port-forwarding. Name it with `--prometheus namespace/service:port` if it is
  not found. Without one, volumes are still reported and the report says
  requests were not judged.
- For a dedicated identity with the least access, apply
  [`docs/cloudpilot-kube-readonly.yaml`](../../docs/cloudpilot-kube-readonly.yaml):
  it may list workloads, pods, services and volumes and query one Prometheus
  service. It cannot read Secrets or ConfigMaps, or change anything.

### How much history

Requests are judged over `--lookback-hours` (default 168, a week). If
Prometheus holds less, the finding says how much it had, and rule confidence
drops: 90% with a week, 80% with a day, 60% with an hour, 40% with less. A
container with under five minutes of history is not judged, and a workload
where no container has that much is listed in the report as not judged.

### What a vCPU costs

Costs use the OpenCost project's default prices ($0.031611 per vCPU-hour,
$0.004237 per GiB-hour of memory, $0.04 per GiB-month of storage) unless you
give your own with `--cpu-hour-usd`, `--memory-gib-hour-usd` and
`--storage-gib-month-usd`. The report says which were used. Lowering a
request frees capacity; the money is saved once that lets the cluster run
fewer or smaller nodes, which a node autoscaler does for you.

### The rest works the same

`--json`, `--out`, `--html`, `--compare`, `--no-compare` and `--only-new`
behave as they do for `scan`. The last scan is kept per cluster
(`.cloudpilot/last-kube-scan-<context>.json`; `ask --kube` leaves one too, and
a replay never does), so a repeat scan says what is new without touching the
AWS baseline. Label or annotate a workload or volume
`cloudpilot/ignore=true` to leave it out. `--namespace <name>` reads one
namespace.

The MCP server has cluster tools too (`scan_cluster`, `get_cluster_workloads`:
see above). Not yet for clusters: the daily report.

### Explain, ask, record and replay

`--explain` has a model write the summary, as it does for `scan`. `ask --kube`
scans the cluster, then lets a model answer your question with two read-only
lookups over that scan: the findings, and every Deployment, StatefulSet and
DaemonSet it read, flagged or not (requests, peak use, hours of history, whether
a container was killed for running out of memory). The model never reads the
cluster itself, so a question costs one scan and nothing more. Without a
model key, `kube --explain` shows the templated summary and says why;
`ask --kube` stops before reading anything.

The model is told to name the kubectl context and namespaces rather than an
account and regions, to quote the `cloudpilot/ignore=true` label rather than
the AWS tag, that a lower request saves money only once the cluster can run
fewer or smaller nodes, and how much usage history a finding rests on. It is
given money as the strings the report shows and never a number to compute with.
Telling it so is a request; the check is what holds it to it. Before its text
is shown, these must all be in the scan data (for `ask`, in what the lookups
returned), or the text is discarded and the templated summary shown, with
what failed:

- a dollar amount, including the unit prices the cluster was costed with;
- an object written as `kind/name` or `namespace/kind/name`, for Deployments,
  StatefulSets, DaemonSets, volume claims and volumes (a volume has no
  namespace, so a namespace in front of one fails);
- the namespace or context a command names (`-n`, `--namespace`, `--context`);
- a CPU quantity in millicores (`300m`) or a memory quantity in binary units
  (`512Mi`, `1Gi`), written as the scan writes it, so `1Gi` may not become
  `1024Mi`.

What it deliberately leaves alone, because it would flag ordinary words:
short forms such as `deploy/web`, `pvc/data` and `sts/db`, a plural, a name
with no kind in front of it, URLs, a kind written after a kind
(`deployment/statefulset`), and `-n` on a line that does not run `kubectl`.
It does not check container names, whole CPUs or plain byte counts,
replica counts or percentages, or whether the model's reasoning is sound. A
quantity such as `5m` is read as millicores even where someone meant minutes.
Tests run all of this with a stand-in model, never a real one.

`kube --record <dir>` and `--replay <dir>`, and `ask --kube` with the same two
flags, are described under [Record and replay](#record-and-replay).

The rules are checked against a seeded cluster: see
[`k8s-lab/`](../../k8s-lab).

## Limits

- `--offline` prices come from one region's price file, so an offline scan
  can only price resources in that region.
- Snapshot and AMI costs use the provisioned volume size, which is an upper
  bound: AWS bills snapshots for stored blocks only.
- An AMI used only by an Auto Scaling launch configuration, or shared with
  another account, still looks unused. The finding says so.
- Sizing an incomplete multipart upload needs `s3:ListMultipartUploadParts`.
  Without it the upload is still found, with its cost reported as unknown.
- Idle detection is CPU only. A box that is busy on network or disk with a
  quiet CPU would be flagged.
- Kubernetes: peak use is taken from the history Prometheus holds. A workload
  whose busy season falls outside that window (month-end, a yearly sale) will
  look over-requested; widen `--lookback-hours` or label it
  `cloudpilot/ignore=true`.
- Kubernetes: a past pod is matched to its workload by name, so two workloads
  named alike in one namespace (`api` and `api-v2`) can, rarely, share history.
- Kubernetes: the output check for model text covers dollar amounts, objects
  named as `kind/name`, the namespace and context a command names, and CPU and
  memory quantities. It is a guard against invented values, not proof that
  what a model says about them is right: see
  [Explain, ask, record and replay](#explain-ask-record-and-replay).
- Kubernetes: limits are not changed, and a workload kept in sync by Helm,
  Argo CD or Flux must be changed at its source. The finding says so.

## Development

```sh
npm test            # unit tests and replay tests, no AWS or network needed
npm run test:lab    # records and replays a scan of the live waste lab
npm run test:kube-lab   # scans the Kubernetes lab (a kind cluster on this machine)
npm run typecheck
npm run fonts       # rewrite src/fonts.ts after a file in site/fonts changes
```

`src/mcp.ts` is the MCP server (protocol only, no dependencies);
`src/detect.ts` is a pure function from inventory and prices to findings;
`src/collect.ts` holds every AWS read; `src/advisor.ts` holds the model's
ground rules (one set for an account, one for a cluster) and tools, with
`src/claude.ts` and `src/openai.ts` as providers; `src/output-check.ts` holds
the check on what the model writes; `src/recording.ts` holds record and replay
for both.
The cluster side is the same split: `src/kube.ts` holds every read through
kubectl and Prometheus, `src/kube-detect.ts` the rules over it.
`src/compare.ts` is a pure function from two scans to what changed.

## Licence

Copyright (C) 2026 Meru Apps. CloudPilot is free software under the GNU
Affero General Public License, version 3 (`AGPL-3.0-only`). See `LICENSE`.

The HTML report embeds two typefaces, Archivo and Courier Prime, both under
the SIL Open Font License. Their licence texts are in `licenses/`.
