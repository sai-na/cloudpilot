/**
 * `cloudpilot anomalies` as a person runs it: the real command against a
 * stand-in for AWS on 127.0.0.1 (see cost-explorer.ts), and against its own
 * recordings. No Cost Explorer request is ever made, so none is charged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cli, cliRun, FIXTURE, recordingText, SECRET_MARKERS } from "./helpers.js";
import { answer, type Day, fakeCostExplorer, type Reply, series, together, utcDay } from "./cost-explorer.js";
import { hook, SECRET } from "./webhook.js";

const CHARGE = "Cost Explorer: AWS charges $0.01 for each request, and this makes one (more only if AWS splits the answer into pages).";

const flat = (service: string, usd: number, n: number, today: string) => series(service, Array<number>(n).fill(usd), utcDay(1, new Date(`${today}T00:00:00Z`)));

/** `n` days of one service ending the day before yesterday, so that yesterday is left for the day to be judged. */
const earlier = (service: string, usd: number, n: number, today: string) => series(service, Array<number>(n).fill(usd), utcDay(2, new Date(`${today}T00:00:00Z`)));

/** Thirty complete days: EC2 flat at 12.30 and then 45.20 yesterday, S3 flat at 3.00. */
const spiking = (today: string): Day[] =>
  together(series("Amazon Elastic Compute Cloud - Compute", [...Array<number>(29).fill(12.3), 45.2], utcDay(1, new Date(`${today}T00:00:00Z`))), flat("Amazon Simple Storage Service", 3, 30, today));
const quiet = (today: string): Day[] => together(flat("Amazon Elastic Compute Cloud - Compute", 12.3, 30, today), flat("Amazon Simple Storage Service", 3, 30, today));

/**
 * A recording made against the stand-in holds the stand-in's host name, so a
 * replay of it is pointed at the same name; nothing listens there, and the
 * network is blocked besides. A recording made against AWS needs none of this.
 */
const REPLAY = { blockNetwork: true, env: { AWS_ENDPOINT_URL: "http://127.0.0.1:9" } };

interface Options {
  env?: Record<string, string>;
  cwd?: string;
  blockNetwork?: boolean;
  accountId?: string;
}

/**
 * Run the command against the stand-in. The days are built from today's UTC
 * date, so a run that straddled midnight UTC is run again rather than judged.
 */
async function live(replies: (today: string) => Reply[], args: string[] = [], options: Options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const today = utcDay();
    const ce = await fakeCostExplorer(replies(today), options.accountId);
    try {
      const run = await cliRun(["anomalies", ...args], { cwd: options.cwd, env: { ...ce.env, ...options.env } });
      if (utcDay() === today) return { ...run, today, ce };
    } finally {
      await ce.close();
    }
  }
  throw new Error("the UTC date changed during three runs in a row");
}

const withAnswer = (days: (today: string) => Day[]) => (today: string) => [answer(days(today))];

test("the first line says what the request costs, then the anomalies, with exactly one Cost Explorer request and nothing else read", async () => {
  const run = await live(withAnswer(spiking));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.split("\n")[0], CHARGE);
  assert.match(run.stdout, /1 service cost more than usual on /);
  assert.match(run.stdout, /1\. Amazon Elastic Compute Cloud - Compute\n\s+\d{4}-\d\d-\d\d\s+\$45\.20\n\s+usual day\s+\$12\.30\s+\(median of the 29 days before\)\n\s+difference\s+\+\$32\.90 a day; if this continues, about \+\$987\.00 over 30 days/);
  assert.match(run.stdout, /Total: \+\$32\.90 a day more than usual across 1 service\./);
  assert.match(run.stdout, /Cost Explorer requests made: 1 \(AWS charges \$0\.01 each\)\./);
  assert.doesNotMatch(run.stdout, /Simple Storage/, "the flat service is not listed");
  assert.deepEqual(run.ce.actions, ["GetCallerIdentity", "GetCostAndUsage"]);
  assert.equal(run.ce.requests.length, 1);
  assert.equal(run.stderr, "");
});

test("the one request asks for daily unblended cost by service, up to but not including today, without credits, refunds or tax", async () => {
  const run = await live(withAnswer(quiet));
  assert.equal(run.status, 0, run.stderr);
  const [request] = run.ce.requests;
  assert.deepEqual(request, {
    TimePeriod: { Start: utcDay(30, new Date(`${run.today}T00:00:00Z`)), End: run.today },
    Granularity: "DAILY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    Filter: { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund", "Tax"] } } },
  });
  assert.equal(request.NextPageToken, undefined, "no page token on the first request");
});

