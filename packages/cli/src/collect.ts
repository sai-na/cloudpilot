import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandInput } from "@aws-sdk/client-cost-explorer";
import {
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeRegionsCommand,
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeLaunchTemplates,
  paginateDescribeNatGateways,
  paginateDescribeSnapshots,
  paginateDescribeVolumes,
  type Tag,
} from "@aws-sdk/client-ec2";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  type Bucket,
} from "@aws-sdk/client-s3";
import {
  DescribeLoadBalancerAttributesCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  paginateDescribeLoadBalancers,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { paginateDescribeDBInstances, RDSClient } from "@aws-sdk/client-rds";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { now } from "./clock.js";
import { awsRequestHandler, labelClient, mode, ReplayMissError } from "./recording.js";
import type {
  Bill,
  BucketInfo,
  ConnectionStats,
  CpuStats,
  InstanceInfo,
  Inventory,
  LoadBalancerInfo,
  MultipartUploadInfo,
  NatGatewayInfo,
  RdsInstanceInfo,
  TrafficStats,
} from "./types.js";

export interface AwsOptions {
  region: string;
  profile?: string;
  /** How far back to read CPU metrics for running instances. */
  lookbackHours: number;
}

/** Objects listed per bucket before the size is reported as a lower bound. */
const MAX_OBJECT_PAGES = 10;

/** Load balancers whose targets are read at the same time, to stay inside the API's rate limits. */
const LOAD_BALANCERS_AT_ONCE = 5;

/** DescribeTags takes at most this many ARNs in one request. */
const TAGS_PER_REQUEST = 20;

/** Run a task per item, a few at a time, keeping the results in the order of the items. */
export async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function clientConfig(opts: { region: string; profile?: string }) {
  // AWS_ENDPOINT_URL (the Moto emulator) is honoured by the SDK itself.
  const emulator = Boolean(process.env.AWS_ENDPOINT_URL);
  const requestHandler = awsRequestHandler();
  return {
    region: opts.region,
    ...(requestHandler ? { requestHandler } : {}),
    // A replay never touches credentials: nothing is sent anywhere.
    ...(mode() === "replay"
      ? { credentials: { accessKeyId: "replay", secretAccessKey: "replay" } }
      : emulator
        ? { credentials: { accessKeyId: "testing", secretAccessKey: "testing" }, forcePathStyle: true }
        : opts.profile
          ? { credentials: fromIni({ profile: opts.profile }) }
          : {}),
  };
}

export const IGNORE_TAG = "cloudpilot:ignore";

const nameTag = (tags?: Tag[]) => tags?.find((t) => t.Key === "Name")?.Value;

const ignoredByTag = (tags?: Array<{ Key?: string; Value?: string }>) =>
  tags?.some((t) => t.Key === IGNORE_TAG && t.Value?.toLowerCase() === "true") || undefined;

const errorName = (err: unknown) => (err instanceof Error ? err.name : String(err));

/** Run one collection step; a failure becomes a warning instead of ending the scan. */
async function attempt<T>(what: string, warnings: string[], fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // A request missing from a replay is a hard stop, never a skipped check.
    if (err instanceof ReplayMissError) throw err;
    warnings.push(`${what}: ${errorName(err)}${err instanceof Error ? ` - ${err.message}` : ""}`);
    return fallback;
  }
}

/** The account these credentials belong to. */
export async function callerAccount(opts: { region: string; profile?: string }): Promise<string> {
  const identity = await labelClient(new STSClient(clientConfig(opts)), "STS").send(new GetCallerIdentityCommand({}));
  return identity.Account ?? "unknown";
}

/** Every region enabled for the account, in name order. */
export async function enabledRegions(opts: { region: string; profile?: string }): Promise<string[]> {
  const res = await labelClient(new EC2Client(clientConfig(opts)), "EC2").send(new DescribeRegionsCommand({}));
  return (res.Regions ?? []).map((r) => r.RegionName!).filter(Boolean).sort();
}

