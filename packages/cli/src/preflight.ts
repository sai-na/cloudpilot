/**
 * `cloudpilot init`: will a scan work here, and what is missing?
 *
 * Every check is the cheapest real read of something a scan reads anyway: one
 * page of one resource, in one region, or one `limit=1` list through
 * `kubectl get --raw`. Nothing is created or changed, and nothing is asked for
 * that a scan does not already need. Where access is missing, the result holds
 * the commands or the file for a person to apply. CloudPilot never runs them.
 */
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeLaunchTemplatesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeRegionsCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { now } from "./clock.js";
import { clientConfig } from "./collect.js";
import { confidenceFor, hours } from "./kube-detect.js";
import { KubectlNotFoundError, list, prometheusCandidates, prometheusLabel, query, type KubeReader, type PrometheusRef } from "./kube.js";
import { PRICING_ENDPOINT_REGION } from "./pricing.js";
import { labelClient } from "./recording.js";

/** How long one AWS read may take before it is reported as not answering. */
const AWS_TIMEOUT_MS = 15_000;
/** How long one kubectl call may take. */
export const KUBECTL_TIMEOUT_MS = 30_000;
/** How far back to look for container history: the cluster scan's default lookback. */
const HISTORY_WINDOW_HOURS = 168;

export const AWS_POLICY_FILE = "docs/cloudpilot-readonly-policy.json";
export const KUBE_ROLE_FILE = "docs/cloudpilot-kube-readonly.yaml";

// What the scan reads from AWS

/** What a read may need from an earlier one to be tried on: something to point at. */
export interface Sample {
  bucket?: string;
  launchTemplateId?: string;
  upload?: { bucket: string; key: string; uploadId: string };
}

export interface AwsRead {
  service: string;
  operation: string;
  /** The IAM permission, as the README and the read-only policy name it. */
  permission: string;
  /** The read can only be tried on something an earlier read found. */
  needs?: keyof Sample;
}

const READS = [
  { service: "EC2", operation: "DescribeRegions", permission: "ec2:DescribeRegions" },
  { service: "EC2", operation: "DescribeVolumes", permission: "ec2:DescribeVolumes" },
  { service: "EC2", operation: "DescribeSnapshots", permission: "ec2:DescribeSnapshots" },
  { service: "EC2", operation: "DescribeImages", permission: "ec2:DescribeImages" },
  { service: "EC2", operation: "DescribeInstances", permission: "ec2:DescribeInstances" },
  { service: "EC2", operation: "DescribeAddresses", permission: "ec2:DescribeAddresses" },
  { service: "EC2", operation: "DescribeLaunchTemplates", permission: "ec2:DescribeLaunchTemplates" },
  { service: "EC2", operation: "DescribeLaunchTemplateVersions", permission: "ec2:DescribeLaunchTemplateVersions", needs: "launchTemplateId" },
  { service: "S3", operation: "ListBuckets", permission: "s3:ListAllMyBuckets" },
  { service: "S3", operation: "GetBucketLocation", permission: "s3:GetBucketLocation", needs: "bucket" },
  { service: "S3", operation: "GetBucketLifecycleConfiguration", permission: "s3:GetLifecycleConfiguration", needs: "bucket" },
  { service: "S3", operation: "GetBucketTagging", permission: "s3:GetBucketTagging", needs: "bucket" },
  { service: "S3", operation: "ListObjectsV2", permission: "s3:ListBucket", needs: "bucket" },
  { service: "S3", operation: "ListMultipartUploads", permission: "s3:ListBucketMultipartUploads", needs: "bucket" },
  { service: "S3", operation: "ListParts", permission: "s3:ListMultipartUploadParts", needs: "upload" },
  { service: "CloudWatch", operation: "GetMetricData", permission: "cloudwatch:GetMetricData" },
  { service: "Pricing", operation: "GetProducts", permission: "pricing:GetProducts" },
] as const satisfies readonly AwsRead[];

type AwsOperation = (typeof READS)[number]["operation"];

/** Every kind of read a scan makes, in the order of the README table. */
export const AWS_READS: readonly AwsRead[] = READS;

