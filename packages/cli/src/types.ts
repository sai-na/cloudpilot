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
  | "incomplete-multipart-upload";

/**
 * How much care a fix needs before anyone runs it.
 * CloudPilot never runs these itself; it only prints them.
 */
export type Risk = "caution" | "dangerous";

export interface Fix {
  commands: string[];
  risk: Risk;
  /** What cannot be undone, and how to keep a way back. */
  rollback: string;
}

export interface Finding {
  /** Region the resource lives in. */
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

export interface ScanResult {
  accountId: string;
  /** Every region that was scanned, including those with nothing in them. */
  regions: string[];
  scannedAt: string;
  prices: { source: PriceBook["source"]; fetchedAt: string };
  findings: Finding[];
  totalMonthlyWasteUsd: number;
  /** Resources left out because they are tagged cloudpilot:ignore=true. */
  skippedByTag: string[];
  warnings: string[];
  /** Present when the scan was compared with an earlier one. */
  comparison?: Comparison;
}

export const HOURS_PER_MONTH = 730;
