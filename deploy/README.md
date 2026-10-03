# Daily report

CloudPilot can check your account every day without you, and write to you
only when there is something new to decide. Nothing to open, nothing to
remember to run.

It runs in your own AWS account, from a CloudFormation template you can read
before you deploy it: [`daily-report.yaml`](daily-report.yaml).

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
