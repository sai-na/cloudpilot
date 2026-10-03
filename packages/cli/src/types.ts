/** Everything CloudPilot read from the account. Collected with read-only calls only. */
export interface Inventory {
  accountId: string;
  region: string;
  collectedAt: string;
  volumes: VolumeInfo[];
  snapshots: SnapshotInfo[];
  images: ImageInfo[];
  instances: InstanceInfo[];
  addresses: AddressInfo[];
  /** AMI IDs referenced by the latest and default version of every launch template. */
  launchTemplateImageIds: string[];
  buckets: BucketInfo[];
  /** Calls that failed (usually a missing permission). Findings that depend on them are skipped. */
  warnings: string[];
}

export interface VolumeInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  id: string;
  type: string;
  sizeGb: number;
  state: string;
  attachedTo: string[];
  createdAt?: string;
  name?: string;
}

export interface SnapshotInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  id: string;
  volumeId?: string;
  sizeGb: number;
  state: string;
  startedAt?: string;
  description?: string;
}

export interface ImageInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  id: string;
  name?: string;
  state: string;
  createdAt?: string;
  snapshots: { id: string; sizeGb: number }[];
}

export interface CpuStats {
  hoursObserved: number;
  datapoints: number;
  averagePct: number;
  maxPct: number;
}

export interface InstanceInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  id: string;
  type: string;
  state: string;
  imageId?: string;
  launchedAt?: string;
  stateReason?: string;
  platform: string;
  volumeIds: string[];
  name?: string;
  /** Only for running instances. Undefined when CloudWatch returned no data. */
  cpu?: CpuStats;
}

export interface AddressInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  allocationId: string;
  publicIp: string;
  associationId?: string;
  instanceId?: string;
  networkInterfaceId?: string;
}

export interface MultipartUploadInfo {
  key: string;
  uploadId: string;
  initiatedAt?: string;
  /** Undefined when the role may not list parts (s3:ListMultipartUploadParts). */
  bytes?: number;
}

export interface BucketInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  name: string;
  hasLifecycle: boolean;
  objectCount: number;
  bytes: number;
  /** True when the listing stopped early, so objectCount and bytes are lower bounds. */
  truncated: boolean;
  multipartUploads: MultipartUploadInfo[];
}

/** USD unit prices for one region. */
export interface PriceBook {
  region: string;
  source: "aws-price-list-api" | "price-file";
  fetchedAt: string;
  ebsGbMonth: Record<string, number>;
  snapshotGbMonth: number;
  idleIpv4Hour: number;
  instanceHour: Record<string, number>;
  s3StandardGbMonth: number;
}

export type Pattern =
  | "unattached-ebs-volume"
  | "gp2-volume"
  | "idle-elastic-ip"
  | "stopped-instance"
  | "idle-instance"
  | "orphaned-snapshot"
  | "unused-ami"
  | "bucket-without-lifecycle"
  | "incomplete-multipart-upload"
  // Kubernetes
  | "over-requested-workload"
  | "unused-volume-claim"
  | "released-volume";

/**
 * How much care a fix needs before anyone runs it.
 * A scan never runs these; it only prints them. The apply command runs one
 * only when a person names it and approves.
 */
export type Risk = "caution" | "dangerous";

export interface Fix {
  commands: string[];
  risk: Risk;
  /** What cannot be undone, and how to keep a way back. */
  rollback: string;
}

export interface Finding {
  /** Where the resource lives: an AWS region, or for a cluster scan the namespace. */
  region: string;
  pattern: Pattern;
  title: string;
  resourceType: string;
  resourceIds: string[];
  /** Facts read from AWS that support the finding. */
  evidence: string[];
  monthlyCostUsd: number;
  costBasis: string;
  fix: Fix;
  alternative?: Fix & { monthlySavingUsd: number; description: string };
  /** 0 to 1. Lower when the supporting data is thin. */
  confidence: number;
  /** Set when the scan was compared with an earlier one: true if that scan did not have this finding. */
  isNew?: boolean;
}

/** How a scan differs from the one before it. */
export interface Comparison {
  /** When the scan it is compared with was taken. */
  previousScannedAt: string;
  newCount: number;
  newMonthlyUsd: number;
  /**
   * How many of the new findings are in regions the earlier scan did not
   * cover. They are new to the reader, but nothing says they appeared since.
   */
  newInRegionsNotScannedBefore: number;
  /** Findings the earlier scan had, in regions scanned again, that are now gone. */
  resolved: Array<{ title: string; region: string; resourceIds: string[]; monthlyCostUsd: number }>;
  resolvedMonthlyUsd: number;
  unchangedCount: number;
}

/** One region's inventory, prices and findings. */
export interface RegionScan {
  inventory: Inventory;
  prices: PriceBook;
  findings: Finding[];
}

/** Unit prices a cluster's findings are costed with. */
export interface ClusterPrices {
  /** Where they come from: the OpenCost project's defaults, or the command line. */
  source: "opencost-defaults" | "command-line";
  cpuHourUsd: number;
  memoryGibHourUsd: number;
  storageGibMonthUsd: number;
}

/** What a cluster scan read, beyond its findings. */
export interface ClusterInfo {
  /** The kubectl context that was read. */
  context: string;
  server?: string;
  /** The Prometheus the usage figures came from, as namespace/service:port. */
  prometheus?: string;
  /** Hours of usage history requests were judged by. */
  lookbackHours: number;
  prices: ClusterPrices;
}

export interface ScanResult {
  /** The AWS account ID. For a cluster scan, the kubectl context: what tells one scanned thing from another. */
  accountId: string;
  /** Every region that was scanned, including those with nothing in them. For a cluster scan, the namespaces. */
  regions: string[];
  /** Present when this is the scan of a Kubernetes cluster rather than an AWS account. */
  cluster?: ClusterInfo;
  scannedAt: string;
  prices: { source: PriceBook["source"] | ClusterPrices["source"]; fetchedAt: string };
  findings: Finding[];
  totalMonthlyWasteUsd: number;
  /** Resources left out because they are tagged cloudpilot:ignore=true. */
  skippedByTag: string[];
  warnings: string[];
  /** Present when the scan was compared with an earlier one. */
  comparison?: Comparison;
}

export const HOURS_PER_MONTH = 730;
