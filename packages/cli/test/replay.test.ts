/** Offline tests against a committed, account-redacted recording of the waste lab. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.ok((html.match(/<button type="button" data-copy>Copy<\/button>/g)?.length ?? 0) >= 10);
  assert.match(html, /<strong>Way back:<\/strong>/);
  assert.match(html, /<h2>Summary<\/h2>/);
  // The only 12-digit number anywhere in the file is the stand-in account ID.
  assert.deepEqual([...new Set(html.match(/\b\d{12}\b/g))], ["123456789012"]);
  // Nothing is fetched: no links, sources, imports or CSS urls.
  assert.doesNotMatch(html, /\b(?:src|href)=|@import|url\(|https?:\/\//);
});
