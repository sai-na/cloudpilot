/**
 * The daily report: deploy/daily-report.yaml, a CloudFormation template a
 * person deploys into their own account. The template is read the way
 * CloudFormation reads it, and the job inside it is run for real, with `aws`
 * and `npx` replaced by stand-ins: S3 is a folder, sent emails are a file, and
 * CloudPilot is the code in this repository replaying the recorded lab.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isScanResult } from "../src/compare.js";
import type { ScanResult } from "../src/types.js";
import { CLI, FIXTURE, TSX } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const BLOCK_NETWORK = resolve(here, "block-network.cjs");

// CloudFormation's short forms, read as the long forms they stand for.
const intrinsic = (short: string, long: string) => ({ tag: `!${short}`, resolve: (value: string) => ({ [long]: value }) });
const template = parse(readFileSync(join(ROOT, "deploy/daily-report.yaml"), "utf8"), {
  customTags: [intrinsic("Ref", "Ref"), intrinsic("Sub", "Fn::Sub"), intrinsic("GetAtt", "Fn::GetAtt")],
});

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}
const statements = (role: string, policy: string): Statement[] =>
  template.Resources[role].Properties.Policies.find((p: { PolicyName: string }) => p.PolicyName === policy).PolicyDocument.Statement;

test("the scan runs with exactly the read-only policy CloudPilot documents", () => {
  const documented = JSON.parse(readFileSync(join(ROOT, "docs/cloudpilot-readonly-policy.json"), "utf8"));
  assert.deepEqual(statements("ScanRole", "cloudpilot-read-only"), documented.Statement);
});

test("beyond reading, the stack may only write its log, keep one state file, send the report and start the scan", () => {
  const extra = [...statements("ScanRole", "daily-job"), ...statements("ScheduleRole", "start-the-scan")];
  const granted = extra.flatMap((s) => [s.Action].flat()).sort();
  assert.deepEqual(granted, ["codebuild:StartBuild", "logs:CreateLogStream", "logs:PutLogEvents", "s3:GetObject", "s3:PutObject", "sns:Publish"]);
  for (const s of extra) {
    assert.equal(s.Effect, "Allow");
    assert.notEqual(s.Resource, "*", `${s.Sid ?? s.Action} names the one resource it is for`);
  }
  const state = statements("ScanRole", "daily-job").find((s) => s.Sid === "KeepThePreviousScan")!;
  assert.deepEqual(state.Resource, { "Fn::Sub": "${StateBucket.Arn}/last-scan.json" });
  assert.deepEqual(Object.keys(template.Resources).filter((name) => template.Resources[name].Type === "AWS::IAM::Role"), ["ScanRole", "ScheduleRole"]);
});

test("it scans daily unless told otherwise, and a failed scan sends an email of its own", () => {
  assert.equal(template.Parameters.Schedule.Default, "rate(1 day)");
  assert.deepEqual(template.Resources.DailySchedule.Properties.ScheduleExpression, { Ref: "Schedule" });
  const failed = template.Resources.ScanFailed.Properties;
  assert.deepEqual(failed.EventPattern.detail["project-name"], [{ Ref: "ScanJob" }]);
  assert.deepEqual(failed.EventPattern.detail["build-status"], ["FAILED", "FAULT", "TIMED_OUT"]);
  assert.deepEqual(failed.Targets[0].Arn, { Ref: "ReportTopic" });
});

/** The shell script CodeBuild runs, taken out of the template's build specification. */
const job: string = parse(template.Resources.ScanJob.Properties.Source.BuildSpec).phases.build.commands[0];

const AWS_STAND_IN = `#!/usr/bin/env node
// A stand-in for the AWS CLI: S3 is a folder, and sent messages are lines in a file.
const fs = require("fs");
const path = require("path");
const [service, action, ...rest] = process.argv.slice(2);
const flag = (name) => rest[rest.indexOf(name) + 1];
const store = (key) => path.join(process.env.FAKE_AWS, "s3", key);
const local = (p) => (p.startsWith("s3://") ? store(p.split("/").slice(3).join("/")) : p);
if (service === "s3api" && action === "head-object") process.exit(fs.existsSync(store(flag("--key"))) ? 0 : 254);
if (service === "s3" && action === "cp") {
  fs.mkdirSync(path.dirname(local(rest[1])), { recursive: true });
  fs.copyFileSync(local(rest[0]), local(rest[1]));
  process.exit(0);
}
if (service === "sns" && action === "publish") {
  if (process.env.FAKE_SNS_DOWN) { console.error("sns is down"); process.exit(255); }
  const message = fs.readFileSync(flag("--message").replace("file://", ""), "utf8");
  fs.appendFileSync(path.join(process.env.FAKE_AWS, "sent.jsonl"), JSON.stringify({ topic: flag("--topic-arn"), subject: flag("--subject"), message }) + "\\n");
  console.log('{"MessageId":"1"}');
  process.exit(0);
}
console.error("the job called something it should not: aws " + process.argv.slice(2).join(" "));
process.exit(2);
`;

// npx -y <package> <args>: runs this repository's CloudPilot on the recorded lab, with every socket blocked.
const NPX_STAND_IN = `#!/bin/sh
echo "$*" >> "$FAKE_AWS/npx.log"
shift 2
exec node --require "${BLOCK_NETWORK}" --import "${TSX}" "${CLI}" "$@" --replay "${FIXTURE}"
`;