/** Read one region. */
export async function collect(opts: AwsOptions, accountId: string): Promise<Inventory> {
  const config = clientConfig(opts);
  const ec2 = labelClient(new EC2Client(config), "EC2");
  const s3 = labelClient(new S3Client(config), "S3");
  const rds = labelClient(new RDSClient(config), "RDS");
  const elb = labelClient(new ElasticLoadBalancingV2Client(config), "ELBv2");
  const cloudwatch = labelClient(new CloudWatchClient(config), "CloudWatch");
  const warnings: string[] = [];

  const [volumes, snapshots, images, instances, rdsInstances, addresses, natGateways, loadBalancers, launchTemplateImageIds, buckets] = await Promise.all([
    attempt("ec2:DescribeVolumes", warnings, [], async () => {
      const out: Inventory["volumes"] = [];
      for await (const page of paginateDescribeVolumes({ client: ec2 }, {})) {
        for (const v of page.Volumes ?? []) {
          out.push({
            id: v.VolumeId!,
            type: v.VolumeType ?? "unknown",
            sizeGb: v.Size ?? 0,
            state: v.State ?? "unknown",
            attachedTo: (v.Attachments ?? []).map((a) => a.InstanceId!).filter(Boolean),
            createdAt: v.CreateTime?.toISOString(),
            name: nameTag(v.Tags),
            ignored: ignoredByTag(v.Tags),
          });
        }
      }
      return out;
    }),
    attempt("ec2:DescribeSnapshots", warnings, [], async () => {
      const out: Inventory["snapshots"] = [];
      for await (const page of paginateDescribeSnapshots({ client: ec2 }, { OwnerIds: ["self"] })) {
        for (const s of page.Snapshots ?? []) {
          // Belt and braces: only snapshots this account owns are its waste.
          if (s.OwnerId && s.OwnerId !== accountId) continue;
          out.push({
            id: s.SnapshotId!,
            volumeId: s.VolumeId,
            sizeGb: s.VolumeSize ?? 0,
            state: s.State ?? "unknown",
            startedAt: s.StartTime?.toISOString(),
            description: s.Description,
            ignored: ignoredByTag(s.Tags),
          });
        }
      }
      return out;
    }),
    attempt("ec2:DescribeImages", warnings, [], async () => {
      const res = await ec2.send(new DescribeImagesCommand({ Owners: ["self"] }));
      return (res.Images ?? []).map((i) => ({
        id: i.ImageId!,
        name: i.Name,
        state: i.State ?? "unknown",
        createdAt: i.CreationDate,
        ignored: ignoredByTag(i.Tags),
        snapshots: (i.BlockDeviceMappings ?? [])
          .filter((m) => m.Ebs?.SnapshotId)
          .map((m) => ({ id: m.Ebs!.SnapshotId!, sizeGb: m.Ebs!.VolumeSize ?? 0 })),
      }));
    }),
    attempt("ec2:DescribeInstances", warnings, [], async () => {
      const out: InstanceInfo[] = [];
      for await (const page of paginateDescribeInstances({ client: ec2 }, {})) {
        for (const r of page.Reservations ?? []) {
          for (const i of r.Instances ?? []) {
            const state = i.State?.Name ?? "unknown";
            if (state === "terminated" || state === "shutting-down") continue;
            out.push({
              id: i.InstanceId!,
              type: i.InstanceType ?? "unknown",
              state,
              imageId: i.ImageId,
              launchedAt: i.LaunchTime?.toISOString(),
              stateReason: i.StateTransitionReason || undefined,
              platform: i.PlatformDetails ?? "Linux/UNIX",
              volumeIds: (i.BlockDeviceMappings ?? []).map((m) => m.Ebs?.VolumeId!).filter(Boolean),
              name: nameTag(i.Tags),
              rootDeviceType: i.RootDeviceType,
              lifecycle: i.InstanceLifecycle,
              tenancy: i.Placement?.Tenancy,
              ignored: ignoredByTag(i.Tags),
            });
          }
        }
      }
      return out;
    }),
    attempt("rds:DescribeDBInstances", warnings, [], async () => {
      const out: RdsInstanceInfo[] = [];
      for await (const page of paginateDescribeDBInstances({ client: rds }, {})) {
        for (const d of page.DBInstances ?? []) {
          out.push({
            id: d.DBInstanceIdentifier!,
            instanceClass: d.DBInstanceClass ?? "unknown",
            engine: d.Engine ?? "unknown",
            status: d.DBInstanceStatus ?? "unknown",
            allocatedGb: d.AllocatedStorage ?? 0,
            storageType: d.StorageType ?? "unknown",
            multiAz: d.MultiAZ ?? false,
            createdAt: d.InstanceCreateTime?.toISOString(),
            clusterId: d.DBClusterIdentifier,
            replicaOf: d.ReadReplicaSourceDBInstanceIdentifier ?? d.ReadReplicaSourceDBClusterIdentifier,
            replicaIds: d.ReadReplicaDBInstanceIdentifiers ?? [],
            deletionProtection: d.DeletionProtection ?? false,
            ignored: ignoredByTag(d.TagList),
          });
        }
      }
      return out;
    }),
    attempt("ec2:DescribeAddresses", warnings, [], async () => {
      const res = await ec2.send(new DescribeAddressesCommand({}));
      return (res.Addresses ?? []).map((a) => ({
        allocationId: a.AllocationId ?? a.PublicIp!,
        publicIp: a.PublicIp ?? "",
        associationId: a.AssociationId,
        instanceId: a.InstanceId,
        networkInterfaceId: a.NetworkInterfaceId,
        ignored: ignoredByTag(a.Tags),
      }));
    }),
    attempt("ec2:DescribeNatGateways", warnings, [], async () => {
      const out: NatGatewayInfo[] = [];
      for await (const page of paginateDescribeNatGateways({ client: ec2 }, {})) {
        for (const g of page.NatGateways ?? []) {
          // A deleted gateway stays listed for about an hour; it is gone.
          if (g.State === "deleted") continue;
          const addresses = g.NatGatewayAddresses ?? [];
          out.push({
            id: g.NatGatewayId!,
            state: g.State ?? "unknown",
            vpcId: g.VpcId,
            subnetId: g.SubnetId,
            connectivityType: g.ConnectivityType ?? "public",
            createdAt: g.CreateTime?.toISOString(),
            allocationIds: addresses.map((a) => a.AllocationId!).filter(Boolean),
            publicIps: addresses.map((a) => a.PublicIp!).filter(Boolean),
            name: nameTag(g.Tags),
            ignored: ignoredByTag(g.Tags),
          });
        }
      }
      return out;
    }),
    attempt("elasticloadbalancing:DescribeLoadBalancers", warnings, [], () => collectLoadBalancers(elb, opts.lookbackHours, warnings)),
    attempt("ec2:DescribeLaunchTemplates", warnings, [], async () => {
      const ids = new Set<string>();
      for await (const page of paginateDescribeLaunchTemplates({ client: ec2 }, {})) {
        for (const t of page.LaunchTemplates ?? []) {
          const versions = await ec2.send(
            new DescribeLaunchTemplateVersionsCommand({
              LaunchTemplateId: t.LaunchTemplateId,
              Versions: ["$Latest", "$Default"],
            }),
          );
          for (const v of versions.LaunchTemplateVersions ?? []) {
            if (v.LaunchTemplateData?.ImageId) ids.add(v.LaunchTemplateData.ImageId);
          }
        }
      }
      return [...ids];
    }),
    attempt("s3:ListAllMyBuckets", warnings, [], () => collectBuckets(s3, opts.region, warnings)),
  ]);

  await Promise.all([
    ...instances
      .filter((i) => i.state === "running")
      .map(async (i) => {
        i.cpu = await attempt(`cloudwatch:GetMetricData ${i.id}`, warnings, undefined, () =>
          cpuStats(cloudwatch, i.id, opts.lookbackHours),
        );
      }),
    ...rdsInstances
      .filter((d) => d.status === "available")
      .map(async (d) => {
        d.connections = await attempt(`cloudwatch:GetMetricData ${d.id}`, warnings, undefined, () =>
          connectionStats(cloudwatch, d.id, opts.lookbackHours),
        );
      }),
    ...natGateways
      .filter((g) => g.state === "available")
      .map(async (g) => {
        g.traffic = await attempt(`cloudwatch:GetMetricData ${g.id}`, warnings, undefined, () =>
          trafficStats(cloudwatch, {
            namespace: "AWS/NATGateway",
            dimension: { Name: "NatGatewayId", Value: g.id },
            metrics: [
              { name: "BytesInFromSource", stat: "Sum" },
              { name: "BytesInFromDestination", stat: "Sum" },
              { name: "BytesOutToSource", stat: "Sum" },
              { name: "BytesOutToDestination", stat: "Sum" },
            ],
            lookbackHours: opts.lookbackHours,
          }),
        );
      }),
    ...loadBalancers
      .filter((b) => b.state === "active" && (b.type === "application" || b.type === "network"))
      .map(async (b) => {
        b.traffic = await attempt(`cloudwatch:GetMetricData ${b.name}`, warnings, undefined, () => loadBalancerTraffic(cloudwatch, b, opts.lookbackHours));
      }),
  ]);

  return {
    accountId,
    region: opts.region,
    collectedAt: now().toISOString(),
    volumes,
    snapshots,
    images,
    instances,
    rdsInstances,
    addresses,
    natGateways,
    loadBalancers,
    launchTemplateImageIds,
    buckets,
    warnings,
  };
}

