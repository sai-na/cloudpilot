/**
 * `cloudpilot init`, offline. The checks are tested with injected probes for
 * every branch; the command itself with a kubectl stand-in that logs every
 * call, and a local stand-in for AWS that logs every request.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KubectlNotFoundError, type KubeReader } from "../src/kube.js";
import { AWS_READS, checkAws, checkKubernetes, policyCommands, preflight, renderPreflight, type AwsProbes, type AwsReport, type PreflightOptions, type Sample } from "../src/preflight.js";
import { cli } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const options: PreflightOptions = { region: "ap-south-1", regionGiven: true, now: new Date("2026-10-03T12:00:00Z") };

class AwsError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

/** AWS behind the probe interface: every read allowed unless `answer` says otherwise. Logs what it was asked. */
function aws(over: { identity?: () => Promise<{ account: string; arn: string }>; answer?: (operation: string, sample: Sample) => Sample | void } = {}) {
  const asked: string[] = [];
  const probes: AwsProbes = {
    region: "ap-south-1",
    identity: over.identity ?? (async () => ({ account: "123456789012", arn: "arn:aws:iam::123456789012:user/alice" })),
    read: async (operation, sample) => {
      asked.push(operation);
      return over.answer?.(operation, sample);
    },
  };
  return { probes, asked };
}

/** What a busy account would hand back for the reads that find something to try the others on. */
const found = (operation: string): Sample | void => {
  if (operation === "ListBuckets") return { bucket: "alpha" };
  if (operation === "DescribeLaunchTemplates") return { launchTemplateId: "lt-1" };
  if (operation === "ListMultipartUploads") return { upload: { bucket: "alpha", key: "k", uploadId: "u" } };
};

const statuses = (checks: Array<{ operation: string; status: string }>) => Object.fromEntries(checks.map((c) => [c.operation, c.status]));

// AWS: identity

