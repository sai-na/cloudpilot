import assert from "node:assert/strict";
import { test } from "node:test";
import { runnable } from "../src/apply.js";
import { detect, idleLoadBalancers, idleNatGateways, idleRdsInstances, mergeScans, oversizedCandidates, withBill } from "../src/detect.js";
import type { Inventory, PriceBook, ScanResult } from "../src/types.js";

const prices: PriceBook = {
  region: "ap-south-1",
  source: "price-file",
  fetchedAt: "2026-10-02T00:00:00Z",
  ebsGbMonth: { gp2: 0.114, gp3: 0.0912 },
  snapshotGbMonth: 0.05,
  idleIpv4Hour: 0.005,
  instanceHour: { "t3.micro": 0.0112 },
  rdsInstanceHour: {},
  rdsStorageGbMonth: {},
  instanceSpecs: {},
  natGatewayHour: 0,
  loadBalancerHour: {},
  s3StandardGbMonth: 0.025,
};

const empty: Inventory = {
  accountId: "123456789012",
  region: "ap-south-1",
  collectedAt: "2026-10-03T00:00:00Z",
  volumes: [],
  snapshots: [],
  images: [],
  instances: [],
  rdsInstances: [],
  addresses: [],
  natGateways: [],
  loadBalancers: [],
  launchTemplateImageIds: [],
  buckets: [],
  warnings: [],
};

const inventory = (part: Partial<Inventory>): Inventory => ({ ...empty, ...part });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const cpu = (hoursObserved: number, maxPct: number, windowHours = hoursObserved) => ({ windowHours, hoursObserved, datapoints: hoursObserved * 12, averagePct: maxPct / 2, maxPct });

test("unattached gp2 volume: delete, with gp3 conversion as the alternative", () => {
  const [f, ...rest] = detect(
    inventory({ volumes: [{ id: "vol-1", type: "gp2", sizeGb: 500, state: "available", attachedTo: [] }] }),
    prices,
  );
  assert.equal(rest.length, 0);
  assert.equal(f!.pattern, "unattached-ebs-volume");
  close(f!.monthlyCostUsd, 57);
  assert.deepEqual(f!.fix.commands, ["aws ec2 delete-volume --volume-id vol-1 --region ap-south-1"]);
  assert.equal(f!.fix.risk, "dangerous");
  close(f!.alternative!.monthlySavingUsd, 11.4);
  assert.deepEqual(f!.alternative!.commands, ["aws ec2 modify-volume --volume-id vol-1 --volume-type gp3 --region ap-south-1"]);
});

test("attached volumes: gp3 is fine, gp2 is flagged only for the gp3 saving", () => {
  const findings = detect(
    inventory({
      volumes: [
        { id: "vol-gp3", type: "gp3", sizeGb: 100, state: "in-use", attachedTo: ["i-1"] },
        { id: "vol-gp2", type: "gp2", sizeGb: 100, state: "in-use", attachedTo: ["i-1"] },
      ],
    }),
    prices,
  );
  assert.deepEqual(findings.map((f) => [f.pattern, f.resourceIds[0]]), [["gp2-volume", "vol-gp2"]]);
  close(findings[0]!.monthlyCostUsd, 100 * (0.114 - 0.0912));
  assert.equal(findings[0]!.fix.risk, "caution");
});

test("Elastic IP: flagged only when not associated", () => {
  const findings = detect(
    inventory({
      addresses: [
        { allocationId: "eipalloc-idle", publicIp: "1.1.1.1" },
        { allocationId: "eipalloc-used", publicIp: "2.2.2.2", associationId: "eipassoc-1" },
      ],
    }),
    prices,
  );
  assert.deepEqual(findings.map((f) => f.resourceIds[0]), ["eipalloc-idle"]);
  close(findings[0]!.monthlyCostUsd, 3.65);
});

test("stopped instance costs its attached storage", () => {
  const findings = detect(
    inventory({
      volumes: [{ id: "vol-root", type: "gp3", sizeGb: 30, state: "in-use", attachedTo: ["i-stopped"] }],
      instances: [{ id: "i-stopped", type: "t3.micro", state: "stopped", platform: "Linux/UNIX", volumeIds: ["vol-root"] }],
    }),
    prices,
  );
  assert.deepEqual(findings.map((f) => f.pattern), ["stopped-instance"]);
  close(findings[0]!.monthlyCostUsd, 30 * 0.0912);
});

test("running instance: idle needs low CPU and enough history", () => {
  const instance = (id: string, stats?: ReturnType<typeof cpu>) => ({
    id,
    type: "t3.micro",
    state: "running",
    platform: "Linux/UNIX",
    volumeIds: [],
    cpu: stats,
  });
  const findings = detect(
    inventory({
      instances: [
        instance("i-idle", cpu(8, 1.5)),
        instance("i-busy", cpu(8, 60)),
        instance("i-new", cpu(0.5, 1)),
        instance("i-nodata"),
      ],
    }),
    prices,
  );
  assert.deepEqual(findings.map((f) => f.resourceIds[0]), ["i-idle"]);
  close(findings[0]!.monthlyCostUsd, 0.0112 * 730);
  assert.equal(findings[0]!.confidence, 0.8);
});

