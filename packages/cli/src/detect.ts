import {
  HOURS_PER_MONTH,
  RDS_PRICED_ENGINES,
  RDS_PRICED_STORAGE,
  rdsHourKey,
  rdsStorageKey,
  type Bill,
  type Finding,
  type InstanceInfo,
  type Inventory,
  type LoadBalancerInfo,
  type NatGatewayInfo,
  type PriceBook,
  type RdsInstanceInfo,
  type RegionScan,
  type ScanResult,
} from "./types.js";

export interface DetectOptions {
  /** A running instance is idle when its CPU never went above this. */
  idleCpuMaxPct: number;
  /** Minimum CPU history before an instance may be called idle. */
  idleMinHours: number;
  /**
   * A running instance is a size too big when its CPU never went above this.
   * Half the vCPUs doubles the load on each, so a peak of 40% becomes about
   * 80%, which still leaves headroom. Above this there is no safe margin.
   */
  oversizedCpuMaxPct: number;
  /**
   * The share of the requested history CloudWatch must hold before an
   * instance is judged oversized, or an RDS instance, NAT gateway or load
   * balancer idle. A short history is a new resource, or a gap in the data,
   * not evidence.
   */
  minCoverage: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = { idleCpuMaxPct: 5, idleMinHours: 1, oversizedCpuMaxPct: 40, minCoverage: 0.9 };

/**
 * The size one step down in the same family: half the vCPUs and half the
 * memory. Only the steps AWS makes by halving are listed; sizes such as
 * 3xlarge or 9xlarge, and the smallest sizes, have no step down. Whether the
 * smaller type exists is settled by the Price List, not guessed here.
 */
const STEP_DOWN: Record<string, string> = {
  large: "medium",
  xlarge: "large",
  "2xlarge": "xlarge",
  "4xlarge": "2xlarge",
  "8xlarge": "4xlarge",
  "12xlarge": "6xlarge",
  "16xlarge": "8xlarge",
  "18xlarge": "9xlarge",
  "24xlarge": "12xlarge",
  "32xlarge": "16xlarge",
  "48xlarge": "24xlarge",
};

/** The t families (t2, t3, t3a, t4g) earn CPU credits, so a low CPU peak says little about what they need. */
const BURSTABLE = /^t\d/;

const smallerType = (type: string): string | undefined => {
  const [family, size, ...rest] = type.split(".");
  if (!family || !size || rest.length > 0 || BURSTABLE.test(family)) return undefined;
  const down = STEP_DOWN[size];
  return down ? `${family}.${down}` : undefined;
};

const isIdle = (i: InstanceInfo, options: DetectOptions) =>
  i.state === "running" && i.cpu !== undefined && i.cpu.hoursObserved >= options.idleMinHours && i.cpu.maxPct < options.idleCpuMaxPct;

/**
 * Running instances that are not idle but whose CPU never rose high, each
 * with the size one step down. Which of them are reported also depends on
 * prices: this is the list a price lookup has to cover.
 */
export function oversizedCandidates(inventory: Inventory, options: DetectOptions = DEFAULT_DETECT_OPTIONS): Array<{ instance: InstanceInfo; smaller: string }> {
  const out: Array<{ instance: InstanceInfo; smaller: string }> = [];
  for (const i of inventory.instances) {
    const cpu = i.cpu;
    if (i.ignored || i.state !== "running" || !cpu || isIdle(i, options)) continue;
    // Prices are On-Demand Linux on shared hardware, and a spot or instance-store instance cannot be stopped and resized.
    if (i.platform !== "Linux/UNIX" || i.lifecycle || (i.tenancy && i.tenancy !== "default") || i.rootDeviceType === "instance-store") continue;
    if (cpu.hoursObserved < options.minCoverage * cpu.windowHours || cpu.maxPct >= options.oversizedCpuMaxPct) continue;
    const smaller = smallerType(i.type);
    if (smaller) out.push({ instance: i, smaller });
  }
  return out;
}

/**
 * RDS instances that nobody connected to for the whole window. An instance
 * that is part of a cluster, that is a read replica or has replicas, or whose
 * engine or storage is not one CloudPilot can price, is never judged.
 */
export function idleRdsInstances(inventory: Inventory, options: DetectOptions = DEFAULT_DETECT_OPTIONS): RdsInstanceInfo[] {
  return inventory.rdsInstances.filter((d) => {
    const c = d.connections;
    if (d.ignored || d.status !== "available" || !c) return false;
    if (d.clusterId || d.replicaOf || d.replicaIds.length > 0) return false;
    if (!RDS_PRICED_ENGINES[d.engine] || !RDS_PRICED_STORAGE[d.storageType]) return false;
    return c.maxConnections === 0 && c.hoursObserved >= options.minCoverage * c.windowHours;
  });
}

/**
 * NAT gateways that carried no traffic for the whole window. A regional NAT
 * gateway (it has no subnet) is billed differently and is never judged.
 */
export function idleNatGateways(inventory: Inventory, options: DetectOptions = DEFAULT_DETECT_OPTIONS): NatGatewayInfo[] {
  return inventory.natGateways.filter((g) => {
    const t = g.traffic;
    if (g.ignored || g.state !== "available" || !g.subnetId || !t) return false;
    return t.total === 0 && t.hoursObserved >= options.minCoverage * t.windowHours;
  });
}

/** Why a load balancer is idle: nothing is registered behind it, or nothing came through it, or both. */
export interface IdleBalancer {
  balancer: LoadBalancerInfo;
  noTargets: boolean;
  noTraffic: boolean;
}

const hoursSince = (iso: string | undefined, at: string) => (iso ? (Date.parse(at) - Date.parse(iso)) / 3600_000 : undefined);

/**
 * Application and Network load balancers that no target group holds a target
 * for, or that took no requests or flows for the whole window. Any recorded
 * traffic clears a balancer, because one with no targets can still answer
 * with a redirect or a fixed response. A balancer must also be old enough:
 * as old as the share of the window CloudWatch has to cover, so one still
 * being set up is never judged. Gateway load balancers, balancers whose tags
 * could not be read, and balancers that are not active are left alone.
 */
export function idleLoadBalancers(inventory: Inventory, options: DetectOptions = DEFAULT_DETECT_OPTIONS): IdleBalancer[] {
  const out: IdleBalancer[] = [];
  for (const b of inventory.loadBalancers) {
    if (b.ignored || b.tagsUnread || b.state !== "active" || (b.type !== "application" && b.type !== "network")) continue;
    const t = b.traffic;
    if (t && t.total > 0) continue;
    const old = (hoursSince(b.createdAt, inventory.collectedAt) ?? 0) >= options.minCoverage * b.windowHours;
    // A target group with no targets is empty; a balancer with no target group at all may only redirect, so it is not judged on this.
    const noTargets = old && b.targetGroups !== undefined && b.targetGroups.length > 0 && b.targetGroups.every((g) => g.registeredTargets === 0);
    const noTraffic = t !== undefined && t.hoursObserved >= options.minCoverage * t.windowHours;
    if (noTargets || noTraffic) out.push({ balancer: b, noTargets, noTraffic });
  }
  return out;
}

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

/**
 * The two fixes autopilot may run, built in one place: autopilot checks a
 * finding's fix against these, word for word, before it runs it.
 */
export const gp3Command = (region: string, volumeId: string) => `aws ec2 modify-volume --volume-id ${volumeId} --volume-type gp3 --region ${region}`;
export const lifecycleCommand = (region: string, bucket: string) =>
  `aws s3api put-bucket-lifecycle-configuration --bucket ${bucket} --lifecycle-configuration '${JSON.stringify(LIFECYCLE_RULE)}' --region ${region}`;

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
      commands: [gp3Command(inventory.region, v.id)],
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

