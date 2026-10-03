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

Every call here is free except the last. `GetCostAndUsage` is made only when
you pass `--bill`, and AWS charges $0.01 for each Cost Explorer request.
CloudPilot never spends your money unasked, so without `--bill` it is never
called.

| Service | Operation | IAM permission | Used for |
|---|---|---|---|
| STS | `GetCallerIdentity` | none needed | The account ID shown in the report |
| EC2 | `DescribeRegions` | `ec2:DescribeRegions` | The regions enabled for the account |
| EC2 | `DescribeVolumes` | `ec2:DescribeVolumes` | Unattached and gp2 volumes |
| EC2 | `DescribeSnapshots` | `ec2:DescribeSnapshots` | Snapshots of deleted volumes |
| EC2 | `DescribeImages` | `ec2:DescribeImages` | Unused AMIs |
| EC2 | `DescribeInstances` | `ec2:DescribeInstances` | Stopped, idle and oversized instances |
| EC2 | `DescribeAddresses` | `ec2:DescribeAddresses` | Idle Elastic IPs |
| EC2 | `DescribeNatGateways` | `ec2:DescribeNatGateways` | Idle NAT gateways |
| EC2 | `DescribeLaunchTemplates` | `ec2:DescribeLaunchTemplates` | Whether an AMI is still referenced |
| EC2 | `DescribeLaunchTemplateVersions` | `ec2:DescribeLaunchTemplateVersions` | Whether an AMI is still referenced |
| RDS | `DescribeDBInstances` | `rds:DescribeDBInstances` | Idle database instances |
| ELBv2 | `DescribeLoadBalancers` | `elasticloadbalancing:DescribeLoadBalancers` | Idle Application and Network load balancers |
| ELBv2 | `DescribeLoadBalancerAttributes` | `elasticloadbalancing:DescribeLoadBalancerAttributes` | Whether deletion protection is on |
| ELBv2 | `DescribeTargetGroups` | `elasticloadbalancing:DescribeTargetGroups` | The target groups of a load balancer |
| ELBv2 | `DescribeTargetHealth` | `elasticloadbalancing:DescribeTargetHealth` | Whether a target group has registered targets |
| ELBv2 | `DescribeTags` | `elasticloadbalancing:DescribeTags` | The `cloudpilot:ignore` tag on a load balancer |
| S3 | `ListBuckets` | `s3:ListAllMyBuckets` | The buckets in each region |
| S3 | `GetBucketLocation` | `s3:GetBucketLocation` | A bucket's region, when the listing omits it |
| S3 | `GetBucketLifecycleConfiguration` | `s3:GetLifecycleConfiguration` | Buckets with no lifecycle rule |
| S3 | `GetBucketTagging` | `s3:GetBucketTagging` | The `cloudpilot:ignore` tag |
| S3 | `ListObjectsV2` | `s3:ListBucket` | Object count and size; object contents are never read |
| S3 | `ListMultipartUploads` | `s3:ListBucketMultipartUploads` | Incomplete uploads |
| S3 | `ListParts` | `s3:ListMultipartUploadParts` | The size of an incomplete upload |
| CloudWatch | `GetMetricData` | `cloudwatch:GetMetricData` | CPU history of running instances, connection history of database instances, traffic of NAT gateways and load balancers |
| Pricing | `GetProducts` | `pricing:GetProducts` | Unit prices for what was found |
| CostExplorer | `GetCostAndUsage` | `ce:GetCostAndUsage` | Last month's total spend, only with `--bill` |

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
| Oversized instance | Not idle, CPU never above 40% over at least 90% of `--lookback-hours`, and the size one step down in the same family exists | Stop it, change the instance type, start it |
| Idle RDS instance | Status `available` and zero database connections over at least 90% of `--lookback-hours` | Delete it with a final snapshot (or stop it) |
| Idle NAT gateway | State `available` and no bytes in or out over at least 90% of `--lookback-hours` | Delete it |
| Idle load balancer | An active Application or Network load balancer with no registered targets in any of its target groups, or with no requests (Application) or flows (Network) over at least 90% of `--lookback-hours` | Delete it |
| Orphaned snapshot | Source volume no longer exists and no AMI uses it | Delete it |
| Unused AMI | No instance and no launch template references it | Deregister it and delete its snapshots |
| Bucket without lifecycle rule | No lifecycle configuration | Add one |
| Incomplete multipart upload | Listed by `ListMultipartUploads` | Abort it |