/**
 * Every Application, Network and Gateway load balancer in the region, with
 * what a rule needs to judge the first two: tags, deletion protection and how
 * many targets each target group holds. A step that cannot be read becomes a
 * warning and leaves its field unset, so the rules never judge on a guess.
 */
async function collectLoadBalancers(elb: ElasticLoadBalancingV2Client, lookbackHours: number, warnings: string[]): Promise<LoadBalancerInfo[]> {
  const out: LoadBalancerInfo[] = [];
  for await (const page of paginateDescribeLoadBalancers({ client: elb }, {})) {
    for (const b of page.LoadBalancers ?? []) {
      out.push({
        arn: b.LoadBalancerArn!,
        name: b.LoadBalancerName!,
        type: b.Type ?? "unknown",
        scheme: b.Scheme,
        dnsName: b.DNSName,
        state: b.State?.Code ?? "unknown",
        createdAt: b.CreatedTime?.toISOString(),
        windowHours: lookbackHours,
      });
    }
  }
  if (out.length === 0) return out;

  // The ignore tag is honoured, so a balancer whose tags cannot be read is not judged at all.
  const tagged = new Map<string, boolean>();
  const tags = await attempt("elasticloadbalancing:DescribeTags", warnings, false, async () => {
    for (let i = 0; i < out.length; i += TAGS_PER_REQUEST) {
      const res = await elb.send(new DescribeTagsCommand({ ResourceArns: out.slice(i, i + TAGS_PER_REQUEST).map((b) => b.arn) }));
      for (const d of res.TagDescriptions ?? []) tagged.set(d.ResourceArn!, Boolean(ignoredByTag(d.Tags)));
    }
    return true;
  });
  for (const b of out) {
    if (!tags) b.tagsUnread = true;
    else b.ignored = tagged.get(b.arn) || undefined;
  }

  // Only active Application and Network balancers are judged; the rest cost the same but have no rule here.
  await mapLimit(
    out.filter((b) => b.state === "active" && (b.type === "application" || b.type === "network")),
    LOAD_BALANCERS_AT_ONCE,
    async (b) => {
      b.deletionProtection = await attempt(`elasticloadbalancing:DescribeLoadBalancerAttributes ${b.name}`, warnings, undefined, async () => {
        const res = await elb.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: b.arn }));
        return res.Attributes?.find((a) => a.Key === "deletion_protection.enabled")?.Value === "true";
      });
      b.targetGroups = await attempt(`elasticloadbalancing:DescribeTargetHealth ${b.name}`, warnings, undefined, async () => {
        const groups = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: b.arn }));
        const found: NonNullable<LoadBalancerInfo["targetGroups"]> = [];
        for (const g of groups.TargetGroups ?? []) {
          const health = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: g.TargetGroupArn }));
          found.push({ arn: g.TargetGroupArn!, name: g.TargetGroupName!, registeredTargets: (health.TargetHealthDescriptions ?? []).length });
        }
        return found;
      });
    },
  );
  return out;
}