test("snapshot is orphaned only when its volume is gone and no AMI uses it", () => {
  const findings = detect(
    inventory({
      volumes: [{ id: "vol-live", type: "gp3", sizeGb: 8, state: "in-use", attachedTo: ["i-1"] }],
      instances: [{ id: "i-1", type: "t3.micro", state: "running", imageId: "ami-used", platform: "Linux/UNIX", volumeIds: ["vol-live"] }],
      snapshots: [
        { id: "snap-orphan", volumeId: "vol-gone", sizeGb: 50, state: "completed" },
        { id: "snap-live", volumeId: "vol-live", sizeGb: 8, state: "completed" },
        { id: "snap-ami", volumeId: "vol-gone-too", sizeGb: 30, state: "completed" },
        { id: "snap-copy", volumeId: "vol-ffffffff", sizeGb: 10, state: "completed" },
      ],
      images: [{ id: "ami-used", state: "available", snapshots: [{ id: "snap-ami", sizeGb: 30 }] }],
    }),
    prices,
  );
  assert.deepEqual(findings.map((f) => [f.pattern, f.resourceIds[0]]), [["orphaned-snapshot", "snap-orphan"]]);
  close(findings[0]!.monthlyCostUsd, 2.5);
});

test("AMI is unused only when no instance and no launch template references it", () => {
  const image = (id: string) => ({ id, state: "available", snapshots: [{ id: `snap-${id}`, sizeGb: 30 }] });
  const findings = detect(
    inventory({
      images: [image("ami-unused"), image("ami-stopped"), image("ami-template")],
      instances: [{ id: "i-1", type: "t3.micro", state: "stopped", imageId: "ami-stopped", platform: "Linux/UNIX", volumeIds: [] }],
      launchTemplateImageIds: ["ami-template"],
    }),
    prices,
  ).filter((f) => f.pattern === "unused-ami");
  assert.deepEqual(findings.map((f) => f.resourceIds[0]), ["ami-unused"]);
  close(findings[0]!.monthlyCostUsd, 1.5);
  assert.deepEqual(findings[0]!.fix.commands, [
    "aws ec2 deregister-image --image-id ami-unused --region ap-south-1",
    "aws ec2 delete-snapshot --snapshot-id snap-ami-unused --region ap-south-1",
  ]);
});

test("buckets: missing lifecycle rule and incomplete multipart uploads", () => {
  const findings = detect(
    inventory({
      buckets: [
        { name: "managed", hasLifecycle: true, objectCount: 1, bytes: 10, truncated: false, multipartUploads: [] },
        {
          name: "neglected",
          hasLifecycle: false,
          objectCount: 3,
          bytes: 1024 ** 3,
          truncated: false,
          multipartUploads: [
            { key: "a.bin", uploadId: "old", initiatedAt: "2026-09-01T00:00:00Z", bytes: 2 * 1024 ** 3 },
            { key: "b.bin", uploadId: "fresh-unknown-size", initiatedAt: "2026-10-02T23:00:00Z" },
          ],
        },
      ],
    }),
    prices,
  );
  const byId = Object.fromEntries(findings.map((f) => [f.resourceIds[0], f]));
  assert.deepEqual(Object.keys(byId).sort(), ["fresh-unknown-size", "neglected", "old"]);
  close(byId["neglected"]!.monthlyCostUsd, 0.025);
  close(byId["old"]!.monthlyCostUsd, 0.05);
  assert.equal(byId["old"]!.confidence, 0.9);
  // Unknown part sizes cost nothing rather than a guess, and a fresh upload may still be running.
  assert.equal(byId["fresh-unknown-size"]!.monthlyCostUsd, 0);
  assert.equal(byId["fresh-unknown-size"]!.confidence, 0.6);
  assert.deepEqual(byId["old"]!.fix.commands, [
    "aws s3api abort-multipart-upload --bucket neglected --key a.bin --upload-id old --region ap-south-1",
  ]);
});

test("findings come back most expensive first, and an empty account has none", () => {
  assert.deepEqual(detect(empty, prices), []);
  const findings = detect(
    inventory({
      volumes: [
        { id: "vol-small", type: "gp3", sizeGb: 10, state: "available", attachedTo: [] },
        { id: "vol-big", type: "gp3", sizeGb: 900, state: "available", attachedTo: [] },
      ],
    }),
    prices,
  );
  assert.deepEqual(findings.map((f) => f.resourceIds[0]), ["vol-big", "vol-small"]);
});

test("resources tagged cloudpilot:ignore=true raise no finding and are counted", () => {
  const tagged = inventory({
    volumes: [
      { id: "vol-kept", type: "gp3", sizeGb: 10, state: "available", attachedTo: [] },
      { id: "vol-ignored", type: "gp3", sizeGb: 900, state: "available", attachedTo: [], ignored: true },
    ],
    addresses: [{ allocationId: "eipalloc-ignored", publicIp: "1.1.1.1", ignored: true }],
    buckets: [
      { name: "ignored-bucket", hasLifecycle: false, objectCount: 1, bytes: 10, truncated: false, ignored: true, multipartUploads: [{ key: "a", uploadId: "u1" }] },
    ],
  });
  assert.deepEqual(detect(tagged, prices).map((f) => f.resourceIds[0]), ["vol-kept"]);
  const scan = { inventory: tagged, prices, findings: detect(tagged, prices) };
  assert.deepEqual(mergeScans("123456789012", [scan]).skippedByTag, ["vol-ignored", "eipalloc-ignored", "ignored-bucket"]);
});

test("an incomplete upload is more certain once its size is known", () => {
  const upload = (uploadId: string, bytes?: number) => ({ key: "k", uploadId, initiatedAt: "2026-09-01T00:00:00Z", bytes });
  const findings = detect(
    inventory({
      buckets: [{ name: "b", hasLifecycle: true, objectCount: 0, bytes: 0, truncated: false, multipartUploads: [upload("sized", 5 * 1024 ** 2), upload("unsized")] }],
    }),
    prices,
  );
  const byId = Object.fromEntries(findings.map((f) => [f.resourceIds[0], f]));
  assert.equal(byId["sized"]!.confidence, 0.9);
  assert.equal(byId["unsized"]!.confidence, 0.6);
  close(byId["sized"]!.monthlyCostUsd, (5 / 1024) * 0.025);
});

