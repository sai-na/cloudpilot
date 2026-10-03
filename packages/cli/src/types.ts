/** Everything CloudPilot read from the account. Collected with read-only calls only. */
export interface Inventory {
  accountId: string;
  region: string;
  collectedAt: string;
  volumes: VolumeInfo[];
  snapshots: SnapshotInfo[];
  images: ImageInfo[];
  instances: InstanceInfo[];
  rdsInstances: RdsInstanceInfo[];
  addresses: AddressInfo[];
  natGateways: NatGatewayInfo[];
  loadBalancers: LoadBalancerInfo[];
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
  /** The window that was asked for, so a reader can tell how much of it CloudWatch had data for. */
  windowHours: number;
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
  /** "ebs" or "instance-store". An instance-store instance cannot be stopped. */
  rootDeviceType?: string;
  /** "spot", "scheduled" or "capacity-block"; undefined for On-Demand. */
  lifecycle?: string;
  /** "default", "dedicated" or "host". Only "default" is priced. */
  tenancy?: string;
  /** Only for running instances. Undefined when CloudWatch returned no data. */
  cpu?: CpuStats;
}

/** Database connections CloudWatch recorded for one RDS instance. */
export interface ConnectionStats {
  /** The window that was asked for, so a reader can tell how much of it CloudWatch had data for. */
  windowHours: number;
  hoursObserved: number;
  datapoints: number;
  /** The highest connection count in any period. Zero means nobody connected. */
  maxConnections: number;
}

export interface RdsInstanceInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  id: string;
  /** For example db.t3.micro. */
  instanceClass: string;
  /** As RDS names it: mysql, postgres, mariadb, aurora-mysql, oracle-ee... */
  engine: string;
  status: string;
  allocatedGb: number;
  /** gp2, gp3, io1, io2 or standard. */
  storageType: string;
  multiAz: boolean;
  createdAt?: string;
  /** Set for a member of a cluster (Aurora, or a Multi-AZ DB cluster). */
  clusterId?: string;
  /** Set when this instance is itself a read replica. */
  replicaOf?: string;
  /** The read replicas that copy from this instance. */
  replicaIds: string[];
  deletionProtection: boolean;
  /** Only for available instances. Undefined when CloudWatch returned no data. */
  connections?: ConnectionStats;
}

/** What CloudWatch recorded for a resource's traffic over the window. */
export interface TrafficStats {
  /** The window that was asked for, so a reader can tell how much of it CloudWatch had data for. */
  windowHours: number;
  hoursObserved: number;
  datapoints: number;
  /** Everything the traffic metrics add up to: bytes for a NAT gateway, requests for an Application Load Balancer, flows for a Network Load Balancer. Zero means none. */
  total: number;
  /**
   * True when CloudWatch held no datapoint at all and `hoursObserved` is how
   * long the load balancer has existed within the window instead. Load
   * balancers publish their request and flow metrics only while traffic
   * flows, so for them no datapoints means no traffic.
   */
  fromAge?: boolean;
}

export interface NatGatewayInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  id: string;
  /** pending, available, deleting, deleted or failed. */
  state: string;
  vpcId?: string;
  /** Not set for a regional NAT gateway, which spans subnets and is not priced here. */
  subnetId?: string;
  /** "public" or "private". Only a public one has an Elastic IP. */
  connectivityType: string;
  createdAt?: string;
  /** The Elastic IP allocations the gateway uses. */
  allocationIds: string[];
  publicIps: string[];
  name?: string;
  /** Only for available gateways. Undefined when CloudWatch returned no data. */
  traffic?: TrafficStats;
}

export interface TargetGroupInfo {
  arn: string;
  name: string;
  /** Targets in any state, draining and unhealthy included. Undefined when the health could not be read. */
  registeredTargets?: number;
}

export interface LoadBalancerInfo {
  /** Tagged cloudpilot:ignore=true, so no finding is raised for it. */
  ignored?: boolean;
  /** The tags could not be read, so whether it carries the ignore tag is unknown and it is not judged. */
  tagsUnread?: boolean;
  arn: string;
  name: string;
  /** "application", "network" or "gateway". Classic load balancers are a different API and are not read. */
  type: string;
  scheme?: string;
  dnsName?: string;
  /** active, provisioning, active_impaired or failed. */
  state: string;
  createdAt?: string;
  /** The window traffic was read over. */
  windowHours: number;
  /** Undefined when the attributes could not be read. */
  deletionProtection?: boolean;
  /** Undefined when the target groups could not be read. */
  targetGroups?: TargetGroupInfo[];
  /** Only for active Application and Network load balancers. Undefined when CloudWatch could not be read. */
  traffic?: TrafficStats;
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
  /** Hourly price of a DB instance, by rdsHourKey. */
  rdsInstanceHour: Record<string, number>;
  /** Monthly price of a GB of DB storage, by rdsStorageKey. */
  rdsStorageGbMonth: Record<string, number>;
  /**
   * What the Price List says an instance type has, for the sizes one step
   * down from a running instance. Only types that were looked up are here.
   */
  instanceSpecs: Record<string, { vcpu: number; memoryGib: number }>;
  /** Hourly price of a NAT gateway. 0 when none was looked up. */
  natGatewayHour: number;
  /** Hourly price of a load balancer by type, "application" or "network". Only types that were looked up are here. */
  loadBalancerHour: Record<string, number>;
  s3StandardGbMonth: number;
}

/** The engines whose RDS price is a plain per-hour rate with no licence term, by their name in the Price List. */
export const RDS_PRICED_ENGINES: Record<string, string> = { mysql: "MySQL", postgres: "PostgreSQL", mariadb: "MariaDB" };

/** The Price List's name for each storage type CloudPilot prices. Provisioned IOPS types are not priced. */
export const RDS_PRICED_STORAGE: Record<string, string> = { gp2: "General Purpose", gp3: "General Purpose-GP3", standard: "Magnetic" };

export const rdsHourKey = (instanceClass: string, engine: string, multiAz: boolean) => `${instanceClass}|${engine}|${multiAz ? "Multi-AZ" : "Single-AZ"}`;
export const rdsStorageKey = (storageType: string, engine: string, multiAz: boolean) => `${storageType}|${engine}|${multiAz ? "Multi-AZ" : "Single-AZ"}`;

export type Pattern =
  | "unattached-ebs-volume"
  | "gp2-volume"
  | "idle-elastic-ip"
  | "stopped-instance"
  | "idle-instance"
  | "oversized-instance"
  | "idle-rds-instance"
  | "idle-nat-gateway"
  | "idle-load-balancer"
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

/**
 * What the account spent in the last full calendar month, read with --bill:
 * the total, and what the waste found comes to as a share of it.
 */
export interface Bill {
  /** The month read, as YYYY-MM. */
  month: string;
  /** Cost Explorer's unblended cost for that month, before credits and refunds. Set unless `unavailable` is. */
  totalUsd?: number;
  /** AWS still marks the month's figures as estimated. */
  estimated?: boolean;
  /**
   * The monthly waste found as a percentage of `totalUsd`, to one decimal.
   * Computed by CloudPilot, never by a model. Not set when there is no waste
   * or no bill to compare with.
   */
  wasteSharePct?: number;
  /** Why the bill could not be read or compared, in words for a report. */
  unavailable?: string;
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
  /** Present when the scan was asked for the account's bill (--bill). */
  bill?: Bill;
  /** Present when the scan was compared with an earlier one. */
  comparison?: Comparison;
}

export const HOURS_PER_MONTH = 730;