async function collectBuckets(s3: S3Client, region: string, warnings: string[]): Promise<BucketInfo[]> {
  // Ask only for this region's buckets, a page at a time.
  const listed: Bucket[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListBucketsCommand({ BucketRegion: region, MaxBuckets: 1000, ContinuationToken: token }));
    listed.push(...(page.Buckets ?? []));
    token = page.ContinuationToken;
  } while (token);

  const out: BucketInfo[] = [];
  for (const b of listed) {
    const name = b.Name!;
    // Older endpoints and emulators ignore the region filter and omit the region; look it up then.
    const bucketRegion =
      b.BucketRegion ??
      (await attempt(`s3:GetBucketLocation ${name}`, warnings, undefined, async () => {
        const loc = await s3.send(new GetBucketLocationCommand({ Bucket: name }));
        // An empty constraint means us-east-1.
        return loc.LocationConstraint || "us-east-1";
      }));
    // Buckets in other regions belong to a scan of that region.
    if (bucketRegion !== region) continue;

    const hasLifecycle = await attempt(`s3:GetLifecycleConfiguration ${name}`, warnings, true, async () => {
      try {
        const res = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }));
        return (res.Rules ?? []).length > 0;
      } catch (err) {
        if (errorName(err) === "NoSuchLifecycleConfiguration") return false;
        throw err;
      }
    });

    let objectCount = 0;
    let bytes = 0;
    let truncated = false;
    await attempt(`s3:ListBucket ${name}`, warnings, undefined, async () => {
      let token: string | undefined;
      for (let page = 0; ; page++) {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: name, ContinuationToken: token }));
        for (const o of res.Contents ?? []) {
          objectCount++;
          bytes += o.Size ?? 0;
        }
        token = res.NextContinuationToken;
        if (!token) break;
        if (page + 1 >= MAX_OBJECT_PAGES) {
          truncated = true;
          break;
        }
      }
    });

    const multipartUploads = await attempt(`s3:ListBucketMultipartUploads ${name}`, warnings, [], async () => {
      const res = await s3.send(new ListMultipartUploadsCommand({ Bucket: name }));
      const uploads: MultipartUploadInfo[] = [];
      for (const u of res.Uploads ?? []) {
        let size: number | undefined;
        try {
          const parts = await s3.send(new ListPartsCommand({ Bucket: name, Key: u.Key, UploadId: u.UploadId }));
          size = (parts.Parts ?? []).reduce((sum, p) => sum + (p.Size ?? 0), 0);
        } catch (err) {
          if (err instanceof ReplayMissError) throw err;
          // Listing parts needs s3:ListMultipartUploadParts; without it the size stays unknown.
        }
        uploads.push({ key: u.Key!, uploadId: u.UploadId!, initiatedAt: u.Initiated?.toISOString(), bytes: size });
      }
      return uploads;
    });

    const ignored = await attempt(`s3:GetBucketTagging ${name}`, warnings, undefined, async () => {
      try {
        return ignoredByTag((await s3.send(new GetBucketTaggingCommand({ Bucket: name }))).TagSet);
      } catch (err) {
        if (errorName(err) === "NoSuchTagSet") return undefined;
        throw err;
      }
    });

    out.push({ name, hasLifecycle, objectCount, bytes, truncated, multipartUploads, ignored });
  }
  return out;
}

