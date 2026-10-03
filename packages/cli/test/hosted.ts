/** Stand-ins on 127.0.0.1 for the hosted service and for AWS. Nothing here reaches beyond this machine. */
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The upload token of every test: the one thing that must never be printed or saved. */
export const TOKEN = "cpt_T0kenForTestsOnly_9f8e7d6c5b4a";

export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Hosted {
  /** The upload endpoint, as `--upload` takes it. */
  url: string;
  host: string;
  requests: Received[];
  close(): Promise<void>;
}

export interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string | object;
}

/** The hosted service's upload endpoint, answering with `respond`, keeping everything it was sent. */
export async function hosted(respond: (request: Received, n: number) => Answer): Promise<Hosted> {
  const requests: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const received = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      requests.push(received);
      const answer = respond(received, requests.length);
      const text = typeof answer.body === "object" ? JSON.stringify(answer.body) : (answer.body ?? "");
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/ingest`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** What the hosted service answers to a scan it stored: the same shape as its ingest returns. */
export const stored = (counts = { findings: 10, new: 10, cameBack: 0, resolved: 0, unchanged: 0 }): Answer => ({
  status: 201,
  body: { scanId: "s1", sourceId: "src1", duplicate: false, firstScan: true, counts },
});

const xml = (inner: string) => `<?xml version="1.0"?>${inner}`;

const IDENTITY = xml(
  '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/alice</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>',
);

const VOLUME = (id: string) =>
  `<item><volumeId>${id}</volumeId><size>500</size><volumeType>gp2</volumeType><status>available</status><createTime>2026-01-01T00:00:00.000Z</createTime><attachmentSet/></item>`;

/**
 * A stand-in for AWS, for a live scan with no AWS in it: the caller is account
 * 123456789012, the region holds `volumes` unattached gp2 volumes, and every
 * other read finds nothing. Point a process at it with AWS_ENDPOINT_URL.
 */
export async function fakeAws(volumes: string[] = ["vol-0aaaaaaaaaaaaaaaa", "vol-0bbbbbbbbbbbbbbbb"]) {
  const actions: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const action = new URLSearchParams(body).get("Action") ?? "";
      if (action) actions.push(action);
      res.writeHead(200, { "content-type": "text/xml" });
      if (action === "GetCallerIdentity") return void res.end(IDENTITY);
      if (action === "DescribeVolumes") return void res.end(xml(`<DescribeVolumesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><volumeSet>${volumes.map(VOLUME).join("")}</volumeSet></DescribeVolumesResponse>`));
      if (action) return void res.end(xml(`<${action}Response><${action}Result/></${action}Response>`));
      // The only read that is not a query action here is S3's bucket listing.
      res.end(xml('<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets/></ListAllMyBucketsResult>'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    actions,
    env: { AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`, AWS_REGION: "ap-south-1", NO_PROXY: "127.0.0.1" },
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

const text = (value: unknown, max: number, what: string) => {
  assert.equal(typeof value, "string", `${what} is text`);
  assert.ok((value as string).length <= max, `${what} is at most ${max} characters`);
};
const number = (value: unknown, what: string, max = Infinity) => {
  assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max, `${what} is a number of zero or more`);
};

/**
 * What the hosted service's validator was read to require of a scan: the
 * fields, their types and their limits. Not the validator itself, which lives
 * in a private repository: a check that what the scanner produces keeps the
 * shape the service takes.
 */
export function assertTakenByHostedService(scan: any): void {
  text(scan.accountId, 256, "accountId");
  assert.ok(scan.accountId.length > 0, "accountId is not empty");
  assert.ok(Array.isArray(scan.regions));
  for (const region of scan.regions) text(region, 256, "a region");
  assert.match(scan.scannedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/, "scannedAt is a date and time");
  text(scan.prices?.source, 64, "prices.source");
  text(scan.prices?.fetchedAt, 64, "prices.fetchedAt");
  number(scan.totalMonthlyWasteUsd, "totalMonthlyWasteUsd");
  for (const name of scan.skippedByTag) text(name, 1024, "a skipped resource");
  for (const warning of scan.warnings) text(warning, 4000, "a warning");
  const fix = (f: any, what: string) => {
    assert.ok(Array.isArray(f.commands) && f.commands.length <= 100, `${what} has at most 100 commands`);
    for (const command of f.commands) text(command, 8000, "a command");
    assert.ok(f.risk === "caution" || f.risk === "dangerous", `${what} risk`);
    text(f.rollback, 8000, "a rollback");
  };
  const seen = new Set<string>();
  for (const f of scan.findings) {
    text(f.region, 256, "a finding's place");
    assert.match(f.pattern, /^[a-z0-9][a-z0-9-]{0,63}$/);
    text(f.title, 1000, "a title");
    text(f.resourceType, 256, "a resource type");
    assert.ok(Array.isArray(f.resourceIds) && f.resourceIds.length >= 1 && f.resourceIds.length <= 1000, "a finding names at least one resource");
    for (const id of f.resourceIds) text(id, 1024, "a resource ID");
    assert.ok(Array.isArray(f.evidence) && f.evidence.length <= 200);
    for (const line of f.evidence) text(line, 4000, "evidence");
    number(f.monthlyCostUsd, "monthlyCostUsd");
    text(f.costBasis, 4000, "costBasis");
    fix(f.fix, "fix");
    if (f.alternative) {
      fix(f.alternative, "alternative");
      number(f.alternative.monthlySavingUsd, "monthlySavingUsd");
      text(f.alternative.description, 2000, "an alternative's description");
    }
    number(f.confidence, "confidence", 1);
    // A finding may appear once: the service refuses a scan that lists one twice.
    const key = JSON.stringify([f.pattern, f.region, [...f.resourceIds].sort()]);
    assert.ok(!seen.has(key), `${key} appears once`);
    seen.add(key);
  }
  if (scan.cluster !== undefined) {
    text(scan.cluster.context, 256, "cluster.context");
    if (scan.cluster.server !== undefined) text(scan.cluster.server, 1024, "cluster.server");
    if (scan.cluster.prometheus !== undefined) text(scan.cluster.prometheus, 512, "cluster.prometheus");
    number(scan.cluster.lookbackHours, "cluster.lookbackHours");
    text(scan.cluster.prices.source, 64, "cluster.prices.source");
    for (const key of ["cpuHourUsd", "memoryGibHourUsd", "storageGibMonthUsd"]) number(scan.cluster.prices[key], `cluster.prices.${key}`);
  }
}