test("with nothing unusual it says so in one calm line and exits 0", async () => {
  const run = await live(withAnswer(quiet));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Nothing unusual on \d{4}-\d\d-\d\d: no service cost at least \$1\.00 a day more than its usual day and beyond its normal range \(2 services checked\)\.$/m);
  assert.doesNotMatch(run.stdout, /Total:|cost more than usual/);
});

test("the day in progress is ignored, and the output says the last days may still change", async () => {
  // Cost Explorer sometimes returns the day in progress when asked for it: a huge partial figure and a brand-new service must not count.
  const run = await live((today) => [answer([...quiet(today), { day: today, costs: { "Amazon Elastic Compute Cloud - Compute": 900, "Amazon Bedrock": 500 } }])]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Nothing unusual on /m);
  assert.match(run.stdout, new RegExp(`Today \\(${run.today}\\) is still in progress and is not used\\.`));
  assert.match(run.stdout, /Cost Explorer can take a day or two to settle, so the figures for the last day or two may still change\./);
  assert.match(run.stdout, new RegExp(`Judged: ${utcDay(1)}, the latest complete day`));
});

test("--json prints one JSON document on stdout and the charge on stderr", async () => {
  const run = await live(withAnswer(spiking), ["--json"]);
  assert.equal(run.status, 0, run.stderr);
  const json = JSON.parse(run.stdout);
  assert.equal(run.stderr.trim(), CHARGE);
  assert.deepEqual(Object.keys(json), [
    "command", "accountId", "charge", "status", "today", "windowDays", "latestDay", "latestDayEstimated", "baseline", "baselineDaysFound",
    "servicesChecked", "rule", "anomalies", "totalIncreaseUsd", "totalMonthlyIfContinuesUsd", "note",
  ]);
  assert.deepEqual([json.command, json.accountId, json.status, json.today, json.latestDay, json.windowDays, json.servicesChecked], ["anomalies", "123456789012", "ok", run.today, utcDay(1), 30, 2]);
  assert.deepEqual(json.charge, { requests: 1, usdPerRequest: 0.01, notice: CHARGE });
  assert.deepEqual(json.baseline, { days: 29, from: utcDay(30), to: utcDay(2) });
  assert.deepEqual(json.anomalies, [
    {
      service: "Amazon Elastic Compute Cloud - Compute",
      kind: "spike",
      day: utcDay(1),
      costUsd: 45.2,
      medianUsd: 12.3,
      madUsd: 0,
      increaseUsd: 32.9,
      monthlyIfContinuesUsd: 987,
      baselineDays: 29,
    },
  ]);
  assert.deepEqual([json.totalIncreaseUsd, json.totalMonthlyIfContinuesUsd], [32.9, 987]);
  assert.equal(json.replay, undefined);
});

test("with too little history it says so and exits 0 with no findings", async () => {
  const run = await live((today) => [answer(earlier("Amazon EC2", 5, 6, today).concat([{ day: utcDay(1), costs: { "Amazon EC2": 500 } }]))]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Not enough history to judge: 6 complete days before \d{4}-\d\d-\d\d, and at least 7 are needed/);
  assert.doesNotMatch(run.stdout, /cost more than usual|Nothing unusual/);
  const json = JSON.parse((await live((today) => [answer(earlier("Amazon EC2", 5, 6, today))], ["--json"])).stdout);
  assert.deepEqual([json.status, json.anomalies], ["not-enough-history", []]);
});

test("a new account with no cost data says that, and exits 0", async () => {
  const run = await live(() => [answer([])]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Cost Explorer returned no cost data for those days, so nothing was judged\./);
});

