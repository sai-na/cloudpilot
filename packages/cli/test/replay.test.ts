/** Offline tests against a committed, account-redacted recording of the waste lab. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { billQuery } from "../src/collect.js";
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

// ---- NAT gateways, load balancers and the bill ----

interface Recorded {
  entries: Record<string, Array<{ service: string; operation: string; status: number; headers: Record<string, string>; body: string }>>;
}
const recordingFile = (dir: string, session = "scan") => join(dir, session, "aws.json");
const readRecorded = (dir: string, session = "scan") => JSON.parse(readFileSync(recordingFile(dir, session), "utf8")) as Recorded;

/** A copy of the committed recording, edited by `change`, for a test to replay. */
async function recordingWith(change: (recorded: Recorded) => void | Promise<void>): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), "cloudpilot-bill-")), "recording");
  cpSync(FIXTURE, dir, { recursive: true });
  const recorded = readRecorded(dir);
  await change(recorded);
  writeFileSync(recordingFile(dir), JSON.stringify(recorded));
  return dir;
}

/** The recorded key of the one Cost Explorer request a bill makes, worked out from the request the code builds. */
async function billKey(): Promise<string> {
  const recordedAt = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")).sessions[0].recordedAt as string;
  let seen: { hostname: string; path: string; body?: unknown } | undefined;
  const client = new CostExplorerClient({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: {
      metadata: { handlerProtocol: "http/1.1" },
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
      async handle(request: { hostname: string; path: string; body?: unknown }) {
        seen = request;
        throw new Error("captured");
      },
    },
  });
  await client.send(new GetCostAndUsageCommand(billQuery(new Date(recordedAt)).input)).catch(() => {});
  return `POST ${seen!.hostname}${seen!.path} ${createHash("sha256").update(String(seen!.body)).digest("hex")}`;
}

const JSON_11 = { "content-type": "application/x-amz-json-1.1" };
const costExplorerSays = (status: number, body: object, errorType?: string) => async (recorded: Recorded) => {
  recorded.entries[await billKey()] = [
    { service: "CostExplorer", operation: "GetCostAndUsage", status, headers: { ...JSON_11, ...(errorType ? { "x-amzn-errortype": errorType } : {}) }, body: Buffer.from(JSON.stringify(body)).toString("base64") },
  ];
};
const monthTotal = (amount: string, unit = "USD") => ({
  ResultsByTime: [{ TimePeriod: { Start: "2026-09-01", End: "2026-10-01" }, Total: { UnblendedCost: { Amount: amount, Unit: unit } }, Groups: [], Estimated: false }],
  DimensionValueAttributes: [],
});
const recordingWithBill = (status: number, body: object, errorType?: string) => recordingWith(costExplorerSays(status, body, errorType));

test("the recording holds the NAT gateway and load balancer reads, empty, in every session, and no Cost Explorer read", () => {
  for (const session of ["scan", "ask-14a18f21221c", "ask-88bc6aba9740"]) {
    const operations = Object.values(readRecorded(FIXTURE, session).entries).map((responses) => `${responses[0]!.service} ${responses[0]!.operation}`);
    assert.equal(operations.filter((o) => o === "EC2 DescribeNatGateways").length, 1, session);
    assert.equal(operations.filter((o) => o === "ELBv2 DescribeLoadBalancers").length, 1, session);
    assert.ok(!operations.some((o) => o.startsWith("CostExplorer")), `${session} must not hold a paid read`);
  }
  assert.ok(!recordingText(FIXTURE).includes("ce.us-east-1"));
});

test("the lab holds no NAT gateway and no load balancer, so the recorded scan reports neither rule and says nothing of the bill", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.warnings, []);
  assert.ok(!result.findings.some((f: { pattern: string }) => f.pattern === "idle-nat-gateway" || f.pattern === "idle-load-balancer"));
  assert.equal(result.bill, undefined, "the bill is read only when asked for");
  assert.doesNotMatch(run.stdout, /Cost Explorer/);
});

test("a role without the load balancer permission still gets a full scan: the denied check becomes a warning", async () => {
  const denied =
    '<ErrorResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/">\n  <Error>\n    <Type>Sender</Type>\n    <Code>AccessDenied</Code>\n' +
    "    <Message>User: arn:aws:sts::123456789012:assumed-role/cloudpilot-readonly/session is not authorized to perform: elasticloadbalancing:DescribeLoadBalancers</Message>\n" +
    "  </Error>\n  <RequestId>00000000-0000-0000-0000-000000000000</RequestId>\n</ErrorResponse>";
  const dir = await recordingWith((recorded) => {
    const elb = Object.values(recorded.entries).filter((responses) => responses[0]!.service === "ELBv2");
    assert.equal(elb.length, 1);
    Object.assign(elb[0]![0]!, { status: 403, headers: { "content-type": "text/xml" }, body: Buffer.from(denied).toString("base64") });
  });
  const run = cli(["scan", "--replay", dir, "--json"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.findings.length, 10);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^\[ap-south-1\] elasticloadbalancing:DescribeLoadBalancers: AccessDenied/);
});