test("an object key or upload ID a shell would act on is quoted, and apply reads it back whole", () => {
  // Keys and upload IDs come from the account, so they can hold anything S3 allows.
  const awkward = [
    { key: "exports/Q3 report (final).bin", uploadId: "2~AbCd.EfGh_IjKl" },
    { key: "logs/it's-mine.bin", uploadId: "2~Xy$Z`w" },
    { key: "tmp/*.bin", uploadId: "2~a;b&c|d" },
  ];
  const findings = detect(
    inventory({
      buckets: [
        {
          name: "b",
          hasLifecycle: true,
          objectCount: 0,
          bytes: 0,
          truncated: false,
          multipartUploads: awkward.map((u) => ({ ...u, initiatedAt: "2026-09-01T00:00:00Z", bytes: 1024 ** 3 })),
        },
      ],
    }),
    prices,
  );
  assert.equal(findings.length, awkward.length);
  for (const { key, uploadId } of awkward) {
    const finding = findings.find((f) => f.resourceIds[0] === uploadId)!;
    const command = finding.fix.commands[0]!;
    // apply's own reader accepts the printed command and gets the key and ID back exactly.
    const args = runnable(command);
    assert.deepEqual(args.slice(0, 3), ["aws", "s3api", "abort-multipart-upload"]);
    assert.equal(args[args.indexOf("--key") + 1], key, command);
    assert.equal(args[args.indexOf("--upload-id") + 1], uploadId, command);
  }
});

test("scans of several regions merge into one result, most expensive first, each finding keeping its region", () => {
  const scanOf = (region: string, volumeId: string, sizeGb: number, warnings: string[] = []) => {
    const inv = { ...inventory({ volumes: [{ id: volumeId, type: "gp3", sizeGb, state: "available", attachedTo: [] }] }), region, warnings };
    return { inventory: inv, prices: { ...prices, region }, findings: detect(inv, prices) };
  };
  const empty = { inventory: { ...inventory({}), region: "eu-west-1" }, prices: { ...prices, region: "eu-west-1" }, findings: [] };
  const result = mergeScans("123456789012", [scanOf("ap-south-1", "vol-small", 10), empty, scanOf("us-east-1", "vol-big", 900, ["ec2:DescribeImages: AccessDenied"])]);

  assert.deepEqual(result.regions, ["ap-south-1", "eu-west-1", "us-east-1"]);
  assert.deepEqual(result.findings.map((f) => [f.resourceIds[0], f.region]), [["vol-big", "us-east-1"], ["vol-small", "ap-south-1"]]);
  assert.match(result.findings[0]!.fix.commands[0]!, /--region us-east-1$/);
  close(result.totalMonthlyWasteUsd, 910 * 0.0912);
  assert.deepEqual(result.warnings, ["[us-east-1] ec2:DescribeImages: AccessDenied"]);
});

// ---- Oversized instances and idle RDS instances ----

const sized: PriceBook = {
  ...prices,
  instanceHour: { "t3.micro": 0.0112, "m5.xlarge": 0.202, "m5.large": 0.101, "m5.2xlarge": 0.404, "m5.3xlarge": 0.606, "t3.xlarge": 0.1664, "t3.large": 0.0832 },
  instanceSpecs: {
    "m5.xlarge": { vcpu: 4, memoryGib: 16 },
    "m5.large": { vcpu: 2, memoryGib: 8 },
    "m5.2xlarge": { vcpu: 8, memoryGib: 32 },
    "m5.3xlarge": { vcpu: 12, memoryGib: 48 },
    "t3.xlarge": { vcpu: 4, memoryGib: 16 },
    "t3.large": { vcpu: 2, memoryGib: 8 },
  },
  rdsInstanceHour: { "db.t3.micro|MySQL|Single-AZ": 0.034, "db.t3.micro|MySQL|Multi-AZ": 0.068, "db.m5.large|PostgreSQL|Single-AZ": 0.253 },
  rdsStorageGbMonth: { "gp3|MySQL|Single-AZ": 0.131, "gp3|MySQL|Multi-AZ": 0.262, "gp2|PostgreSQL|Single-AZ": 0.131, "standard|MySQL|Single-AZ": 0.11 },
};

const running = (id: string, type: string, stats: ReturnType<typeof cpu> | undefined, extra: object = {}) => ({
  id,
  type,
  state: "running",
  platform: "Linux/UNIX",
  volumeIds: [],
  rootDeviceType: "ebs",
  cpu: stats,
  ...extra,
});
const patternsOf = (instances: ReturnType<typeof running>[]) => detect(inventory({ instances }), sized).map((f) => [f.pattern, f.resourceIds[0]]);

test("oversized instance: the saving is the price difference to the size one step down, with the resize as the fix", () => {
  const [f, ...rest] = detect(inventory({ instances: [running("i-big", "m5.xlarge", cpu(24, 25, 24), { name: "api" })] }), sized);
  assert.equal(rest.length, 0);
  assert.equal(f!.pattern, "oversized-instance");
  assert.equal(f!.title, "m5.xlarge could be m5.large: CPU peaked at 25.0%");
  close(f!.monthlyCostUsd, (0.202 - 0.101) * 730);
  assert.deepEqual(f!.fix.commands, [
    "aws ec2 stop-instances --instance-ids i-big --region ap-south-1",
    "aws ec2 wait instance-stopped --instance-ids i-big --region ap-south-1",
    'aws ec2 modify-instance-attribute --instance-id i-big --instance-type "{\\"Value\\": \\"m5.large\\"}" --region ap-south-1',
    "aws ec2 start-instances --instance-ids i-big --region ap-south-1",
  ]);
  assert.equal(f!.fix.risk, "caution");
  assert.match(f!.fix.rollback, /Needs downtime/);
  assert.match(f!.fix.rollback, /with "\{\\"Value\\": \\"m5\.xlarge\\"\}" as the instance type/);
  assert.equal(f!.alternative, undefined);
  // CPU alone cannot show the memory fits, so the rule is never confident.
  assert.equal(f!.confidence, 0.5);
  assert.ok(f!.evidence.some((e) => /Memory, disk and network use were not checked/.test(e)));
  assert.ok(f!.evidence.some((e) => /m5\.xlarge has 4 vCPU and 16 GiB; m5\.large has 2 vCPU and 8 GiB/.test(e)));
  assert.ok(f!.evidence.some((e) => /would peak at about 50%/.test(e)));
});