/** One account's worth of fake AWS, and a way to run the daily job against it. */
function account() {
  const fake = mkdtempSync(join(tmpdir(), "cloudpilot-daily-"));
  const bin = join(fake, "bin");
  mkdirSync(bin);
  for (const [name, body] of [["aws", AWS_STAND_IN], ["npx", NPX_STAND_IN]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const statePath = join(fake, "s3/last-scan.json");
  return {
    statePath,
    state: (): ScanResult => JSON.parse(readFileSync(statePath, "utf8")),
    sent: (): Array<{ topic: string; subject: string; message: string }> =>
      existsSync(join(fake, "sent.jsonl")) ? readFileSync(join(fake, "sent.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    npxCalls: () => readFileSync(join(fake, "npx.log"), "utf8").trim().split("\n"),
    /** Each day's run starts in an empty directory, as a fresh build container does. */
    run(env: Record<string, string> = {}) {
      return spawnSync("sh", ["-c", job], {
        cwd: mkdtempSync(join(tmpdir(), "cloudpilot-daily-run-")),
        encoding: "utf8",
        env: {
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: process.env.HOME ?? "",
          // Colour forced on, as on a terminal: the emailed file must stay plain regardless.
          FORCE_COLOR: "1",
          FAKE_AWS: fake,
          STATE_BUCKET: "state-bucket",
          TOPIC_ARN: "arn:aws:sns:ap-south-1:123456789012:report",
          SCAN_REGION: "",
          PACKAGE_SPEC: "@meruapps/cloudpilot",
          STACK_NAME: "cloudpilot-daily",
          ...env,
        },
      });
    },
  };
}

test("the first run emails the whole report and keeps the scan for tomorrow", () => {
  const aws = account();
  const run = aws.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /No earlier scan: this is the first run/);

  const saved = aws.state();
  assert.ok(isScanResult(saved), "what is kept is a scan the next run can compare with");
  assert.equal(saved.findings.length, 10);

  const sent = aws.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.topic, "arn:aws:sns:ap-south-1:123456789012:report");
  assert.equal(sent[0]!.subject, `CloudPilot: first report, 10 findings, $${saved.totalMonthlyWasteUsd.toFixed(2)} a month, AWS account 123456789012`);
  assert.ok(sent[0]!.subject.length <= 100, "an SNS subject holds at most 100 characters");
  assert.match(sent[0]!.message, /10 findings, \$\d+\.\d\d per month of estimated waste/);
  // The reason it gives is a replay's (a recording is never compared by itself); a live first run says there is no earlier scan.
  assert.match(sent[0]!.message, /; showing every finding\./);
  for (const f of saved.findings) assert.ok(sent[0]!.message.includes(f.fix.commands[0]!), `the email carries the fix for ${f.title}`);
  assert.doesNotMatch(sent[0]!.message, /\u001b\[/, "an email has no colour codes");
  assert.match(sent[0]!.message, /comes from the CloudFormation stack "cloudpilot-daily" in your own AWS account\. Delete that stack to stop it\.\n$/);
});

test("a day with nothing new sends no email", () => {
  const aws = account();
  assert.equal(aws.run().status, 0);
  const second = aws.run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Nothing new since the last scan\. No email sent\./);
  assert.equal(aws.sent().length, 1, "only the first run's email");
  assert.equal(aws.state().findings.length, 10);
});

test("a new finding sends an email about that finding alone", () => {
  const aws = account();
  assert.equal(aws.run().status, 0);
  // Yesterday the most expensive finding was not there yet.
  const yesterday = aws.state();
  const [added, ...rest] = yesterday.findings;
  writeFileSync(aws.statePath, JSON.stringify({ ...yesterday, scannedAt: "2026-10-01T00:00:00Z", findings: rest }));

  const run = aws.run();
  assert.equal(run.status, 0, run.stderr);
  const sent = aws.sent();
  assert.equal(sent.length, 2);
  const email = sent[1]!;
  assert.equal(email.subject, `CloudPilot: 1 new finding, $${added!.monthlyCostUsd.toFixed(2)} a month, AWS account 123456789012`);
  assert.match(email.message, /Since the last scan \(2026-10-01T00:00:00Z\): 1 new/);
  assert.match(email.message, /Showing only the 1 new finding\./);
  assert.ok(email.message.includes(added!.fix.commands[0]!));
  assert.ok(!email.message.includes(rest[0]!.fix.commands[0]!), "findings already reported are left out");
  assert.equal(aws.state().findings.length, 10, "and today's scan becomes the new baseline");
});

test("if the email cannot be sent the run fails and the findings stay new for the next run", () => {
  const aws = account();
  const failed = aws.run({ FAKE_SNS_DOWN: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(aws.statePath), false, "nothing is kept, so nothing is silently marked as reported");
  // The next day sending works again, and the report is still the full first one.
  const next = aws.run();
  assert.equal(next.status, 0, next.stderr);
  assert.match(aws.sent()[0]!.subject, /first report, 10 findings/);
});

test("the region and the package version chosen at deploy time reach the scan", () => {
  const aws = account();
  const run = aws.run({ SCAN_REGION: "ap-south-1", PACKAGE_SPEC: "@meruapps/cloudpilot@0.1.0" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(aws.npxCalls(), ["-y @meruapps/cloudpilot@0.1.0 scan --json --out report.txt --only-new --region ap-south-1"]);
  // Every region unless one was chosen.
  const everywhere = account();
  assert.equal(everywhere.run().status, 0);
  assert.deepEqual(everywhere.npxCalls(), ["-y @meruapps/cloudpilot scan --json --out report.txt --only-new"]);
});
