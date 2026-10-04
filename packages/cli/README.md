# CloudPilot

A command-line agent that finds wasted AWS spend, prices it from the AWS Price
List, and prints the exact commands that would fix it. A scan changes nothing.
`apply` is the only command that can change anything, and only what you name
and approve. `watch --autopilot` is the one other thing that can: it is off
unless you turn it on, it acts only for the rules you name, and only for fixes
that can be undone.

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

A scan only reads. These are all the operations it calls, and a test
fails the build if the code calls anything that is not on this list or that
is not a `Describe`, `List` or `Get`.

Every call here is free except the last. `GetCostAndUsage` is made only when
you pass `--bill` or run `anomalies`, and AWS charges $0.01 for each Cost Explorer
request. CloudPilot never spends your money unasked, so a scan without
`--bill` never calls it, and nothing else does.

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
| CostExplorer | `GetCostAndUsage` | `ce:GetCostAndUsage` | Last month's total spend, only with `--bill`; the last days' cost per service, only with `anomalies` |

CloudShell's credentials are your console permissions, which usually allow
far more than this. To hold CloudPilot to exactly these reads, run it with a
role that has only the policy in `docs/cloudpilot-readonly-policy.json`
(`--profile <read-only profile>`). Any operation the role may not call is
reported as a skipped check instead of ending the scan.

With `--explain` or `ask`, the findings are also sent to the model provider
whose API key you set. Without those, nothing leaves AWS and your terminal.

### Check first with `init`

```sh
npx @meruapps/cloudpilot init
```

`init` says whether a scan will work from where you are, so you do not find
out halfway through one. It reports:

- **Who your AWS credentials are**: account and ARN, or that none were found
  and how to supply them (CloudShell, `--profile`, environment variables).
- **Which reads are allowed**: for every read in the table above that AWS does
  not charge for, the cheapest real call of it in one region (`--region`,
  otherwise where a scan starts: `AWS_REGION`, `AWS_DEFAULT_REGION`, then
  `us-east-1`). Each read is reported as allowed, denied, failed or not tested,
  and nothing stops at the first denial. A read AWS refused is denied; a read
  that errored or did not answer in time is failed, which is not a refusal and
  asks nothing of IAM. A read that needs something to try on (a bucket, a
  launch template, an incomplete multipart upload, a load balancer, a target
  group) is tried on the first one found in that region, and reported as not
  tested when there is none. The one charged read, `CostExplorer
  GetCostAndUsage`, is never made - checking that a scan will work must cost
  nothing - and is reported as not tested with that reason; only `scan --bill`
  and `anomalies` make it.