test("without credentials it says how to supply them and tries no read", async () => {
  const { probes, asked } = aws({ identity: async () => Promise.reject(new AwsError("CredentialsProviderError", "Could not load credentials from any providers")) });
  const report = await checkAws(probes, {});
  assert.equal(report.status, "not-ready");
  assert.deepEqual(report.problem, { kind: "no-credentials", message: "Could not load credentials from any providers" });
  assert.deepEqual([report.identity, report.checks, report.fix, asked], [undefined, [], [], []]);

  const text = renderPreflight(await preflight(options, { aws: probes, kube: kubeReader({ missing: true }) }), options);
  assert.match(text, /No AWS credentials were found\. \(Could not load credentials from any providers\)/);
  assert.match(text, /AWS CloudShell/);
  assert.match(text, /--profile <name>/);
  assert.match(text, /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
});

test("credentials that STS refuses are reported as such, not as missing", async () => {
  const { probes } = aws({ identity: async () => Promise.reject(new AwsError("ExpiredToken", "The security token included in the request is expired")) });
  const report = await checkAws(probes, { profile: "work" });
  assert.deepEqual(report.problem, { kind: "failed", message: "ExpiredToken: The security token included in the request is expired" });
  assert.equal(report.profile, "work");
});

// AWS: access

test("every read allowed: ready, nothing to fix, and each read is tried on what an earlier one found", async () => {
  const seen: Array<[string, Sample]> = [];
  const { probes } = aws({
    answer: (operation, sample) => {
      seen.push([operation, { ...sample }]);
      return found(operation);
    },
  });
  const report = await checkAws(probes, {});
  assert.equal(report.status, "ready");
  assert.deepEqual(report.identity, { account: "123456789012", arn: "arn:aws:iam::123456789012:user/alice" });
  assert.equal(report.checks.length, AWS_READS.length);
  assert.ok(report.checks.every((c) => c.status === "allowed"));
  assert.equal(report.canListRegions, true);
  assert.deepEqual(report.fix, []);
  const tried = Object.fromEntries(seen);
  assert.equal(tried.GetBucketTagging!.bucket, "alpha");
  assert.equal(tried.DescribeLaunchTemplateVersions!.launchTemplateId, "lt-1");
  assert.equal(tried.ListParts!.upload!.uploadId, "u");
  assert.equal(report.checks.find((c) => c.operation === "ListObjectsV2")!.detail, "tried on bucket alpha");
});

test("a denied read never ends the check; the rest are still tried and the fix is printed as commands to run", async () => {
  const { probes } = aws({
    answer: (operation) => {
      if (operation === "DescribeVolumes" || operation === "GetMetricData") throw new AwsError("UnauthorizedOperation");
      if (operation === "GetProducts") throw new AwsError("AccessDeniedException", "not allowed");
      return found(operation);
    },
  });
  const report = await checkAws(probes, {});
  assert.equal(report.status, "limited");
  assert.deepEqual(
    report.checks.filter((c) => c.status !== "allowed").map((c) => [c.operation, c.status, c.detail]),
    [["DescribeVolumes", "denied", "UnauthorizedOperation"], ["GetMetricData", "denied", "UnauthorizedOperation"], ["GetProducts", "denied", "AccessDeniedException"]],
  );
  assert.deepEqual(report.fix, [
    "aws iam create-policy --policy-name CloudPilotReadOnly --policy-document file://docs/cloudpilot-readonly-policy.json",
    "aws iam attach-user-policy --user-name alice --policy-arn arn:aws:iam::123456789012:policy/CloudPilotReadOnly",
  ]);

  const text = renderPreflight({ ready: true, aws: report, kubernetes: { status: "skipped", skipped: "kubectl is not on the PATH", checks: [] }, next: ["x"] }, options);
  assert.match(text, /^ {2}denied {6}EC2 DescribeVolumes {2,}UnauthorizedOperation$/m);
  assert.match(text, /14 of 17 reads allowed, 3 denied\./);
  assert.match(text, /A scan still runs and reports each read it cannot make as a skipped check\./);
  assert.match(text, /docs\/cloudpilot-readonly-policy\.json in the CloudPilot repository/);
  assert.match(text, /commands for you to run, with an identity that may change IAM\. CloudPilot does not run them:\n {4}aws iam create-policy/);
});

test("the policy commands fit a user, an assumed role and anything else", () => {
  const attach = (arn: string) => policyCommands({ account: "123456789012", arn })[1];
  assert.equal(attach("arn:aws:iam::123456789012:user/team/alice"), "aws iam attach-user-policy --user-name alice --policy-arn arn:aws:iam::123456789012:policy/CloudPilotReadOnly");
  assert.equal(attach("arn:aws:sts::123456789012:assumed-role/auditor/session-1"), "aws iam attach-role-policy --role-name auditor --policy-arn arn:aws:iam::123456789012:policy/CloudPilotReadOnly");
  assert.equal(attach("arn:aws-cn:iam::123456789012:user/bob"), "aws iam attach-user-policy --user-name bob --policy-arn arn:aws-cn:iam::123456789012:policy/CloudPilotReadOnly");
  assert.match(attach("arn:aws:iam::123456789012:root"), /--user-name <user> .* or attach-role-policy --role-name <role>$/);
});

test("a read that fails for another reason is failed, not denied, and says why", async () => {
  const { probes } = aws({
    answer: (operation) => {
      if (operation === "DescribeSnapshots") throw new AwsError("AbortError");
      if (operation === "DescribeImages") throw new AwsError("RequestLimitExceeded", "Request limit exceeded.");
      return found(operation);
    },
  });
  const report = await checkAws(probes, {});
  assert.equal(report.status, "limited");
  assert.deepEqual(
    report.checks.filter((c) => c.status === "failed").map((c) => [c.operation, c.detail]),
    [["DescribeSnapshots", "no answer within 15 seconds"], ["DescribeImages", "RequestLimitExceeded: Request limit exceeded."]],
  );
  assert.deepEqual(report.fix, [], "a timeout is not a missing permission");
});

test("reads that need something to try on are not tested when the account has none, and that does not count against it", async () => {
  const { probes, asked } = aws();
  const report = await checkAws(probes, {});
  assert.equal(report.status, "ready");
  assert.deepEqual(
    report.checks.filter((c) => c.status === "not-tested").map((c) => c.operation),
    ["DescribeLaunchTemplateVersions", "GetBucketLocation", "GetBucketLifecycleConfiguration", "GetBucketTagging", "ListObjectsV2", "ListMultipartUploads", "ListParts"],
  );
  assert.equal(report.checks.find((c) => c.operation === "ListParts")!.detail, "needs an incomplete multipart upload to try it on; none was found");
  assert.ok(!asked.includes("ListParts") && !asked.includes("GetBucketTagging"));
});

test("when the listing a read depends on is denied, the read says it could not be tried because of that", async () => {
  const { probes } = aws({
    answer: (operation) => {
      if (operation === "ListBuckets") throw new AwsError("AccessDenied");
    },
  });
  const report = await checkAws(probes, {});
  assert.equal(report.checks.find((c) => c.operation === "GetBucketTagging")!.detail, "needs a bucket to try it on; none could be listed");
});

test("without DescribeRegions a scan has to be given a region, and the next command says so", async () => {
  const denyRegions = aws({
    answer: (operation) => {
      if (operation === "DescribeRegions") throw new AwsError("UnauthorizedOperation");
    },
  });
  const noRegionGiven = { ...options, regionGiven: false, profile: "audit" };
  const result = await preflight(noRegionGiven, { aws: denyRegions.probes, kube: kubeReader({ missing: true }) });
  assert.equal(result.aws.canListRegions, false);
  assert.deepEqual(result.next, ["cloudpilot scan --profile audit --region ap-south-1"]);
  assert.match(renderPreflight(result, noRegionGiven), /DescribeRegions is not allowed, so a scan has to be given --region\./);

  const allowed = await preflight(noRegionGiven, { aws: aws().probes, kube: kubeReader({ missing: true }) });
  assert.deepEqual(allowed.next, ["cloudpilot scan --profile audit"], "with the list of regions, the default scan of every region works");
});

test("when nothing is allowed there is nothing to scan", async () => {
  const { probes } = aws({
    answer: () => {
      throw new AwsError("UnauthorizedOperation");
    },
  });
  const result = await preflight(options, { aws: probes, kube: kubeReader({ missing: true }) });
  assert.equal(result.aws.status, "not-ready");
  assert.deepEqual([result.ready, result.next], [false, []]);
  assert.match(renderPreflight(result, options), /No read was allowed, so a scan would find nothing\./);
  assert.match(renderPreflight(result, options), /Nothing is ready to scan yet\. Fix what is listed above, then run cloudpilot init again\./);
});

test("init covers exactly the reads in the README table, each within the read-only policy", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("### Every AWS API call it makes"), readme.indexOf("## What it finds"));
  const rows = [...section.matchAll(/^\| (\w+) \| `(\w+)` \| (?:`([\w:]+)`|none needed) \|/gm)].filter((m) => m[2] !== "GetCallerIdentity");
  assert.deepEqual(
    AWS_READS.map((r) => [r.service, r.operation, r.permission]),
    rows.map((m) => [m[1], m[2], m[3]]),
  );

  const policy = JSON.parse(readFileSync(join(root, "../../docs/cloudpilot-readonly-policy.json"), "utf8")) as { Statement: Array<{ Action: string[] }> };
  const actions = policy.Statement.flatMap((s) => s.Action).map((a) => new RegExp(`^${a.replace(/\*/g, ".*")}$`));
  for (const read of AWS_READS) assert.ok(actions.some((a) => a.test(read.permission)), `${read.permission} is not in the read-only policy`);
});

