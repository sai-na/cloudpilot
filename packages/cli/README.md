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
fetched), with a copy button on each command and a print layout.

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

Every tool is marked read-only, and they make the same AWS calls as the
list above and nothing else. The server tells the client's model the same
ground rules `ask` uses: quote figures exactly, and present fix commands as
proposals for a person. Two things differ from `ask`. The tool results (the
findings and inventory of your account) go to whichever model your client
uses. And CloudPilot cannot check what that model then writes, so the
output check does not apply.

`--region`, `--profile`, `--redact-account` and `--replay <dir>` work here
too. With `--replay` every result starts with the `REPLAY MODE` banner.

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

## Options

| Option | Meaning |
|---|---|
| `--profile <name>` | AWS profile to read with. Defaults to `AWS_PROFILE`, then the standard credential chain |
| `--region <region>` | Scan only this region |
| `--all-regions` | Scan every region enabled for the account. The default when `--region` is not given |
| `--html <file>` | `scan` only: also write a self-contained HTML report |
| `--out <file>` | `scan` only: also write a Markdown report |
| `--json` | `scan` only: print the result as JSON |
| `--explain` | `scan` only: have a model write the summary |
| `--compare <file>` | `scan` only: say what changed since this earlier scan. Default: the last scan made from this directory |
| `--no-compare` | `scan` only: do not compare |
| `--only-new` | `scan` only: list only the findings that are new since the earlier scan |
| `--lookback-hours <n>` | Hours of CPU history used to judge idleness. Default 24 |
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

## Development

```sh
npm test            # unit tests and replay tests, no AWS or network needed
npm run test:lab    # records and replays a scan of the live waste lab
npm run typecheck
```

`src/mcp.ts` is the MCP server (protocol only, no dependencies);
`src/detect.ts` is a pure function from inventory and prices to findings;
`src/collect.ts` holds every AWS read; `src/advisor.ts` holds the model's
ground rules and tools, with `src/claude.ts` and `src/openai.ts` as providers.

## Licence

Copyright (C) 2026 Meru Apps. CloudPilot is free software under the GNU
Affero General Public License, version 3 (`AGPL-3.0-only`). See `LICENSE`.
