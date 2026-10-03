import { HOURS_PER_MONTH, type Finding, type Inventory, type PriceBook, type RegionScan, type ScanResult } from "./types.js";

export interface DetectOptions {
  /** A running instance is idle when its CPU never went above this. */
  idleCpuMaxPct: number;
  /** Minimum CPU history before an instance may be called idle. */
  idleMinHours: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = { idleCpuMaxPct: 5, idleMinHours: 1 };

const GIB = 1024 ** 3;

const LIFECYCLE_RULE = {
  Rules: [
    {
      ID: "cloudpilot-abort-incomplete-uploads-and-tier-down",
      Status: "Enabled",
      Filter: {},
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      Transitions: [{ Days: 30, StorageClass: "STANDARD_IA" }],
    },
  ],
};

/** A unit price, which is often a fraction of a cent: $0.0912, not $0.09. */
const usd = (n: number) => `$${Number(n.toFixed(4))}`;

/**
 * Turn an inventory into findings. Pure: no AWS calls and no clock. A resource
 * is flagged for what it is, not for how it is labelled; the one tag that
 * counts is cloudpilot:ignore=true, which leaves a resource out.
 */
export function detect(inventory: Inventory, prices: PriceBook, options: DetectOptions = DEFAULT_DETECT_OPTIONS): Finding[] {
  const cli = (command: string) => `aws ${command} --region ${inventory.region}`;
  // An object key or upload ID can hold spaces and other characters a shell would act on.
  const quoted = (value: string) => (/^[A-Za-z0-9._\/=:@%+,-]+$/.test(value) ? value : value.includes("'") ? `"${value.replace(/[\\"$`]/g, "\\$&")}"` : `'${value}'`);
  const ebsPrice = (type: string) => prices.ebsGbMonth[type] ?? 0;
  const volumeById = new Map(inventory.volumes.map((v) => [v.id, v]));
  const findings: Array<Omit<Finding, "region">> = [];

  // Unattached volumes, and gp2 volumes that would be cheaper as gp3.
  const gp3Saving = (sizeGb: number) => sizeGb * (ebsPrice("gp2") - ebsPrice("gp3"));
  for (const v of inventory.volumes) {
    if (v.ignored) continue;
    const unattached = v.state === "available" && v.attachedTo.length === 0;
    const toGp3 = {
      commands: [cli(`ec2 modify-volume --volume-id ${v.id} --volume-type gp3`)],
      risk: "caution" as const,
      rollback: "Online and reversible: the volume can be changed back to gp2 after AWS's 6-hour modification cooldown.",
    };
    if (unattached) {
      findings.push({
        pattern: "unattached-ebs-volume",
        title: `Unattached ${v.sizeGb} GB ${v.type} volume`,
        resourceType: "AWS::EC2::Volume",
        resourceIds: [v.id],
        evidence: [
          `State is "available" with no attachments`,
          ...(v.createdAt ? [`Created ${v.createdAt}`] : []),
          ...(v.name ? [`Name tag: ${v.name}`] : []),
        ],
        monthlyCostUsd: v.sizeGb * ebsPrice(v.type),
        costBasis: `${v.sizeGb} GB x ${usd(ebsPrice(v.type))}/GB-month (${v.type})`,
        fix: {
          commands: [cli(`ec2 delete-volume --volume-id ${v.id}`)],
          risk: "dangerous",
          rollback: `Deleting a volume is permanent. To keep a way back, snapshot it first: ${cli(`ec2 create-snapshot --volume-id ${v.id}`)}`,
        },
        ...(v.type === "gp2" && gp3Saving(v.sizeGb) > 0
          ? {
              alternative: {
                ...toGp3,
                description: "If the volume must be kept, convert it from gp2 to gp3",
                monthlySavingUsd: gp3Saving(v.sizeGb),
              },
            }
          : {}),
        confidence: 0.95,
      });
    } else if (v.type === "gp2" && gp3Saving(v.sizeGb) > 0) {
      findings.push({
        pattern: "gp2-volume",
        title: `${v.sizeGb} GB gp2 volume can move to gp3`,
        resourceType: "AWS::EC2::Volume",
        resourceIds: [v.id],
        evidence: [`Volume type is gp2, attached to ${v.attachedTo.join(", ") || "nothing"}`],
        monthlyCostUsd: gp3Saving(v.sizeGb),
        costBasis: `${v.sizeGb} GB x (${usd(ebsPrice("gp2"))} - ${usd(ebsPrice("gp3"))})/GB-month`,
        fix: toGp3,
        confidence: 0.9,
      });
    }
  }

  for (const a of inventory.addresses) {
    if (a.ignored || a.associationId) continue;
    findings.push({
      pattern: "idle-elastic-ip",
      title: `Elastic IP ${a.publicIp} is not associated`,
      resourceType: "AWS::EC2::EIP",
      resourceIds: [a.allocationId],
      evidence: ["No association with an instance or network interface"],
      monthlyCostUsd: prices.idleIpv4Hour * HOURS_PER_MONTH,
      costBasis: `${usd(prices.idleIpv4Hour)}/hour idle public IPv4 x ${HOURS_PER_MONTH} hours`,
      fix: {
        commands: [cli(`ec2 release-address --allocation-id ${a.allocationId}`)],
        risk: "dangerous",
        rollback: "The address goes back to AWS's pool and usually cannot be reclaimed. Check nothing (DNS, allow-lists) still points at it.",
      },
      confidence: 0.95,
    });
  }

  for (const i of inventory.instances) {
    if (i.ignored) continue;
    const volumes = i.volumeIds.map((id) => volumeById.get(id)).filter((v) => v !== undefined);
    const storage = volumes.reduce((sum, v) => sum + v.sizeGb * ebsPrice(v.type), 0);
    const storageBasis = volumes.map((v) => `${v.sizeGb} GB ${v.type}`).join(" + ") || "no EBS volumes";
    const terminate = {
      commands: [cli(`ec2 terminate-instances --instance-ids ${i.id}`)],
      risk: "dangerous" as const,
      rollback: `Termination is permanent. To keep a way back, image it first: ${cli(`ec2 create-image --instance-id ${i.id} --name backup-${i.id}`)}`,
    };

    if (i.state === "stopped") {
      findings.push({
        pattern: "stopped-instance",
        title: `Stopped ${i.type} still pays for ${storageBasis}`,
        resourceType: "AWS::EC2::Instance",
        resourceIds: [i.id],
        evidence: [
          "Instance state is stopped: no compute charge, but its EBS volumes are still billed",
          ...(i.stateReason ? [`State transition: ${i.stateReason}`] : []),
          ...(i.name ? [`Name tag: ${i.name}`] : []),
        ],
        monthlyCostUsd: storage,
        costBasis: `${storageBasis} at EBS GB-month prices`,
        fix: terminate,
        confidence: 0.8,
      });
    }

    if (i.state === "running" && i.cpu && i.cpu.hoursObserved >= options.idleMinHours && i.cpu.maxPct < options.idleCpuMaxPct) {
      const hourly = prices.instanceHour[i.type] ?? 0;
      findings.push({
        pattern: "idle-instance",
        title: `Idle ${i.type}: CPU never above ${i.cpu.maxPct.toFixed(1)}%`,
        resourceType: "AWS::EC2::Instance",
        resourceIds: [i.id],
        evidence: [
          `CloudWatch CPUUtilization over the last ${i.cpu.hoursObserved.toFixed(1)} h: average ${i.cpu.averagePct.toFixed(2)}%, maximum ${i.cpu.maxPct.toFixed(2)}% (${i.cpu.datapoints} datapoints)`,
          ...(i.launchedAt ? [`Launched ${i.launchedAt}`] : []),
          ...(i.name ? [`Name tag: ${i.name}`] : []),
        ],
        monthlyCostUsd: hourly * HOURS_PER_MONTH + storage,
        costBasis: `${usd(hourly)}/hour x ${HOURS_PER_MONTH} hours + ${storageBasis}`,
        fix: terminate,
        // A few idle hours can be a quiet night; a full day is a much stronger signal.
        confidence: i.cpu.hoursObserved >= 24 ? 0.9 : i.cpu.hoursObserved >= 6 ? 0.8 : 0.6,
      });
    }
  }

  // Snapshots whose source volume is gone and that no AMI is built on.
  const amiSnapshots = new Set(inventory.images.flatMap((img) => img.snapshots.map((s) => s.id)));
  for (const s of inventory.snapshots) {
    // Copied snapshots carry a placeholder volume ID, so their source cannot be checked.
    if (s.ignored || !s.volumeId || s.volumeId === "vol-ffffffff") continue;
    if (volumeById.has(s.volumeId) || amiSnapshots.has(s.id)) continue;
    findings.push({
      pattern: "orphaned-snapshot",
      title: `Snapshot of a deleted ${s.sizeGb} GB volume`,
      resourceType: "AWS::EC2::Snapshot",
      resourceIds: [s.id],
      evidence: [
        `Source volume ${s.volumeId} no longer exists`,
        "No AMI in this account references the snapshot",
        ...(s.startedAt ? [`Taken ${s.startedAt}`] : []),
      ],
      monthlyCostUsd: s.sizeGb * prices.snapshotGbMonth,
      costBasis: `${s.sizeGb} GB provisioned x ${usd(prices.snapshotGbMonth)}/GB-month. Upper bound: snapshots are billed for stored blocks only.`,
      fix: {
        commands: [cli(`ec2 delete-snapshot --snapshot-id ${s.id}`)],
        risk: "dangerous",
        rollback: "Deleting a snapshot is permanent, and with the source volume gone it may be the only copy of that data.",
      },
      confidence: 0.8,
    });
  }

  const imagesInUse = new Set([
    ...inventory.instances.map((i) => i.imageId).filter(Boolean),
    ...inventory.launchTemplateImageIds,
  ]);
  for (const img of inventory.images) {
    if (img.ignored || img.state !== "available" || imagesInUse.has(img.id)) continue;
    const sizeGb = img.snapshots.reduce((sum, s) => sum + s.sizeGb, 0);
    findings.push({
      pattern: "unused-ami",
      title: `AMI ${img.name ?? img.id} is used by nothing`,
      resourceType: "AWS::EC2::Image",
      resourceIds: [img.id],
      evidence: [
        "No instance in this region (running or stopped) was launched from it",
        "No launch template references it",
        `Backed by ${img.snapshots.length} snapshot(s): ${img.snapshots.map((s) => s.id).join(", ")}`,
        ...(img.createdAt ? [`Created ${img.createdAt}`] : []),
      ],
      monthlyCostUsd: sizeGb * prices.snapshotGbMonth,
      costBasis: `${sizeGb} GB provisioned x ${usd(prices.snapshotGbMonth)}/GB-month. Upper bound: snapshots are billed for stored blocks only.`,
      fix: {
        commands: [
          cli(`ec2 deregister-image --image-id ${img.id}`),
          ...img.snapshots.map((s) => cli(`ec2 delete-snapshot --snapshot-id ${s.id}`)),
        ],
        risk: "dangerous",
        rollback: "Deregistering and deleting the snapshots is permanent. Auto Scaling launch configurations and other accounts the AMI is shared with are not visible to this scan - check them first.",
      },
      confidence: 0.7,
    });
  }

  for (const b of inventory.buckets) {
    // An ignored bucket takes its incomplete uploads with it: uploads cannot be tagged.
    if (b.ignored) continue;
    if (!b.hasLifecycle) {
      findings.push({
        pattern: "bucket-without-lifecycle",
        title: `Bucket ${b.name} has no lifecycle rule`,
        resourceType: "AWS::S3::Bucket",
        resourceIds: [b.name],
        evidence: [
          "No lifecycle configuration: objects never transition or expire, and incomplete multipart uploads are never cleaned up",
          `${b.truncated ? "At least " : ""}${b.objectCount} object(s), ${b.bytes} bytes in S3 Standard`,
        ],
        monthlyCostUsd: (b.bytes / GIB) * prices.s3StandardGbMonth,
        costBasis: `${b.truncated ? "at least " : ""}${b.bytes} bytes x ${usd(prices.s3StandardGbMonth)}/GB-month (S3 Standard)`,
        fix: {
          commands: [
            cli(`s3api put-bucket-lifecycle-configuration --bucket ${b.name} --lifecycle-configuration '${JSON.stringify(LIFECYCLE_RULE)}'`),
          ],
          risk: "caution",
          rollback: `Remove the rule again with: ${cli(`s3api delete-bucket-lifecycle --bucket ${b.name}`)}. Objects already moved to Standard-IA stay there.`,
        },
        confidence: 0.9,
      });
    }
    for (const u of b.multipartUploads) {
      const ageHours = u.initiatedAt ? (Date.parse(inventory.collectedAt) - Date.parse(u.initiatedAt)) / 3600_000 : undefined;
      findings.push({
        pattern: "incomplete-multipart-upload",
        title: `Incomplete multipart upload in ${b.name}`,
        resourceType: "AWS::S3::MultipartUpload",
        resourceIds: [u.uploadId],
        evidence: [
          `Key ${u.key}, started ${u.initiatedAt ?? "at an unknown time"}, never completed`,
          u.bytes === undefined
            ? "Size of the uploaded parts is not visible to this role (needs s3:ListMultipartUploadParts)"
            : `${u.bytes} bytes of parts are stored and billed, but do not show up in object listings`,
        ],
        monthlyCostUsd: ((u.bytes ?? 0) / GIB) * prices.s3StandardGbMonth,
        costBasis: u.bytes === undefined ? "part sizes not visible; cost unknown" : `${u.bytes} bytes x ${usd(prices.s3StandardGbMonth)}/GB-month`,
        fix: {
          commands: [cli(`s3api abort-multipart-upload --bucket ${b.name} --key ${quoted(u.key)} --upload-id ${quoted(u.uploadId)}`)],
          risk: "caution",
          rollback: "Aborting discards the uploaded parts; the upload would have to start again from the beginning.",
        },
        // Without the part sizes the cost is unknown; a fresh upload may simply still be in progress.
        confidence: u.bytes === undefined ? 0.6 : ageHours !== undefined && ageHours < 24 ? 0.8 : 0.9,
      });
    }
  }

  return findings.sort((a, b) => b.monthlyCostUsd - a.monthlyCostUsd).map((f) => ({ region: inventory.region, ...f }));
}