// Kubernetes

const DAY = 24;

/** An AWS report for tests that are about the cluster. */
const NO_AWS: AwsReport = { status: "not-ready", region: "x", problem: { kind: "no-credentials", message: "none" }, checks: [], canListRegions: false, fix: [] };

/** A cluster behind the reader interface. Logs every path asked for. */
function kubeReader(
  over: {
    missing?: boolean;
    identityError?: string;
    denied?: string[];
    /** The Prometheus service in the cluster, if any. */
    prometheus?: boolean;
    /** Hours of container history Prometheus holds; null for none. */
    history?: number | null;
    proxyError?: string;
  } = {},
): KubeReader & { asked: string[] } {
  const asked: string[] = [];
  const history = over.history === undefined ? 3 : over.history;
  return {
    asked,
    identity: async () => {
      if (over.missing) throw new KubectlNotFoundError();
      if (over.identityError) throw new Error(over.identityError);
      return { context: "prod", server: "https://prod.example:6443" };
    },
    get: async (path) => {
      asked.push(path);
      const resource = path.replace(/\?.*$/, "");
      if (over.denied?.includes(resource)) throw new Error(`Error from server (Forbidden): ${resource.split("/").pop()} is forbidden: User "alice" cannot list resource`);
      if (path.includes("/proxy/")) {
        if (over.proxyError) throw new Error(over.proxyError);
        const promql = decodeURIComponent(path.split("query=")[1]!);
        const result = promql === "vector(1)" ? [{ metric: {}, value: [0, "1"] }] : history === null ? [] : [{ metric: {}, value: [0, String(options.now!.getTime() / 1000 - history * 3600)] }];
        return { status: "success", data: { result } };
      }
      if (path.startsWith("/api/v1/services?")) {
        return { items: over.prometheus === false ? [{ metadata: { name: "web", namespace: "shop" }, spec: { ports: [{ port: 80 }] } }] : [{ metadata: { name: "prometheus-server", namespace: "monitoring" }, spec: { ports: [{ port: 9090 }] } }] };
      }
      return { items: [] };
    },
  };
}