    if (isIdle(i, options) && i.cpu) {
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

  // Running instances one size too big. CPU is the only signal: memory is invisible without the CloudWatch agent.
  for (const { instance: i, smaller } of oversizedCandidates(inventory, options)) {
    const cpu = i.cpu!;
    const hourly = prices.instanceHour[i.type];
    const smallerHourly = prices.instanceHour[smaller];
    const spec = prices.instanceSpecs[i.type];
    const smallerSpec = prices.instanceSpecs[smaller];
    // Without both prices there is no saving to state; without both specs, "one step down" is unconfirmed.
    if (!hourly || !smallerHourly || hourly <= smallerHourly || !spec || !smallerSpec) continue;
    if (spec.vcpu !== smallerSpec.vcpu * 2 || spec.memoryGib !== smallerSpec.memoryGib * 2) continue;
    const instanceTypeArg = (type: string) => `"{\\"Value\\": \\"${type}\\"}"`;
    const resize = (type: string) => [
      cli(`ec2 stop-instances --instance-ids ${i.id}`),
      cli(`ec2 wait instance-stopped --instance-ids ${i.id}`),
      cli(`ec2 modify-instance-attribute --instance-id ${i.id} --instance-type ${instanceTypeArg(type)}`),
      cli(`ec2 start-instances --instance-ids ${i.id}`),
    ];
    findings.push({
      pattern: "oversized-instance",
      title: `${i.type} could be ${smaller}: CPU peaked at ${cpu.maxPct.toFixed(1)}%`,
      resourceType: "AWS::EC2::Instance",
      resourceIds: [i.id],
      evidence: [
        `CloudWatch CPUUtilization over the last ${cpu.hoursObserved.toFixed(1)} h of the ${cpu.windowHours} h asked for: average ${cpu.averagePct.toFixed(2)}%, maximum ${cpu.maxPct.toFixed(2)}% (${cpu.datapoints} datapoints)`,
        `On half the vCPUs the same load would peak at about ${(cpu.maxPct * 2).toFixed(0)}%`,
        `${i.type} has ${spec.vcpu} vCPU and ${spec.memoryGib} GiB; ${smaller} has ${smallerSpec.vcpu} vCPU and ${smallerSpec.memoryGib} GiB (AWS Price List)`,
        "Memory, disk and network use were not checked: CloudPilot reads CPU only, and memory is not visible without the CloudWatch agent",
        ...(i.name ? [`Name tag: ${i.name}`] : []),
      ],
      monthlyCostUsd: (hourly - smallerHourly) * HOURS_PER_MONTH,
      costBasis: `(${usd(hourly)} - ${usd(smallerHourly)})/hour x ${HOURS_PER_MONTH} hours (${i.type} to ${smaller})`,
      fix: {
        commands: resize(smaller),
        risk: "caution",
        rollback: `Needs downtime: the instance is stopped while it is resized, an instance store is erased when it stops, and a public IP that is not Elastic changes. To go back, run the same four commands with ${instanceTypeArg(i.type)} as the instance type. If an Auto Scaling group or a stack manages the instance, change its launch template or template instead: a replacement would launch at the old size.`,
      },
      // CPU alone cannot show that the memory fits. A short window is weaker still.
      confidence: cpu.hoursObserved >= 24 ? 0.5 : 0.4,
    });
  }

  // RDS instances nobody connected to for the whole window.
  for (const d of idleRdsInstances(inventory, options)) {
    const c = d.connections!;
    const engine = RDS_PRICED_ENGINES[d.engine]!;
    const hourly = prices.rdsInstanceHour[rdsHourKey(d.instanceClass, engine, d.multiAz)];
    const gbMonth = prices.rdsStorageGbMonth[rdsStorageKey(d.storageType, engine, d.multiAz)];
    // An instance that cannot be priced is left out rather than reported at a cost that omits part of its bill.
    if (hourly === undefined || gbMonth === undefined) continue;
    const compute = hourly * HOURS_PER_MONTH;
    const storage = d.allocatedGb * gbMonth;
    const deployment = d.multiAz ? "Multi-AZ" : "Single-AZ";
    const snapshot = `${d.id}-final-${inventory.collectedAt.slice(0, 10)}`;
    findings.push({
      pattern: "idle-rds-instance",
      title: `Idle RDS ${d.instanceClass} (${d.engine}): no connections`,
      resourceType: "AWS::RDS::DBInstance",
      resourceIds: [d.id],
      evidence: [
        `CloudWatch DatabaseConnections over the last ${c.hoursObserved.toFixed(1)} h of the ${c.windowHours} h asked for: maximum ${c.maxConnections} (${c.datapoints} datapoints)`,
        "Zero connections means nobody connected in that window; it does not show that nothing depends on the database, such as a job that runs weekly or monthly",
        `${d.instanceClass} ${d.engine}, ${deployment}, ${d.allocatedGb} GB ${d.storageType}, status available`,
        ...(d.createdAt ? [`Created ${d.createdAt}`] : []),
        ...(d.deletionProtection ? ["Deletion protection is on: RDS refuses the delete until it is turned off"] : []),
      ],
      monthlyCostUsd: compute + storage,
      costBasis: `${usd(hourly)}/hour x ${HOURS_PER_MONTH} hours + ${d.allocatedGb} GB x ${usd(gbMonth)}/GB-month (${deployment} ${d.storageType}). Backup storage beyond the free allocation and provisioned IOPS above the baseline are not included.`,
      fix: {
        commands: [cli(`rds delete-db-instance --db-instance-identifier ${d.id} --final-db-snapshot-identifier ${snapshot}`)],
        risk: "dangerous",
        rollback: `Deleting a DB instance is permanent, and its automated backups are deleted with it. The final snapshot is the way back: ${cli(`rds restore-db-instance-from-db-snapshot --db-instance-identifier ${d.id} --db-snapshot-identifier ${snapshot}`)}, adding the subnet group, security groups and parameter group again. The snapshot is billed per GB-month until it is deleted.`,
      },
      alternative: {
        commands: [cli(`rds stop-db-instance --db-instance-identifier ${d.id}`)],
        risk: "caution",
        rollback: `Start it again with: ${cli(`rds start-db-instance --db-instance-identifier ${d.id}`)}. AWS starts a stopped instance again by itself after 7 days, so this only pauses the compute charge.`,
        description: "Stop it instead: compute is not billed while it is stopped, but its storage keeps costing and AWS restarts it after 7 days",
        monthlySavingUsd: compute,
      },
      // A day without connections can be a quiet day; a week is a much stronger signal. Deleting is permanent, so none is higher than 0.85.
      confidence: c.hoursObserved >= 168 ? 0.85 : c.hoursObserved >= 24 ? 0.7 : 0.5,
    });
  }

  // NAT gateways that carried nothing for the whole window.
  for (const g of idleNatGateways(inventory, options)) {
    const t = g.traffic!;
    const hourly = prices.natGatewayHour;
    // A gateway that cannot be priced is left out rather than reported at a made-up cost.
    if (!hourly) continue;
    findings.push({
      pattern: "idle-nat-gateway",
      title: `Idle NAT gateway: no traffic in the last ${t.hoursObserved.toFixed(0)} h`,
      resourceType: "AWS::EC2::NatGateway",
      resourceIds: [g.id],
      evidence: [
        `CloudWatch NAT gateway bytes in and out (BytesInFromSource, BytesInFromDestination, BytesOutToSource, BytesOutToDestination) over the last ${t.hoursObserved.toFixed(1)} h of the ${t.windowHours} h asked for: ${t.total} bytes in total (${t.datapoints} datapoints)`,
        "No traffic means none passed in that window; it does not show that nothing routes to the gateway, such as a route used only when another path fails",
        `${g.connectivityType} NAT gateway in ${g.subnetId} (${g.vpcId ?? "unknown VPC"}), state available`,
        ...(g.allocationIds.length > 0 ? [`Elastic IP: ${g.publicIps.join(", ") || "unknown address"} (${g.allocationIds.join(", ")})`] : []),
        ...(g.createdAt ? [`Created ${g.createdAt}`] : []),
        ...(g.name ? [`Name tag: ${g.name}`] : []),
      ],
      monthlyCostUsd: hourly * HOURS_PER_MONTH,
      costBasis: `${usd(hourly)}/hour x ${HOURS_PER_MONTH} hours. Data-processing charges are not included; with no traffic there are none. The Elastic IP is billed separately and is not included.`,
      fix: {
        commands: [cli(`ec2 delete-nat-gateway --nat-gateway-id ${g.id}`)],
        risk: "dangerous",
        rollback: `Deleting a NAT gateway is permanent. A route table entry that points at it is not removed: that route black-holes, so traffic sent through it is dropped, until the route is changed or deleted. ${g.allocationIds.length > 0 ? "Its Elastic IP is not released with it: the address stays in the account, billed as an idle IP and reported by the idle Elastic IP check unless it is released too. " : ""}A new gateway gets a new ID${g.allocationIds.length > 0 ? " and a new or another Elastic IP" : ""}, so every route has to be pointed at it again.`,
      },
      // A day without traffic can be a quiet day; a week is a much stronger signal. Deleting is permanent, so none is higher than 0.85.
      confidence: t.hoursObserved >= 168 ? 0.85 : t.hoursObserved >= 24 ? 0.7 : 0.5,
    });
  }

  // Load balancers with no targets behind them, or no traffic through them, for the whole window.
  for (const { balancer: b, noTargets, noTraffic } of idleLoadBalancers(inventory, options)) {
    const hourly = prices.loadBalancerHour[b.type];
    if (hourly === undefined) continue;
    const t = b.traffic;
    const unit = b.type === "application" ? "requests" : "flows";
    const metrics = b.type === "application" ? "RequestCount" : "NewFlowCount and ActiveFlowCount";
    const hours = t?.hoursObserved ?? hoursSince(b.createdAt, inventory.collectedAt) ?? 0;
    const why = [noTargets ? "no registered targets" : "", noTraffic ? `no ${unit}` : ""].filter(Boolean).join(" and ");
    findings.push({
      pattern: "idle-load-balancer",
      title: `Idle ${b.type} load balancer ${b.name}: ${why}`,
      resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      resourceIds: [b.name],
      evidence: [
        ...(noTargets ? [`${b.targetGroups!.length} target group${b.targetGroups!.length === 1 ? "" : "s"} (${b.targetGroups!.map((g) => g.name).join(", ")}), none with a registered target`] : []),
        ...(t && noTraffic
          ? [
              t.fromAge
                ? `CloudWatch holds no ${metrics} datapoints for the last ${t.hoursObserved.toFixed(1)} h of the ${t.windowHours} h asked for. A load balancer reports that metric only while ${unit} flow, so none means no ${unit}`
                : `CloudWatch ${metrics} over the last ${t.hoursObserved.toFixed(1)} h of the ${t.windowHours} h asked for: ${t.total} ${unit} in total (${t.datapoints} datapoints)`,
            ]
          : []),
        ...(!noTraffic
          ? [
              t
                ? `CloudWatch held ${metrics} for only the last ${t.hoursObserved.toFixed(1)} h of the ${t.windowHours} h asked for, less than the ${(options.minCoverage * 100).toFixed(0)}% of the window needed, so ${unit} over the rest of it are not ruled out: a load balancer with no targets can still answer with a redirect or a fixed response`
                : `Traffic was not read, so ${unit} are not ruled out: a load balancer with no targets can still answer with a redirect or a fixed response`,
            ]
          : []),
        "No targets or no traffic in that window does not show that nothing uses the load balancer, such as one that serves a yearly event",
        `${b.type} load balancer ${b.name}, ${b.scheme ?? "unknown scheme"}, state active, DNS name ${b.dnsName ?? "unknown"}`,
        `ARN ${b.arn}`,
        ...(b.createdAt ? [`Created ${b.createdAt}`] : []),
        ...(b.deletionProtection ? ["Deletion protection is on: the delete command is refused until it is turned off"] : []),
      ],
      monthlyCostUsd: hourly * HOURS_PER_MONTH,
      costBasis: `${usd(hourly)}/hour x ${HOURS_PER_MONTH} hours (${b.type} load balancer). Load balancer capacity unit (LCU) charges are not included${noTraffic ? "; with no traffic there are almost none" : ""}.`,
      fix: {
        commands: [cli(`elbv2 delete-load-balancer --load-balancer-arn ${b.arn}`)],
        risk: "dangerous",
        rollback: `Deleting a load balancer is permanent. Its DNS name${b.dnsName ? ` (${b.dnsName})` : ""} is gone for good and cannot be claimed again, so every DNS record or allow-list that uses it breaks, and a new load balancer gets a new DNS name. Its listeners and rules are deleted with it. Its target groups are left behind, unused and not billed: delete them separately if they are not wanted. If deletion protection is on, the command is refused until it is switched off. To keep a way back, save its setup first: ${cli(`elbv2 describe-listeners --load-balancer-arn ${b.arn}`)} and ${cli("elbv2 describe-rules --listener-arn <each listener ARN>")}.`,
      },
      // The same ladder as the other idle rules. Without a traffic reading that covers the window, only the empty target groups speak, so it stays low.
      confidence: Math.min(hours >= 168 ? 0.85 : hours >= 24 ? 0.7 : 0.5, noTraffic ? 1 : 0.5),
    });
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
          commands: [lifecycleCommand(inventory.region, b.name)],
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
          risk: "dangerous",
          rollback: "Cannot be undone: aborting discards the uploaded parts for good, and the upload would have to start again from the beginning.",
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
    ...inventory.rdsInstances.filter((r) => r.ignored).map((r) => r.id),
    ...inventory.addresses.filter((r) => r.ignored).map((r) => r.allocationId),
    ...inventory.natGateways.filter((r) => r.ignored).map((r) => r.id),
    ...inventory.loadBalancers.filter((r) => r.ignored).map((r) => r.name),
    ...inventory.buckets.filter((r) => r.ignored).map((r) => r.name),
  ];
}

/**
 * The scan with the account's bill added: the bill as read, and what the
 * monthly waste found comes to as a share of it, rounded to one decimal. This
 * is the only place the share is worked out. No share is given when nothing
 * was wasted or the bill is not a positive amount.
 */
export function withBill(result: ScanResult, bill: Bill): ScanResult {
  const share = bill.totalUsd && bill.totalUsd > 0 && result.totalMonthlyWasteUsd > 0 ? Math.round((result.totalMonthlyWasteUsd / bill.totalUsd) * 1000) / 10 : undefined;
  return { ...result, bill: { ...bill, ...(share !== undefined ? { wasteSharePct: share } : {}) } };
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