/** IDs of every resource tagged cloudpilot:ignore=true, so skipping is never silent. */
export function skippedByTag(inventory: Inventory): string[] {
  return [
    ...inventory.volumes.filter((r) => r.ignored).map((r) => r.id),
    ...inventory.snapshots.filter((r) => r.ignored).map((r) => r.id),
    ...inventory.images.filter((r) => r.ignored).map((r) => r.id),
    ...inventory.instances.filter((r) => r.ignored).map((r) => r.id),
    ...inventory.addresses.filter((r) => r.ignored).map((r) => r.allocationId),
    ...inventory.buckets.filter((r) => r.ignored).map((r) => r.name),
  ];
}

/** A warning names the region whose check could not run, so a reader can tell what was missed. */
const regionWarning = (region: string, warning: string) => `[${region}] ${warning}`;

/**
 * The regions where at least one check could not run. Their part of the scan
 * is incomplete: what is missing from the findings may simply be unread.
 */
export function regionsNotFullyScanned(warnings: string[]): Set<string> {
  const regions = new Set<string>();
  for (const warning of warnings) {
    const named = /^\[([^\]]+)\] /.exec(warning);
    if (named) regions.add(named[1]!);
  }
  return regions;
}

/**
 * Combine per-region scans into one result. Scans must arrive in a fixed
 * order (by region name) so the same account always gives the same output.
 */
export function mergeScans(accountId: string, scans: RegionScan[]): ScanResult {
  const findings = scans.flatMap((s) => s.findings).sort((a, b) => b.monthlyCostUsd - a.monthlyCostUsd);
  const priced = scans.find((s) => s.findings.length > 0) ?? scans[0];
  return {
    accountId,
    regions: scans.map((s) => s.inventory.region),
    scannedAt: scans[0]?.inventory.collectedAt ?? "",
    prices: { source: priced?.prices.source ?? "aws-price-list-api", fetchedAt: priced?.prices.fetchedAt ?? "" },
    findings,
    totalMonthlyWasteUsd: findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0),
    skippedByTag: scans.flatMap((s) => skippedByTag(s.inventory)),
    warnings: scans.flatMap((s) => s.inventory.warnings.map((w) => regionWarning(s.inventory.region, w))),
  };
}