test("kubectl missing, and no current context, each skip Kubernetes in one line and read nothing", async () => {
  const none = kubeReader({ missing: true });
  assert.deepEqual(await checkKubernetes(none, options), { status: "skipped", skipped: "kubectl is not on the PATH", checks: [] });
  const noContext = kubeReader({ identityError: "error: current-context must exist in order to minify" });
  assert.deepEqual(await checkKubernetes(noContext, options), { status: "skipped", skipped: "kubectl has no current context (choose one with --context)", checks: [] });
  const broken = await checkKubernetes(kubeReader({ identityError: "error: cannot locate context nope" }), options);
  assert.equal(broken.skipped, "kubectl could not read its configuration: error: cannot locate context nope");
  assert.deepEqual([none.asked, noContext.asked], [[], []]);

  const text = renderPreflight({ ready: false, aws: NO_AWS, kubernetes: await checkKubernetes(none, options), next: [] }, options);
  assert.match(text, /^Kubernetes\n {2}Skipped: kubectl is not on the PATH\.$/m);
});

test("a cluster that allows every list and has a week of history is ready", async () => {
  const reader = kubeReader({ history: 200 });
  const report = await checkKubernetes(reader, options);
  assert.equal(report.status, "ready");
  assert.deepEqual([report.context, report.server], ["prod", "https://prod.example:6443"]);
  assert.deepEqual(
    report.checks.map((c) => c.resource),
    ["namespaces", "pods", "services", "replicasets", "deployments", "statefulsets", "daemonsets", "persistentvolumeclaims", "persistentvolumes"],
  );
  assert.ok(report.checks.every((c) => c.status === "allowed"));
  assert.deepEqual(report.prometheus, { status: "answers", ref: "monitoring/prometheus-server:9090", discovered: true, historyHours: 168 });

  // Every list is a limit=1 read; the only bigger read is the services list that Prometheus is found in.
  assert.deepEqual(
    reader.asked.filter((p) => !p.includes("/proxy/") && !p.endsWith("?limit=1")),
    ["/api/v1/services?limit=500"],
  );
  assert.ok(reader.asked.every((p) => p.startsWith("/api/") || p.startsWith("/apis/")));

  const text = renderPreflight({ ready: true, aws: NO_AWS, kubernetes: report, next: ["cloudpilot kube"] }, options);
  assert.match(text, /^ {2}Context {2}prod \(https:\/\/prod\.example:6443\)$/m);
  assert.match(text, /^ {4}allowed {5}pods$/m);
  assert.match(text, /monitoring\/prometheus-server:9090 \(found among the cluster's services\) answers a query\./);
  assert.match(text, /It holds about 168 hours of container history or more\./);
  assert.doesNotMatch(text, /rule confidence/);
});

test("little history still scans, with the lower confidence it brings; under five minutes judges nothing", async () => {
  const some = await checkKubernetes(kubeReader({ history: 3 }), options);
  assert.equal(some.status, "ready");
  assert.equal(some.prometheus!.historyHours, 3);
  const aboutADay = renderPreflight({ ready: true, aws: NO_AWS, kubernetes: some, next: [] }, options);
  assert.match(aboutADay, /It holds about 3 hours of container history\./);
  assert.match(aboutADay, /rule confidence of 60% on findings; a week or more gives 90%\./);

  const day = await checkKubernetes(kubeReader({ history: DAY }), options);
  assert.match(renderPreflight({ ready: true, aws: NO_AWS, kubernetes: day, next: [] }, options), /rule confidence of 80%/);

  const minutes = await checkKubernetes(kubeReader({ history: 0.05 }), options);
  assert.match(renderPreflight({ ready: true, aws: NO_AWS, kubernetes: minutes, next: [] }, options), /under five minutes, so no container can be judged yet\./);
});

test("with no Prometheus in the cluster a scan still runs, for volumes, and the report points at --prometheus", async () => {
  const report = await checkKubernetes(kubeReader({ prometheus: false }), options);
  assert.equal(report.status, "limited");
  assert.equal(report.prometheus!.status, "not-found");
  const result = { ready: true, aws: NO_AWS, kubernetes: report, next: ["cloudpilot kube"] };
  const text = renderPreflight(result, options);
  assert.match(text, /Prometheus was not found: no service in the cluster looks like a Prometheus server\./);
  assert.match(text, /Name it with --prometheus namespace\/service:port\./);
  assert.match(text, /Without it a scan still reports volumes, and says requests were not compared with real use\./);
});

test("a Prometheus that answers but holds no container figures is not enough to judge requests", async () => {
  const report = await checkKubernetes(kubeReader({ history: null }), options);
  assert.equal(report.status, "limited");
  assert.equal(report.prometheus!.status, "no-container-figures");
  assert.equal(report.prometheus!.ref, "monitoring/prometheus-server:9090");
});

test("a Prometheus that was named is queried, and a refusal is told apart from silence", async () => {
  const named = { ...options, prometheus: { namespace: "obs", service: "prom", port: "80" } };
  const ok = kubeReader({ history: 50 });
  const report = await checkKubernetes(ok, named);
  assert.deepEqual(report.prometheus, { status: "answers", ref: "obs/prom:80", discovered: false, historyHours: 50 });
  assert.ok(!ok.asked.includes("/api/v1/services?limit=500"), "a named Prometheus is not looked for");
  assert.ok(ok.asked.some((p) => p.startsWith("/api/v1/namespaces/obs/services/prom:80/proxy/api/v1/query?query=")));

  const refused = await checkKubernetes(kubeReader({ proxyError: 'Error from server (Forbidden): services "prom:80" is forbidden: User "alice" cannot get resource "services/proxy"' }), named);
  assert.equal(refused.prometheus!.status, "denied");
  assert.match(renderPreflight({ ready: true, aws: NO_AWS, kubernetes: refused, next: [] }, named), /Querying it through the API server needs get on services\/proxy; see docs\/cloudpilot-kube-readonly\.yaml\./);

  const silent = await checkKubernetes(kubeReader({ proxyError: "Error from server (ServiceUnavailable): no endpoints available for service" }), named);
  assert.equal(silent.prometheus!.status, "unreachable");
});

test("a list the identity may not read is reported with what the scan loses; without pods or namespaces there is no scan", async () => {
  const some = await checkKubernetes(kubeReader({ denied: ["/apis/apps/v1/replicasets", "/api/v1/services"] }), options);
  assert.equal(some.status, "limited");
  assert.deepEqual(
    some.checks.filter((c) => c.status !== "allowed").map((c) => [c.resource, c.status]),
    [["services", "denied"], ["replicasets", "denied"]],
  );
  assert.equal(some.prometheus!.status, "not-checked", "without the services list Prometheus cannot be looked for");
  const result = { ready: true, aws: NO_AWS, kubernetes: some, next: ["cloudpilot kube"] };
  const text = renderPreflight(result, options);
  assert.match(text, /^ {4}denied {6}replicasets {2}\(.*is forbidden.*; Deployments are not seen\)$/m);
  assert.match(text, /docs\/cloudpilot-kube-readonly\.yaml in the CloudPilot repository holds the least access the scan needs;\n {2}it is a file for you to apply, and CloudPilot does not apply it\./);

  const reader = kubeReader({ denied: ["/api/v1/pods"] });
  const none = await checkKubernetes(reader, options);
  assert.equal(none.status, "not-ready");
  assert.equal(none.prometheus, undefined);
  assert.ok(!reader.asked.some((p) => p.includes("/proxy/") || p.startsWith("/api/v1/services?limit=500")), "nothing more is read once a scan is impossible");
  assert.deepEqual((await preflight(options, { aws: aws().probes, kube: reader })).next, ["cloudpilot scan --region ap-south-1"]);
});

test("a cluster that cannot be reached is a failed list, not a refused one", async () => {
  const reader: KubeReader = {
    identity: async () => ({ context: "prod" }),
    get: async () => {
      throw new Error("Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout");
    },
  };
  const report = await checkKubernetes(reader, options);
  assert.equal(report.status, "not-ready");
  assert.ok(report.checks.every((c) => c.status === "failed" && c.detail!.startsWith("Unable to connect")));
});

test("the exit code is 0 when either side can be scanned and the next commands name only what works", async () => {
  const noAws = aws({ identity: async () => Promise.reject(new AwsError("CredentialsProviderError")) }).probes;
  const given = { ...options, context: "prod", prometheus: { namespace: "obs", service: "prom", port: "80" }, profile: "audit" };

  const kubeOnly = await preflight(given, { aws: noAws, kube: kubeReader() });
  assert.deepEqual([kubeOnly.ready, kubeOnly.next], [true, ["cloudpilot kube --context prod --prometheus obs/prom:80"]]);
  const awsOnly = await preflight(given, { aws: aws().probes, kube: kubeReader({ missing: true }) });
  assert.deepEqual([awsOnly.ready, awsOnly.next], [true, ["cloudpilot scan --profile audit --region ap-south-1"]]);
  const both = await preflight(given, { aws: aws().probes, kube: kubeReader() });
  assert.equal(both.next.length, 2);
  const neither = await preflight(given, { aws: noAws, kube: kubeReader({ missing: true }) });
  assert.deepEqual([neither.ready, neither.next], [false, []]);
});

// The command

/** kubectl, as far as init uses it. Logs every call and refuses anything that is not a GET through get --raw or a read of the local config. */
const KUBECTL = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KUBE_LOG, JSON.stringify(args) + "\\n");
const rest = args[0] === "--context" ? args.slice(2) : args;
const mode = process.env.KUBE_MODE || "ok";
const fail = (text, code = 1) => { process.stderr.write(text); process.exitCode = code; };
if (rest.join(" ") === "config view --minify -o json") {
  if (mode === "no-context") fail("error: current-context must exist in order to minify");
  else process.stdout.write(JSON.stringify({ contexts: [{ name: args[0] === "--context" ? args[1] : "lab" }], clusters: [{ cluster: { server: "https://127.0.0.1:6443" } }] }));
} else if (rest.length === 3 && rest[0] === "get" && rest[1] === "--raw") {
  const path = rest[2];
  if (mode === "no-prometheus" && path.includes("/proxy/")) fail("Error from server (NotFound): services \\"prom\\" not found");
  else if (path.startsWith("/api/v1/services?")) process.stdout.write(JSON.stringify({ items: mode === "no-prometheus" ? [] : [{ metadata: { name: "prometheus", namespace: "monitoring" }, spec: { ports: [{ port: 9090 }] } }] }));
  else if (path.includes("/proxy/")) {
    const promql = decodeURIComponent(path.split("query=")[1]);
    const first = Date.now() / 1000 - 5 * 3600;
    process.stdout.write(JSON.stringify({ status: "success", data: { result: [{ metric: {}, value: [0, promql === "vector(1)" ? "1" : String(first)] }] } }));
  } else if (mode === "no-pods" && path.startsWith("/api/v1/pods")) fail('Error from server (Forbidden): pods is forbidden: User "alice" cannot list resource "pods"');
  else process.stdout.write(JSON.stringify({ items: [] }));
} else {
  fail("init called something it should not: kubectl " + args.join(" "), 2);
}
`;

function withKubectl(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-init-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "kubectl"), KUBECTL);
  chmodSync(join(bin, "kubectl"), 0o755);
  const log = join(dir, "kubectl.log");
  writeFileSync(log, "");
  return {
    calls: (): string[][] =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    run: (args: string[], env: Record<string, string> = {}) =>
      cli(["init", ...args], { blockNetwork: true, env: { PATH: `${bin}:${dirname(process.execPath)}`, KUBE_LOG: log, KUBE_MODE: mode, ...env } }),
  };
}

test("cloudpilot init with no credentials and no kubectl says what is missing and exits non-zero", () => {
  const run = cli(["init"], { blockNetwork: true, env: { PATH: dirname(process.execPath) } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /^CloudPilot init: what a scan can read from here\. It creates and changes nothing\.$/m);
  assert.match(run.stdout, /No AWS credentials were found\./);
  assert.match(run.stdout, /^Kubernetes\n {2}Skipped: kubectl is not on the PATH\.$/m);
  assert.match(run.stdout, /Nothing is ready to scan yet\./);

  const json = JSON.parse(cli(["init", "--json", "--profile", "nobody"], { blockNetwork: true, env: { PATH: dirname(process.execPath) } }).stdout);
  assert.equal(json.ready, false);
  assert.equal(json.aws.problem.kind, "no-credentials");
  assert.equal(json.aws.profile, "nobody");
  assert.deepEqual([json.kubernetes.status, json.kubernetes.skipped, json.next], ["skipped", "kubectl is not on the PATH", []]);
});

test("kubectl with no current context is skipped with that reason", () => {
  const run = withKubectl("no-context").run([]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Skipped: kubectl has no current context \(choose one with --context\)\./);
});

test("cloudpilot init scans a cluster ready, exits 0 without AWS, and kubectl is only ever asked to read", () => {
  const lab = withKubectl("ok");
  const run = lab.run(["--context", "lab-2"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}Context {2}lab-2 \(https:\/\/127\.0\.0\.1:6443\)$/m);
  assert.match(run.stdout, /monitoring\/prometheus:9090 \(found among the cluster's services\) answers a query\./);
  assert.match(run.stdout, /It holds about 5 hours of container history\./);
  assert.match(run.stdout, /What to run next\n {2}cloudpilot kube --context lab-2$/m);

  const calls = lab.calls();
  assert.ok(calls.length > 10);
  for (const call of calls) {
    assert.equal(call[0], "--context", "every call is made against the chosen context");
    const rest = call.slice(2);
    assert.ok(rest.join(" ") === "config view --minify -o json" || (rest.length === 3 && rest[0] === "get" && rest[1] === "--raw"), `kubectl ${call.join(" ")}`);
  }
  const paths = calls.filter((c) => c[2] === "get").map((c) => c[4]!);
  assert.ok(paths.every((p) => p.startsWith("/api/") || p.startsWith("/apis/")));
  assert.ok(!calls.some((c) => c.some((a) => /^(auth|can-i|apply|create|delete|patch|edit|replace|exec|proxy|port-forward)$/.test(a))));
  assert.deepEqual(
    [...new Set(paths.map((p) => p.replace(/\?.*$/, "").replace(/^.*\/proxy\//, "prometheus:")))].sort(),
    ["/api/v1/namespaces", "/api/v1/persistentvolumeclaims", "/api/v1/persistentvolumes", "/api/v1/pods", "/api/v1/services", "/apis/apps/v1/daemonsets", "/apis/apps/v1/deployments", "/apis/apps/v1/replicasets", "/apis/apps/v1/statefulsets", "prometheus:api/v1/query"],
  );
});

test("--prometheus names the service and the next command repeats it; a missing one is reported", () => {
  const named = withKubectl("ok").run(["--prometheus", "obs/prom:80", "--json"]);
  const json = JSON.parse(named.stdout);
  assert.equal(json.kubernetes.prometheus.ref, "obs/prom:80");
  assert.equal(json.kubernetes.prometheus.discovered, false);
  assert.deepEqual(json.next, ["cloudpilot kube --prometheus obs/prom:80"]);

  const missing = withKubectl("no-prometheus").run([]);
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /Prometheus was not found/);
  assert.match(missing.stdout, /cloudpilot kube$/m);

  assert.match(withKubectl("ok").run(["--prometheus", "nonsense"]).stderr, /--prometheus takes namespace\/service:port/);
});

test("a cluster that refuses pods leaves nothing to scan", () => {
  const run = withKubectl("no-pods").run([]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /denied {6}pods/);
  assert.match(run.stdout, /The scan needs to list namespaces and pods\./);
});

test("a failing call never echoes the credentials", () => {
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const run = cli(["init"], { blockNetwork: true, env: { PATH: dirname(process.execPath), AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: "FwoGZXIvYXdzEXAMPLETOKEN" } });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /The credentials could not be used: /);
  for (const text of [run.stdout, run.stderr]) {
    assert.doesNotMatch(text, /AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI|FwoGZXIvYXdz/);
  }
});

/**
 * A local stand-in for AWS: STS names a user, EC2, S3, CloudWatch and the
 * Price List answer some reads and refuse the rest in each service's own
 * error format. It logs every request, so the test can see what was sent.
 */
const FAKE_AWS = `
const http = require("http");
const fs = require("fs");
const xml = (res, status, body) => { res.writeHead(status, { "content-type": "text/xml" }); res.end(body); };
const s3error = (res, status, code) => xml(res, status, "<Error><Code>" + code + "</Code><Message>" + code + "</Message></Error>");
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const target = req.headers["x-amz-target"] || "";
    const action = new URLSearchParams(body).get("Action") || "";
    fs.appendFileSync(process.env.AWS_LOG, JSON.stringify({ method: req.method, path: url.pathname, query: url.search, target, action }) + "\\n");
    if (target.startsWith("AWSPriceListService")) {
      res.writeHead(400, { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": "AccessDeniedException" });
      return res.end(JSON.stringify({ __type: "AccessDeniedException", message: "not allowed" }));
    }
    if (action === "GetMetricData") return xml(res, 403, "<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>not allowed</Message></Error></ErrorResponse>");
    if (action === "GetCallerIdentity") {
      return xml(res, 200, '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/alice</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
    }
    if (action === "DescribeRegions") return xml(res, 200, '<DescribeRegionsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><regionInfo/></DescribeRegionsResponse>');
    if (action === "DescribeVolumes") return xml(res, 200, '<DescribeVolumesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><volumeSet/></DescribeVolumesResponse>');
    if (action) return xml(res, 403, "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>not authorized</Message></Error></Errors></Response>");
    const q = url.searchParams;
    if (url.pathname === "/") return xml(res, 200, '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets><Bucket><Name>alpha</Name></Bucket></Buckets></ListAllMyBucketsResult>');
    if (q.has("location")) return xml(res, 200, '<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">ap-south-1</LocationConstraint>');
    if (q.has("lifecycle")) return s3error(res, 404, "NoSuchLifecycleConfiguration");
    if (q.has("tagging")) return s3error(res, 404, "NoSuchTagSet");
    if (q.has("uploads")) return xml(res, 200, '<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>alpha</Bucket></ListMultipartUploadsResult>');
    return s3error(res, 403, "AccessDenied");
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

test("against a stand-in for AWS, the real reads are classified: allowed, denied, nothing there, not tested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-init-aws-"));
  const log = join(dir, "aws.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "server.cjs"), FAKE_AWS);
  const server = spawn(process.execPath, [join(dir, "server.cjs")], { env: { AWS_LOG: log, PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise<string>((done, fail) => {
      server.stdout.once("data", (d) => done(String(d).trim()));
      server.once("exit", () => fail(new Error("the stand-in for AWS did not start")));
    });
    const run = cli(["init", "--region", "ap-south-1", "--json"], { env: { PATH: dirname(process.execPath), AWS_ENDPOINT_URL: `http://127.0.0.1:${port}` } });
    const json = JSON.parse(run.stdout);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(json.aws.identity, { account: "123456789012", arn: "arn:aws:iam::123456789012:user/alice" });
    assert.deepEqual(statuses(json.aws.checks), {
      DescribeRegions: "allowed",
      DescribeVolumes: "allowed",
      DescribeSnapshots: "denied",
      DescribeImages: "denied",
      DescribeInstances: "denied",
      DescribeAddresses: "denied",
      DescribeLaunchTemplates: "denied",
      DescribeLaunchTemplateVersions: "not-tested",
      ListBuckets: "allowed",
      GetBucketLocation: "allowed",
      GetBucketLifecycleConfiguration: "allowed",
      GetBucketTagging: "allowed",
      ListObjectsV2: "denied",
      ListMultipartUploads: "allowed",
      ListParts: "not-tested",
      GetMetricData: "denied",
      GetProducts: "denied",
    });
    assert.equal(json.aws.status, "limited");
    assert.equal(json.aws.fix[1], "aws iam attach-user-policy --user-name alice --policy-arn arn:aws:iam::123456789012:policy/CloudPilotReadOnly");
    assert.deepEqual(json.next, ["cloudpilot scan --region ap-south-1"]);

    // Only reads reached AWS: Describe and Get actions through the query APIs, GETs to S3, and the Price List read.
    const requests = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; path: string; action: string; target: string });
    assert.ok(requests.length >= AWS_READS.length - 2);
    for (const r of requests) {
      if (r.action) assert.match(r.action, /^(Describe|Get)[A-Z]/, r.action);
      else if (r.target) assert.match(r.target, /\.GetProducts$/);
      else assert.equal(r.method, "GET", `${r.method} ${r.path}`);
    }
    // Reads that are tried on a bucket go to the one the listing returned.
    assert.ok(requests.some((r) => r.path === "/alpha/" && r.query.includes("tagging")));
  } finally {
    server.kill();
  }
});
