/**
 * What a run of `cloudpilot watch --autopilot` needs, with nothing real in it:
 * a stand-in for the AWS endpoint (answering only reads, and keeping a note of
 * every request, so a write that reached it would show), and stand-in `aws`
 * and `kubectl` programs on the PATH that write down how they were called and
 * change nothing. The fixes autopilot runs go to those.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliRun } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PRICES = resolve(here, "../../../pricing/ap-south-1.json");

export interface FakeVolume {
  id: string;
  type?: string;
  sizeGb?: number;
  /** An instance it is attached to. Unset: not attached, so the volume is unattached. */
  attachedTo?: string;
}
export interface FakeBucket {
  name: string;
  /** Has a lifecycle rule already. */
  lifecycle?: boolean;
  bytes?: number;
}

export interface Account {
  volumes?: FakeVolume[];
  buckets?: FakeBucket[];
  /** Actions the stand-in refuses, as a role without the permission would: "DescribeSnapshots". */
  deny?: string[];
}

const EC2 = "http://ec2.amazonaws.com/doc/2016-11-15/";
const S3 = "http://s3.amazonaws.com/doc/2006-03-01/";
const xml = (res: import("node:http").ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "text/xml" });
  res.end(body);
};

/** The AWS endpoint: the caller is account 123456789012, and it answers the reads a scan makes. */
async function fakeAws(account: Account) {
  const requests: Array<{ method: string; path: string; action: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const action = new URLSearchParams(body).get("Action") ?? "";
      requests.push({ method: req.method ?? "", path: url.pathname, action });
      if (action && account.deny?.includes(action)) {
        return xml(res, 403, "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>not authorized</Message></Error></Errors></Response>");
      }
      if (action === "GetCallerIdentity") {
        return xml(res, 200, '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/alice</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
      }
      if (action === "DescribeVolumes") {
        const items = (account.volumes ?? [])
          .map((v) => `<item><volumeId>${v.id}</volumeId><size>${v.sizeGb ?? 100}</size><status>${v.attachedTo ? "in-use" : "available"}</status><createTime>2026-01-01T00:00:00.000Z</createTime><attachmentSet>${v.attachedTo ? `<item><instanceId>${v.attachedTo}</instanceId></item>` : ""}</attachmentSet><volumeType>${v.type ?? "gp2"}</volumeType></item>`)
          .join("");
        return xml(res, 200, `<DescribeVolumesResponse xmlns="${EC2}"><requestId>r</requestId><volumeSet>${items}</volumeSet></DescribeVolumesResponse>`);
      }
      if (action === "DescribeDBInstances") {
        return xml(res, 200, '<DescribeDBInstancesResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBInstancesResult><DBInstances/></DescribeDBInstancesResult></DescribeDBInstancesResponse>');
      }
      if (action === "DescribeLoadBalancers") {
        return xml(res, 200, '<DescribeLoadBalancersResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeLoadBalancersResult><LoadBalancers/></DescribeLoadBalancersResult></DescribeLoadBalancersResponse>');
      }
      if (action) return xml(res, 200, `<${action}Response xmlns="${EC2}"><requestId>r</requestId></${action}Response>`);

      // S3, addressed by path.
      const q = url.searchParams;
      const buckets = account.buckets ?? [];
      if (url.pathname === "/") {
        const list = buckets.map((b) => `<Bucket><Name>${b.name}</Name><BucketRegion>ap-south-1</BucketRegion></Bucket>`).join("");
        return xml(res, 200, `<ListAllMyBucketsResult xmlns="${S3}"><Owner><ID>x</ID></Owner><Buckets>${list}</Buckets></ListAllMyBucketsResult>`);
      }
      const name = url.pathname.split("/")[1]!;
      const bucket = buckets.find((b) => b.name === name);
      const s3error = (status: number, code: string) => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
      if (!bucket) return s3error(404, "NoSuchBucket");
      if (q.has("lifecycle")) {
        return bucket.lifecycle
          ? xml(res, 200, `<LifecycleConfiguration xmlns="${S3}"><Rule><ID>keep</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><Expiration><Days>365</Days></Expiration></Rule></LifecycleConfiguration>`)
          : s3error(404, "NoSuchLifecycleConfiguration");
      }
      if (q.has("tagging")) return s3error(404, "NoSuchTagSet");
      if (q.has("uploads")) return xml(res, 200, `<ListMultipartUploadsResult xmlns="${S3}"><Bucket>${name}</Bucket></ListMultipartUploadsResult>`);
      if (q.get("list-type") === "2") {
        return xml(res, 200, `<ListBucketResult xmlns="${S3}"><Name>${name}</Name><IsTruncated>false</IsTruncated><Contents><Key>a.bin</Key><Size>${bucket.bytes ?? 1024 ** 3}</Size></Contents></ListBucketResult>`);
      }
      return s3error(403, "AccessDenied");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, requests, close: () => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))) };
}

/** A program that writes down how it was called and exits 0, or 254 when asked to fail on one of its arguments. */
const STAND_IN = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STAND_IN_LOG, JSON.stringify({ program: path.basename(process.argv[1]), args, profile: process.env.AWS_PROFILE || null }) + "\\n");
if (process.env.STAND_IN_FAIL && args.includes(process.env.STAND_IN_FAIL)) { process.stderr.write("An error occurred (UnauthorizedOperation)"); process.exitCode = 254; }
`;

export interface Call {
  program: string;
  args: string[];
  profile: string | null;
}

/** An empty directory to run from, with the stand-ins in place. Close it when the test is done. */
export async function rig(account: Account = {}) {
  const aws = await fakeAws(account);
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-autopilot-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["aws", "kubectl"]) {
    writeFileSync(join(bin, name), STAND_IN);
    chmodSync(join(bin, name), 0o755);
  }
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const log = join(dir, "calls.log");
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${dirname(process.execPath)}`,
    STAND_IN_LOG: log,
    AWS_ENDPOINT_URL: `http://127.0.0.1:${aws.port}`,
    NO_PROXY: "127.0.0.1",
    ...extra,
  });
  /** The arguments of a one-round watch of the one region the stand-in serves, offline for prices. */
  const watchArgs = (...more: string[]) => ["watch", "--region", "ap-south-1", "--offline", "--price-file", PRICES, "--max-runs", "1", ...more];
  return {
    cwd,
    file: (name: string) => join(cwd, ".cloudpilot", name),
    /** Everything the stand-in aws and kubectl were asked to run. */
    calls: (): Call[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    /** Every request that reached the stand-in AWS endpoint. */
    requests: aws.requests,
    watchArgs,
    run: (args: string[], extra: Record<string, string> = {}) => cliRun(args, { cwd, env: env(extra) }),
    env,
    close: aws.close,
  };
}