/** Live CPU statistics for one instance. Read-only. */
export function readCpu(opts: { region: string; profile?: string }, instanceId: string, lookbackHours: number) {
  return cpuStats(labelClient(new CloudWatchClient(clientConfig(opts)), "CloudWatch"), instanceId, lookbackHours);
}

async function cpuStats(cloudwatch: CloudWatchClient, instanceId: string, lookbackHours: number): Promise<CpuStats | undefined> {
  const end = now();
  const start = new Date(end.getTime() - lookbackHours * 3600_000);
  // 5-minute points for a day, hourly beyond that, to stay well inside the API's datapoint limits.
  const period = lookbackHours <= 24 ? 300 : 3600;
  const metric = (stat: string) => ({
    Metric: {
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "InstanceId", Value: instanceId }],
    },
    Period: period,
    Stat: stat,
  });
  const res = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        { Id: "avg", MetricStat: metric("Average") },
        { Id: "max", MetricStat: metric("Maximum") },
      ],
    }),
  );
  const avg = res.MetricDataResults?.find((r) => r.Id === "avg")?.Values ?? [];
  const max = res.MetricDataResults?.find((r) => r.Id === "max")?.Values ?? [];
  if (avg.length === 0) return undefined;
  return {
    windowHours: lookbackHours,
    datapoints: avg.length,
    hoursObserved: (avg.length * period) / 3600,
    averagePct: avg.reduce((a, b) => a + b, 0) / avg.length,
    maxPct: Math.max(...max, ...avg),
  };
}