Detection uses resource properties, not labels. Every finding carries its
evidence, a monthly cost, a rule confidence, the fix commands, a risk level
(`caution` or `dangerous`) and a note on what cannot be undone.

### The bill, for scale

```sh
npx @meruapps/cloudpilot --bill
```

With `--bill`, CloudPilot also reads what the account spent last month and
says what share of it the waste found comes to. One request goes to AWS Cost
Explorer (`ce:GetCostAndUsage`, unblended cost, for the last full calendar
month in UTC, before credits and refunds). **AWS charges $0.01 for each Cost
Explorer request**, and CloudPilot never spends your money unasked, so the flag
is off by default, is on `scan` only, and a scan without it never calls Cost
Explorer. It makes that one request per scan, however many regions are scanned.

Every form of the report (terminal, Markdown, plain text, HTML, JSON and the
summary) then carries two sentences:

```
In September 2026 the account spent $1234.56 (AWS Cost Explorer, unblended cost, before credits and refunds).
The $151.53 a month of waste found is about 12.3% of last month's bill. The waste is an estimate per month at current prices; the bill is last month's actual total.
```

The percentage is worked out by CloudPilot's code, rounded to one decimal, and
is "less than 0.1%" when it rounds to nothing. A model never computes it: with
`--explain` the figure is given to it as text and it may quote it, and the
output check discards text that states any other percentage of the bill. In the
JSON it is `bill.wasteSharePct`, next to `bill.totalUsd` and `bill.month`. When
Cost Explorer still marks the month as an estimate, the first sentence says so.

When the bill cannot be read, the report says so in one plain line, and the
scan is otherwise whole:

```
The bill could not be read: AccessDeniedException - User: ... is not authorized to perform: ce:GetCostAndUsage.
```

That covers a role without the permission, Cost Explorer not enabled for the
account, no data for the month yet (a new account reads nothing to the cent),
a bill in a currency other than dollars, and any other error. No figure and no
share are shown then. The comparison is rough on purpose: the waste is an
estimate at today's prices and the bill is last month's actual total, so a
resource that only appeared this month, or a bill with a large one-off charge,
moves it. The daily report does not pass `--bill`.

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
| Oversized instance | 40% or 50% | CPU only: memory is invisible without the CloudWatch agent, so it is never checked. 40% under 24 hours of data, 50% from 24 hours |
| Idle RDS instance | 50%, 70% or 85% | Connections only. 50% under 24 hours of data, 70% from 24 hours, 85% from 7 days. A job that connects once a month is not in the window |
| Idle NAT gateway | 50%, 70% or 85% | Traffic only. 50% under 24 hours of data, 70% from 24 hours, 85% from 7 days. A route used only when another path fails carries nothing until then |
| Idle load balancer | 50%, 70% or 85% | The same ladder, by the hours of no traffic, or by how long the balancer has existed when its targets alone were the reason. At most 50% when its traffic could not be read, or covered less than 90% of the window. A balancer that serves a yearly event is quiet the rest of the year |
| Orphaned snapshot | 80% | The source volume is gone, but the snapshot may be a deliberate backup |
| Unused AMI | 70% | Auto Scaling launch configurations and other accounts are not visible to the scan |
| Bucket without lifecycle rule | 90% | The configuration is simply absent |
| Incomplete multipart upload | 60%, 80% or 90% | 60% when part sizes are not visible, 80% when sized but under a day old (it may still be running), 90% when sized and older |

### Leaving a resource out

Tag a resource `cloudpilot:ignore` = `true` and no finding is raised for it.
Skipping is never silent: the report and the summary state how many resources
were skipped and list them. Volumes, snapshots, AMIs, instances, DB instances,
Elastic IPs, NAT gateways, load balancers and buckets can be tagged; an ignored
bucket takes its incomplete uploads with it. A load balancer whose tags cannot be
read (`elasticloadbalancing:DescribeTags` is missing) is not judged at all, so
the ignore tag is never overridden by a permission gap.

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

Model text is checked before it is shown. Every resource ID and dollar
amount in it must already exist in the scan data. If one does not, the text
is discarded, the value that failed is logged, and the templated summary is
shown instead.

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
as the list above and nothing else, except the one paid call: there is no
`--bill` here, so no tool ever reads Cost Explorer. The cluster tools only run
`kubectl get --raw`. Cluster costs use the OpenCost default prices here.
The server tells the client's model the same ground rules `ask` uses:
quote figures exactly, and present fix commands as proposals for a person.
Two things differ from `ask`. The tool results (the findings and inventory
of your account) go to whichever model your client uses. And CloudPilot
cannot check what that model then writes, so the output check does not
apply.