- **The cluster**, when `kubectl` is on the PATH and has a current context (or
  `--context`): whether each list the cluster scan makes is allowed (a
  `kubectl get --raw` with `limit=1`), whether a Prometheus is found (or named
  with `--prometheus`) and answers a query, and how many hours of container
  history it holds, looking back at most a week. Run inside a cluster, where
  there is no kubeconfig, it checks the same things through the pod's service
  account once the cluster is named with `--cluster-name` (see [Read a cluster
  from inside it](#read-a-cluster-from-inside-it)), and the `kube` command it
  prints next carries that name. Without `kubectl`, without a context, or
  inside a cluster with no name for it, the cluster is skipped in one line that
  says why.
- **What to run next**: the `scan` and `kube` commands that will work.

`init` creates and changes nothing. Where a read was refused it prints what to
apply and leaves it to you: for AWS, the commands that write the read-only
policy to a file (`cloudpilot init --print-policy`), create it and attach it
to the credentials' user or role, marked as commands for you to run; for a
cluster, a pointer to `docs/cloudpilot-kube-readonly.yaml` in the repository
or to `--prometheus`. A read that only failed asks for none of that: no policy
commands are printed for it, and a cluster list that did not answer says to
check that the cluster can be reached from here and to run `init` again.
The AWS policy is carried in the package, so
`--print-policy` works wherever CloudPilot was installed; it is the same
document as `docs/cloudpilot-readonly-policy.json`, and a test fails if the
two differ.

Every AWS read it makes is one in the table above, and a test fails if it makes
one that is not, or one that the policy does not allow. Its `kubectl` calls are
`get --raw` and `config view --minify`, and a test fails if they are anything
else. The Prometheus queries go through the same service proxy a scan uses.

`--json` prints the result as JSON. The exit code is 0 when at least one of AWS
and Kubernetes can be scanned (AWS: the credentials work and at least one read
is allowed; Kubernetes: namespaces and pods can be listed), and 1 when neither
can. A denied or failed read does not change it: a scan runs and reports that
read as a skipped check.

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
| Incomplete multipart upload | Listed by `ListMultipartUploads` | Abort it (permanent: the parts already uploaded are discarded for good) |

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

### Spend anomalies

```sh
npx @meruapps/cloudpilot anomalies
```

`anomalies` says which services cost unusually much on the latest complete
day, compared with that service's own days before it. It does not look for
waste and it reads no resources: it reads the account's daily cost per service
from AWS Cost Explorer (`ce:GetCostAndUsage`, unblended cost, before credits,
refunds and tax) and applies a fixed rule. **AWS charges $0.01 for each Cost
Explorer request.** The command makes one request (more only if AWS splits
the answer into pages, at most 10, after which it stops rather than be
charged for more; it says how many it made), CloudPilot never spends your
money unasked, and so the first line of its output, and its `--help`, say so
before anything is read. No model is involved: the same days always give the
same answer, and there is no `--explain`.

```
Cost Explorer: AWS charges $0.01 for each request, and this makes one (more only if AWS splits the answer into pages).

Spend anomalies for AWS account 123456789012
Unblended cost per service over the last 30 days, before credits, refunds and tax.
Judged: 2026-10-02, the latest complete day, against the 29 days before it (2026-09-03 to 2026-10-01).
Today (2026-10-03) is still in progress and is not used. Cost Explorer can take a day or two to settle, so the figures for the last day or two may still change. AWS still marks 2026-10-02 as an estimate.

2 services cost more than usual on 2026-10-02:

  1. Amazon Elastic Compute Cloud - Compute
     2026-10-02    $45.20
     usual day     $12.30  (median of the 29 days before)
     difference    +$32.90 a day; if this continues, about +$987.00 over 30 days
     same weekday  previous Fridays: at most $12.30 (4 days)

  2. Amazon Bedrock
     2026-10-02    $8.00
     usual day     $0.00  (no cost at all in the 29 days before: new spend)
     difference    +$8.00 a day; if this continues, about +$240.00 over 30 days

Total: +$40.90 a day more than usual across 2 services. If all of it continued, that would add up to about $1227.00 over 30 days.
The rule says a day was unusual, not why. The 30-day figure is arithmetic on one day, not a forecast.

Not flagged: its day was high against the usual day, but no higher than earlier days on the same weekday:
  Nightly export: $40.00 on 2026-10-02; previous Fridays: at most $40.00 (4 days)

Cost Explorer requests made: 1 (AWS charges $0.01 each).
```

**The rule.** For each service, the latest complete day is compared with the
days before it in the window. Every figure is in whole cents.

- The usual day is the median of the earlier days, and the spread is their
  median absolute deviation (MAD). Both barely move for a few odd days, which
  is why they are used and not a mean and a standard deviation.
- A service is flagged when **all three** hold. The latest day is above the
  median plus `k` times 1.4826 times the MAD (`k` is `--sensitivity`, default
  3; the 1.4826 makes the MAD read like a standard deviation). It is at least
  `--min-increase` above the median (default $1.00 a day), so pennies never
  raise an alarm, however large the rise looks next to a tiny usual cost. And
  it is unusual for its own weekday, below.
- When the MAD is 0 (a flat baseline) there is no spread to measure against,
  so the day must be at least the floor above the median **and** at least 50%
  above it.
- **The weekday check.** Take the earlier days that fall on the same weekday
  as the latest day (UTC). If there are at least 2, the latest day must be
  **above the largest of them by at least `--min-increase`** (the same floor,
  default $1.00; a day that only equals the largest is never above it). A
  service whose busy day comes round every week, a Saturday job, is therefore
  not flagged each Saturday, while a Saturday far above the earlier Saturdays,
  or a spike on any ordinary weekday, still is. With fewer than 2 earlier days
  on that weekday (a short window, or days Cost Explorer had nothing for) the
  check does not apply, the service is flagged on the first two tests alone,
  and the output says the weekday could not be checked. A full window of 15
  days or more has at least 2 of every weekday. `--no-weekday-check` switches
  the check off. For each anomaly the output shows the comparison, for example
  `previous Fridays: at most $13.10 (4 days)`, and a service the check held
  back is listed under the anomalies, with its day and that comparison, so
  that it is never hidden silently.
- A service with no cost at all in the earlier days that now costs at least
  the floor is flagged as new spend. The weekday check does not apply to it.
- A service missing from a day Cost Explorer returned counts as $0 that day. A
  day Cost Explorer returned nothing for at all is not a day.
- At least 7 earlier days are needed. With fewer, the output says there is not
  enough history, nothing is flagged, and the exit status is 0. So does a
  window with no cost data at all (a new account, or Cost Explorer only just
  enabled). A cost of exactly the floor, or exactly 50% above the median, is
  flagged.
- Anomalies are listed with the largest daily increase first. For each: the
  service, the day and what it cost, the usual day, the increase a day, and
  what that adds up to over 30 days **if** every day cost as much as this one.
  That sum is arithmetic on one day, worded as a condition and never as a
  forecast. A total line adds them up. With nothing unusual it prints one calm
  line saying so. The exit status is 0 either way; a failure to read Cost
  Explorer is 1.

**The days.** `--days <n>` (8 to 90, default 30) is how many complete days are
read: the latest one is judged and the rest are its baseline. The day in
progress is never asked for and never used, because a partial day always looks
cheap. The days before it can still be settling: Cost Explorer can take a day
or two to finalise its figures, so a figure for the latest day may be a little
low and can still change. The output says so every time, and says when AWS
marks the latest day as an estimate. Run it a day later and the same day may
read differently. If Cost Explorer has no data for yesterday yet, the latest
day it does have is judged and the output says that nothing later was there.
Credits, refunds and tax are left out of the request, so a credit running out
or the month's tax landing on the first does not read as a service costing
more. Cost Explorer's dates are UTC.

**What it cannot see.** The weekday check knows what a week looks like and
nothing longer.

- A service that costs less at weekends is fine: the weekdays are most of the
  days, so the median is the weekday cost, and an ordinary weekday, or a quiet
  weekend, is not flagged.
- A service whose busy days are the *few* days, a weekly report or a job that
  runs on Saturdays, looks like a spike against the quiet median. The weekday
  check removes that alarm: the day is only flagged if it is also above the
  earlier days on the same weekday. What is left of it:
  - A weekly job that started only one run ago. The one earlier run is the
    largest same-weekday day, so the second run is not flagged. (When the job
    has no earlier run in the window at all, the day is new spend or a spike on
    zeros, and is flagged as before.)
  - The largest earlier same-weekday day sets the bar. One earlier Saturday that
    was itself a spike hides later, smaller ones until it leaves the window.
  - A job whose Saturday cost drifts by a little can set a new high by a dollar
    or two and be flagged. `--min-increase` raises the margin for that, since
    the weekday check uses the same floor.
  - A pattern longer than a week, such as a monthly job, is not seen: it looks
    like a spike every month, as before.
- A change that lasts is flagged for as long as it takes to become the usual
  day, which is half the window, and then no more. A daily run therefore
  repeats a sustained rise for a while.
- A cost that arrives on one day of the month (a support or subscription fee,
  an upfront reservation payment) can look like a spike on that day. The
  weekday check does not help: the same weekday of earlier weeks cost nothing.
- It judges one day. It does not say what caused it, whether it is a mistake,
  or what next month's bill will be.
- It reads what Cost Explorer shows the credentials. Called from an AWS
  Organization's management account that is the consolidated cost of every
  member account together, with no split by account; from a member account it
  is that account alone. Run it where you mean to look.

**Options.** `--days <n>`, `--sensitivity <k>` (above zero), `--min-increase
<dollars>` (zero or more), `--no-weekday-check`, `--json`, `--profile`, `--redact-account`,
`--notify`, `--record` and `--replay`; see [Options](#options). A value that
makes no sense is refused before anything is asked of AWS.

**JSON.** `--json` prints one JSON document on stdout, and the charge notice
on stderr. New fields may be added; none will be renamed or removed. Amounts
are dollars to the cent, days are `YYYY-MM-DD` in UTC.

```json
{
  "command": "anomalies",
  "accountId": "123456789012",
  "charge": { "requests": 1, "usdPerRequest": 0.01, "notice": "Cost Explorer: AWS charges $0.01 for each request, and this makes one (more only if AWS splits the answer into pages)." },
  "status": "ok",
  "today": "2026-10-03",
  "windowDays": 30,
  "latestDay": "2026-10-02",
  "latestDayEstimated": true,
  "baseline": { "days": 29, "from": "2026-09-03", "to": "2026-10-01" },
  "baselineDaysFound": 29,
  "servicesChecked": 4,
  "rule": { "sensitivity": 3, "minIncreaseUsd": 1, "weekdayCheck": true, "madScale": 1.4826, "flatRise": 0.5, "minBaselineDays": 7, "minSameWeekdayDays": 2, "projectionDays": 30 },
  "anomalies": [
    { "service": "Amazon Elastic Compute Cloud - Compute", "kind": "spike", "day": "2026-10-02", "costUsd": 45.2, "medianUsd": 12.3, "madUsd": 0, "increaseUsd": 32.9, "monthlyIfContinuesUsd": 987, "baselineDays": 29, "sameWeekday": { "weekday": "Friday", "days": 4, "checked": true, "maxUsd": 12.3 } }
  ],
  "weekdayCleared": [
    { "service": "Nightly export", "day": "2026-10-02", "costUsd": 40, "medianUsd": 5, "sameWeekday": { "weekday": "Friday", "days": 4, "checked": true, "maxUsd": 40 } }
  ],
  "totalIncreaseUsd": 32.9,
  "totalMonthlyIfContinuesUsd": 987,
  "note": "Cost Explorer can take a day or two to settle, so the figures for the last day or two may still change."
}
```

`status` is `ok`, `not-enough-history` or `no-data`; with the last two,
`anomalies` is empty. `kind` is `spike` or `new`. `sameWeekday` is the weekday
check for that anomaly: the weekday, how many earlier days fell on it, whether
it was `checked` (at least `minSameWeekdayDays`) and the largest of those days
in `maxUsd`, which is `null` when it was not checked. It is `null` for new
spend, and when `--no-weekday-check` is given (then `rule.weekdayCheck` is
`false`). `weekdayCleared` lists the services that were high against the usual
day but not against their own weekday, so were not flagged; it is empty
otherwise. `baseline` is `null` unless
`status` is `ok`, and `latestDay` is `null` with `no-data`. A replay adds a
`replay` field holding the banner, and its `charge.requests` is 0.

**Without a Cost Explorer request.** `--record <dir>` runs live and saves the
answers, and `--replay <dir>` repeats the run from them with no network, no
credentials and no charge, behind the usual `REPLAY MODE` banner, followed by a
line saying no request is made. The recording notes the `--days` it was made
with and a replay uses them, so the clock and the request match; asking for
another window is a missing read, never a call to AWS. See
[Record and replay](#record-and-replay). A scan recording and an anomalies
recording can share a directory.

**Telling your team.** `--notify <url>` sends one message when at least one
service cost more than usual: the services, their costs, the usual day and the
rise, and the 30-day sum as a condition. It sends nothing when nothing is
unusual or when there was not enough history, and says which on stderr. Unlike
`scan --notify` it keeps no memory between runs: a rise that lasts is
reported on every run while the latest day is still unusual. A run that could
not read Cost Explorer sends a message saying the check failed, so silence only
ever means nothing was unusual. See
[Tell your team what is new](#tell-your-team-what-is-new).

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

The default bar for `watch --autopilot` is 0.9, and only the gp2 and lifecycle
rows reach it among the rules autopilot can run. See
[Let watch run the fixes that can be undone](#let-watch-run-the-fixes-that-can-be-undone-autopilot).

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
has a tick box (a finding CloudPilot prints no command for has none, which
happens only in a cluster scan: see [Kubernetes](#kubernetes)); the saving of
everything ticked and the script that would do it are always on screen and
change as you tick. Fixes that can be undone
start ticked, permanent ones never do, and a finding with two ways to fix it
takes one of them at most. One button copies the script, which is commands
and comments only: the report runs nothing.

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

### Tell your team what is new

A scan is only useful if someone reads it. `--notify` sends what is new to
where your team already looks, and says nothing on a day when nothing is:

```sh
npx @meruapps/cloudpilot scan --notify https://hooks.slack.com/services/...
npx @meruapps/cloudpilot kube --notify https://discord.com/api/webhooks/...

# or keep the URLs out of the command line, comma-separated
export CLOUDPILOT_NOTIFY=https://hooks.slack.com/services/...,https://example.com/hooks/cloudpilot
```

| URL | What it is sent |
|---|---|
| `hooks.slack.com` | A Slack incoming webhook: one text message |
| `discord.com/api/webhooks/...` or `discordapp.com/api/webhooks/...` | A Discord webhook: one message, with mentions switched off so a resource name cannot ping anyone |
| Any other `https` URL | A generic webhook: JSON with the new findings, the comparison and a short text (see below) |

`--notify` can be given more than once, and takes the place of
`CLOUDPILOT_NOTIFY` when it is. The variable can also be set in a `.env` file.
Anything but `https` is refused, except `http` to `127.0.0.1` or `localhost`,
which is for trying a webhook on your own machine.

**When it sends.** `scan` and `kube` compare with the previous scan as they
always do, and send only when that comparison finds something new. The first
scan, with nothing to compare with, sends the whole report once. A scan with
nothing new sends nothing, and says so on stderr. Findings that were resolved
are shown in the report but are not a reason to send. `--notify` needs the
comparison, so it cannot be used with `--no-compare`, nor with `kube
--answer-key`, which scores a lab instead of reporting.

**What it says.** The same lines in every service, for example:

```
CloudPilot: 2 new findings, $18.03 a month, AWS account 123456789012
Since the last scan (2026-10-02T00:00:00Z): 2 new ($18.03 a month), 1 resolved ($18.24 a month), 1 unchanged.

1. $9.12/mo  Unattached 500 GB gp2 volume (vol-0dddddddddddddddd), region ap-south-1, permanent fix
2. $8.91/mo  Idle t3.micro: CPU never above 3.4% (i-0cccccccccccccccc), region ap-south-1, reversible fix

Nothing has been changed: every fix is a proposal for a person to review and run.
Run cloudpilot to see each finding's evidence and fix commands.
```

Each new finding gets its title, its ID, where it is (region, or namespace for
a cluster), its monthly cost as the scan worked it out, and whether the fix
is permanent. Fix commands are not in the chat message of a scan: they are in
the report. (With `watch --autopilot`, a round that ran, held back or refused a
fix sends a message of its own, which does carry the way back for each fix, and
that is often a command. See [What you are told](#let-watch-run-the-fixes-that-can-be-undone-autopilot).) A message is cut to 2,000 characters for Discord, the most it takes,
and to 3,000 for Slack; the list gives way, the headline and the closing lines
do not, and the message says how many findings were left out. A generic
webhook has no such limit. It receives one JSON object: `source`
(`cloudpilot`), `event` (`first-report`, `new-findings`, `check-failed`,
`check-recovered`, `autopilot` or, from `anomalies`, `spend-anomalies`), `text`
(the message above as plain lines) and `subject`.
A report adds `scannedAt`, `totalMonthlyWasteUsd`, `comparison`, `warnings`
and `findings`, which holds the new findings exactly as `--json` has them,
evidence and fix commands included; a failure or a recovery adds `at` and
either the `error` or the `failingSince` it had been failing from.

An `autopilot` event comes only from `watch --autopilot`, once for each round
that ran, failed, held back or refused a fix, or that could not use the audit
log. It adds `at`, `dryRun` (true when nothing was run), `rules`, `lines` and,
when the round could not run anything or the audit log could not take a record,
`problem`. Each of `lines` has `outcome` (`applied`, `failed`, `held-back`,
`refused` or `would-run`), `title`, `resourceIds`, `region`, `monthlyCostUsd`,
the `commands` that were or would be run, `wayBack`, and where they apply
`reason`, `halfDone`, `notStarted` (a failed fix that never started, so changed
nothing) and `exitCode`. So unlike every other event, it carries fix commands,
and its `reason` and `problem` can hold error text from the machine that runs
the watch. The Slack and Discord text of it has the way back for each fix and
the reason for each one held back or not run, not the command list.

`anomalies --notify` sends the same way, one message when a service cost more
than usual (see [Spend anomalies](#spend-anomalies)). Its generic body is
`source`, `event` (`spend-anomalies`), `text`, `subject`, `day`,
`totalIncreaseUsd`, `totalMonthlyIfContinuesUsd` and `anomalies`, as `--json`
has them, and `rule` with one field, `weekdayCheck` (`false` when the run
used `--no-weekday-check`). It has no earlier scan to compare with, so none of the rules above
about the saved scan apply to it.

**A message that fails to send is not lost.** CloudPilot says so on stderr and
exits with status 1, and the saved scan is left as it was, so the next run
reports the same findings again. With several URLs, the one that failed is
not the reason the others are skipped.

**A check that fails is a message of its own**, so that silence only ever
means nothing is new. If the scan cannot run (credentials expired, cluster
unreachable) and `--notify` is set, the webhook is told that the check itself
failed, with the reason, and the command still exits with status 1.

**Privacy.** `--notify` sends finding titles, resource IDs and costs to the
service you name, with the account ID or cluster name, and a generic webhook
also gets each finding's evidence and fix commands. When a check fails, the
error it gave is sent too. With `watch --autopilot`, each round's message
adds what autopilot ran or would run: the titles and IDs, the way back for each
fix and the reason for each one held back or refused, and a generic webhook also
gets the commands themselves. Nothing else is sent, and nothing is sent anywhere
you did not name: each message is one HTTPS request to your URL, and a redirect is
treated as a failure instead of being followed. A webhook URL is a secret,
since anyone who has it can post to that channel. CloudPilot never prints it,
and never writes it to a saved scan, a report or a recording; where it must
name a target it shows the host. Two things are outside its control: a URL
given with `--notify` is visible in the process list of the machine, so use
`CLOUDPILOT_NOTIFY` on a shared one, and the service you name sees what it is
sent. `--redact-account` hides the account ID in messages too.

With `--replay`, `--notify` still sends its message, since that is what was
asked for. The `REPLAY MODE` banner says so, and leads the message, so it
cannot pass for a live one. A replay has no saved scan to compare with, so it
sends the whole report each time unless it is given `--compare <file>`.

### Watch it

`cloudpilot watch` runs the scan again and again and speaks up only when
something changes:

```sh
npx @meruapps/cloudpilot watch --every 6h --notify https://hooks.slack.com/services/...
npx @meruapps/cloudpilot watch --kube --every 1h --notify https://discord.com/api/webhooks/...
```

It is a foreground process on purpose: it does not detach, so run it where
something keeps it running, such as systemd, tmux or a container. Each round
runs the same scan as `scan` (or `kube` with `--kube`) and then waits `--every`
before the next one, so rounds never overlap.

- **Nothing new:** one line is printed, and nothing is sent.
- **Something new:** the new findings, and anything resolved, are printed, and
  with `--notify` they are sent, as above. The first round sends the whole
  report once. If the first scan finds nothing, nothing is sent.
- **The check fails** (credentials expired, cluster unreachable): the reason is
  printed on stderr and sent, and the process carries on. The same failure in
  the next rounds is not said again, a different one is, and when checking
  works again that is said once, so a quiet channel means nothing is new and
  nothing is broken.
- **A message that cannot be sent is retried** the next round. What has been
  reported only moves forward once every `--notify` target has the message,
  and a failed round never moves it. This is the daily report's reasoning:
  a lost message must not turn into a finding nobody was told about. A target
  that already has a message is not sent it again while another is retried.
- **Where it is kept:** `.cloudpilot/watch-baseline.json`, or
  `.cloudpilot/watch-kube-<context>.json` for a cluster, in the directory it is
  run from, so a restart carries on instead of reporting everything again. It
  is separate from the scan that `scan` and `kube` save, so running those by
  hand does not decide what the watch has told your team. `--replay` never
  writes it, and `--redact-account` neither reads nor writes it. What a region
  held last time is kept whenever this round did not read that region in full,
  whether a check there failed or the round never looked, so it is not
  reported as new when that region is read again.
- **Fixes:** none, unless you turn on `--autopilot`, which runs the fixes that
  can be undone for the rules you name and nothing else. It is off by default
  and has a section of its own: [Let watch run the fixes that can be undone](#let-watch-run-the-fixes-that-can-be-undone-autopilot).
  Without it, `watch` only reads, in every round, whatever its findings hold.
- **Uploads:** with `--upload`, every round that completed is uploaded, with
  something new or not (see [Keep the history](#keep-the-history)). A failed
  upload is said once on stderr and not again while it keeps failing the same
  way, and when uploading works again that is said once. It never changes what
  has been reported or sent.
- **Stopping:** Ctrl+C or SIGTERM ends it cleanly, between rounds or in the
  middle of one. `--max-runs <n>` ends it after `n` rounds. The exit status is
  1 if the last round failed, its message was not delivered or its upload
  failed, or an autopilot fix failed, and 0 otherwise, and always 0 when it was
  stopped by a signal.
- **How often:** `--every` takes a number and a unit (`30m`, `6h`, `1d`), and
  defaults to `6h`. It is refused below 15 minutes and above 7 days. A round
  reads every region (or asks Prometheus for days of history for every
  container) and the figures it judges by are a day or a week long, so
  reading faster than every 15 minutes finds nothing the last round missed,
  while AWS throttles API calls and Prometheus pays for every long query. For a wait longer than a week,
  use cron or a systemd timer and `scan --notify`.

`watch` takes `--profile`, `--region`, `--all-regions`, `--lookback-hours`,
`--price-file`, `--offline`, `--replay` and `--redact-account` for the account,
and `--kube` with `--context`, `--cluster-name`, `--namespace`, `--prometheus`,
`--lookback-hours`, `--cpu-hour-usd`, `--memory-gib-hour-usd` and
`--storage-gib-month-usd` for the cluster, and the `--autopilot` options described
below. With `--kube` the kubectl context in force
when it starts is the one read in every round. To have a cluster watch itself,
from inside it, see [Read a cluster from inside it](#read-a-cluster-from-inside-it). It makes the same read-only calls as `scan` and `kube`;
the only new outbound requests are the POSTs to your `--notify` URLs and, with
`--upload`, to the one address you gave. With `--autopilot` it also starts your
own `aws` to run a fix, as `apply` does.

### Keep the history

`--upload` sends each scan's result to CloudPilot's hosted service, so a team
has history (what is new, what was resolved, over weeks) without piping output
to curl. It is optional: CloudPilot sends nothing anywhere unless you give it
this option.

```sh
# the token the service made for you, from its settings (it is shown once)
export CLOUDPILOT_UPLOAD_TOKEN=<the token>
npx @meruapps/cloudpilot scan --upload https://your-cloudpilot-address/api/ingest
npx @meruapps/cloudpilot kube --upload https://your-cloudpilot-address/api/ingest
npx @meruapps/cloudpilot watch --every 6h --upload https://your-cloudpilot-address/api/ingest
```

The address is the service's upload endpoint, `/api/ingest` on its address
(`your-cloudpilot-address` is a placeholder). Anything but `https` is refused,
except `http` to `127.0.0.1` or `localhost`, which is for trying it on your own
machine. An address with a user name or password in it is refused too.

**The token is a secret**, since whoever has it can add scans to your history.
It is read only from the environment variable `CLOUDPILOT_UPLOAD_TOKEN` (which
can also be set in a `.env` file), and there is no flag for it, on purpose: a
flag ends up in your shell history and in the process list of the machine,
where any user on it can read it. CloudPilot never prints it, and never writes
it to a saved scan, a report or a recording. Where it must name the address it
shows the host only, and anything the service says back is shown with the
token and the address taken out. Once the token is read, it is removed from
CloudPilot's own environment, so `kubectl` and the other programs a scan
starts do not inherit it. What it cannot control: the service you name sees
the token, and anything on your machine that can read the environment of the
process or your `.env` file can too.

**What is sent.** One HTTPS POST to your address, with `Authorization: Bearer
<token>`, whose body is the JSON that `--json` prints for that run: the
account ID, or the cluster's context; the regions, or namespaces; when the scan
was taken; the price source; and every finding with its title, rule name,
resource type and IDs, evidence, monthly cost and how it was worked out, fix
commands with their risk and way back, and confidence. Also the total, the
names of resources skipped by the ignore tag, and the warnings, which are the
error text of checks that could not run and can name the role that was
refused. For a cluster, its API server address, its Prometheus and the unit
prices. Because it is exactly what `--json` prints, it also carries the
comparison with the last scan, the `isNew` marks, the bill figures if you asked
for `--bill`, and the summary (written by a model if you asked for `--explain`).
The service works out for itself what is new and what was
resolved, from the sequence of scans. The service receives no AWS or cluster
credentials: CloudPilot never sends any, and the only secret in the request is
the upload token, which is the service's own. Nothing is sent anywhere but the
address you gave, and a redirect is treated as a failure instead of being
followed, so the token never goes where you did not point it.

**When it uploads.** Every run, not only a run with something new: the service
needs each scan to work out what is new and what was resolved. `--only-new`,
`--no-compare` and `--notify` change what is printed or sent to your team, not
what is uploaded. Under `watch`, every round that completed is uploaded; a
round whose check failed has no result and uploads nothing. An upload comes
after the report is printed, and one that fails changes nothing else: the
saved scan and what `--notify` has told your team move as they would without
it.

**What the service answers, and what CloudPilot says.** One line on stderr for
each, never the body of the answer:

| Answer | What CloudPilot says | Exit status |
|---|---|---|
| `201` stored | `Uploaded the scan to <host>: stored (3 new, 1 came back, 2 resolved, 8 unchanged).` The counts are shown when the service gives them | 0 |
| `200` this exact scan was already stored | `Uploaded the scan to <host>: this exact scan was already stored, so nothing changed.` | 0 |
| `401` token missing, wrong or revoked | the token in `CLOUDPILOT_UPLOAD_TOKEN` was not accepted; make a new one in the service's settings and set the variable again | 1 |
| `409` older than the latest stored | a later scan of this account or cluster is already stored; check the clock of this machine | 1 |
| `413` too large | the scan is larger than the service accepts; scan a smaller part at a time, with `--region` or `--namespace` | 1 |
| `422` not a scan result | the service does not take this as a scan result, with the first thing it found wrong; update CloudPilot, and report it if it still happens | 1 |
| anything else | the status, and for a redirect, a server error or an address that does not answer like the service, what to check | 1 |

Every failure line starts `Could not upload the scan to <host>:`. A failed
upload does not hide the report: the report is printed, then the failure is
said, and a `scan` or `kube` run ends with status 1, so a cron job or CI step
cannot take a missing scan for a stored one. Under `watch` it is said once,
and not again while the upload keeps failing the same way.

**Time-outs and retries.** Each attempt gets 20 seconds to answer, so a service
that hangs cannot hold the scan for more than about 42 seconds. An attempt that
gets no answer, or a server error (`5xx`), is tried once more after two seconds,
and never more than once. The retry sends the same scan, which the service
stores once however often it is sent. An answer that says what is wrong with
the request (`401`, `409`, `413`, `422`) is not retried.

**What it refuses, and why.** All of these stop the run before anything is read:

- `--upload` with `--replay`: a recording is not the account as it is now, and
  uploading it would put old findings into the history as if they were current.
- `--upload` with `--redact-account`: the stand-in account ID is the same for
  every account, so the history would merge different accounts into one.
- `kube --upload` with `--answer-key`: that run scores a lab and keeps no scan.
- `--upload` with no `CLOUDPILOT_UPLOAD_TOKEN`, so a typo costs no scan.

### Run a fix you approved

A scan never runs anything, and neither do `kube`, `ask`, `anomalies`,
`init`, `audit` or `mcp`, or `watch` unless you turn on `--autopilot`: none of
them changes anything in your AWS account or cluster. `apply` is the only
command that can, and only what you name and approve; `watch --autopilot` is
the one other thing that can, [described below](#let-watch-run-the-fixes-that-can-be-undone-autopilot),
and only for the rules you name and the fixes that can be undone. If you want
CloudPilot to run a fix for you now, name the resource:

```sh
cloudpilot apply vol-0123456789abcdef0
cloudpilot apply deployment/api
```

It finds the finding in the scans saved in this directory (the account's and
each cluster's), shows the commands and the way back, and asks before it runs
them. The commands go to your own `aws` or `kubectl`, with your own
credentials; the read-only access a scan uses is not enough for them, and
CloudPilot asks for no more than you already have. The read-only policy
(`cloudpilot init --print-policy`) is not widened for it: to run a fix, use an
identity that may make that change, such as `--profile <name>` for the `aws`
commands.

What it will and will not do:

- **Fixes that can be undone come first.** Where a finding has a gentler
  alternative (convert a volume instead of deleting it), that is what runs.
- **A permanent fix needs asking for.** Pass `--allow-permanent`, and then
  type the resource ID back at the prompt. It is never run unattended,
  whatever else is passed.
- **Only CloudPilot's own kinds of command.** It runs the commands a scan
  printed, as a list of arguments and never through a shell, and only the
  kinds the rules print: volume, address, snapshot and image changes, instance
  terminate, resize (stop, wait, change the type, start) and delete, database
  delete and stop, NAT gateway and load balancer delete, bucket lifecycle and
  upload abort, and `kubectl` resource, claim and volume changes. A saved scan
  that has been edited to hold anything else is refused, and so is one that
  calls a command that cannot be undone undoable.
- **Nothing stale.** A scan older than 24 hours (`--max-age-hours`) is
  refused: scan again first.
- **It stops at the first failure,** and leaves everything after it alone.
  A fix that is several commands, such as resizing an instance (stop, wait,
  change the type, start), may then be half done: it says so, and the way back
  it showed is the place to start.
- **`--yes`** runs fixes that can be undone without asking, for scripts.
  Without it and without a terminal, nothing runs. **`--dry-run`** shows the
  commands and stops.

Every fix it ran, was told not to run or refused to run is appended to
`.cloudpilot/audit.jsonl`: who, when, which finding, each command with its
exit code, and the way back. `cloudpilot audit` prints it as a list to read,
`cloudpilot audit --json` as the entries themselves. Before it runs anything it
checks that a line can be added to the log, and if not it runs nothing (a
`--dry-run` writes no record and skips the check). If a record cannot be written
after a fix has run, the entry is printed instead, nothing after it is run, and
the exit code is 1.

`apply` never sends anything anywhere: it has no `--notify`, `--upload`,
`--replay` or `--record`, and a webhook or upload token in the environment is
not used by it. It works from the scans a live run saved in this directory (a
replay never saves one), or from the file you give with `--from`.

A cluster scan is saved under the cluster's name (`.cloudpilot/last-kube-scan-<name>.json`),
and `apply` runs its fixes with that name as `--context`, exactly as printed.
For a cluster scanned from inside it with `--cluster-name`, that name has to
be a kubectl context on the machine where you run `apply`; where it is not,
`kubectl` refuses and nothing is changed.

The MCP server has no tool that runs a fix, so an AI client cannot apply
anything through it.

### Let watch run the fixes that can be undone (autopilot)

`watch` only reads, unless you turn on `--autopilot`. With it, `watch` is the
one thing besides `apply` that can change anything in your account. It is off
unless you give the option, it acts only for the rules you name (there is no
"all"), and only for fixes that can be undone. A fix that cannot be undone is
never run by it, under any option.

**Start with a dry run.** `--autopilot-dry-run` does everything except run the
commands: each round it prints, and sends to `--notify`, what it would have
run. It writes nothing to the audit log, so that output and the message are the
only record of it. Read those for a few days, then take the dry run off.

```sh
cloudpilot watch --every 6h --notify https://hooks.slack.com/services/... \
  --autopilot gp2-volume,bucket-without-lifecycle --autopilot-dry-run
```

**Which rules can qualify today.** Two. Autopilot is told the rule's name, and
runs that rule's own fix, word for word as the report prints it:

| Rule | What autopilot runs | What can be undone, and what cannot |
|---|---|---|
| `gp2-volume` | `aws ec2 modify-volume ... --volume-type gp3` | The change is made online and can be reversed: "Online and reversible: the volume can be changed back to gp2 after AWS's 6-hour modification cooldown." AWS allows one modification of a volume every 6 hours, so the way back opens 6 hours after the change. Until then the volume stays gp3. gp3 comes with 3,000 IOPS and 125 MiB/s unless more is paid for, and a gp2 volume of more than about 1 TB has more IOPS than that, and one of more than about 330 GB can have more throughput: autopilot does not look at a volume's size or its I/O, so such a volume can be slower until it is changed back |
| `bucket-without-lifecycle` | `aws s3api put-bucket-lifecycle-configuration`, one rule for the whole bucket: abort multipart uploads left unfinished for 7 days, and move objects to Standard-IA after 30 days | The rule can be removed: "Remove the rule again with: `aws s3api delete-bucket-lifecycle --bucket <name>`. Objects already moved to Standard-IA stay there." An unfinished upload the rule has aborted is not brought back, and Standard-IA can cost more than Standard for many small objects |

Both are reported at 90% rule confidence, which is why the default bar is
`0.9`. Putting a lifecycle configuration on a bucket replaces whatever the
bucket has; the finding exists only where the scan saw none, moments earlier.

Every other rule is refused when it is named, before anything runs, with the
reason. Most print a fix that deletes, terminates, releases or deregisters,
which is permanent, and so does aborting an incomplete multipart upload: the
parts already uploaded are discarded for good. Two rules print a fix that is not
marked permanent and are still left out: an oversized instance (the fix stops a
running instance and starts it again, an outage that a failure part-way leaves
half done) and an over-requested workload (it restarts the pods, and a
cluster is never touched). A rule whose main fix is permanent but that has a
gentler alternative, such as a volume nobody has attached, which could be
converted to gp3 instead of deleted, is refused as well: autopilot never takes
an alternative in place of the fix a finding proposes. `apply` still does that,
when you ask.

**The gates.** A finding is fixed only if it passes every one of these, in
this order, in a round of the watch:

1. Its rule is one you named with `--autopilot <rules>`, a comma-separated
   list such as `gp2-volume,bucket-without-lifecycle`. A name that is not a
   rule, `all`, or a rule that can never qualify, is an error before anything
   runs.
2. The fix can be undone: the finding's own risk is not "dangerous", no
   command in it is of a kind `apply`'s allow-list calls permanent, and the
   commands are exactly the ones the rule prints for that one resource. A scan
   edited to call a delete safe, or to add a command, fails here.
3. Its confidence is at least `--autopilot-min-confidence` (default `0.9`).
4. It has been among the findings of at least `--autopilot-after` rounds of
   this watch in a row (default `2`), so a blip in one scan never changes
   anything. The count is kept in memory: a restart, or a round whose check
   failed, starts it again.
5. The scan is from this round, not older than the round's start, and read the
   finding's region in full: if a check could not run there, or a warning does
   not say where it was from, nothing in it is run.
6. No fix has been run, or failed, on that resource from this directory
   before. The audit log is read for this, so it holds across restarts and
   counts a fix you ran with `apply` too. A fix that failed is not tried again
   either: to retry it, use `apply`.
7. The caps: at most `--autopilot-max` fixes in a round (default `3`, biggest
   saving first) and `--autopilot-max-total` in this watch process (default
   `10`). What is past a cap is held back, not run.

It stops at the first failure in a round: the fix that failed is recorded
with its output, and the fixes after it in that round are held back. A fix of
several commands that fails after the first says it may be half done, as
`apply` does. If the audit log cannot be read, has a line that cannot be read
(a fix whose record is that line would look as if it was never tried), or cannot
take a line, nothing is run, and the message names the file to repair. `apply`
by hand is not affected. Ctrl+C lets a fix that has started finish and be recorded, and starts
no other.

**It refuses to start,** before reading anything, with `--replay` (a recording
is not the account as it is now), with `--redact-account` (the record would not
say where), with `--kube` (no rule that runs against a cluster can qualify),
and anywhere inside a cluster, found the way `watch --kube` finds it, since
the watcher that runs in a cluster is read-only by design. Its options
without `--autopilot` are an error, so that none of them can be mistaken for it
being on.

**What you are told.** The watch says in plain words that autopilot is on when
it starts: which rules, the caps, and that a permanent fix is never run. Every
fix it runs, holds back, refuses or fails is written to
`.cloudpilot/audit.jsonl` with a field saying it was autopilot's and which
gates it had passed, and `cloudpilot audit` shows it. A dry run writes nothing
to the audit log: what it would have run, held back or refused is printed in
the watch's own output each round, and sent with `--notify`. With `--notify`, each
round that did any of that sends one message of its own: what was changed, with
the way back for each, what was held back or not run and why, and, for a dry
run, what would have run. A fix that failed after it started is given its exit
code and the way back, and may be half done; one that never started (`aws` is
not on the PATH, say) is said to have changed nothing, with the reason, and has
no way back to take. The message about new findings says that autopilot's
changes are in a message of their own, so nothing in it is untrue. A round with
nothing to do sends nothing, and findings that are not yet eligible (below the
confidence bar, or not yet in enough rounds) are only listed in that round's
output.

**What it does not guard against.**

- It runs your `aws` with your credentials, as `apply` does, and a scan's
  read-only role cannot change anything. Use `--profile <name>` for an identity
  that may make these two changes. A fix the identity may not make fails, is
  recorded as failed, and is not tried again.
- Two watches started in the same directory at once could each start a fix
  on the same resource. Run one.
- A process killed after a command finished and before its line reached the
  audit log could try that resource again after a restart. For these two
  fixes the second try is harmless (AWS refuses a second change to a volume that
  is still being modified, and putting the same lifecycle rule again changes
  nothing), but it is a gap.
- The 6-hour wait AWS puts on a volume is also a limit on how fast a change can
  be taken back.

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

| Provider | Needs | Default model for the summary | Default model for `ask` |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | `claude-opus-5-5` |
| `openai` | `OPENAI_API_KEY` | the newest `-mini` GPT model the key can use, else the newest `-nano` one | the newest full-size GPT model the key can use |
| `bedrock` | `--bedrock-profile <aws profile>` and `npm install @anthropic-ai/bedrock-sdk` | Claude Haiku 4.5 | Claude Haiku 4.5 |

**The model is picked by the job.** The summary that `--explain` writes is a
short formatting job over facts the scanner already worked out, so it gets a
small, fast model. `ask` may look things up over several turns, so it gets a
stronger one. For OpenAI the defaults are picked from the models the key can
list: the summary takes the newest family that has a `-mini` model, or failing
that the newest with a `-nano` one; `ask` takes the newest family that has a
full-size one, never a `-mini` or `-nano` model. A key that can use only one
kind of model uses the same model for both. Bedrock has one default, Haiku 4.5,
for both jobs, because it is the only Bedrock model CloudPilot names and Bedrock
model IDs depend on your account and region: name a stronger one for `ask`
yourself.

To choose the model yourself, from first to last:

1. `--model <id>` on the command line wins for whatever that command does.
2. `CLOUDPILOT_MODEL_SUMMARY` names the model for the `--explain` summary and
   `CLOUDPILOT_MODEL_ASK` the one for `ask`. They can be set in a `.env` file.
3. The defaults above.

(For OpenAI, the older `CLOUDPILOT_OPENAI_MODEL` still names one model for both
jobs, after the two variables above.) A model name is passed to the provider
as given. One that the provider does not have, or the key cannot use, fails as
it always has: the provider's reason is printed, and `--explain` shows the
templated summary. The model only ever writes words: the output check and the
templated fallback below are the same for every model, and a model never
computes a figure. A recording stores what the model said for each job, not
which model said it, so `--replay` is unaffected by any of this; with
`--live-llm` the job's model is called live.

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
amount in it must already exist in the scan data. So must any percentage
written near a word about spending (`bill`, `spend`, `invoice`): the only one
accepted is the share of the bill CloudPilot worked out itself, so a scan
without `--bill`, which reads no bill at all, accepts none. A percentage
nowhere near those words, such as a CPU reading, is not checked. If a value
does not check out, the text is discarded, the value that failed is logged,
and the templated summary is shown instead.

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
the cluster tools are not offered: the server replays an account only.

### Record and replay

`--record <dir>` on `scan`, `ask` and `anomalies` runs normally and saves
every AWS response and every model event of that run. `--replay <dir>`
repeats the run from that recording with no network calls and no
credentials: the clock is pinned to the recording time, so ages, CloudWatch
windows and results match exactly. Every replay starts with a `REPLAY MODE`
banner naming when and where it was recorded, so it cannot pass for a live
run. A request or a question the recording does not hold is an error, never
a silent fallback to the network. `--live-llm` replays AWS but calls the
model live, and `--redact-account` shows the account ID as `123456789012` in
output and recordings. Recordings hold no credentials or signatures and
`recordings/` is gitignored. A recording is replayed by the CloudPilot
version that made it: requests are matched exactly, so a different version
may not find them. `demo/record.sh` at the repo root records the demo set
(`scan --explain` and two questions) in one go, and `demo/replay.sh` plays
it back.

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

`anomalies` records and replays the same way, into a folder of its own
(`anomalies/`) that holds its Cost Explorer answer and the caller's identity,
and notes the `--days` it was made with. Its replay needs no credentials and
makes no request, so nothing is charged.

An account and a cluster can be recorded into one directory. Each session
has a folder of its own (`scan/`, `ask-<hash>/`, `anomalies/` for the account;
`kube/`, `kube-ask-<hash>/` for a cluster) and a line in `manifest.json`, so
recording one never touches the other, and `scan --replay`, `kube --replay`
and the two kinds of `ask` each find only their own sessions. Account
sessions keep their `aws.json`; cluster sessions hold `kube.json` instead. A
directory that holds only clusters has no account ID in its manifest.

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

The image is for scanning, and a scan changes nothing. It holds `kubectl` but
not the `aws` command, and it is meant to be given read-only credentials, so
run `apply` from your own machine rather than from the container.

The image holds the built command, its production dependencies and `kubectl`
v1.37.1, on Node 22 (Alpine), with CloudPilot's own licence at `/app/LICENSE`
and the two font licence texts in `/app/licenses` beside them. It runs as a
non-root user (uid 1000) and holds no credentials. It does not hold the AWS
CLI. The `kubectl` download is checked in the build against a SHA-256 written
in the `Dockerfile`. Building needs network and BuildKit (the default in
current Docker), for `linux/amd64` or `linux/arm64`.

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

### Watch a cluster from inside it

The same image runs as a Deployment in the cluster it watches, with its own
read-only identity: [`deploy/kube-watch.yaml`](../../deploy/kube-watch.yaml),
described in [`deploy/README.md`](../../deploy/README.md#watch-a-cluster-from-inside-it).
The image is not published, so you build it (above) and load or push it to
where your cluster pulls from.

### Check the image

`scripts/docker-smoke.sh` builds the image and replays the recorded scan in
`test/fixtures/lab` inside a container with `--network none` and the recording
mounted read-only. It checks that the replay exits 0 and reports the 10
recorded findings, that the container is not root, and that `kubectl` is
present. It needs Docker and is not part of `npm test`.

## Options

These are the options for `scan`, `ask` and `eval`. `kube` adds its own, and
reads `--lookback-hours` with its own meaning and default: see
[Kubernetes](#kubernetes). `anomalies` takes `--days`, `--sensitivity`,
`--min-increase` and `--no-weekday-check`, and the options below that name it: see
[Spend anomalies](#spend-anomalies). `ask --kube` takes the `kube` options
named there in place of the AWS ones. `init` takes `--profile`, `--region`,
`--context`, `--cluster-name`, `--prometheus`, `--json` and `--print-policy`: see
[Check first with `init`](#check-first-with-init). `watch` takes the ones that
say so: see [Watch it](#watch-it).

| Option | Meaning |
|---|---|
| `--profile <name>` | AWS profile to read with. Defaults to `AWS_PROFILE`, then the standard credential chain |
| `--region <region>` | Scan only this region. With `init`: the region its AWS reads are tried in |
| `--all-regions` | Scan every region enabled for the account. The default when `--region` is not given |
| `--html <file>` | `scan` only: also write a self-contained HTML report |
| `--out <file>` | `scan` only: also write the report to a file, as Markdown, or as plain text when the name ends in `.txt` |
| `--json` | `scan`, `kube`, `anomalies` and `init` only: print the result as JSON |
| `--explain` | `scan` and `kube` only: have a model write the summary |
| `--compare <file>` | `scan` only: say what changed since this earlier scan. Default: the last scan made from this directory |
| `--no-compare` | `scan` only: do not compare |
| `--no-advisories` | `kube` and `watch --kube` only: leave out the advisories (things to look at that are not waste) and do not read the cluster's nodes. See [Also worth a look](#also-worth-a-look-advisories-which-are-not-waste) |
| `--only-new` | `scan` only: list only the findings that are new since the earlier scan |
| `--notify <url>` | `scan`, `kube`, `anomalies` and `watch`: send what is new (for `anomalies`, the services that cost more than usual) to this Slack, Discord or other https webhook. Repeatable; or `CLOUDPILOT_NOTIFY`, comma-separated. See [Tell your team what is new](#tell-your-team-what-is-new) |
| `--upload <url>` | `scan`, `kube` and `watch`: send each scan's full result as JSON to this https address, the hosted service's upload endpoint. The token is read only from `CLOUDPILOT_UPLOAD_TOKEN`, never from a flag. Not with `--replay`, `--redact-account` or `kube --answer-key`. See [Keep the history](#keep-the-history) |
| `--every <interval>` | `watch` only: the wait between rounds, `15m` to `7d`. Default `6h` |
| `--max-runs <n>` | `watch` only: stop after this many rounds. Default: until stopped |
| `--autopilot <rules>` | `watch` only: run the fix for these rules, comma-separated, when a finding passes every gate and the fix can be undone. Off unless given; there is no `all`; a permanent fix is never run. Can qualify today: `gp2-volume`, `bucket-without-lifecycle`. See [Let watch run the fixes that can be undone](#let-watch-run-the-fixes-that-can-be-undone-autopilot) |
| `--autopilot-dry-run` | `watch --autopilot` only: do everything but run the commands, and say, and send, what would have run. Start with this |
| `--autopilot-min-confidence <n>` | `watch --autopilot` only: the lowest confidence a finding may have. Default 0.9 |
| `--autopilot-after <n>` | `watch --autopilot` only: the rounds of this watch in a row a finding must be in. Default 2 |
| `--autopilot-max <n>` | `watch --autopilot` only: the most fixes in one round. Default 3 |
| `--autopilot-max-total <n>` | `watch --autopilot` only: the most fixes in one watch process. Default 10 |
| `--kube` | `watch` and `ask`: work on the cluster kubectl points at instead of the AWS account. With `ask` it takes `--context`, `--namespace`, `--prometheus`, `--lookback-hours` (default 168, not 24) and the price options, and refuses `--region`, `--all-regions`, `--profile`, `--price-file`, `--offline` and `--redact-account` |
| `--cluster-name <name>` | `kube`, `watch --kube`, `ask --kube` and `init`: inside a cluster with no kubeconfig, what to call it (or `CLOUDPILOT_CLUSTER_NAME`). Use the kubectl context name your team uses for it: the fix commands carry `--context <name>`. Ignored when kubectl has a context; not with `--context`. See [Read a cluster from inside it](#read-a-cluster-from-inside-it) |
| `--days <n>` | `anomalies` only: complete days of cost to read, 8 to 90. Default 30. With `--replay`, the days recorded. AWS charges $0.01 for the one Cost Explorer request `anomalies` makes |
| `--sensitivity <k>` | `anomalies` only: flag a day above the median plus `k` times 1.4826 times the median absolute deviation. Default 3 |
| `--min-increase <dollars>` | `anomalies` only: never flag a day less than this far above the median, or less than this far above the largest earlier day on the same weekday. Default 1.00 |
| `--no-weekday-check` | `anomalies` only: do not also require the day to be above the earlier days on its own weekday. Without it a weekly job, such as one that runs on Saturdays, is not flagged every week |
| `--bill` | `scan` only: also read last month's total spend from Cost Explorer and say what share of it the waste is. AWS charges $0.01 for this one request, so it is never made unless you ask |
| `--lookback-hours <n>` | Hours of CPU, database connection and NAT gateway and load balancer traffic history used to judge idle and oversized resources. Default 24 |
| `--price-file <path>` | Saved price table to fall back on |
| `--offline` | Use only `--price-file` for prices |
| `--provider <name>` | `anthropic`, `openai` or `bedrock`. Default: whichever key is set |
| `--model <id>` | Model to use for whatever the command does (`--explain` summary or `ask`), over `CLOUDPILOT_MODEL_SUMMARY` and `CLOUDPILOT_MODEL_ASK`. Default: a small, fast model for the summary and a stronger one for `ask`, see [Ask questions](#ask-questions-needs-a-model-api-key) |
| `--bedrock-profile <name>` | AWS profile for Claude through Amazon Bedrock |
| `--record <dir>` | Run live and save the run for replay. Also for `kube` and `anomalies` |
| `--replay <dir>` | Repeat a recorded run with no network calls. Also for `kube` and `anomalies` |
| `--live-llm` | With `--replay`: AWS (or the cluster) from the recording, model called live |
| `--redact-account` | Show the account ID as `123456789012`. Also for `anomalies`. Not with `--kube` |

`apply` takes its own options:

| Option | Meaning |
|---|---|
| `--from <file>` | Take the fixes from this scan result instead of the scans saved in this directory |
| `--allow-permanent` | Choose the fix that cannot be undone; it still needs the resource ID typed back at a terminal |
| `--yes` | Run fixes that can be undone without asking. Never applies to permanent fixes |
| `--dry-run` | Show what would run and stop |
| `--max-age-hours <n>` | Refuse a scan older than this (default 24) |
| `--profile <name>` | AWS profile the `aws` commands run with |

The last scan is saved to `.cloudpilot/last-scan.json`, except by `--replay`
and `--redact-account` runs. With `--notify` it is saved once the message has
been delivered, or when nothing needed sending. `watch` keeps its own.

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

**Names from the cluster are made safe before they are printed.** Every name a
scan reads (a workload, pod, node, claim, volume, namespace or container, and
the kind and name of an owner reference, which the API server only requires to
be non-empty) is shown with every character outside the ones a name is made of
(letters, digits, `.`, `_` and `-`) replaced by `?`, so no quote, backtick,
markup or terminal control byte from a cluster is ever printed. The free text a
cluster writes, such as a scheduler's message or a container's stop reason, has
its control characters and the invisible marks that change the direction or the
joining of what follows them removed, because that text reaches a terminal and
the Markdown and HTML reports alike. An object whose name is not a valid
Kubernetes name is still reported, with its cost and its evidence, but
CloudPilot prints no command for it, because a command pasted with a name like
that could act on something else: the finding's `fix.commands` is empty and its
`rollback` says why, the terminal and Markdown reports say "no fix command" in
place of the fix, the HTML report gives it no tick box and no line in the
script, an advisory says the same in its advice, and `apply` refuses to run it.

### Also worth a look: advisories, which are not waste

`kube` also reports a second kind of result, apart from the findings. An
**advisory** is something a person should look at. It is found by a fixed rule
from what the scan already read, and it is **not waste**: it is never counted in
"N findings, $X per month", never compared with the last scan, never scored
against a lab's answer key and never announced to a webhook. It is listed in its
own section, "Also worth a look (not counted as waste)", after the findings.
Advisories are a type of their own and sit in their own array,
`advisories`, on the scan result. They are not findings with a cost of zero, so
nothing that adds up, compares, scores or announces findings can pick one up.

| Rule | Raised when | Says | Command |
|---|---|---|---|
| `out-of-memory` | A container's last stop (`lastState`, or `state` for one that has stopped for good) was `OOMKilled`, in a pod that has not finished. One advisory per container of one workload | Which container, when, its memory limit, its restart count, and that the over-requested rule already leaves its memory request alone | Only where the limit is known and the pod belongs to a Deployment, StatefulSet or DaemonSet: `kubectl set resources ... --limits=memory=<limit plus 25%, rounded up to the next 16Mi>`, as a suggestion, with the old limit as the way back. The right figure depends on the workload, and the advisory says so |
| `restarting` | A container is waiting in `CrashLoopBackOff`, **or** has restarted 5 or more times and, where the pod records when it last stopped, that was within 24 hours of the scan (where it does not, or where the time it gives cannot be read, the count alone decides, and the evidence says which) | The restart count of the worst pod, its last state (reason, exit code, time). Where any pod of the group is in `CrashLoopBackOff` the worst is taken from those, so what is said is true of the pod named | None. It points at `kubectl logs <pod> -c <container> --previous` |
| `no-requests` | A container of a Deployment, StatefulSet or DaemonSet sets no CPU request or no memory request (a request of zero counts as none) | Which containers lack which request, and that the scheduler cannot place the pods sensibly and CloudPilot cannot judge whether they ask for too much | None. No dollar figure |
| `unschedulable` | A pod is `Pending` and its `PodScheduled` condition is `False` | The scheduler's own message, made safe to print (above) and cut to 240 characters, and how long it has waited | None |
| `spare-node-capacity` | The requests of the pods on the nodes that run workloads would fit on fewer nodes of the same size, now or once the over-requested findings' suggested requests are applied | The arithmetic below | None: how a node is removed depends on the provider, so CloudPilot prints no command for it |

Pods of one workload that show the same thing are one advisory, with the count.
Objects labelled `cloudpilot/ignore=true`, and pods of such a workload, raise
none. The advisories come in a fixed order: by rule in the order above, then by
namespace, object and container.

**Spare node capacity, as arithmetic.** Nodes are read with
`kubectl get --raw /api/v1/nodes` (see [What it needs](#what-it-needs)). A node
that runs the control plane (a `node-role.kubernetes.io/control-plane` or
`.../master` label), carries a `NoSchedule` or `NoExecute` taint, or is cordoned
is named and left out. So is a node whose allocatable CPU or memory is missing,
or is not a figure above zero, since it can hold nothing: those are named in
`advisoryWarnings` instead. For the others:

1. Sum the CPU and memory **requests** of every pod bound to them that has not
   finished, in every namespace, the cluster's own included. Compare with the
   nodes' **allocatable**.
2. Take the average node. With no node above 80% of its allocatable CPU or
   memory, the nodes needed are the larger of `ceil(CPU requested / (0.8 x CPU per
   node))` and `ceil(memory requested / (0.8 x memory per node))`, and at least
   one. The nodes that could go are the nodes counted less that.
3. Do it again after taking off what the over-requested findings free: for each
   workload that has a finding, the difference between each container's request
   and the suggested one, for each of its pods on the nodes counted. This is what
   turns those findings' dollars into a real saving, because lower requests only
   free a node once the nodes are fewer.
4. Say what the nodes that could go are worth: nodes x (CPU per node x the CPU
   price + GiB per node x the memory price) x 730 hours, at the prices of this scan.

The advisory is raised only when some node could go. Its dollar figure,
`estimatedMonthlyUsd`, is never added to the total or to a finding: the
over-requested findings already count the CPU and memory they free, so adding
the two would count it twice, and the advisory says so. It is also an
**estimate by totals**. It ignores affinity and anti-affinity rules, taints and
tolerations on the pods, the DaemonSet pod every node must run, pod disruption
budgets, local volumes, init containers, pod overhead and the headroom a spike
needs, and it does not look at node health. With mixed node sizes it uses the
average node.

Worked example. The lab has one node, its control plane, so it raises nothing
about nodes; the offline tests put its recorded pods on three nodes of 2 CPU and
4 GiB to show the arithmetic. The pods request 3.08 CPU and 3554Mi. One node
holds 1.6 CPU and 3276.8Mi within 80%, so today's requests need 2 of the 3
nodes (3.08 / 1.6 rounds up to 2), and 1 could go. The three findings that lower
requests would free 1.85 CPU (checkout 980m, reports 870m) and 2432Mi (search
992Mi, reports 1440Mi), leaving 1.23 CPU and 1122Mi, which fit on 1 node, so 2
could go: worth 2 x (2 x $0.031611 + 4 x $0.004237) x 730 = $117.05 a month at
OpenCost's prices. The $50.64 total does not move.

**`--json`.** Every advisory has this shape. `countedInTotal` is always `false`.

```json
{
  "advisories": [
    {
      "rule": "out-of-memory",
      "title": "Container job of deployment/importer was killed for running out of memory",
      "kind": "Deployment",
      "resource": "deployment/importer",
      "namespace": "shop",
      "container": "job",
      "evidence": ["Container job was last killed for running out of memory (reason OOMKilled, exit code 137) at 2026-10-03T14:22:40Z.", "..."],
      "advice": "Raise the memory limit and watch whether the kills stop. ...",
      "suggestion": { "commands": ["kubectl set resources deployment/importer -n shop --context kind-cloudpilot-lab -c job --limits=memory=320Mi"], "risk": "caution", "rollback": "..." },
      "countedInTotal": false
    }
  ],
  "advisoryWarnings": []
}
```

| Field | Meaning |
|---|---|
| `rule` | `out-of-memory`, `restarting`, `no-requests`, `unschedulable` or `spare-node-capacity` |
| `title`, `evidence[]`, `advice` | Words for a person. `advice` is always there |
| `kind`, `resource`, `namespace` | What it is about: `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, `Pod`, or `Cluster` with `resource` `cluster/<context>` and `namespace` `(cluster)` |
| `container` | For the rules that are about one container |
| `suggestion` | Only where a command can be worked out: `commands`, `risk` and `rollback`, as in a finding's `fix` |
| `countedInTotal` | Always `false` |
| `estimatedMonthlyUsd`, `estimateBasis` | Only for `spare-node-capacity`: what the nodes that could go are worth, and the arithmetic. Not counted anywhere |
| `capacity` | Only for `spare-node-capacity`: the figures behind it (`headroomPct`, `nodes`, `excludedNodes`, `perNode`, `allocatable`, and `now` and `afterSuggestions`, each with `requestedCpuCores`, `requestedMemoryBytes`, `nodesNeeded` and `removable`) |

`advisoryWarnings` lists reads the advisories needed that could not be made.
With `--no-advisories`, neither key is in the result. An account scan has
neither. The hosted service ignores keys it does not know, so `--upload` sends
them with everything else `--json` prints; nothing in the uploaded findings or
total changes.

**What they do not touch.** The comparison with the last scan, `--only-new`,
`--notify`, `watch`, `--answer-key` and `eval` work on findings exactly as
before. Advisories are not compared (so `--only-new` cuts the findings and
still lists every advisory), are not scored and do not trigger or fill a
notification, in this version. In the HTML report they have no tick box and are
not part of the one script.

**`--no-advisories`** (on `kube` and `watch --kube`) leaves them out and does
not read the nodes. A cluster that refuses the nodes read gets one warning that
the spare node capacity check could not run, in its own list (`advisoryWarnings`),
so it never makes a comparison doubt the findings; every other result is
unaffected. `--namespace` also skips that check, and says why: a node is loaded
by the pods of every namespace, and only one was read.

**The model.** `--explain`, `ask --kube` and the MCP server's `scan_cluster` give
the model the advisories as facts it may mention, apart from the findings. Its
rules say they are not waste, that their figure is never to be called waste or a
saving or added to the total, and what an `advisoryWarnings` entry means. The
output check accepts the resource names, quantities and amounts in the
advisories as known values, and still discards text that names an unknown
workload, quantity, amount, namespace or context.

### What it needs

- **`kubectl`**, which also brings whatever sign-in your cluster uses. Every
  cluster read is `kubectl get --raw`, which can only GET; the only other call
  is `kubectl config view --minify`, to learn the current context. A test fails
  if a scan asks kubectl for anything else. Only `apply`, which you run
  yourself, ever runs another kind of `kubectl` command. Inside a cluster, with no
  kubeconfig, `kubectl` reads as the pod's service account: see
  [Read a cluster from inside it](#read-a-cluster-from-inside-it).
- **Prometheus with the kubelet's container metrics**
  (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`),
  which kube-prometheus-stack and most setups collect. It is found among the
  cluster's services and queried through the API server, so nothing needs
  port-forwarding. Name it with `--prometheus namespace/service:port` if it is
  not found. Without one, volumes are still reported and the report says
  requests were not judged.
- **`list` on nodes** (`/api/v1/nodes`), for the spare node capacity advisory
  only. Without it that one check says it could not run and every other result
  is unaffected; `--no-advisories` skips the read, and `cloudpilot init` lists
  `nodes` with the other reads.
- For a dedicated identity with the least access, apply
  [`docs/cloudpilot-kube-readonly.yaml`](../../docs/cloudpilot-kube-readonly.yaml):
  it may list workloads, pods, services, volumes and nodes and query one
  Prometheus service. It cannot read Secrets or ConfigMaps, or change anything.

### Read a cluster from inside it

A pod has no kubeconfig and so no context, but `kubectl` still works there: with
none, it uses the pod's service account. CloudPilot does the same. When there is no
kubeconfig context to read and the process is in a cluster (the two variables every
pod is given, `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`, are set), the
scan goes ahead, and the cluster is known by the name you give it:

```sh
cloudpilot kube --cluster-name prod-eu
cloudpilot watch --kube --cluster-name prod-eu --every 6h
# or: CLOUDPILOT_CLUSTER_NAME=prod-eu
```

Make that name **the kubectl context name your team uses for this cluster on their
own machines**. The fix commands CloudPilot prints carry `--context <name>`, so that
a command pasted into the wrong terminal cannot reach a different cluster; a name
nobody's kubectl knows makes the paste fail, and another cluster's name would aim
it there. Inside a cluster with no name, it stops with a message before it reads
anything. A name is one word with no spaces, quotes or shell characters, and is
refused otherwise. It is used only when kubectl has no context: with a kubeconfig
(or `--context`) nothing changes, and `--cluster-name` cannot be combined with
`--context`. The lines `Reading cluster <name> from inside it, as this pod's service
account (read-only)...` say which case a run was in.

The pod's role cannot change anything, so a fix is never run from inside it. A
scan saved there is only a file: to run one of its fixes, run `apply` on your
own machine with your own credentials, giving the file with `--from`, where
that name is a kubectl context (see [Run a fix you approved](#run-a-fix-you-approved)).

To run the watch in a cluster as a Deployment, with the least access, see
[`deploy/README.md`](../../deploy/README.md#watch-a-cluster-from-inside-it).

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

`--json`, `--out`, `--html`, `--compare`, `--no-compare`, `--only-new`,
`--notify` and `--upload` behave as they do for `scan`, and `watch --kube`
repeats the scan. Advisories are in the reports and in what `--json` and
`--upload` carry, and in nothing a comparison or a notification is made from:
see [Also worth a look](#also-worth-a-look-advisories-which-are-not-waste). `kube --upload` is refused with `--answer-key`, which scores
a lab instead of keeping a scan: see [Keep the history](#keep-the-history).
The last scan is kept per cluster
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
lookups over that scan: the findings (with the advisories, listed apart from
them), and every Deployment, StatefulSet and DaemonSet it read, flagged or not (requests, peak use, hours of history, whether
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
  `1024Mi`;
- a percentage written near a word about spending (`bill`, `spend`), which has
  to be one the scan data states itself, such as the headroom a suggested
  request carries. A cluster scan reads no bill, so it can never say what
  share of one the waste is.

What it deliberately leaves alone, because it would flag ordinary words:
short forms such as `deploy/web`, `pvc/data` and `sts/db`, a plural, a name
with no kind in front of it, URLs, a kind written after a kind
(`deployment/statefulset`), and `-n` on a line that does not run `kubectl`.
It does not check container names, whole CPUs or plain byte counts,
replica counts, a percentage nowhere near a word about spending, or whether
the model's reasoning is sound. A quantity such as `5m` is read as millicores
even where someone meant minutes. Tests run all of this with a stand-in
model, never a real one.

`kube --record <dir>` and `--replay <dir>`, and `ask --kube` with the same two
flags, are described under [Record and replay](#record-and-replay). A recording
keeps the nodes, cut to what the scan reads (their role labels, taints,
allocatable figures), and notes whether the advisories were read. A recording
made without them, or before they existed, replays without them.

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
- `anomalies` judges one day against the days before it with a fixed rule, and
  does not flag a weekly job each week, since a day must also exceed the
  earlier days on its own weekday, but it cannot see a monthly pattern or a
  month-start charge, and a weekly job's second run is not flagged; a rise
  that lasts is reported until it becomes the usual day; the latest day can
  still be settling in Cost Explorer. The rule is in [Spend anomalies](#spend-anomalies). It has been
  run against a stand-in for Cost Explorer and recordings made from it, never
  against AWS: the real service's answers, and the `RECORD_TYPE` values the
  request filters on (`Credit`, `Refund`, `Tax`), have not been checked live.
- Kubernetes: peak use is taken from the history Prometheus holds. A workload
  whose busy season falls outside that window (month-end, a yearly sale) will
  look over-requested; widen `--lookback-hours` or label it
  `cloudpilot/ignore=true`.
- Kubernetes: a past pod is matched to its workload by name, so two workloads
  named alike in one namespace (`api` and `api-v2`) can, rarely, share history.
- Kubernetes: the output check for model text is a guard against invented
  values, not proof that what a model says about them is right. What it covers
  is listed under
  [Explain, ask, record and replay](#explain-ask-record-and-replay).
- Kubernetes: limits are not changed by the findings, and a workload kept in
  sync by Helm, Argo CD or Flux must be changed at its source. The finding says so.
- Kubernetes advisories: they are fixed rules over one reading of the cluster,
  not a health check. `out-of-memory` rests on the pod's last stop, which
  Kubernetes keeps only while the pod exists, and says nothing of how often it
  happens. `restarting` cannot tell a crash from a deliberate restart. A pod
  that is `Pending` only for a moment, while a node autoscaler adds a node, is
  reported as `unschedulable` with how long it has waited. The figure the
  `out-of-memory` command suggests is the limit plus 25%, not a measurement.
- Kubernetes advisories, spare node capacity: an estimate by totals, described
  under [Also worth a look](#also-worth-a-look-advisories-which-are-not-waste).
  It has been run on the offline recording and on a hand-built cluster of nodes,
  not on a live cluster with more than one node, because the lab has one. Its
  dollar figure is not part of any total, by design.
- Kubernetes, inside a cluster: the name given with `--cluster-name` is taken on
  trust, since a pod cannot ask the cluster what your team calls it. And
  `deploy/kube-watch.yaml` keeps the watch's baseline in an `emptyDir`, so a
  restarted or rescheduled pod sends its first report again. See
  [`deploy/README.md`](../../deploy/README.md#limits).

- Notifications: if the first scan finds nothing, nothing is sent, so there is
  no message to prove that a webhook works. Try a new URL on an account or
  cluster that has findings.
- Notifications: a round where some checks could not run is reported in the
  message when there is one, and in the output, but does not send a message of
  its own.
- Notifications: with several URLs, a message that one of them refused is
  retried for that one only by `watch`. A one-shot `scan` leaves the findings
  new, so the next run sends the message to every URL again.
- Uploads: a scan that could not be uploaded is not kept and sent later. The
  next run uploads its own result, so the service has no scan for the gap.
- Uploads: only the address you give is used. CloudPilot does not look the
  service up, and does not follow a redirect.
- Uploads: `--upload` has only been run against a stand-in for the service on
  the same machine, which answers as the service's documentation says it does.
  It has not been run against a deployed service.

## Development

```sh
npm test            # unit tests and replay tests, no AWS or network needed
npm run test:lab    # records and replays a scan of the live waste lab
npm run test:kube-lab   # the Kubernetes lab (a kind cluster on this machine): scans it, and applies one fix
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
`src/compare.ts` is a pure function from two scans to what changed, and
`src/anomaly.ts` a pure function from daily costs to the services that cost
more than usual, with no clock and no AWS in it.
`src/preflight.ts` holds the `init` checks as functions over injected probes,
with the real AWS probes beside them.
`src/notify.ts` builds and sends the messages, and `src/watch.ts` is the loop
behind `watch`: it is handed the scan, the clock and the sender, so its tests
run without waiting or a network.
`src/apply.ts` is the only module that can change anything: it chooses the
fix, asks, and runs the commands through `aws` or `kubectl`. `src/autopilot.ts`
is the list of reasons `watch --autopilot` has to refuse a fix before it hands
one to `apply`'s machinery, and `src/audit.ts` is the log both write.

## Licence

Copyright (C) 2026 Meru Apps. CloudPilot is free software under the GNU
Affero General Public License, version 3 (`AGPL-3.0-only`). See `LICENSE`.

The HTML report embeds two typefaces, Archivo and Courier Prime, both under
the SIL Open Font License. Their licence texts are in `licenses/`.
