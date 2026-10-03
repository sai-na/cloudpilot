import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeLaunchTemplateVersionsCommand,
  DescribeRegionsCommand,
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeLaunchTemplates,
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
import { paginateDescribeDBInstances, RDSClient } from "@aws-sdk/client-rds";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { now } from "./clock.js";
import { awsRequestHandler, labelClient, mode, ReplayMissError } from "./recording.js";
import type {
  BucketInfo,
  ConnectionStats,
  CpuStats,
  InstanceInfo,
  Inventory,
  MultipartUploadInfo,
  RdsInstanceInfo,
} from "./types.js";

export interface AwsOptions {
  region: string;
  profile?: string;
  /** How far back to read CPU metrics for running instances. */
  lookbackHours: number;
}

/** Objects listed per bucket before the size is reported as a lower bound. */
const MAX_OBJECT_PAGES = 10;

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
  const cloudwatch = labelClient(new CloudWatchClient(config), "CloudWatch");
  const warnings: string[] = [];

  const [volumes, snapshots, images, instances, rdsInstances, addresses, launchTemplateImageIds, buckets] = await Promise.all([
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

  await Promise.all(
    instances
      .filter((i) => i.state === "running")
      .map(async (i) => {
        i.cpu = await attempt(`cloudwatch:GetMetricData ${i.id}`, warnings, undefined, () =>
          cpuStats(cloudwatch, i.id, opts.lookbackHours),
        );
      }),
  );

  await Promise.all(
    rdsInstances
      .filter((d) => d.status === "available")
      .map(async (d) => {
        d.connections = await attempt(`cloudwatch:GetMetricData ${d.id}`, warnings, undefined, () =>
          connectionStats(cloudwatch, d.id, opts.lookbackHours),
        );
      }),
  );

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
    launchTemplateImageIds,
    buckets,
    warnings,
  };
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