`--region`, `--profile`, `--redact-account` and `--replay <dir>` work here
too. With `--replay` every result starts with the `REPLAY MODE` banner, and
the cluster tools are not offered: a recording holds an account only.

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
[Kubernetes](#kubernetes).

| Option | Meaning |
|---|---|
| `--profile <name>` | AWS profile to read with. Defaults to `AWS_PROFILE`, then the standard credential chain |
| `--region <region>` | Scan only this region |
| `--all-regions` | Scan every region enabled for the account. The default when `--region` is not given |
| `--html <file>` | `scan` only: also write a self-contained HTML report |
| `--out <file>` | `scan` only: also write the report to a file, as Markdown, or as plain text when the name ends in `.txt` |
| `--json` | `scan` only: print the result as JSON |
| `--explain` | `scan` only: have a model write the summary |
| `--compare <file>` | `scan` only: say what changed since this earlier scan. Default: the last scan made from this directory |
| `--no-compare` | `scan` only: do not compare |
| `--only-new` | `scan` only: list only the findings that are new since the earlier scan |
| `--bill` | `scan` only: also read last month's total spend from Cost Explorer and say what share of it the waste is. AWS charges $0.01 for this one request, so it is never made unless you ask |
| `--lookback-hours <n>` | Hours of CPU, database connection and NAT gateway and load balancer traffic history used to judge idle and oversized resources. Default 24 |
| `--price-file <path>` | Saved price table to fall back on |
| `--offline` | Use only `--price-file` for prices |
| `--provider <name>` | `anthropic`, `openai` or `bedrock`. Default: whichever key is set |
| `--model <id>` | Model for `--explain` and `ask` |
| `--bedrock-profile <name>` | AWS profile for Claude through Amazon Bedrock |
| `--record <dir>` | Run live and save the run for replay |
| `--replay <dir>` | Repeat a recorded run with no network calls |
| `--live-llm` | With `--replay`: AWS from the recording, model called live |
| `--redact-account` | Show the account ID as `123456789012` |

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
(`.cloudpilot/last-kube-scan-<context>.json`), so a repeat scan says what is
new without touching the AWS baseline. Label or annotate a workload or volume
`cloudpilot/ignore=true` to leave it out. `--namespace <name>` reads one
namespace.

The MCP server has cluster tools too (`scan_cluster`, `get_cluster_workloads`:
see above). Not yet for clusters: `ask`, `--explain`, record and replay, and
the daily report.

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
- Oversized instances are judged on CPU only, because memory is not visible
  without the CloudWatch agent. The finding says memory was not checked, and
  its rule confidence is 50% at most. The 40% limit is on the highest reading
  CloudWatch holds, a five-minute average unless detailed monitoring is on, so
  a shorter burst is not seen. It leaves room because half the vCPUs doubles
  the load on each, so a 40% peak becomes about 80%. A busy season outside
  `--lookback-hours` is not seen either.
- Oversized instances are reported only for On-Demand Linux instances on shared
  hardware with an EBS root volume, and never for the burstable families
  (t1, t2, t3, t3a, t4g), where CPU credits make a low peak mean little. The
  step down is the size AWS names by halving (for example xlarge to large),
  and it is reported only when the Price List has it in the region with exactly
  half the vCPUs and half the memory. Odd sizes such as 3xlarge, the smallest
  size of a family, and anything the Price List does not hold are not reported.
  With `--offline` the price file carries no instance sizes, so no instance is
  reported oversized.
- Resizing needs the instance stopped, so it means downtime, and an instance
  store is erased when it stops. The saving is the compute price difference;
  an instance behind an Auto Scaling group or a stack must be changed at its
  launch template or template.
- Idle RDS instances are judged only for MySQL, PostgreSQL and MariaDB on
  gp2, gp3 or magnetic storage, the cases whose price is a plain hourly rate
  and a plain per-GB rate. Oracle, SQL Server, Db2, and instances on
  provisioned IOPS storage are not judged. Aurora and other cluster members,
  read replicas, instances that have read replicas, and instances in any status
  but `available` are never judged either. So is an instance with less than 90% of
  the window in CloudWatch, such as one created after the window began. An
  instance whose price the Price List does not return is left out rather than
  reported with part of its bill missing. With `--offline` no database is
  priced, so none is reported.
- An idle RDS instance's cost is its hourly price over 730 hours plus its
  allocated storage. Backup storage beyond the free allocation, a final
  snapshot, and IOPS or throughput above the gp3 baseline are not included.
  The stop alternative saves the compute part only, and AWS starts a stopped
  instance again after 7 days.
- Zero connections is zero over the window, not proof that nothing needs the
  database. Deletion protection, if on, is stated in the evidence, and RDS will
  refuse the delete until it is turned off.
- Idle NAT gateways are judged only when `available`, with a subnet. A regional
  NAT gateway (it has no subnet) is billed differently and is never judged.
  The cost is the hourly price over 730 hours. Data-processing charges are not
  included (with no traffic there are none), nor is the gateway's Elastic IP,
  which is billed on its own and is reported separately once the gateway is
  gone. No bytes in either direction is no traffic in the window, not proof
  that nothing routes to the gateway: a route used only in an outage is
  invisible. Deleting it leaves any route that points at it black-holing until
  the route is changed. A gateway with less than 90% of the window in
  CloudWatch is not judged, and neither is one CloudWatch holds no datapoints
  for: only a reading of zero counts as no traffic. (This relies on an idle
  gateway still publishing zeros. It has not been seen on a live idle gateway,
  because the lab has none.)
- Idle load balancers are judged for Application and Network load balancers
  only. Gateway load balancers are skipped, and so are Classic load balancers,
  which are a different API (`elasticloadbalancing` version 1) that CloudPilot
  does not read. A balancer is idle when none of its target groups has a
  registered target (in any state), or when it took no requests (Application,
  `RequestCount`) or flows (Network, `NewFlowCount` and `ActiveFlowCount`) over
  at least 90% of the window. Any recorded traffic clears it, because a balancer
  with no targets can still answer with a redirect or a fixed response. A
  balancer with no target group at all is not judged on targets, for the same
  reason. It must also be as old as 90% of the window, so one still being set
  up is not judged on its targets. CloudWatch publishes these two metrics only
  while traffic flows, so a balancer with no datapoints at all counts as having
  had no traffic for as long as it has existed within the window; the evidence
  says so. If CloudWatch cannot be read, or holds less than 90% of the window,
  only the empty target groups speak, the evidence says which of the two it was,
  and the confidence stays at 50%.
- The cost of an idle load balancer is its hourly price over 730 hours.
  Load balancer capacity unit (LCU) charges are not included. Deletion
  protection is read (`DescribeLoadBalancerAttributes`) and stated in the
  evidence: AWS refuses the delete until it is turned off. Deleting a load
  balancer is permanent, its DNS name is gone for good, and its target groups
  are left behind. With `--offline` no NAT gateway or load balancer is priced,
  so none is reported.
- The idle RDS, oversized instance, idle NAT gateway and idle load balancer
  rules are tested on hand-built inventories, and the last two also on a local
  Moto emulator with synthetic metrics. None of the four has been scored
  against a live seeded lab: the waste lab holds no RDS instance, no oversized
  instance, no NAT gateway and no load balancer.
- `--bill` compares an estimate with an actual total, and rounds to one
  decimal. The bill is the unblended cost before credits and refunds, as Cost
  Explorer reports it for the last full calendar month in UTC. A new account,
  or one Cost Explorer was only just enabled for, has none yet.
- Kubernetes: peak use is taken from the history Prometheus holds. A workload
  whose busy season falls outside that window (month-end, a yearly sale) will
  look over-requested; widen `--lookback-hours` or label it
  `cloudpilot/ignore=true`.
- Kubernetes: a past pod is matched to its workload by name, so two workloads
  named alike in one namespace (`api` and `api-v2`) can, rarely, share history.
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
ground rules and tools, with `src/claude.ts` and `src/openai.ts` as providers.
The cluster side is the same split: `src/kube.ts` holds every read through
kubectl and Prometheus, `src/kube-detect.ts` the rules over it.
`src/compare.ts` is a pure function from two scans to what changed.

## Licence

Copyright (C) 2026 Meru Apps. CloudPilot is free software under the GNU
Affero General Public License, version 3 (`AGPL-3.0-only`). See `LICENSE`.

The HTML report embeds two typefaces, Archivo and Courier Prime, both under
the SIL Open Font License. Their licence texts are in `licenses/`.