test("oversized instance: a short window lowers the rule confidence", () => {
  const [f] = detect(inventory({ instances: [running("i-big", "m5.xlarge", cpu(6, 25, 6))] }), sized);
  assert.equal(f!.confidence, 0.4);
});

test("oversized instance: the CPU limit is 40%, exclusive", () => {
  assert.deepEqual(patternsOf([running("i-39", "m5.xlarge", cpu(24, 39.9, 24)), running("i-40", "m5.xlarge", cpu(24, 40, 24)), running("i-70", "m5.xlarge", cpu(24, 70, 24))]), [["oversized-instance", "i-39"]]);
});

test("oversized instance: at least 90% of the asked-for window must have data", () => {
  // 21.6 of 24 hours is exactly 90%; 21.5 is not.
  assert.deepEqual(patternsOf([running("i-enough", "m5.xlarge", cpu(21.6, 25, 24)), running("i-short", "m5.xlarge", cpu(21.5, 25, 24)), running("i-nodata", "m5.xlarge", undefined)]), [["oversized-instance", "i-enough"]]);
});

test("oversized instance: an idle instance is reported as idle only, never also as oversized", () => {
  assert.deepEqual(patternsOf([running("i-idle", "m5.xlarge", cpu(24, 2, 24))]), [["idle-instance", "i-idle"]]);
});

test("oversized instance: burstable families, the smallest size, odd sizes and unpriced sizes are never reported", () => {
  const low = cpu(24, 20, 24);
  assert.deepEqual(
    patternsOf([
      running("i-burst", "t3.xlarge", low),
      // m5.medium is not in the price list for this region, so m5.large has no size below it.
      running("i-smallest", "m5.large", low),
      // There is no half-size step below 3xlarge.
      running("i-odd", "m5.3xlarge", low),
      // medium is the bottom of the ladder: nothing is below it.
      running("i-medium", "m6g.medium", low),
    ]),
    [],
  );
  assert.deepEqual(detect(inventory({ instances: [running("i-burst", "t3.xlarge", low)] }), { ...sized, instanceHour: { "t3.xlarge": 1, "t3.large": 0.1 } }), []);
});

test("oversized instance: no saving is stated without both prices and both specs, or when the smaller size is not cheaper", () => {
  const instances = [running("i-big", "m5.xlarge", cpu(24, 20, 24))];
  assert.deepEqual(detect(inventory({ instances }), { ...sized, instanceHour: { "m5.xlarge": 0.202 } }), []);
  assert.deepEqual(detect(inventory({ instances }), { ...sized, instanceSpecs: { "m5.xlarge": { vcpu: 4, memoryGib: 16 } } }), []);
  assert.deepEqual(detect(inventory({ instances }), { ...sized, instanceSpecs: { ...sized.instanceSpecs, "m5.large": { vcpu: 2, memoryGib: 4 } } }), []);
  assert.deepEqual(detect(inventory({ instances }), { ...sized, instanceHour: { "m5.xlarge": 0.1, "m5.large": 0.1 } }), []);
});

test("oversized instance: only On-Demand Linux on shared hardware with an EBS root that is running and not ignored", () => {
  const low = cpu(24, 20, 24);
  assert.deepEqual(
    patternsOf([
      running("i-windows", "m5.xlarge", low, { platform: "Windows" }),
      running("i-spot", "m5.xlarge", low, { lifecycle: "spot" }),
      running("i-dedicated", "m5.xlarge", low, { tenancy: "dedicated" }),
      running("i-store", "m5.xlarge", low, { rootDeviceType: "instance-store" }),
      running("i-ignored", "m5.xlarge", low, { ignored: true }),
      running("i-stopped", "m5.xlarge", low, { state: "stopped" }),
      running("i-shared", "m5.xlarge", low, { tenancy: "default" }),
    ]),
    // The stopped instance is a stopped-instance finding, not an oversized one.
    [["oversized-instance", "i-shared"], ["stopped-instance", "i-stopped"]],
  );
  const scan = { inventory: inventory({ instances: [running("i-ignored", "m5.xlarge", low, { ignored: true })] }), prices: sized, findings: [] };
  assert.deepEqual(mergeScans("123456789012", [scan]).skippedByTag, ["i-ignored"]);
});

const connections = (hoursObserved: number, maxConnections: number, windowHours = 24) => ({ windowHours, hoursObserved, datapoints: hoursObserved * 12, maxConnections });
const db = (id: string, extra: object = {}) => ({
  id,
  instanceClass: "db.t3.micro",
  engine: "mysql",
  status: "available",
  allocatedGb: 100,
  storageType: "gp3",
  multiAz: false,
  createdAt: "2026-01-01T00:00:00Z",
  replicaIds: [],
  deletionProtection: false,
  connections: connections(24, 0),
  ...extra,
});
const dbPatterns = (rdsInstances: ReturnType<typeof db>[]) => detect(inventory({ rdsInstances }), sized).map((f) => [f.pattern, f.resourceIds[0]]);