test("--bill reads last month's spend once and every form of the report says what share the waste is", async () => {
  const dir = await recordingWithBill(200, monthTotal("1234.56"));
  const json = cli(["scan", "--replay", dir, "--bill", "--json"], { blockNetwork: true });
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.findings.length, 10);
  // 151.53 of 1234.56 is 12.27%, written to one decimal by the code.
  assert.deepEqual(result.bill, { month: "2026-09", totalUsd: 1234.56, wasteSharePct: 12.3 });
  assert.match(result.summary, /In September 2026 the account spent \$1234\.56 \(AWS Cost Explorer, unblended cost, before credits and refunds\)\.\nThe \$151\.53 a month of waste found is about 12\.3% of last month's bill\./);

  const text = cli(["scan", "--replay", dir, "--bill", "--out", "report.md", "--html", "report.html"], { blockNetwork: true });
  assert.equal(text.status, 0, text.stderr);
  const share = "The $151.53 a month of waste found is about 12.3% of last month's bill. The waste is an estimate per month at current prices; the bill is last month's actual total.";
  assert.ok(text.stdout.includes(share), "terminal report");
  assert.ok(readFileSync(join(text.cwd, "report.md"), "utf8").includes(share), "Markdown report");
  assert.ok(readFileSync(join(text.cwd, "report.html"), "utf8").includes(share.replaceAll("'", "&#39;")), "HTML report");
  const plain = cli(["scan", "--replay", dir, "--bill", "--out", "report.txt"], { blockNetwork: true });
  assert.ok(readFileSync(join(plain.cwd, "report.txt"), "utf8").includes(share), "plain text report");

  // Without --bill the same recording is scanned and the bill is not touched.
  assert.equal(JSON.parse(cli(["scan", "--replay", dir, "--json"], { blockNetwork: true }).stdout).bill, undefined);
});

test("--bill degrades to a plain note when the bill cannot be read, and the scan is otherwise whole", async () => {
  const cases: Array<[string, number, object, string | undefined, RegExp]> = [
    [
      "denied",
      400,
      { __type: "AccessDeniedException", Message: "User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: ce:GetCostAndUsage" },
      "AccessDeniedException",
      /The bill could not be read: AccessDeniedException - User: .* is not authorized to perform: ce:GetCostAndUsage\./,
    ],
    ["not enabled", 400, { __type: "AccessDeniedException", Message: "User not enabled for cost explorer access" }, "AccessDeniedException", /The bill could not be read: AccessDeniedException - User not enabled for cost explorer access\./],
    ["no data", 200, { ResultsByTime: [], DimensionValueAttributes: [] }, undefined, /The bill could not be read: Cost Explorer returned no data for 2026-09\./],
    ["a few thousandths of a cent", 200, monthTotal("0.000045"), undefined, /The bill could not be read: Cost Explorer shows no spend to the cent for 2026-09/],
    ["zero", 200, monthTotal("0.0"), undefined, /The bill could not be read: Cost Explorer shows no spend to the cent for 2026-09/],
    ["another currency", 200, monthTotal("90000", "INR"), undefined, /The bill could not be read: Cost Explorer reports 2026-09 in INR, and CloudPilot compares dollars only\./],
    ["not a number", 200, monthTotal("lots"), undefined, /The bill could not be read: Cost Explorer returned an amount for 2026-09 that is not a number\./],
  ];
  for (const [name, status, body, errorType, note] of cases) {
    const dir = await recordingWithBill(status, body, errorType);
    const run = cli(["scan", "--replay", dir, "--bill", "--json"], { blockNetwork: true });
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.findings.length, 10, name);
    assert.equal(result.bill.totalUsd, undefined, `${name}: no made-up figure`);
    assert.equal(result.bill.wasteSharePct, undefined, name);
    assert.match(result.summary, note, name);
    assert.doesNotMatch(result.summary, /the account spent|of last month's bill/, name);
    const report = cli(["scan", "--replay", dir, "--bill"], { blockNetwork: true });
    assert.match(report.stdout, note, name);
  }
});

test("--bill against a recording with no Cost Explorer read stops, naming it, and never reaches the network", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--bill"], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Replay: no recorded response for CostExplorer GetCostAndUsage/);
  assert.match(run.stderr, /never falls back to the network/);
});