test("--days sets the window, and --sensitivity and --min-increase move the rule", async () => {
  const eight = await live((today) => [answer(earlier("Amazon EC2", 5, 7, today).concat([{ day: utcDay(1), costs: { "Amazon EC2": 50 } }]))], ["--days", "8"]);
  assert.equal(eight.status, 0, eight.stderr);
  assert.deepEqual(eight.ce.requests[0].TimePeriod, { Start: utcDay(8), End: eight.today });
  assert.match(eight.stdout, /1 service cost more than usual/);
  assert.match(eight.stdout, /over the last 8 days/);
  const ninety = await live(withAnswer(quiet), ["--days", "90"]);
  assert.deepEqual(ninety.ce.requests[0].TimePeriod, { Start: utcDay(90), End: ninety.today });

  // 12.30 to 45.20 is a rise of 32.90: flagged by default, not with a floor above it.
  const floor = await live(withAnswer(spiking), ["--min-increase", "40"]);
  assert.match(floor.stdout, /^Nothing unusual/m);
  assert.match(floor.stdout, /at least \$40\.00 a day more/);
  // A noisy baseline: 10 +/- 1, and a day at 15 is flagged at k = 3 and not at k = 6.
  const noisy = (today: string) => [answer(series("S", [...Array.from({ length: 29 }, (_, i) => [9, 10, 11][i % 3]!), 15], utcDay(1, new Date(`${today}T00:00:00Z`))))];
  assert.match((await live(noisy)).stdout, /1 service cost more than usual/);
  assert.match((await live(noisy, ["--sensitivity", "6"])).stdout, /^Nothing unusual/m);
});

test("a setting that makes no sense is refused before anything is asked of AWS", () => {
  const refused: Array<[string[], RegExp]> = [
    [["--days", "7"], /--days takes a whole number from 8 to 90\. Got "7"\./],
    [["--days", "91"], /--days takes a whole number from 8 to 90\. Got "91"\./],
    [["--days", "30.5"], /--days takes a whole number from 8 to 90\./],
    [["--days", "abc"], /--days takes a whole number from 8 to 90\./],
    [["--sensitivity", "0"], /--sensitivity takes a number above zero\. Got "0"\./],
    [["--sensitivity", "-2"], /--sensitivity takes a number above zero\./],
    [["--sensitivity", "lots"], /--sensitivity takes a number above zero\./],
    [["--min-increase", "-1"], /--min-increase takes a number that is zero or more\. Got "-1"\./],
    [["--min-increase", "cheap"], /--min-increase takes a number that is zero or more\./],
    [["--record", "x", "--replay", "y"], /Use --record or --replay, not both\./],
  ];
  for (const [args, message] of refused) {
    // With every socket blocked, a request made anyway would end the run with a different error than the one asked for.
    const run = cli(["anomalies", ...args], { blockNetwork: true });
    assert.equal(run.status, 1, args.join(" "));
    assert.match(run.stderr, message, args.join(" "));
    assert.equal(run.stdout, "", `${args.join(" ")}: not even the charge notice is printed, since nothing is asked of AWS`);
    assert.doesNotMatch(run.stderr, /network blocked/);
  }
});

