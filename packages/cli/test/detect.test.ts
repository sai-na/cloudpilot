import assert from "node:assert/strict";
import { test } from "node:test";
import { detect, mergeScans } from "../src/detect.js";
import type { Inventory, PriceBook } from "../src/types.js";

const prices: PriceBook = {
  region: "ap-south-1",
  source: "price-file",
  fetchedAt: "2026-10-02T00:00:00Z",
  ebsGbMonth: { gp2: 0.114, gp3: 0.0912 },
  snapshotGbMonth: 0.05,
  idleIpv4Hour: 0.005,
  instanceHour: { "t3.micro": 0.0112 },
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
  addresses: [],
  launchTemplateImageIds: [],
  buckets: [],
  warnings: [],
};

const inventory = (part: Partial<Inventory>): Inventory => ({ ...empty, ...part });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const cpu = (hoursObserved: number, maxPct: number) => ({ hoursObserved, datapoints: hoursObserved * 12, averagePct: maxPct / 2, maxPct });

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
