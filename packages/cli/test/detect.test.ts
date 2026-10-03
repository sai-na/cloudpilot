import assert from "node:assert/strict";
import { test } from "node:test";
import { detect, idleRdsInstances, mergeScans, oversizedCandidates } from "../src/detect.js";
import type { Inventory, PriceBook } from "../src/types.js";

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