/** The highest database connection count CloudWatch holds for one RDS instance over the window. */
async function connectionStats(cloudwatch: CloudWatchClient, dbInstanceId: string, lookbackHours: number): Promise<ConnectionStats | undefined> {
  const end = now();
  const start = new Date(end.getTime() - lookbackHours * 3600_000);
  const period = lookbackHours <= 24 ? 300 : 3600;
  const res = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        {
          Id: "max",
          MetricStat: {
            Metric: {
              Namespace: "AWS/RDS",
              MetricName: "DatabaseConnections",
              Dimensions: [{ Name: "DBInstanceIdentifier", Value: dbInstanceId }],
            },
            Period: period,
            Stat: "Maximum",
          },
        },
      ],
    }),
  );
  const max = res.MetricDataResults?.find((r) => r.Id === "max")?.Values ?? [];
  if (max.length === 0) return undefined;
  return {
    windowHours: lookbackHours,
    datapoints: max.length,
    hoursObserved: (max.length * period) / 3600,
    maxConnections: Math.max(...max),
  };
}

/**
 * The traffic CloudWatch holds for one resource over the window, summed over
 * every metric asked for. Undefined when it holds no datapoint, unless the
 * resource publishes only while traffic flows: then `existedSince` is given,
 * and the hours it has existed stand in for the hours observed.
 */
async function trafficStats(
  cloudwatch: CloudWatchClient,
  q: {
    namespace: string;
    dimension: { Name: string; Value: string };
    metrics: Array<{ name: string; stat: string }>;
    lookbackHours: number;
    existedSince?: string;
  },
): Promise<TrafficStats | undefined> {
  const end = now();
  const start = new Date(end.getTime() - q.lookbackHours * 3600_000);
  const period = q.lookbackHours <= 24 ? 300 : 3600;
  const res = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: q.metrics.map((m, n) => ({
        Id: `m${n}`,
        MetricStat: {
          Metric: { Namespace: q.namespace, MetricName: m.name, Dimensions: [q.dimension] },
          Period: period,
          Stat: m.stat,
        },
      })),
    }),
  );
  const results = res.MetricDataResults ?? [];
  // A period counts as observed when any of the metrics has a point in it.
  const observed = new Set(results.flatMap((r) => (r.Timestamps ?? []).map((t) => t.getTime())));
  const total = results.reduce((sum, r) => sum + (r.Values ?? []).reduce((a, b) => a + b, 0), 0);
  if (observed.size > 0) {
    return { windowHours: q.lookbackHours, datapoints: observed.size, hoursObserved: (observed.size * period) / 3600, total };
  }
  if (!q.existedSince) return undefined;
  const age = (end.getTime() - Date.parse(q.existedSince)) / 3600_000;
  if (!Number.isFinite(age)) return undefined;
  return { windowHours: q.lookbackHours, datapoints: 0, hoursObserved: Math.min(Math.max(age, 0), q.lookbackHours), total: 0, fromAge: true };
}