test("when AWS pages the answer the next page is asked for with its token, each is a request, and the days are put together", async () => {
  const run = await live((today) => {
    const days = quiet(today).map((d, i) => (i === 29 ? { ...d, costs: { ...d.costs, "Amazon Elastic Compute Cloud - Compute": 45.2 } } : d));
    return [answer(days.slice(0, 15), { nextPageToken: "page-2" }), answer(days.slice(15))];
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.ce.requests.length, 2);
  assert.equal(run.ce.requests[0].NextPageToken, undefined);
  assert.equal(run.ce.requests[1].NextPageToken, "page-2");
  assert.deepEqual({ ...run.ce.requests[1], NextPageToken: undefined }, { ...run.ce.requests[0], NextPageToken: undefined }, "the same question on every page");
  assert.match(run.stdout, /Judged: .* against the 29 days before it/);
  assert.match(run.stdout, /\+\$32\.90 a day/);
  assert.match(run.stdout, /Cost Explorer requests made: 2 \(AWS charges \$0\.01 each\)\./);
});

test("an answer that never stops paging is cut off after ten requests, and says why", async () => {
  const run = await live((today) => [answer(quiet(today).slice(0, 2), { nextPageToken: "again" })]);
  assert.equal(run.status, 1);
  assert.equal(run.ce.requests.length, 10);
  assert.match(run.stderr, /Cost Explorer kept paging after 10 requests, so CloudPilot stopped rather than be charged for more\./);
});

test("a refusal from Cost Explorer is an error that names the reason, and no figure is made up", async () => {
  const denied = { status: 400, errorType: "AccessDeniedException", body: { __type: "AccessDeniedException", Message: "User: arn:aws:iam::123456789012:user/alice is not authorized to perform: ce:GetCostAndUsage" } };
  const run = await live(() => [denied]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /cloudpilot: Cost Explorer could not be read: AccessDeniedException - User: .* is not authorized to perform: ce:GetCostAndUsage/);
  assert.doesNotMatch(run.stdout, /Nothing unusual|Total:/);
  assert.equal(run.ce.requests.length, 1, "a refusal is not retried into more charges");

  const other = await live((today) => [answer(quiet(today), { unit: "INR" })]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /Cost Explorer reports .* in INR, and CloudPilot compares dollars only\./);
  const garbled = await live((today) => [answer(quiet(today), { amount: () => "lots" })]);
  assert.equal(garbled.status, 1);
  assert.match(garbled.stderr, /Cost Explorer returned an amount for .* that is not a number\./);
});

test("--help says what the request costs, and that no model is involved", () => {
  const help = cli(["anomalies", "--help"], { blockNetwork: true });
  assert.equal(help.status, 0, help.stderr);
  const text = help.stdout.replace(/\s+/g, " ");
  assert.match(text, /AWS charges \$0\.01 for each Cost Explorer request, and this makes one\./);
  assert.match(text, /median and median absolute deviation/);
  for (const flag of ["--days <n>", "--sensitivity <k>", "--min-increase <dollars>", "--json", "--profile <name>", "--notify <url>", "--record <dir>", "--replay <dir>", "--redact-account"]) assert.ok(text.includes(flag), `${flag} is offered`);
  assert.doesNotMatch(text, /--explain|--bill|--provider|--model/, "no model option, and no bill option");
  assert.match(cli(["--help"], { blockNetwork: true }).stdout.replace(/\s+/g, " "), /anomalies \[options\] Find services that cost unusually much/);
});

// ---- Record and replay ----

test("a recorded run replays with no network and no credentials, and says no request is made", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cloudpilot-anomalies-")), "recording");
  const recorded = await live(withAnswer(spiking), ["--record", dir, "--days", "30"]);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stderr, /Recorded to .*anomalies/);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.accountId, "123456789012");
  assert.deepEqual(manifest.sessions.map((s: any) => [s.id, s.command, s.days]), [["anomalies", "anomalies", 30]]);

  const replay = cli(["anomalies", "--replay", dir], REPLAY);
  assert.equal(replay.status, 0, replay.stderr);
  const lines = replay.stdout.split("\n");
  assert.match(lines[0]!, /^REPLAY MODE: recorded \S+ from account 123456789012, the last 30 days of cost\. No live calls\.$/);
  assert.equal(lines[2], "Cost Explorer is read from the recording, so no request is made and nothing is charged. A live run makes one request, which AWS charges $0.01 for.");
  assert.match(replay.stdout, /1\. Amazon Elastic Compute Cloud - Compute/);
  assert.match(replay.stdout, /Cost Explorer requests made: 0 \(read from the recording\)\./);
  // The clock is the recording's, so the same figures come out whenever it is replayed.
  assert.match(replay.stdout, new RegExp(`Judged: ${utcDay(1, new Date(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).sessions[0].recordedAt))}`));

  const json = (args: string[] = []) => cli(["anomalies", "--replay", dir, "--json", ...args], REPLAY);
  const first = json();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, json().stdout, "two replays are byte-identical");
  const parsed = JSON.parse(first.stdout);
  assert.match(parsed.replay, /^REPLAY MODE: /);
  assert.deepEqual([parsed.charge.requests, parsed.anomalies.length], [0, 1]);
  assert.match(first.stderr, /^REPLAY MODE: /m);

  assert.ok(!SECRET_MARKERS.some((marker) => recordingText(dir).includes(marker)), "the recording holds no credentials");
});

test("a replay asks for the days it was recorded with, and a different window is a miss, not a call to AWS", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cloudpilot-anomalies-")), "recording");
  const recorded = await live((today) => [answer(earlier("Amazon EC2", 5, 11, today).concat([{ day: utcDay(1), costs: { "Amazon EC2": 50 } }]))], ["--record", dir, "--days", "12"]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const same = cli(["anomalies", "--replay", dir], REPLAY);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /the last 12 days of cost/);
  assert.match(same.stdout, /1 service cost more than usual/);
  const other = cli(["anomalies", "--replay", dir, "--days", "20"], REPLAY);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /Replay: no recorded response for CostExplorer GetCostAndUsage/);
  assert.match(other.stderr, /never falls back to the network/);
});

