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

// ---- An account that does hold an idle NAT gateway and an idle load balancer ----
//
// The waste lab plants neither (creating them costs money), so the rules are
// scored here against a copy of the recording with both spliced in: the two
// empty list reads answered with one gateway and one balancer, and the reads
// that follow from them (CloudWatch, the ELBv2 detail calls and the two Price
// List lookups) recorded alongside. The scan itself is the real CLI, with
// every socket blocked.

const NAT_ID = "nat-0a1b2c3d4e5f67890";
const LB_NAME = "checkout-old";
const LB_ARN = `arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/${LB_NAME}/50dc6c495c0c9188`;
const TG_ARN = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/checkout-old-tg/73e2d6bc24d8a067";
/** The default window (--lookback-hours 24) and the period the collector asks for over a day. */
const WINDOW_HOURS = 24;
const PERIOD_SECONDS = 300;
const NAT_HOUR = 0.056;
const ALB_HOUR = 0.0239;
const recordedAt = () => new Date(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")).sessions[0].recordedAt as string);

/** The key a recording stores one request under: method, host, path and a hash of the body. */
function keyOfRequest(seen: { hostname: string; path: string; query?: Record<string, string | string[] | null>; body?: unknown }): string {
  const body = seen.body;
  const bytes = typeof body === "string" ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : Buffer.alloc(0);
  const query = Object.entries(seen.query ?? {})
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : (value ?? "")}`)
    .sort()
    .join("&");
  return `POST ${seen.hostname}${query ? `${seen.path}?${query}` : seen.path} ${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The recorded key of one request, worked out from the request the SDK builds for it. Nothing is sent. */
async function requestKey<C extends { send(command: never): Promise<unknown> }>(make: (config: object) => C, region: string, command: unknown): Promise<string> {
  let seen: Parameters<typeof keyOfRequest>[0] | undefined;
  const client = make({
    region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: {
      metadata: { handlerProtocol: "http/1.1" },
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
      async handle(request: Parameters<typeof keyOfRequest>[0]) {
        seen = request;
        throw new Error("captured");
      },
    },
  });
  await client.send(command as never).catch(() => {});
  return keyOfRequest(seen!);
}

const xmlResponse = (service: string, operation: string, body: string) => [{ service, operation, status: 200, headers: { "content-type": "text/xml" }, body: Buffer.from(body).toString("base64") }];
const jsonResponse = (service: string, operation: string, body: object) => [{ service, operation, status: 200, headers: JSON_11, body: Buffer.from(JSON.stringify(body)).toString("base64") }];

/** One GetMetricData result per metric, each holding `points` zero-valued datapoints ending at the recorded time. */
function metricData(ids: string[], points: number): string {
  const end = recordedAt().getTime();
  const stamps = Array.from({ length: points }, (_, n) => `<member>${new Date(end - n * PERIOD_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}</member>`).join("");
  const values = Array.from({ length: points }, () => "<member>0.0</member>").join("");
  const members = ids
    .map((id) => `<member><Id>${id}</Id><Label>${id}</Label><Timestamps>${stamps}</Timestamps><Values>${values}</Values><StatusCode>Complete</StatusCode></member>`)
    .join("");
  return `<GetMetricDataResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/"><GetMetricDataResult><MetricDataResults>${members}</MetricDataResults><Messages/></GetMetricDataResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></GetMetricDataResponse>`;
}

/** A Price List answer carrying one hourly On-Demand product. */
const priceList = (serviceCode: string, productFamily: string, usagetype: string, usd: number) => ({
  FormatVersion: "aws_v1",
  PriceList: [
    JSON.stringify({
      product: { productFamily, attributes: { regionCode: "ap-south-1", servicecode: serviceCode, usagetype, locationType: "AWS Region", location: "Asia Pacific (Mumbai)" }, sku: "SKUSKUSKUSKUSKU1" },
      serviceCode,
      terms: { OnDemand: { "SKUSKUSKUSKUSKU1.JRTCKXETXF": { priceDimensions: { "SKUSKUSKUSKUSKU1.JRTCKXETXF.6YS6EN2CT7": { unit: "Hrs", endRange: "Inf", beginRange: "0", pricePerUnit: { USD: usd.toFixed(4) } } } } } },
    }),
  ],
});

/** The committed recording, with one idle NAT gateway and one idle Application load balancer spliced in. */
async function recordingWithNetwork(): Promise<string> {
  const { CloudWatchClient, GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
  const { EC2Client } = await import("@aws-sdk/client-ec2");
  const { GetProductsCommand, PricingClient } = await import("@aws-sdk/client-pricing");
  const elb = await import("@aws-sdk/client-elastic-load-balancing-v2");
  const end = recordedAt();
  const start = new Date(end.getTime() - WINDOW_HOURS * 3600_000);
  const traffic = (namespace: string, dimension: { Name: string; Value: string }, metrics: Array<{ name: string; stat: string }>) =>
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: metrics.map((m, n) => ({
        Id: `m${n}`,
        MetricStat: { Metric: { Namespace: namespace, MetricName: m.name, Dimensions: [dimension] }, Period: PERIOD_SECONDS, Stat: m.stat },
      })),
    });
  const cloudwatch = (command: unknown) => requestKey((config) => new CloudWatchClient(config), "ap-south-1", command);
  const elbv2 = (command: unknown) => requestKey((config) => new elb.ElasticLoadBalancingV2Client(config), "ap-south-1", command);
  const pricing = (serviceCode: string, attrs: Record<string, string>) =>
    requestKey((config) => new PricingClient(config), "us-east-1", new GetProductsCommand({ ServiceCode: serviceCode, Filters: Object.entries(attrs).map(([Field, Value]) => ({ Type: "TERM_MATCH", Field, Value })) }));

  const natTraffic = await cloudwatch(
    traffic("AWS/NATGateway", { Name: "NatGatewayId", Value: NAT_ID }, [
      { name: "BytesInFromSource", stat: "Sum" },
      { name: "BytesInFromDestination", stat: "Sum" },
      { name: "BytesOutToSource", stat: "Sum" },
      { name: "BytesOutToDestination", stat: "Sum" },
    ]),
  );
  const lbTraffic = await cloudwatch(traffic("AWS/ApplicationELB", { Name: "LoadBalancer", Value: `app/${LB_NAME}/50dc6c495c0c9188` }, [{ name: "RequestCount", stat: "Sum" }]));
  const lbTags = await elbv2(new elb.DescribeTagsCommand({ ResourceArns: [LB_ARN] }));
  const lbAttributes = await elbv2(new elb.DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: LB_ARN }));
  const lbTargetGroups = await elbv2(new elb.DescribeTargetGroupsCommand({ LoadBalancerArn: LB_ARN }));
  const lbHealth = await elbv2(new elb.DescribeTargetHealthCommand({ TargetGroupArn: TG_ARN }));
  const natPrice = await pricing("AmazonEC2", { regionCode: "ap-south-1", productFamily: "NAT Gateway", operation: "NatGateway", locationType: "AWS Region" });
  const albPrice = await pricing("AWSELB", { regionCode: "ap-south-1", productFamily: "Load Balancer-Application", locationType: "AWS Region", groupDescription: "LoadBalancer hourly usage by Application Load Balancer" });
  // The capturing clients must never have reached the network for these keys to be the recorded ones.
  assert.ok(new Set([natTraffic, lbTraffic, lbTags, lbAttributes, lbTargetGroups, lbHealth, natPrice, albPrice]).size === 8);

  return recordingWith((recorded) => {
    const replace = (service: string, operation: string, body: string) => {
      const found = Object.entries(recorded.entries).filter(([, responses]) => responses[0]!.service === service && responses[0]!.operation === operation);
      assert.equal(found.length, 1, `${service} ${operation} is read once`);
      recorded.entries[found[0]![0]] = xmlResponse(service, operation, body);
    };
    // The two reads the lab answers with an empty list, answered with a resource instead.
    replace(
      "EC2",
      "DescribeNatGateways",
      `<?xml version="1.0" encoding="UTF-8"?><DescribeNatGatewaysResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>00000000-0000-0000-0000-000000000000</requestId><natGatewaySet><item><natGatewayId>${NAT_ID}</natGatewayId><state>available</state><subnetId>subnet-0abc1234</subnetId><vpcId>vpc-0def5678</vpcId><connectivityType>public</connectivityType><createTime>2026-06-01T09:14:02.000Z</createTime><natGatewayAddressSet><item><allocationId>eipalloc-0123456789abcdef0</allocationId><publicIp>13.233.44.55</publicIp></item></natGatewayAddressSet><tagSet><item><key>Name</key><value>legacy-egress</value></item></tagSet></item></natGatewaySet></DescribeNatGatewaysResponse>`,
    );
    replace(
      "ELBv2",
      "DescribeLoadBalancers",
      `<DescribeLoadBalancersResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeLoadBalancersResult><LoadBalancers><member><LoadBalancerArn>${LB_ARN}</LoadBalancerArn><DNSName>${LB_NAME}-1234567890.ap-south-1.elb.amazonaws.com</DNSName><LoadBalancerName>${LB_NAME}</LoadBalancerName><Scheme>internet-facing</Scheme><VpcId>vpc-0def5678</VpcId><State><Code>active</Code></State><Type>application</Type><CreatedTime>2026-05-20T11:02:41.120Z</CreatedTime></member></LoadBalancers></DescribeLoadBalancersResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></DescribeLoadBalancersResponse>`,
    );

    // The gateway published a zero for every period of the window; the balancer published nothing at all.
    recorded.entries[natTraffic] = xmlResponse("CloudWatch", "GetMetricData", metricData(["m0", "m1", "m2", "m3"], (WINDOW_HOURS * 3600) / PERIOD_SECONDS));
    recorded.entries[lbTraffic] = xmlResponse("CloudWatch", "GetMetricData", metricData(["m0"], 0));
    recorded.entries[lbTags] = xmlResponse(
      "ELBv2",
      "DescribeTags",
      `<DescribeTagsResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeTagsResult><TagDescriptions><member><ResourceArn>${LB_ARN}</ResourceArn><Tags><member><Key>Name</Key><Value>${LB_NAME}</Value></member></Tags></member></TagDescriptions></DescribeTagsResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></DescribeTagsResponse>`,
    );
    recorded.entries[lbAttributes] = xmlResponse(
      "ELBv2",
      "DescribeLoadBalancerAttributes",
      `<DescribeLoadBalancerAttributesResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeLoadBalancerAttributesResult><Attributes><member><Key>deletion_protection.enabled</Key><Value>false</Value></member></Attributes></DescribeLoadBalancerAttributesResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></DescribeLoadBalancerAttributesResponse>`,
    );
    recorded.entries[lbTargetGroups] = xmlResponse(
      "ELBv2",
      "DescribeTargetGroups",
      `<DescribeTargetGroupsResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeTargetGroupsResult><TargetGroups><member><TargetGroupArn>${TG_ARN}</TargetGroupArn><TargetGroupName>checkout-old-tg</TargetGroupName><Protocol>HTTP</Protocol><Port>80</Port><VpcId>vpc-0def5678</VpcId><TargetType>instance</TargetType><LoadBalancerArns><member>${LB_ARN}</member></LoadBalancerArns></member></TargetGroups></DescribeTargetGroupsResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></DescribeTargetGroupsResponse>`,
    );
    recorded.entries[lbHealth] = xmlResponse(
      "ELBv2",
      "DescribeTargetHealth",
      `<DescribeTargetHealthResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeTargetHealthResult><TargetHealthDescriptions/></DescribeTargetHealthResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></DescribeTargetHealthResponse>`,
    );
    recorded.entries[natPrice] = jsonResponse("Pricing", "GetProducts", priceList("AmazonEC2", "NAT Gateway", "APS3-NatGateway-Hours", NAT_HOUR));
    recorded.entries[albPrice] = jsonResponse("Pricing", "GetProducts", priceList("AWSELB", "Load Balancer-Application", "APS3-LoadBalancerUsage", ALB_HOUR));
  });
}