test("idle RDS instance: priced at its instance hours plus its storage, deleted with a final snapshot, stopped as the alternative", () => {
  const [f, ...rest] = detect(inventory({ rdsInstances: [db("orders-db")] }), sized);
  assert.equal(rest.length, 0);
  assert.equal(f!.pattern, "idle-rds-instance");
  assert.equal(f!.resourceType, "AWS::RDS::DBInstance");
  close(f!.monthlyCostUsd, 0.034 * 730 + 100 * 0.131);
  assert.deepEqual(f!.fix.commands, [
    "aws rds delete-db-instance --db-instance-identifier orders-db --final-db-snapshot-identifier orders-db-final-2026-10-03 --region ap-south-1",
  ]);
  assert.equal(f!.fix.risk, "dangerous");
  assert.match(f!.fix.rollback, /permanent/);
  assert.match(f!.fix.rollback, /aws rds restore-db-instance-from-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier orders-db-final-2026-10-03 --region ap-south-1/);
  assert.match(f!.fix.rollback, /snapshot is billed/);
  assert.deepEqual(f!.alternative!.commands, ["aws rds stop-db-instance --db-instance-identifier orders-db --region ap-south-1"]);
  assert.equal(f!.alternative!.risk, "caution");
  // Stopping saves the compute only: the storage keeps costing.
  close(f!.alternative!.monthlySavingUsd, 0.034 * 730);
  assert.match(f!.alternative!.description, /storage keeps costing/);
  assert.match(f!.alternative!.description, /7 days/);
  assert.match(f!.alternative!.rollback, /7 days/);
  assert.ok(f!.evidence.some((e) => /DatabaseConnections over the last 24\.0 h of the 24 h asked for: maximum 0/.test(e)));
  assert.ok(f!.evidence.some((e) => /does not show that nothing depends on the database/.test(e)));
});

test("idle RDS instance: Multi-AZ is priced from the Multi-AZ rates, and protection against deletion is stated", () => {
  const [f] = detect(inventory({ rdsInstances: [db("ha-db", { multiAz: true, deletionProtection: true })] }), sized);
  close(f!.monthlyCostUsd, 0.068 * 730 + 100 * 0.262);
  assert.ok(f!.evidence.some((e) => /Deletion protection is on/.test(e)));
  assert.ok(f!.evidence.some((e) => /Multi-AZ/.test(e)));
});

test("idle RDS instance: confidence grows with how long nobody connected", () => {
  const confidence = (hours: number, window = hours) => detect(inventory({ rdsInstances: [db("d", { connections: connections(hours, 0, window) })] }), sized)[0]!.confidence;
  assert.equal(confidence(6), 0.5);
  assert.equal(confidence(24), 0.7);
  assert.equal(confidence(168), 0.85);
});

test("idle RDS instance: any connection, too little history, or no data is not idle", () => {
  assert.deepEqual(
    dbPatterns([
      db("busy", { connections: connections(24, 1) }),
      // 21.5 of 24 hours is under 90% of the window.
      db("short", { connections: connections(21.5, 0) }),
      db("nodata", { connections: undefined }),
      db("enough", { connections: connections(21.6, 0) }),
    ]),
    [["idle-rds-instance", "enough"]],
  );
});

test("idle RDS instance: cluster members, replicas, instances with replicas, and other statuses are never judged", () => {
  assert.deepEqual(
    dbPatterns([
      db("aurora-member", { engine: "aurora-mysql", clusterId: "cluster-1" }),
      db("cluster-member-mysql", { clusterId: "cluster-1" }),
      db("replica", { replicaOf: "orders-db" }),
      db("primary-with-replica", { replicaIds: ["replica"] }),
      db("stopped", { status: "stopped" }),
      db("creating", { status: "creating" }),
      db("backing-up", { status: "backing-up" }),
    ]),
    [],
  );
});

test("idle RDS instance: engines and storage that are not priced, and unpriced instances, are left out", () => {
  assert.deepEqual(
    dbPatterns([
      db("oracle", { engine: "oracle-ee" }),
      db("sqlserver", { engine: "sqlserver-se" }),
      db("io1", { storageType: "io1" }),
      db("unknown-class", { instanceClass: "db.x2g.16xlarge" }),
      db("no-storage-price", { storageType: "gp2" }),
    ]),
    [],
  );
  // PostgreSQL on gp2 is priced in this table, so it is reported.
  assert.deepEqual(dbPatterns([db("pg", { engine: "postgres", instanceClass: "db.m5.large", storageType: "gp2" })]), [["idle-rds-instance", "pg"]]);
});

test("idle RDS instance: the ignore tag leaves it out and it is counted as skipped", () => {
  const inv = inventory({ rdsInstances: [db("kept"), db("ignored-db", { ignored: true })] });
  assert.deepEqual(detect(inv, sized).map((f) => f.resourceIds[0]), ["kept"]);
  assert.deepEqual(mergeScans("123456789012", [{ inventory: inv, prices: sized, findings: detect(inv, sized) }]).skippedByTag, ["ignored-db"]);
});

test("the instances a price lookup must cover are exactly the ones the rules could report", () => {
  const inv = inventory({
    instances: [running("i-big", "m5.xlarge", cpu(24, 20, 24)), running("i-busy", "m5.2xlarge", cpu(24, 80, 24)), running("i-burst", "t3.xlarge", cpu(24, 20, 24))],
    rdsInstances: [db("idle"), db("busy", { connections: connections(24, 3) }), db("replica", { replicaOf: "idle" })],
  });
  assert.deepEqual(oversizedCandidates(inv).map((c) => [c.instance.id, c.smaller]), [["i-big", "m5.large"]]);
  assert.deepEqual(idleRdsInstances(inv).map((d) => d.id), ["idle"]);
});