/** Requests (Application) or flows (Network) one load balancer handled over the window. */
function loadBalancerTraffic(cloudwatch: CloudWatchClient, b: LoadBalancerInfo, lookbackHours: number) {
  // CloudWatch names a balancer by the end of its ARN: app/my-alb/50dc6c495c0c9188.
  const suffix = b.arn.split(":loadbalancer/")[1];
  if (!suffix) return Promise.resolve(undefined);
  const application = b.type === "application";
  return trafficStats(cloudwatch, {
    namespace: application ? "AWS/ApplicationELB" : "AWS/NetworkELB",
    dimension: { Name: "LoadBalancer", Value: suffix },
    metrics: application
      ? [{ name: "RequestCount", stat: "Sum" }]
      : [
          { name: "NewFlowCount", stat: "Sum" },
          { name: "ActiveFlowCount", stat: "Maximum" },
        ],
    lookbackHours,
    existedSince: b.createdAt,
  });
}

/** The calendar month before the one `at` falls in (UTC), as the dates Cost Explorer takes: the end is exclusive. */
export function lastFullMonth(at: Date): { month: string; start: string; end: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  return { month: day(start).slice(0, 7), start: day(start), end: day(end) };
}

/** The one Cost Explorer request a bill costs, for the month before `at`. */
export function billQuery(at: Date): { month: string; input: GetCostAndUsageCommandInput } {
  const { month, start, end } = lastFullMonth(at);
  return {
    month,
    input: {
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      // The spend before credits and refunds: waste is measured at list price, and a month paid with credits would otherwise read as nothing.
      Filter: { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } },
    },
  };
}

/**
 * What the account spent last month, from Cost Explorer: one request, which
 * AWS charges $0.01 for, made only when the scan was asked for the bill. Every
 * way it can fail (no permission, Cost Explorer not enabled, no data yet, a
 * currency that is not dollars) comes back as a reason, never as a figure.
 */
export async function readBill(opts: { profile?: string }): Promise<Bill> {
  const { month, input } = billQuery(now());
  // Cost Explorer is one global endpoint, served from us-east-1.
  const client = labelClient(new CostExplorerClient(clientConfig({ region: "us-east-1", profile: opts.profile })), "CostExplorer");
  try {
    const res = await client.send(new GetCostAndUsageCommand(input));
    const totals = (res.ResultsByTime ?? []).map((r) => r.Total?.UnblendedCost).filter((t) => t !== undefined);
    if (totals.length === 0) return { month, unavailable: `Cost Explorer returned no data for ${month}` };
    const unit = totals[0]!.Unit;
    if (unit !== "USD") return { month, unavailable: `Cost Explorer reports ${month} in ${unit ?? "an unknown currency"}, and CloudPilot compares dollars only` };
    const totalUsd = totals.reduce((sum, t) => sum + Number(t.Amount), 0);
    if (!Number.isFinite(totalUsd)) return { month, unavailable: `Cost Explorer returned an amount for ${month} that is not a number` };
    // A new account, or one Cost Explorer was only just enabled for, reads zero or a fraction of a cent: that is no data, not a free month, and a share of it would mean nothing.
    if (totalUsd < 0.005) return { month, unavailable: `Cost Explorer shows no spend to the cent for ${month}, so there is nothing to compare the waste with (a new account, or no data yet)` };
    return { month, totalUsd, ...((res.ResultsByTime ?? []).some((r) => r.Estimated) ? { estimated: true } : {}) };
  } catch (err) {
    // A request missing from a replay is a hard stop, never a skipped check.
    if (err instanceof ReplayMissError) throw err;
    return { month, unavailable: `${errorName(err)}${err instanceof Error ? ` - ${err.message}` : ""}` };
  }
}