test("an idle NAT gateway and an idle load balancer are reported, priced from the Price List, with a delete command and the way back", async () => {
  const dir = await recordingWithNetwork();
  const run = cli(["scan", "--replay", dir, "--json"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.warnings, []);

  const nat = result.findings.find((f: { pattern: string }) => f.pattern === "idle-nat-gateway");
  assert.ok(nat, "the idle NAT gateway is reported");
  assert.deepEqual(nat.resourceIds, [NAT_ID]);
  // $0.056/hour x 730 hours, the hourly price the recorded Price List answer holds.
  assert.equal(nat.monthlyCostUsd, Number((NAT_HOUR * 730).toFixed(10)));
  assert.match(nat.costBasis, /^\$0\.056\/hour x 730 hours\./);
  assert.match(nat.title, /^Idle NAT gateway: no traffic in the last 24 h$/);
  assert.ok(nat.evidence.some((e: string) => e.includes("over the last 24.0 h of the 24 h asked for: 0 bytes in total (288 datapoints)")), nat.evidence.join("\n"));
  assert.ok(nat.evidence.some((e: string) => e.includes("public NAT gateway in subnet-0abc1234 (vpc-0def5678), state available")));
  assert.deepEqual(nat.fix.commands, [`aws ec2 delete-nat-gateway --nat-gateway-id ${NAT_ID} --region ap-south-1`]);
  assert.equal(nat.fix.risk, "dangerous");
  assert.match(nat.fix.rollback, /permanent.*black-holes.*Elastic IP is not released with it/s);
  assert.equal(nat.confidence, 0.7);

  const lb = result.findings.find((f: { pattern: string }) => f.pattern === "idle-load-balancer");
  assert.ok(lb, "the idle load balancer is reported");
  assert.deepEqual(lb.resourceIds, [LB_NAME]);
  assert.equal(lb.monthlyCostUsd, Number((ALB_HOUR * 730).toFixed(10)));
  assert.match(lb.costBasis, /^\$0\.0239\/hour x 730 hours \(application load balancer\)\./);
  assert.equal(lb.title, `Idle application load balancer ${LB_NAME}: no registered targets and no requests`);
  assert.ok(lb.evidence.some((e: string) => e === "1 target group (checkout-old-tg), none with a registered target"), lb.evidence.join("\n"));
  // No datapoint at all over a window the balancer existed for the whole of: the metric is published only while requests flow.
  assert.ok(
    lb.evidence.some((e: string) => e === "CloudWatch holds no RequestCount datapoints for the last 24.0 h of the 24 h asked for. A load balancer reports that metric only while requests flow, so none means no requests"),
    lb.evidence.join("\n"),
  );
  assert.deepEqual(lb.fix.commands, [`aws elbv2 delete-load-balancer --load-balancer-arn ${LB_ARN} --region ap-south-1`]);
  assert.equal(lb.fix.risk, "dangerous");
  assert.match(lb.fix.rollback, /DNS name \(checkout-old-1234567890\.ap-south-1\.elb\.amazonaws\.com\) is gone for good/);
  assert.equal(lb.confidence, 0.7);

  // Both are new: the lab's ten findings are still there, and the total grew by exactly the two monthly costs.
  const lab = JSON.parse(cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true }).stdout);
  assert.equal(lab.findings.length, 10);
  assert.equal(result.findings.length, 12);
  assert.ok(Math.abs(result.totalMonthlyWasteUsd - (lab.totalMonthlyWasteUsd + (NAT_HOUR + ALB_HOUR) * 730)) < 1e-9, String(result.totalMonthlyWasteUsd));
});

test("the terminal report shows both new findings with their cost, command and way back, and --bill their share of last month", async () => {
  const dir = await recordingWithNetwork();
  const recorded = readRecorded(dir);
  await costExplorerSays(200, monthTotal("1234.56"))(recorded);
  writeFileSync(recordingFile(dir), JSON.stringify(recorded));

  const run = cli(["scan", "--replay", dir, "--bill"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /12 findings, \$209\.86 per month of estimated waste/);
  assert.match(run.stdout, /\$40\.88\/mo  Idle NAT gateway: no traffic in the last 24 h/);
  assert.match(run.stdout, /\$17\.45\/mo  Idle application load balancer checkout-old: no registered targets and no requests/);
  assert.ok(run.stdout.includes(`aws ec2 delete-nat-gateway --nat-gateway-id ${NAT_ID} --region ap-south-1`));
  assert.ok(run.stdout.includes(`aws elbv2 delete-load-balancer --load-balancer-arn ${LB_ARN} --region ap-south-1`));
  // 209.86 of 1234.56 is 17.0%.
  assert.ok(run.stdout.includes("The $209.86 a month of waste found is about 17.0% of last month's bill."), "the share of the bill covers the new findings");
});