// ---- Idle NAT gateways and idle load balancers ----

const networked: PriceBook = { ...sized, natGatewayHour: 0.056, loadBalancerHour: { application: 0.0239, network: 0.0239 } };
const traffic = (hoursObserved: number, total: number, windowHours = 24, extra: object = {}) => ({ windowHours, hoursObserved, datapoints: hoursObserved * 12, total, ...extra });
const nat = (id: string, extra: object = {}) => ({
  id,
  state: "available",
  vpcId: "vpc-0a1b2c3d4e5f60718",
  subnetId: "subnet-0a1b2c3d4e5f60718",
  connectivityType: "public",
  createdAt: "2026-01-01T00:00:00Z",
  allocationIds: ["eipalloc-0a1b2c3d4e5f60718"],
  publicIps: ["13.126.0.1"],
  traffic: traffic(24, 0),
  ...extra,
});
const natPatterns = (natGateways: ReturnType<typeof nat>[], book: PriceBook = networked) => detect(inventory({ natGateways }), book).map((f) => [f.pattern, f.resourceIds[0]]);

test("idle NAT gateway: priced at its hourly rate over 730 hours, deleted, with the way back spelled out", () => {
  const [f, ...rest] = detect(inventory({ natGateways: [nat("nat-0a1b2c3d4e5f60718", { name: "egress" })] }), networked);
  assert.equal(rest.length, 0);
  assert.equal(f!.pattern, "idle-nat-gateway");
  assert.equal(f!.resourceType, "AWS::EC2::NatGateway");
  close(f!.monthlyCostUsd, 0.056 * 730);
  assert.match(f!.costBasis, /Data-processing charges are not included; with no traffic there are none/);
  assert.deepEqual(f!.fix.commands, ["aws ec2 delete-nat-gateway --nat-gateway-id nat-0a1b2c3d4e5f60718 --region ap-south-1"]);
  assert.equal(f!.fix.risk, "dangerous");
  assert.match(f!.fix.rollback, /permanent/);
  assert.match(f!.fix.rollback, /route table entry that points at it is not removed/);
  assert.match(f!.fix.rollback, /black-holes/);
  assert.match(f!.fix.rollback, /Elastic IP is not released with it/);
  assert.match(f!.fix.rollback, /idle Elastic IP/);
  assert.match(f!.fix.rollback, /new gateway gets a new ID/);
  assert.equal(f!.alternative, undefined);
  assert.ok(f!.evidence.some((e) => /BytesOutToDestination.*over the last 24\.0 h of the 24 h asked for: 0 bytes in total/.test(e)));
  assert.ok(f!.evidence.some((e) => /does not show that nothing routes to the gateway/.test(e)));
  assert.ok(f!.evidence.some((e) => /Elastic IP: 13\.126\.0\.1 \(eipalloc-0a1b2c3d4e5f60718\)/.test(e)));
  assert.ok(f!.evidence.some((e) => /Name tag: egress/.test(e)));
});

test("idle NAT gateway: a private gateway has no Elastic IP to talk about", () => {
  const [f] = detect(inventory({ natGateways: [nat("nat-0a1b2c3d4e5f60718", { connectivityType: "private", allocationIds: [], publicIps: [] })] }), networked);
  assert.ok(!/Elastic IP/.test(f!.fix.rollback));
  assert.ok(!f!.evidence.some((e) => /Elastic IP/.test(e)));
  assert.match(f!.fix.rollback, /new gateway gets a new ID/);
});

test("idle NAT gateway: confidence grows with how long nothing passed", () => {
  const confidence = (hours: number, window = hours) => detect(inventory({ natGateways: [nat("nat-1", { traffic: traffic(hours, 0, window) })] }), networked)[0]!.confidence;
  assert.equal(confidence(6), 0.5);
  assert.equal(confidence(24), 0.7);
  assert.equal(confidence(168), 0.85);
});

test("idle NAT gateway: any byte, too little history, no data, another state, or no subnet is not idle", () => {
  assert.deepEqual(
    natPatterns([
      nat("nat-busy", { traffic: traffic(24, 1) }),
      // 21.5 of 24 hours is under 90% of the window.
      nat("nat-short", { traffic: traffic(21.5, 0) }),
      nat("nat-nodata", { traffic: undefined }),
      nat("nat-pending", { state: "pending" }),
      nat("nat-failed", { state: "failed" }),
      nat("nat-deleting", { state: "deleting" }),
      // A regional NAT gateway has no subnet and is priced differently.
      nat("nat-regional", { subnetId: undefined }),
      nat("nat-enough", { traffic: traffic(21.6, 0) }),
    ]),
    [["idle-nat-gateway", "nat-enough"]],
  );
});

test("idle NAT gateway: with no price it is left out, and the ignore tag leaves it out and counts it as skipped", () => {
  assert.deepEqual(natPatterns([nat("nat-1")], { ...networked, natGatewayHour: 0 }), []);
  const inv = inventory({ natGateways: [nat("nat-kept"), nat("nat-ignored", { ignored: true })] });
  assert.deepEqual(detect(inv, networked).map((f) => f.resourceIds[0]), ["nat-kept"]);
  assert.deepEqual(mergeScans("123456789012", [{ inventory: inv, prices: networked, findings: detect(inv, networked) }]).skippedByTag, ["nat-ignored"]);
});