export interface AwsProbes {
  /** Where the reads are tried. */
  region: string;
  /** Who the credentials are. Rejects with the SDK's error when there are none. */
  identity(): Promise<{ account: string; arn: string }>;
  /** Try one read. Resolves with what it found that other reads can be tried on; rejects with AWS's error. */
  read(operation: string, sample: Sample): Promise<Sample | void>;
}

/** The names AWS services give a refusal. */
const DENIED = /^(UnauthorizedOperation|UnauthorizedAccess|Unauthorized|AccessDenied|AccessDeniedException|AuthorizationError|Forbidden)$/;

const errorName = (err: unknown) => (err instanceof Error ? err.name : String(err));

/** Reads that answer with an error when the thing they ask about is simply not there, which still proves access. */
const NOTHING_THERE: Partial<Record<AwsOperation, string>> = {
  GetBucketLifecycleConfiguration: "NoSuchLifecycleConfiguration",
  GetBucketTagging: "NoSuchTagSet",
};

/** The reads, over the same clients, regions and credentials a scan uses. Each is one page of one resource. */
export function awsProbes(opts: { region: string; profile?: string }): AwsProbes {
  const config = clientConfig(opts);
  const ec2 = labelClient(new EC2Client(config), "EC2");
  const s3 = labelClient(new S3Client(config), "S3");
  const cloudwatch = labelClient(new CloudWatchClient(config), "CloudWatch");
  const pricing = labelClient(new PricingClient(clientConfig({ region: PRICING_ENDPOINT_REGION, profile: opts.profile })), "Pricing");
  const within = () => ({ abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
  const target = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`${what} is needed to try this read`);
    return value;
  };

  const reads: Record<AwsOperation, (sample: Sample) => Promise<Sample | void>> = {
    DescribeRegions: async () => void (await ec2.send(new DescribeRegionsCommand({}), within())),
    DescribeVolumes: async () => void (await ec2.send(new DescribeVolumesCommand({ MaxResults: 5 }), within())),
    DescribeSnapshots: async () => void (await ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ["self"], MaxResults: 5 }), within())),
    DescribeImages: async () => void (await ec2.send(new DescribeImagesCommand({ Owners: ["self"], MaxResults: 5 }), within())),
    DescribeInstances: async () => void (await ec2.send(new DescribeInstancesCommand({ MaxResults: 5 }), within())),
    DescribeAddresses: async () => void (await ec2.send(new DescribeAddressesCommand({}), within())),
    DescribeLaunchTemplates: async () => {
      const res = await ec2.send(new DescribeLaunchTemplatesCommand({ MaxResults: 1 }), within());
      return { launchTemplateId: res.LaunchTemplates?.[0]?.LaunchTemplateId };
    },
    DescribeLaunchTemplateVersions: async (sample) => {
      await ec2.send(new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: target(sample.launchTemplateId, "A launch template"), Versions: ["$Latest"] }), within());
    },
    ListBuckets: async () => {
      const res = await s3.send(new ListBucketsCommand({ BucketRegion: opts.region, MaxBuckets: 1 }), within());
      return { bucket: res.Buckets?.[0]?.Name };
    },
    GetBucketLocation: async (sample) => void (await s3.send(new GetBucketLocationCommand({ Bucket: target(sample.bucket, "A bucket") }), within())),
    GetBucketLifecycleConfiguration: async (sample) => void (await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: target(sample.bucket, "A bucket") }), within())),
    GetBucketTagging: async (sample) => void (await s3.send(new GetBucketTaggingCommand({ Bucket: target(sample.bucket, "A bucket") }), within())),
    ListObjectsV2: async (sample) => void (await s3.send(new ListObjectsV2Command({ Bucket: target(sample.bucket, "A bucket"), MaxKeys: 1 }), within())),
    ListMultipartUploads: async (sample) => {
      const bucket = target(sample.bucket, "A bucket");
      const res = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, MaxUploads: 1 }), within());
      const upload = res.Uploads?.[0];
      return upload?.Key && upload.UploadId ? { upload: { bucket, key: upload.Key, uploadId: upload.UploadId } } : {};
    },
    ListParts: async (sample) => {
      const upload = target(sample.upload, "An incomplete upload");
      await s3.send(new ListPartsCommand({ Bucket: upload.bucket, Key: upload.key, UploadId: upload.uploadId, MaxParts: 1 }), within());
    },
    GetMetricData: async () => {
      const end = now();
      await cloudwatch.send(
        new GetMetricDataCommand({
          StartTime: new Date(end.getTime() - 5 * 60_000),
          EndTime: end,
          MetricDataQueries: [{ Id: "probe", MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUUtilization" }, Period: 300, Stat: "Average" } }],
        }),
        within(),
      );
    },
    GetProducts: async () => {
      await pricing.send(
        new GetProductsCommand({
          ServiceCode: "AmazonEC2",
          Filters: [
            { Type: "TERM_MATCH", Field: "regionCode", Value: opts.region },
            { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage" },
          ],
          MaxResults: 1,
        }),
        within(),
      );
    },
  };

  return {
    region: opts.region,
    identity: async () => {
      const res = await labelClient(new STSClient(config), "STS").send(new GetCallerIdentityCommand({}), within());
      return { account: res.Account ?? "unknown", arn: res.Arn ?? "unknown" };
    },
    read: async (operation, sample) => {
      const run = reads[operation as AwsOperation];
      if (!run) throw new Error(`${operation} is not a read CloudPilot makes`);
      try {
        return await run(sample);
      } catch (err) {
        if (errorName(err) === NOTHING_THERE[operation as AwsOperation]) return;
        throw err;
      }
    },
  };
}

// The result

export type Access = "allowed" | "denied" | "failed" | "not-tested";

export interface ReadCheck {
  service: string;
  operation: string;
  permission: string;
  status: Access;
  detail?: string;
}

export interface AwsReport {
  /** ready: every read allowed. limited: a scan runs but skips some checks. not-ready: a scan cannot run. */
  status: "ready" | "limited" | "not-ready";
  region: string;
  profile?: string;
  identity?: { account: string; arn: string };
  problem?: { kind: "no-credentials" | "failed"; message: string };
  checks: ReadCheck[];
  /** A scan without --region needs the list of regions. */
  canListRegions: boolean;
  /** Commands for a person to run to give the credentials the read-only policy. Empty when nothing was denied. */
  fix: string[];
}

export interface KubeListCheck {
  resource: string;
  path: string;
  status: Exclude<Access, "not-tested">;
  detail?: string;
}

export interface PrometheusCheck {
  status: "answers" | "no-container-figures" | "not-found" | "unreachable" | "denied" | "not-checked";
  /** namespace/service:port. */
  ref?: string;
  /** Found by looking at the cluster's services, not named with --prometheus. */
  discovered?: boolean;
  /** How far back the oldest container's figures go, at most a week. */
  historyHours?: number;
  detail?: string;
}

export interface KubeReport {
  /** skipped: no kubectl, or no context to read. */
  status: "ready" | "limited" | "not-ready" | "skipped";
  skipped?: string;
  context?: string;
  server?: string;
  checks: KubeListCheck[];
  prometheus?: PrometheusCheck;
}

export interface PreflightResult {
  /** At least one of AWS and Kubernetes can be scanned: the exit code is 0. */
  ready: boolean;
  aws: AwsReport;
  kubernetes: KubeReport;
  next: string[];
}

export interface PreflightOptions {
  region: string;
  /** --region was given, not defaulted. */
  regionGiven: boolean;
  profile?: string;
  context?: string;
  prometheus?: PrometheusRef;
  now?: Date;
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
const brief = (text: string) => (text.length > 140 ? `${text.slice(0, 137)}...` : text);

function awsFailure(err: unknown): string {
  return errorName(err) === "AbortError" || errorName(err) === "TimeoutError"
    ? `no answer within ${AWS_TIMEOUT_MS / 1000} seconds`
    : brief(`${errorName(err)}${err instanceof Error && err.message ? `: ${firstLine(err)}` : ""}`);
}

// AWS

/** What a read that needs something to try itself on says when it had nothing, and the read that looks for it. */
const NEEDS: Record<keyof Sample, { what: string; looked: string }> = {
  bucket: { what: "a bucket", looked: "ListBuckets" },
  launchTemplateId: { what: "a launch template", looked: "DescribeLaunchTemplates" },
  upload: { what: "an incomplete multipart upload", looked: "ListMultipartUploads" },
};

/** Try every read a scan makes, each as soon as what it needs has been found. */
async function tryReads(probes: AwsProbes): Promise<ReadCheck[]> {
  const sample: Sample = {};
  const results = new Map<string, Pick<ReadCheck, "status" | "detail">>();
  let pending = [...AWS_READS];
  while (pending.length > 0) {
    const ready = pending.filter((r) => !r.needs || sample[r.needs] !== undefined);
    if (ready.length === 0) break;
    pending = pending.filter((r) => !ready.includes(r));
    await Promise.all(
      ready.map(async (r) => {
        try {
          const found = await probes.read(r.operation, sample);
          if (found) for (const [key, value] of Object.entries(found)) if (value !== undefined) Object.assign(sample, { [key]: value });
          const on = r.needs === "bucket" ? sample.bucket : r.needs === "upload" ? sample.upload?.bucket : undefined;
          results.set(r.operation, { status: "allowed", ...(on ? { detail: `tried on bucket ${on}` } : {}) });
        } catch (err) {
          results.set(r.operation, DENIED.test(errorName(err)) ? { status: "denied", detail: errorName(err) } : { status: "failed", detail: awsFailure(err) });
        }
      }),
    );
  }
  return AWS_READS.map((r) => {
    const need = NEEDS[r.needs!];
    const unlisted = ["denied", "failed"].includes(results.get(need?.looked)?.status ?? "");
    const result = results.get(r.operation) ?? { status: "not-tested" as const, detail: `needs ${need?.what} to try it on; ${unlisted ? "none could be listed" : "none was found"}` };
    return { service: r.service, operation: r.operation, permission: r.permission, ...result };
  });
}

/** The commands that would attach the read-only policy to whoever these credentials are. */
export function policyCommands(identity: { account: string; arn: string }): string[] {
  const [, partition = "aws", , , , resource = ""] = identity.arn.split(":");
  const [kind = "", ...rest] = resource.split("/");
  const policy = `arn:${partition}:iam::${identity.account}:policy/CloudPilotReadOnly`;
  const attach =
    kind === "user" && rest.length > 0
      ? `aws iam attach-user-policy --user-name ${rest[rest.length - 1]} --policy-arn ${policy}`
      : kind === "assumed-role" && rest.length > 1
        ? `aws iam attach-role-policy --role-name ${rest[0]} --policy-arn ${policy}`
        : `aws iam attach-user-policy --user-name <user> --policy-arn ${policy}   # or attach-role-policy --role-name <role>`;
  return [`aws iam create-policy --policy-name CloudPilotReadOnly --policy-document file://${AWS_POLICY_FILE}`, attach];
}

export async function checkAws(probes: AwsProbes, options: Pick<PreflightOptions, "profile">): Promise<AwsReport> {
  const base = { region: probes.region, ...(options.profile ? { profile: options.profile } : {}) };
  let identity: { account: string; arn: string };
  try {
    identity = await probes.identity();
  } catch (err) {
    const none = errorName(err) === "CredentialsProviderError";
    return { ...base, status: "not-ready", problem: { kind: none ? "no-credentials" : "failed", message: none ? firstLine(err) : awsFailure(err) }, checks: [], canListRegions: false, fix: [] };
  }
  const checks = await tryReads(probes);
  const allowed = checks.filter((c) => c.status === "allowed").length;
  const missing = checks.some((c) => c.status === "denied" || c.status === "failed");
  return {
    ...base,
    status: allowed === 0 ? "not-ready" : missing ? "limited" : "ready",
    identity,
    checks,
    canListRegions: checks.find((c) => c.operation === "DescribeRegions")?.status === "allowed",
    fix: checks.some((c) => c.status === "denied") ? policyCommands(identity) : [],
  };
}

// Kubernetes

/** The lists a cluster scan makes. The first two are the ones it cannot do without. */
const KUBE_LISTS = [
  { resource: "namespaces", path: "/api/v1/namespaces", without: "the scan cannot run", required: true },
  { resource: "pods", path: "/api/v1/pods", without: "the scan cannot run", required: true },
  { resource: "services", path: "/api/v1/services", without: "Prometheus cannot be found; name it with --prometheus" },
  { resource: "replicasets", path: "/apis/apps/v1/replicasets", without: "Deployments are not seen" },
  { resource: "deployments", path: "/apis/apps/v1/deployments", without: "the cloudpilot/ignore label on a Deployment is not seen" },
  { resource: "statefulsets", path: "/apis/apps/v1/statefulsets", without: "the cloudpilot/ignore label on a StatefulSet is not seen" },
  { resource: "daemonsets", path: "/apis/apps/v1/daemonsets", without: "the cloudpilot/ignore label on a DaemonSet is not seen" },
  { resource: "persistentvolumeclaims", path: "/api/v1/persistentvolumeclaims", without: "unused volume claims are not reported" },
  { resource: "persistentvolumes", path: "/api/v1/persistentvolumes", without: "released volumes are not reported" },
] as const;

const refused = (err: unknown) => /\((Forbidden|Unauthorized)\)|is forbidden|must be logged in/i.test(err instanceof Error ? err.message : String(err));

/** What the people who read the report need to know about a failed kubectl call, in one line. */
const kubeFailure = (err: unknown) => brief(firstLine(err));

async function checkPrometheus(reader: KubeReader, options: PreflightOptions, servicesAllowed: boolean): Promise<PrometheusCheck> {
  let candidates: PrometheusRef[];
  const discovered = !options.prometheus;
  if (options.prometheus) {
    candidates = [options.prometheus];
  } else if (!servicesAllowed) {
    return { status: "not-checked", detail: "the cluster's services could not be listed, so Prometheus was not looked for" };
  } else {
    try {
      candidates = prometheusCandidates(await list(reader, "/api/v1/services"));
    } catch (err) {
      return { status: "not-checked", detail: `the cluster's services could not be listed to look for Prometheus: ${kubeFailure(err)}` };
    }
    if (candidates.length === 0) return { status: "not-found", detail: "no service in the cluster looks like a Prometheus server" };
  }

  let last: unknown;
  for (const candidate of candidates) {
    const ref = prometheusLabel(candidate);
    try {
      await query(reader, candidate, "vector(1)");
    } catch (err) {
      last = err;
      continue;
    }
    // The oldest figure any container has, as the scan would find it, looking back at most a week.
    const oldest = `min(min_over_time(timestamp(container_memory_working_set_bytes{container!="",container!="POD"})[${HISTORY_WINDOW_HOURS}h:5m]))`;
    try {
      const [first] = (await query(reader, candidate, oldest)).filter((s) => Number.isFinite(s.value));
      if (!first) return { status: "no-container-figures", ref, discovered, detail: "it answers, but holds no container_memory_working_set_bytes" };
      const historyHours = Math.min(HISTORY_WINDOW_HOURS, Math.max(0, ((options.now ?? new Date()).getTime() / 1000 - first.value) / 3600));
      return { status: "answers", ref, discovered, historyHours };
    } catch (err) {
      return { status: "answers", ref, discovered, detail: `it answers, but the history could not be read: ${kubeFailure(err)}` };
    }
  }
  const named = candidates.map(prometheusLabel).join(", ");
  return { status: refused(last) ? "denied" : "unreachable", ref: named, discovered, detail: kubeFailure(last) };
}

export async function checkKubernetes(reader: KubeReader, options: PreflightOptions): Promise<KubeReport> {
  let identity: { context: string; server?: string };
  try {
    identity = await reader.identity();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof KubectlNotFoundError) return { status: "skipped", skipped: "kubectl is not on the PATH", checks: [] };
    if (/current-context|no current context/i.test(message)) return { status: "skipped", skipped: "kubectl has no current context (choose one with --context)", checks: [] };
    return { status: "skipped", skipped: `kubectl could not read its configuration: ${kubeFailure(err)}`, checks: [] };
  }

  const checks = await Promise.all(
    KUBE_LISTS.map(async (l): Promise<KubeListCheck> => {
      try {
        await reader.get(`${l.path}?limit=1`);
        return { resource: l.resource, path: l.path, status: "allowed" };
      } catch (err) {
        return { resource: l.resource, path: l.path, status: refused(err) ? "denied" : "failed", detail: kubeFailure(err) };
      }
    }),
  );
  const allowed = (resource: string) => checks.find((c) => c.resource === resource)?.status === "allowed";
  const canScan = KUBE_LISTS.filter((l) => "required" in l).every((l) => allowed(l.resource));
  const base = { context: identity.context, ...(identity.server ? { server: identity.server } : {}), checks };
  if (!canScan) return { ...base, status: "not-ready" };

  const prometheus = await checkPrometheus(reader, options, allowed("services"));
  const complete = checks.every((c) => c.status === "allowed") && prometheus.status === "answers" && prometheus.historyHours !== undefined;
  return { ...base, status: complete ? "ready" : "limited", prometheus };
}

// Putting it together

/** The commands that will work, given what was found. */
function nextCommands(aws: AwsReport, kubernetes: KubeReport, options: PreflightOptions): string[] {
  const next: string[] = [];
  if (aws.status !== "not-ready") {
    // Scanning every region starts by listing them; without that permission a region has to be named.
    const region = options.regionGiven || !aws.canListRegions ? ` --region ${aws.region}` : "";
    next.push(`cloudpilot scan${options.profile ? ` --profile ${options.profile}` : ""}${region}`);
  }
  if (kubernetes.status === "ready" || kubernetes.status === "limited") {
    const given = options.prometheus ? ` --prometheus ${prometheusLabel(options.prometheus)}` : "";
    next.push(`cloudpilot kube${options.context ? ` --context ${options.context}` : ""}${given}`);
  }
  return next;
}

export async function preflight(options: PreflightOptions, probes: { aws: AwsProbes; kube: KubeReader }): Promise<PreflightResult> {
  const [aws, kubernetes] = await Promise.all([checkAws(probes.aws, options), checkKubernetes(probes.kube, options)]);
  const next = nextCommands(aws, kubernetes, options);
  return { ready: next.length > 0, aws, kubernetes, next };
}

// The report

const LABEL = 12;
const mark = (status: Access) => status.replace("-", " ").padEnd(LABEL);

function renderAws(aws: AwsReport, options: PreflightOptions): string[] {
  const out = ["AWS identity"];
  if (aws.problem?.kind === "no-credentials") {
    out.push(
      `  No AWS credentials were found${aws.profile ? ` for profile ${aws.profile}` : ""}. (${aws.problem.message})`,
      "  Supply them in one of these ways:",
      "    - AWS CloudShell, opened from the AWS console, already has yours.",
      "    - A named profile: cloudpilot init --profile <name>",
      "    - Environment variables: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (with AWS_SESSION_TOKEN for temporary credentials), or AWS_PROFILE.",
    );
    return out;
  }
  if (aws.problem) {
    out.push(`  The credentials could not be used: ${aws.problem.message}`);
    return out;
  }
  const { account, arn } = aws.identity!;
  out.push(`  Account  ${account}`, `  ARN      ${arn}`, ...(aws.profile ? [`  Profile  ${aws.profile}`] : []));

  out.push("", `AWS access, tried in ${aws.region}${options.regionGiven ? "" : " (the default; --region tries another)"}`);
  for (const c of aws.checks) {
    out.push(`  ${mark(c.status)}${`${c.service} ${c.operation}`.padEnd(46)}${c.detail ? `  ${c.detail}` : ""}`.trimEnd());
  }
  const count = (status: Access) => aws.checks.filter((c) => c.status === status).length;
  const total = aws.checks.length;
  out.push("", `  ${count("allowed")} of ${total} reads allowed${count("denied") ? `, ${count("denied")} denied` : ""}${count("failed") ? `, ${count("failed")} failed` : ""}${count("not-tested") ? `, ${count("not-tested")} not tested` : ""}.`);
  if (aws.status === "not-ready") out.push("  No read was allowed, so a scan would find nothing.");
  else if (aws.status === "limited") out.push("  A scan still runs and reports each read it cannot make as a skipped check.");
  if (!aws.canListRegions) out.push("  DescribeRegions is not allowed, so a scan has to be given --region.");
  if (aws.fix.length > 0) {
    out.push(
      "",
      `  To allow the reads that were denied, give these credentials the read-only policy (${AWS_POLICY_FILE} in the CloudPilot repository).`,
      "  These are commands for you to run, with an identity that may change IAM. CloudPilot does not run them:",
      ...aws.fix.map((c) => `    ${c}`),
      "  A denial can also come from a permissions boundary or an organisation policy, which this policy does not override.",
      ...(aws.identity!.arn.includes("assumed-role/AWSReservedSSO_") ? ["  These credentials are an IAM Identity Center role: add the permissions to its permission set instead."] : []),
    );
  }
  return out;
}

function renderKube(kube: KubeReport): string[] {
  const out = ["Kubernetes"];
  if (kube.status === "skipped") return [...out, `  Skipped: ${kube.skipped}.`];
  out.push(`  Context  ${kube.context}${kube.server ? ` (${kube.server})` : ""}`, "", "  Lists, tried with kubectl get --raw and limit=1");
  const lists = new Map<string, string>(KUBE_LISTS.map((l) => [l.resource, l.without]));
  for (const c of kube.checks) {
    const effect = c.status === "allowed" ? "" : [c.detail, lists.get(c.resource)].filter(Boolean).join("; ");
    out.push(`    ${mark(c.status)}${c.resource}${effect ? `  (${effect})` : ""}`);
  }
  const lost = kube.checks.filter((c) => c.status !== "allowed");
  if (kube.status === "not-ready") out.push("", "  The scan needs to list namespaces and pods. Nothing was found that lets it.");
  if (lost.length > 0) out.push("", `  Access to read these comes from your cluster's administrator. ${KUBE_ROLE_FILE} in the CloudPilot repository holds the least access the scan needs;`, "  it is a file for you to apply, and CloudPilot does not apply it.");

  const p = kube.prometheus;
  if (p) {
    out.push("", "  Prometheus");
    if (p.status === "answers") {
      out.push(`    ${p.ref}${p.discovered ? " (found among the cluster's services)" : ""} answers a query.`);
      if (p.historyHours !== undefined) {
        const h = p.historyHours;
        out.push(`    It holds about ${hours(h)} of container history${h >= HISTORY_WINDOW_HOURS ? " or more" : ""}.`);
        if (h < 5 / 60) out.push("    That is under five minutes, so no container can be judged yet.");
        else if (h < HISTORY_WINDOW_HOURS) out.push(`    A scan can use it, with a rule confidence of ${Math.round(confidenceFor(h) * 100)}% on findings; a week or more gives ${Math.round(confidenceFor(HISTORY_WINDOW_HOURS) * 100)}%.`);
      } else if (p.detail) {
        out.push(`    ${p.detail}`);
      }
    } else {
      const what = { "no-container-figures": "holds no container figures", "not-found": "was not found", unreachable: "could not be queried", denied: "was refused", "not-checked": "was not checked" }[p.status];
      out.push(`    ${p.ref ?? "Prometheus"} ${what}${p.detail ? `: ${p.detail}` : ""}.`);
      if (p.status === "not-found" || p.status === "unreachable" || p.status === "not-checked") out.push("    Name it with --prometheus namespace/service:port.");
      if (p.status === "denied") out.push(`    Querying it through the API server needs get on services/proxy; see ${KUBE_ROLE_FILE}.`);
      out.push("    Without it a scan still reports volumes, and says requests were not compared with real use.");
    }
  }
  return out;
}

export function renderPreflight(result: PreflightResult, options: PreflightOptions): string {
  const out = ["CloudPilot init: what a scan can read from here. It creates and changes nothing.", "", ...renderAws(result.aws, options), "", ...renderKube(result.kubernetes), "", "What to run next"];
  if (result.next.length > 0) out.push(...result.next.map((c) => `  ${c}`));
  else out.push("  Nothing is ready to scan yet. Fix what is listed above, then run cloudpilot init again.");
  return out.join("\n");
}