test("a recording of something else holds no anomalies check, and says so", () => {
  const run = cli(["anomalies", "--replay", FIXTURE], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /holds no recorded spend anomalies check\. Record one with --record first\./);
});

test("--redact-account hides the account ID in the output and in the recording", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cloudpilot-anomalies-")), "recording");
  const run = await live(withAnswer(spiking), ["--redact-account", "--record", dir], { accountId: "210987654321" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Spend anomalies for AWS account 123456789012$/m);
  assert.doesNotMatch(run.stdout + run.stderr, /210987654321/);
  assert.ok(!recordingText(dir).includes("210987654321"));
  const json = await live(withAnswer(spiking), ["--redact-account", "--json"], { accountId: "210987654321" });
  assert.equal(JSON.parse(json.stdout).accountId, "123456789012");
  assert.doesNotMatch(json.stdout + json.stderr, /210987654321/);
  const plain = await live(withAnswer(spiking), [], { accountId: "210987654321" });
  assert.match(plain.stdout, /AWS account 210987654321/);
});

// ---- --notify ----

test("--notify sends one message when a service cost more than usual, and says what it is and is not", async () => {
  const webhook = await hook(() => ({ status: 200 }));
  try {
    const run = await live(withAnswer(spiking), ["--notify", webhook.url]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Sent to 127\.0\.0\.1:\d+\./);
    assert.equal(webhook.requests.length, 1);
    const body = JSON.parse(webhook.requests[0]!.body);
    assert.equal(body.event, "spend-anomalies");
    assert.equal(body.subject, "AWS account 123456789012");
    assert.equal(body.anomalies.length, 1);
    assert.match(body.text, /^CloudPilot: 1 service costs more than usual on \d{4}-\d\d-\d\d, \$32\.90 a day more, AWS account 123456789012$/m);
    assert.match(body.text, /1\. Amazon Elastic Compute Cloud - Compute: \$45\.20 on \d{4}-\d\d-\d\d, usually \$12\.30 \(\+\$32\.90 a day\)/);
    assert.match(body.text, /If all of it continued, that would add up to about \$987\.00 over 30 days\. That is arithmetic on one day, not a forecast\./);
    assert.match(body.text, /Nothing has been changed: CloudPilot only reads\./);
    assert.ok(!(run.stdout + run.stderr).includes(SECRET), "the webhook URL is never printed");
  } finally {
    await webhook.close();
  }
});

test("--notify sends nothing when nothing is unusual or nothing could be judged, and says so on stderr", async () => {
  const webhook = await hook(() => ({ status: 200 }));
  try {
    const calm = await live(withAnswer(quiet), ["--notify", webhook.url]);
    assert.equal(calm.status, 0, calm.stderr);
    assert.match(calm.stderr, /Nothing unusual, so nothing was sent to 127\.0\.0\.1:\d+\./);
    const little = await live((today) => [answer(flat("S", 5, 3, today))], ["--notify", webhook.url]);
    assert.equal(little.status, 0, little.stderr);
    assert.match(little.stderr, /Nothing could be judged, so nothing was sent to /);
    assert.equal(webhook.requests.length, 0);
  } finally {
    await webhook.close();
  }
});

test("--notify says that the check failed when Cost Explorer could not be read, so silence never hides a failure", async () => {
  const webhook = await hook(() => ({ status: 200 }));
  try {
    const denied = { status: 400, errorType: "AccessDeniedException", body: { __type: "AccessDeniedException", Message: "not authorized to perform: ce:GetCostAndUsage" } };
    const run = await live(() => [denied], ["--notify", webhook.url]);
    assert.equal(run.status, 1);
    assert.equal(webhook.requests.length, 1);
    const body = JSON.parse(webhook.requests[0]!.body);
    assert.equal(body.event, "check-failed");
    assert.match(body.error, /Cost Explorer could not be read: AccessDeniedException/);
  } finally {
    await webhook.close();
  }
});

test("a message that could not be delivered sets the exit code, after the report has been printed", async () => {
  const webhook = await hook(() => ({ status: 500, body: "down" }));
  try {
    const run = await live(withAnswer(spiking), ["--notify", webhook.url]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /1\. Amazon Elastic Compute Cloud - Compute/);
    assert.match(run.stderr, /Could not send the message: 127\.0\.0\.1:\d+ answered 500/);
    assert.ok(!run.stderr.includes(SECRET));
  } finally {
    await webhook.close();
  }
});