const ARN = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/web/50dc6c495c0c9188";
const empties = [{ arn: "arn:tg-1", name: "web-tg", registeredTargets: 0 }];
const balancer = (name: string, extra: object = {}) => ({
  arn: ARN.replace("app/web/", `app/${name}/`),
  name,
  type: "application",
  scheme: "internet-facing",
  dnsName: `${name}-123.ap-south-1.elb.amazonaws.com`,
  state: "active",
  createdAt: "2026-01-01T00:00:00Z",
  windowHours: 24,
  deletionProtection: false,
  targetGroups: [{ arn: "arn:tg-1", name: "web-tg", registeredTargets: 2 }],
  traffic: traffic(24, 500),
  ...extra,
});
const balancerPatterns = (loadBalancers: ReturnType<typeof balancer>[], book: PriceBook = networked) => detect(inventory({ loadBalancers }), book).map((f) => [f.pattern, f.resourceIds[0]]);

test("idle load balancer with no registered targets: priced at its hourly rate, deleted, with the way back spelled out", () => {
  const lb = balancer("web", { targetGroups: empties, traffic: undefined, deletionProtection: true });
  const [f, ...rest] = detect(inventory({ loadBalancers: [lb] }), networked);
  assert.equal(rest.length, 0);
  assert.equal(f!.pattern, "idle-load-balancer");
  assert.equal(f!.resourceType, "AWS::ElasticLoadBalancingV2::LoadBalancer");
  assert.deepEqual(f!.resourceIds, ["web"]);
  assert.equal(f!.title, "Idle application load balancer web: no registered targets");
  close(f!.monthlyCostUsd, 0.0239 * 730);
  assert.match(f!.costBasis, /LCU\) charges are not included/);
  assert.deepEqual(f!.fix.commands, [`aws elbv2 delete-load-balancer --load-balancer-arn ${lb.arn} --region ap-south-1`]);
  assert.equal(f!.fix.risk, "dangerous");
  assert.match(f!.fix.rollback, /permanent/);
  assert.match(f!.fix.rollback, /DNS name \(web-123\.ap-south-1\.elb\.amazonaws\.com\) is gone for good/);
  assert.match(f!.fix.rollback, /new load balancer gets a new DNS name/);
  assert.match(f!.fix.rollback, /deletion protection is on, the command is refused/);
  assert.match(f!.fix.rollback, /target groups are left behind/);
  assert.ok(f!.evidence.some((e) => /1 target group \(web-tg\), none with a registered target/.test(e)));
  assert.ok(f!.evidence.some((e) => /Deletion protection is on: the delete command is refused/.test(e)));
  assert.ok(f!.evidence.some((e) => /Traffic was not read, so requests are not ruled out/.test(e)));
  assert.ok(f!.evidence.some((e) => e === `ARN ${lb.arn}`));
  // Only the empty target group speaks, so the confidence stays at the bottom of the ladder.
  assert.equal(f!.confidence, 0.5);
});

test("idle load balancer with no requests: the Application one by RequestCount, the Network one by flows", () => {
  const [alb] = detect(inventory({ loadBalancers: [balancer("web", { traffic: traffic(24, 0) })] }), networked);
  assert.equal(alb!.title, "Idle application load balancer web: no requests");
  assert.ok(alb!.evidence.some((e) => /CloudWatch RequestCount over the last 24\.0 h of the 24 h asked for: 0 requests in total/.test(e)));
  assert.equal(alb!.confidence, 0.7);
  assert.ok(!alb!.evidence.some((e) => /target group/.test(e)));
  assert.match(alb!.costBasis, /with no traffic there are almost none/);

  const [nlb] = detect(inventory({ loadBalancers: [balancer("tcp", { type: "network", traffic: traffic(24, 0) })] }), networked);
  assert.equal(nlb!.title, "Idle network load balancer tcp: no flows");
  assert.ok(nlb!.evidence.some((e) => /NewFlowCount and ActiveFlowCount over the last 24\.0 h of the 24 h asked for: 0 flows in total/.test(e)));
});

test("idle load balancer: both signals are named, and a balancer CloudWatch published nothing for is judged by its age", () => {
  const [both] = detect(inventory({ loadBalancers: [balancer("web", { targetGroups: empties, traffic: traffic(168, 0, 168), windowHours: 168 })] }), networked);
  assert.equal(both!.title, "Idle application load balancer web: no registered targets and no requests");
  assert.equal(both!.confidence, 0.85);

  // No datapoints at all, which is what a balancer with no requests publishes: the hours it has existed count.
  const silent = balancer("quiet", { traffic: traffic(24, 0, 24, { datapoints: 0, fromAge: true }) });
  const [f] = detect(inventory({ loadBalancers: [silent] }), networked);
  assert.equal(f!.title, "Idle application load balancer quiet: no requests");
  assert.ok(f!.evidence.some((e) => /holds no RequestCount datapoints.*reports that metric only while requests flow, so none means no requests/.test(e)));
});

test("idle load balancer: any traffic clears it, even one with no targets that only redirects", () => {
  assert.deepEqual(
    balancerPatterns([
      balancer("busy", { traffic: traffic(24, 1) }),
      balancer("redirects", { targetGroups: empties, traffic: traffic(24, 9000) }),
      // Too little history to call it idle, but not too little to see that it is in use.
      balancer("busy-short", { targetGroups: empties, traffic: traffic(2, 5) }),
    ]),
    [],
  );
});

test("idle load balancer: at least 90% of the window must be covered, and a balancer must have existed that long", () => {
  assert.deepEqual(
    balancerPatterns([
      // 21.5 of 24 hours is under 90% of the window.
      balancer("short", { traffic: traffic(21.5, 0) }),
      balancer("enough", { traffic: traffic(21.6, 0) }),
      // Empty target groups, but created two hours before the scan: still being set up.
      balancer("new", { targetGroups: empties, traffic: undefined, createdAt: "2026-10-02T22:00:00Z" }),
      balancer("no-creation-time", { targetGroups: empties, traffic: undefined, createdAt: undefined }),
      balancer("old-enough", { targetGroups: empties, traffic: undefined, createdAt: "2026-10-02T02:00:00Z" }),
    ]),
    [["idle-load-balancer", "enough"], ["idle-load-balancer", "old-enough"]].sort(),
  );
});

