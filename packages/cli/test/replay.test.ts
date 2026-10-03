/** Offline tests against a committed, account-redacted recording of the waste lab. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cli, FIXTURE, recordingText, SECRET_MARKERS } from "./helpers.js";

const BANNER = /^REPLAY MODE: recorded \S+ from account 123456789012, region ap-south-1\. No live calls\.$/m;

test("replay succeeds with every socket blocked and no credentials", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.findings.length, 10);
  assert.equal(result.accountId, "123456789012");
  assert.match(result.replay, BANNER);
  assert.match(run.stderr, BANNER);
});

test("a replayed report starts with the replay banner", () => {
  const run = cli(["scan", "--replay", FIXTURE], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.split("\n")[0]!, BANNER);
});

test("two replays of one recording give byte-identical output", () => {
  const first = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  const second = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  assert.equal(first.stdout, second.stdout);
});

test("a recorded question replays its lookups and answer with no network", () => {
  const question = "What should I fix first, and what is the risk?";
  const run = cli(["ask", "--replay", FIXTURE, question], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, BANNER);
  assert.match(run.stderr, /looking up: list_findings/);
  assert.match(run.stdout, /vol-[0-9a-f]+/);
});

test("an unrecorded question is refused and the recorded ones are listed", () => {
  const run = cli(["ask", "--replay", FIXTURE, "What is the weather?"], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /This question was not recorded\. Recorded questions:/);
  assert.match(run.stderr, /What should I fix first, and what is the risk\?/);
  assert.equal(run.stdout, "");
});

test("a request missing from the recording fails loudly, naming service and operation", () => {
  // A different lookback window asks CloudWatch for data the recording does not hold.
  const run = cli(["scan", "--replay", FIXTURE, "--lookback-hours", "5"], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Replay: no recorded response for CloudWatch GetMetricData/);
  assert.match(run.stderr, /never falls back to the network/);
});

test("the recording holds no credentials, signatures or tokens", () => {
  const text = recordingText(FIXTURE);
  for (const marker of SECRET_MARKERS) assert.ok(!text.includes(marker), `recording contains ${marker}`);
});

test("without a model key, scan still prints every finding, cost and fix command", () => {
  const run = cli(["scan", "--replay", FIXTURE], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /10 findings, \$\d+\.\d\d per month of estimated waste/);
  assert.equal(run.stdout.match(/^\s+\d+\.\s+\$\d+\.\d\d\/mo /gm)?.length, 10);
  assert.ok((run.stdout.match(/^\s+aws (ec2|s3api) /gm)?.length ?? 0) >= 10);
  assert.match(run.stdout, /rule confidence \d+%/);
});

test("without a model key, ask stops with a clear message before reading AWS", () => {
  const run = cli(["ask", "--region", "ap-south-1", "What should I fix first?"], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No model access configured\. Set ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  assert.equal(run.stdout, "");
});

test("without a model key, scan --explain says so in one line and shows the templated summary", () => {
  // --live-llm asks for a live model; with no key set there is none.
  const run = cli(["scan", "--replay", FIXTURE, "--live-llm", "--explain"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const notices = run.stderr.split("\n").filter((line) => line.includes("AI explanations are unavailable"));
  assert.deepEqual(notices, ["AI explanations are unavailable: no model API key is set. Showing the templated summary instead."]);
  assert.match(run.stdout, /\nSummary\n\nEstimated waste: \$\d+\.\d\d per month across 10 findings in ap-south-1\./);
  assert.match(run.stdout, /Nothing has been changed: every fix is a proposal/);
});

test("a recorded AI summary replays with no network and passes the output check", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--explain"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /discarded|unavailable/);
  assert.match(run.stdout, /\nSummary\n\n/);
  assert.doesNotMatch(run.stdout, /\nSummary\n\nEstimated waste:/);
});

test("a plain scan needs no subcommand and ends with the templated summary", () => {
  const run = cli(["--replay", FIXTURE], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /10 findings, \$\d+\.\d\d per month of estimated waste/);
  assert.match(run.stdout, /\nSummary\n\nEstimated waste: \$\d+\.\d\d per month across 10 findings in ap-south-1\./);
  assert.doesNotMatch(run.stderr, /unavailable/);
});

test("the HTML report is one self-contained file carrying the replay banner and the redacted account", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--explain", "--html", "report.html"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const html = readFileSync(join(run.cwd, "report.html"), "utf8");

  assert.match(html, /<p class="replay" role="note">REPLAY MODE: recorded \S+ from account 123456789012, region ap-south-1\. No live calls\.<\/p>/);
  assert.equal(html.match(/<article class="finding">/g)?.length, 10);
  assert.match(html, /rule confidence \d+%/);
  assert.ok((html.match(/data-risk="dangerous"/g)?.length ?? 0) >= 8);
  assert.equal(html.match(/<button\b/g)?.length, 1, "one button copies the whole script");
  assert.ok((html.match(/<input type="checkbox"/g)?.length ?? 0) >= 10, "every fix can be ticked");
  assert.match(html, /<strong>Way back:<\/strong>/);
  assert.match(html, /<h2>Summary<\/h2>/);
  // The only 12-digit number anywhere in the file is the stand-in account ID.
  assert.deepEqual([...new Set(html.match(/\b\d{12}\b/g))], ["123456789012"]);
  // Nothing is fetched: no sources or imports, the only link points within the page,
  // and the only CSS urls are the three typefaces carried inside the file itself.
  assert.doesNotMatch(html, /\bsrc=|\bhref="(?!#)|@import|https?:\/\//);
  assert.deepEqual(html.match(/url\(.{0,23}/g), Array(3).fill("url(data:font/woff2;base64,"));
  assert.deepEqual(html.match(/\bhref="[^"]*"/g), ['href="#script"']);
});

test("a role without the database permission still gets a full scan: the denied check becomes a warning", () => {
  // The recorded database read, answered the way IAM answers a role that may not make it.
  const denied =
    '<ErrorResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/">\n  <Error>\n    <Type>Sender</Type>\n    <Code>AccessDenied</Code>\n' +
    "    <Message>User: arn:aws:sts::123456789012:assumed-role/cloudpilot-readonly/session is not authorized to perform: rds:DescribeDBInstances</Message>\n" +
    "  </Error>\n  <RequestId>00000000-0000-0000-0000-000000000000</RequestId>\n</ErrorResponse>";
  const dir = join(mkdtempSync(join(tmpdir(), "cloudpilot-denied-")), "recording");
  cpSync(FIXTURE, dir, { recursive: true });
  const file = join(dir, "scan/aws.json");
  const recorded = JSON.parse(readFileSync(file, "utf8")) as { entries: Record<string, Array<{ service: string; status: number; headers: Record<string, string>; body: string }>> };
  const rds = Object.values(recorded.entries).filter((responses) => responses[0]!.service === "RDS");
  assert.equal(rds.length, 1, "the recording holds the one database read");
  Object.assign(rds[0]![0]!, { status: 403, headers: { "content-type": "text/xml" }, body: Buffer.from(denied).toString("base64") });
  writeFileSync(file, JSON.stringify(recorded));

  const run = cli(["scan", "--replay", dir, "--json"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.findings.length, 10);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^\[ap-south-1\] rds:DescribeDBInstances: AccessDenied/);
});

test("the lab holds no database or oversized instance, so the recorded scan reports neither rule", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.warnings, []);
  assert.ok(!result.findings.some((f: { pattern: string }) => f.pattern === "idle-rds-instance" || f.pattern === "oversized-instance"));
});
