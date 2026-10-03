# CloudPilot

A read-only command that finds the money your AWS account is wasting and
prints the exact command that would fix each item. It changes nothing.

```sh
npx @meruapps/cloudpilot
```

Run it in AWS CloudShell, or anywhere with Node 18 or later and AWS
credentials. It reads every region enabled for the account and ends with an
itemised list: what is wasted, the evidence, what it costs per month, the fix
command, and what about that fix cannot be undone.

## What it finds

In an AWS account:

Unattached EBS volumes, gp2 volumes that would be cheaper as gp3, idle
Elastic IPs, stopped instances still paying for storage, idle running
instances, snapshots of deleted volumes, unused AMIs, buckets with no
lifecycle rule, and incomplete multipart uploads. The rules, their
confidence and their limits are in [`packages/cli/README.md`](packages/cli/README.md).

In a Kubernetes cluster, with `npx @meruapps/cloudpilot kube`:

Workloads that request more CPU or memory than they use, volume
claims no pod mounts, and volumes left Released. It reads through your own
`kubectl` and the cluster's Prometheus, and prints the `kubectl` command for
each fix with the old values as the way back.

## How it works

1. **Read.** It asks AWS what exists, using only Describe, List and Get calls.
2. **Apply rules.** Each kind of waste is a fixed rule over what it read.
3. **Price.** Unit prices come from the AWS Price List.
4. **Report.** Findings go to the terminal, and optionally to JSON, Markdown
   or a self-contained HTML file.

None of that uses AI, so the same account always gives the same answer and no
API key is needed. A model is optional: with a key, `--explain` writes the
summary in prose and `ask` answers questions about the findings. The model
never computes a figure, and its text is discarded if it mentions a number or
resource ID that is not in the scan.

## How it stays safe

- **It only reads.** Every AWS call is listed in the CLI README, and a test
  fails if the code calls anything else.
- **It never runs a fix.** It prints the commands for a person to review.
- **It runs in your account,** with your credentials, and sends no telemetry.
- **It is open source,** so you can read what it checks.

## A daily report, without asking

Deploy one CloudFormation template and CloudPilot scans the account every day
in the background. It emails you only on a day something new appears, with
only the new findings; a day with nothing new sends nothing. It runs in your
own account with the same read-only access. See [`deploy/`](deploy).

Run by hand, a repeat scan does the same: it compares with the last scan and
says what is new, what was resolved and what is unchanged.

## Also in the box

- **A check before the first scan.** `cloudpilot init` says whether a scan
  will work from where you are: who the credentials are, which of its reads
  they are allowed, and whether the cluster can be read. Where access is
  refused it prints the commands for you to run. It creates and changes
  nothing.
- **What changed since last time.** A repeat scan compares with the last one
  made from the same directory and says what is new, what was resolved and
  what is unchanged, so nobody re-reads every finding.
- **MCP server.** `cloudpilot mcp` lets Claude Code, Cursor and other MCP
  clients scan the account and query the findings through read-only tools.
- **Record and replay.** A scan can be recorded and replayed later with no
  network, behind a `REPLAY MODE` banner.
- **Ignore tag.** Resources tagged `cloudpilot:ignore=true` are skipped, and
  the report says how many.

## In this repository

| Path | What it is |
|---|---|
| [`packages/cli`](packages/cli) | The CloudPilot command, published as `@meruapps/cloudpilot` |
| [`docs/waste-lab.md`](docs/waste-lab.md) | The waste lab: a test AWS account seeded with nine kinds of waste, and the answer key CloudPilot is scored against |
| `terraform/`, `scripts/`, `emulator/`, `lab-spec.json`, `pricing/` | The lab itself |
| [`k8s-lab/`](k8s-lab) | The Kubernetes waste lab: a local cluster with seeded waste and its answer key |
| [`deploy/`](deploy) | The daily report: a CloudFormation template that runs the scan on a schedule in your own account and emails what is new |
| [`demo/`](demo) | Demo runbook and the record and replay scripts |
| [`site/`](site) | The landing page |

## Licence

Copyright (C) 2026 Meru Apps.

CloudPilot is free software: you can redistribute it and modify it under the
terms of the GNU Affero General Public License, version 3, as published by
the Free Software Foundation. It is distributed without any warranty. See
[`LICENSE`](LICENSE).