test("idle load balancer reported on its empty target groups alone: a traffic reading too short to count is said to be inconclusive, and the confidence stays at the bottom", () => {
  // 100 of the 168 hours asked for is under 90% of the window, so the zero requests rule nothing out.
  const lb = balancer("web", { targetGroups: empties, traffic: traffic(100, 0, 168), windowHours: 168 });
  const [f, ...rest] = detect(inventory({ loadBalancers: [lb] }), networked);
  assert.equal(rest.length, 0);
  assert.equal(f!.title, "Idle application load balancer web: no registered targets");
  assert.ok(
    f!.evidence.some((e) => /CloudWatch held RequestCount for only the last 100\.0 h of the 168 h asked for, less than the 90% of the window needed, so requests over the rest of it are not ruled out/.test(e)),
    "the short reading is named",
  );
  assert.ok(!f!.evidence.some((e) => /Traffic was not read/.test(e)));
  assert.equal(f!.confidence, 0.5);
  assert.ok(!/with no traffic there are almost none/.test(f!.costBasis));
});

test("idle load balancer: targets in any state count, and a balancer with no target group or an unread one is not judged on targets", () => {
  assert.deepEqual(
    balancerPatterns([
      balancer("one-empty-one-full", { traffic: undefined, targetGroups: [...empties, { arn: "arn:tg-2", name: "api-tg", registeredTargets: 1 }] }),
      // A balancer with no target group at all may only redirect or answer with a fixed response.
      balancer("no-groups", { traffic: undefined, targetGroups: [] }),
      balancer("groups-unread", { traffic: undefined, targetGroups: undefined }),
      balancer("health-unread", { traffic: undefined, targetGroups: [{ arn: "arn:tg-3", name: "x", registeredTargets: undefined }] }),
    ]),
    [],
  );
});

test("idle load balancer: Gateway and unknown types, other states, unreadable tags, the ignore tag and unpriced types are left alone", () => {
  const idle = { targetGroups: empties, traffic: traffic(24, 0) };
  assert.deepEqual(
    balancerPatterns([
      balancer("gwlb", { ...idle, type: "gateway" }),
      balancer("mystery", { ...idle, type: "something-new" }),
      balancer("provisioning", { ...idle, state: "provisioning" }),
      balancer("impaired", { ...idle, state: "active_impaired" }),
      balancer("failed", { ...idle, state: "failed" }),
      balancer("tags-unread", { ...idle, tagsUnread: true }),
      balancer("ignored-lb", { ...idle, ignored: true }),
    ]),
    [],
  );
  // A type the Price List had no price for is left out rather than reported at a cost that is made up.
  assert.deepEqual(balancerPatterns([balancer("net", { ...idle, type: "network" })], { ...networked, loadBalancerHour: { application: 0.0239 } }), []);
  const inv = inventory({ loadBalancers: [balancer("kept", idle), balancer("ignored-lb", { ...idle, ignored: true })] });
  assert.deepEqual(detect(inv, networked).map((f) => f.resourceIds[0]), ["kept"]);
  assert.deepEqual(mergeScans("123456789012", [{ inventory: inv, prices: networked, findings: detect(inv, networked) }]).skippedByTag, ["ignored-lb"]);
});

test("the NAT gateways and load balancers a price lookup must cover are exactly the ones the rules could report", () => {
  const inv = inventory({
    natGateways: [nat("nat-idle"), nat("nat-busy", { traffic: traffic(24, 5) }), nat("nat-regional", { subnetId: undefined })],
    loadBalancers: [balancer("idle", { traffic: traffic(24, 0) }), balancer("busy"), balancer("gw", { type: "gateway", traffic: traffic(24, 0) })],
  });
  assert.deepEqual(idleNatGateways(inv).map((g) => g.id), ["nat-idle"]);
  assert.deepEqual(idleLoadBalancers(inv).map((i) => [i.balancer.name, i.noTargets, i.noTraffic]), [["idle", false, true]]);
});

// ---- The bill ----

const scanned = (totalMonthlyWasteUsd: number): ScanResult => ({
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "2026-10-03T00:00:00Z" },
  findings: [],
  totalMonthlyWasteUsd,
  skippedByTag: [],
  warnings: [],
});

test("the share of the bill is worked out in code, to one decimal", () => {
  assert.equal(withBill(scanned(151.53), { month: "2026-09", totalUsd: 1234.56 }).bill!.wasteSharePct, 12.3);
  assert.equal(withBill(scanned(10), { month: "2026-09", totalUsd: 1000 }).bill!.wasteSharePct, 1);
  assert.equal(withBill(scanned(0.04), { month: "2026-09", totalUsd: 1000 }).bill!.wasteSharePct, 0);
  // Never more than the bill's own figures: the total is carried through untouched.
  assert.deepEqual(withBill(scanned(5), { month: "2026-09", totalUsd: 100, estimated: true }).bill, { month: "2026-09", totalUsd: 100, estimated: true, wasteSharePct: 5 });
});

test("there is no share when nothing was wasted or the bill could not be read", () => {
  assert.equal(withBill(scanned(0), { month: "2026-09", totalUsd: 100 }).bill!.wasteSharePct, undefined);
  assert.deepEqual(withBill(scanned(5), { month: "2026-09", unavailable: "AccessDeniedException" }).bill, { month: "2026-09", unavailable: "AccessDeniedException" });
  assert.equal(withBill(scanned(5), { month: "2026-09", totalUsd: 0 }).bill!.wasteSharePct, undefined);
});
