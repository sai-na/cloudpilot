/** Scans built by hand, for tests that need particular findings rather than the recorded lab. */
import { detect } from "../src/detect.js";
import type { Finding, Inventory, PriceBook, ScanResult } from "../src/types.js";

export const finding = (id: string, cost: number, extra: Partial<Finding> = {}): Finding => ({
  region: "ap-south-1",
  pattern: "unattached-ebs-volume",
  title: `Unattached 500 GB gp2 volume`,
  resourceType: "AWS::EC2::Volume",
  resourceIds: [id],
  evidence: ["State is available"],
  monthlyCostUsd: cost,
  costBasis: "500 GB x $0.114/GB-month (gp2)",
  fix: { commands: [`aws ec2 delete-volume --volume-id ${id}`], risk: "dangerous", rollback: "" },
  confidence: 0.95,
  ...extra,
});

export const scan = (findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult => ({
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "" },
  findings,
  totalMonthlyWasteUsd: findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0),
  skippedByTag: [],
  warnings: [],
  ...extra,
});

/**
 * An account with one of everything the rules look for, so a test can go
 * through every rule's printed fix. Built from an inventory and a price book,
 * not by hand, so the commands are the ones detect() really prints.
 */
const hours = <T extends object>(hoursObserved: number, extra: T) => ({ windowHours: 24, hoursObserved, datapoints: hoursObserved * 12, ...extra });
const GIB = 1024 ** 3;

export const everyRuleBook: PriceBook = {
  region: "ap-south-1",
  source: "price-file",
  fetchedAt: "2026-10-02T00:00:00Z",
  ebsGbMonth: { gp2: 0.114, gp3: 0.0912 },
  snapshotGbMonth: 0.05,
  idleIpv4Hour: 0.005,
  instanceHour: { "t3.micro": 0.0112, "m5.xlarge": 0.202, "m5.large": 0.101 },
  instanceSpecs: { "m5.xlarge": { vcpu: 4, memoryGib: 16 }, "m5.large": { vcpu: 2, memoryGib: 8 } },
  rdsInstanceHour: { "db.t3.micro|MySQL|Single-AZ": 0.034 },
  rdsStorageGbMonth: { "gp3|MySQL|Single-AZ": 0.131 },
  natGatewayHour: 0.056,
  loadBalancerHour: { application: 0.0239, network: 0.0239 },
  s3StandardGbMonth: 0.025,
};

export const everyRuleInventory: Inventory = {
  accountId: "123456789012",
  region: "ap-south-1",
  collectedAt: "2026-10-03T00:00:00Z",
  volumes: [
    { id: "vol-0a1b2c3d4e5f60001", type: "gp2", sizeGb: 100, state: "available", attachedTo: [] },
    { id: "vol-0a1b2c3d4e5f60002", type: "gp3", sizeGb: 50, state: "available", attachedTo: [] },
    { id: "vol-0a1b2c3d4e5f60003", type: "gp2", sizeGb: 200, state: "in-use", attachedTo: ["i-0a1b2c3d4e5f60003"] },
  ],
  snapshots: [{ id: "snap-0a1b2c3d4e5f60001", volumeId: "vol-gone", sizeGb: 50, state: "completed" }],
  images: [
    { id: "ami-0a1b2c3d4e5f60001", state: "available", snapshots: [{ id: "snap-0a1b2c3d4e5f60011", sizeGb: 8 }, { id: "snap-0a1b2c3d4e5f60012", sizeGb: 20 }] },
  ],
  instances: [
    { id: "i-0a1b2c3d4e5f60001", type: "t3.micro", state: "stopped", imageId: "ami-in-use", platform: "Linux/UNIX", volumeIds: [] },
    { id: "i-0a1b2c3d4e5f60002", type: "t3.micro", state: "running", imageId: "ami-in-use", platform: "Linux/UNIX", volumeIds: [], rootDeviceType: "ebs", cpu: { windowHours: 48, hoursObserved: 48, datapoints: 576, averagePct: 0.2, maxPct: 1 } },
    { id: "i-0a1b2c3d4e5f60003", type: "m5.xlarge", state: "running", imageId: "ami-in-use", platform: "Linux/UNIX", volumeIds: ["vol-0a1b2c3d4e5f60003"], rootDeviceType: "ebs", cpu: { windowHours: 24, hoursObserved: 24, datapoints: 288, averagePct: 5, maxPct: 10 } },
  ],
  rdsInstances: [
    {
      id: "orders-db",
      instanceClass: "db.t3.micro",
      engine: "mysql",
      status: "available",
      allocatedGb: 100,
      storageType: "gp3",
      multiAz: false,
      createdAt: "2026-01-01T00:00:00Z",
      replicaIds: [],
      deletionProtection: false,
      connections: hours(24, { maxConnections: 0 }),
    },
  ],
  addresses: [{ allocationId: "eipalloc-0a1b2c3d4e5f60001", publicIp: "13.126.0.1" }],
  natGateways: [
    {
      id: "nat-0a1b2c3d4e5f60001",
      state: "available",
      vpcId: "vpc-0a1b2c3d4e5f60718",
      subnetId: "subnet-0a1b2c3d4e5f60718",
      connectivityType: "public",
      createdAt: "2026-01-01T00:00:00Z",
      allocationIds: ["eipalloc-0a1b2c3d4e5f60002"],
      publicIps: ["13.126.0.2"],
      traffic: hours(24, { total: 0 }),
    },
  ],
  loadBalancers: [
    {
      arn: "arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/web/50dc6c495c0c9188",
      name: "web",
      type: "application",
      scheme: "internet-facing",
      dnsName: "web-123.ap-south-1.elb.amazonaws.com",
      state: "active",
      createdAt: "2026-01-01T00:00:00Z",
      windowHours: 24,
      deletionProtection: false,
      targetGroups: [{ arn: "arn:tg-1", name: "web-tg", registeredTargets: 0 }],
      traffic: hours(24, { total: 0 }),
    },
  ],
  launchTemplateImageIds: [],
  buckets: [
    {
      name: "neglected",
      hasLifecycle: false,
      objectCount: 3,
      bytes: GIB,
      truncated: false,
      // The second key is one a shell would act on: it has to be printed quoted and read back whole.
      multipartUploads: [
        { key: "a.bin", uploadId: "2~AbCd", initiatedAt: "2026-09-01T00:00:00Z", bytes: 2 * GIB },
        { key: "exports/Q3 report (final).bin", uploadId: "2~Xy$Zw", initiatedAt: "2026-09-01T00:00:00Z", bytes: GIB },
      ],
    },
  ],
  warnings: [],
};

/** Every finding the AWS rules can make, from one account built to trigger each of them. */
export const everyAwsFinding = (): Finding[] => detect(everyRuleInventory, everyRuleBook);
