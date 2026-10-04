/**
 * The rules for a Kubernetes cluster. Like the AWS rules they are fixed and
 * need no model: the same cluster always gives the same findings.
 */
import { detectAdvisories } from "./kube-advisories.js";
import { cpuQuantity, hours, memoryQuantity } from "./kube-format.js";
import { invalidName, noCommandFor, type ClaimInfo, type ClusterInventory, type PersistentVolumeInfo, type Workload, type WorkloadContainer } from "./kube.js";
import { HOURS_PER_MONTH, type ClusterPrices, type Finding, type Fix, type ScanResult } from "./types.js";

/**
 * What a vCPU, a GiB of memory and a GiB of storage cost when nobody says
 * otherwise: the defaults the OpenCost project ships. A cluster's real prices
 * depend on its nodes, so these can be set on the command line.
 */
export const OPENCOST_DEFAULTS: ClusterPrices = {
  source: "opencost-defaults",
  cpuHourUsd: 0.031611,
  memoryGibHourUsd: 0.004237,
  storageGibMonthUsd: 0.04,
};

const MI = 2 ** 20;
const GI = 2 ** 30;

/** Room left above the busiest moment seen. */
const HEADROOM = 1.15;
/** No request is suggested below these, however quiet the container. */
const CPU_FLOOR_CORES = 0.01;
const MEMORY_FLOOR_BYTES = 32 * MI;
/** A request is only worth changing when it is at least twice the suggestion and the difference is more than noise. */
const WORTH_CHANGING_RATIO = 2;
const CPU_NOISE_CORES = 0.05;
const MEMORY_NOISE_BYTES = 64 * MI;
/** With less history than this there is nothing to judge a request by. */
const MIN_HISTORY_HOURS = 5 / 60;

export { cpuQuantity, hours, memoryQuantity };

const roundUp = (value: number, step: number) => Math.ceil(value / step - 1e-9) * step;

/** Use as measured, rounded up so it never reads as less than it was. */
const cpuUse = (cores: number) => (cores < 0.001 ? "under 1m" : cpuQuantity(Math.ceil(cores * 1000 - 1e-9) / 1000));
const memoryUse = (bytes: number) => (bytes < MI ? "under 1Mi" : memoryQuantity(Math.ceil(bytes / MI - 1e-9) * MI));

const gib = (bytes: number) => Number((bytes / GI).toFixed(2));
const usd = (n: number) => `$${n}`;

/** A week of history is worth trusting; an hour is a hint. */
export const confidenceFor = (historyHours: number) => (historyHours >= 168 ? 0.9 : historyHours >= 24 ? 0.8 : historyHours >= 1 ? 0.6 : 0.4);

export interface Resize {
  container: WorkloadContainer;
  cpuTo?: number;
  memoryTo?: number;
  evidence: string[];
}

/** What one container's requests could come down to, if anything. */
function resize(container: WorkloadContainer): Resize | undefined {
  const evidence: string[] = [];
  const history = container.historyHours ?? 0;
  let cpuTo: number | undefined;
  let memoryTo: number | undefined;

  if (container.cpuRequestCores !== undefined && container.cpuPeakCores !== undefined) {
    const suggested = Math.max(CPU_FLOOR_CORES, roundUp(container.cpuPeakCores * HEADROOM, 0.01));
    if (container.cpuRequestCores >= suggested * WORTH_CHANGING_RATIO && container.cpuRequestCores - suggested >= CPU_NOISE_CORES) {
      cpuTo = suggested;
      evidence.push(
        `Container ${container.name} requests ${cpuQuantity(container.cpuRequestCores)} CPU; its busiest five minutes in the last ${hours(history)} used ${cpuUse(container.cpuPeakCores)}`,
      );
    }
  }
  if (container.memoryRequestBytes !== undefined && container.memoryPeakBytes !== undefined) {
    const suggested = Math.max(MEMORY_FLOOR_BYTES, roundUp(container.memoryPeakBytes * HEADROOM, 16 * MI));
    if (container.memoryRequestBytes >= suggested * WORTH_CHANGING_RATIO && container.memoryRequestBytes - suggested >= MEMORY_NOISE_BYTES) {
      if (container.oomKilled) {
        // The graph can miss the moment a container ran out of memory. The kill on the pod's record cannot.
        if (cpuTo !== undefined) evidence.push(`Container ${container.name} has been killed for running out of memory, so its memory request is left alone`);
      } else {
        memoryTo = suggested;
        evidence.push(
          `Container ${container.name} requests ${memoryQuantity(container.memoryRequestBytes)} memory; the most it held in the last ${hours(history)} was ${memoryUse(container.memoryPeakBytes)}`,
        );
      }
    }
  }
  return cpuTo === undefined && memoryTo === undefined ? undefined : { container, cpuTo, memoryTo, evidence };
}

const requests = (cpu: number | undefined, memory: number | undefined) =>
  [cpu !== undefined ? `cpu=${cpuQuantity(cpu)}` : "", memory !== undefined ? `memory=${memoryQuantity(memory)}` : ""].filter(Boolean).join(",");

/** The containers of a workload whose requests could come down, as the over-requested finding judges them. */
function judgedResizes(workload: Workload): Resize[] {
  return workload.containers.flatMap((c) => ((c.historyHours ?? 0) >= MIN_HISTORY_HOURS ? [resize(c)].flatMap((r) => (r ? [r] : [])) : []));
}

function overRequested(workload: Workload, inventory: ClusterInventory, prices: ClusterPrices): Finding | undefined {
  const resizes = judgedResizes(workload);
  if (resizes.length === 0) return undefined;

  const target = `${workload.kind.toLowerCase()}/${workload.name}`;
  const at = `-n ${workload.namespace} --context ${inventory.context}`;
  const cpuSaved = resizes.reduce((sum, r) => sum + (r.cpuTo !== undefined ? r.container.cpuRequestCores! - r.cpuTo : 0), 0);
  const memorySaved = resizes.reduce((sum, r) => sum + (r.memoryTo !== undefined ? r.container.memoryRequestBytes! - r.memoryTo : 0), 0);
  const replicas = workload.replicas;
  const monthly = replicas * (cpuSaved * prices.cpuHourUsd + (memorySaved / GI) * prices.memoryGibHourUsd) * HOURS_PER_MONTH;
  const history = Math.min(...resizes.map((r) => r.container.historyHours ?? 0));

  const parts = [
    cpuSaved > 0 ? `${cpuQuantity(cpuSaved)} CPU x ${usd(prices.cpuHourUsd)}/vCPU-hour` : "",
    memorySaved > 0 ? `${gib(memorySaved)} GiB memory x ${usd(prices.memoryGibHourUsd)}/GiB-hour` : "",
  ].filter(Boolean);
  const set = (r: Resize, cpu: number | undefined, memory: number | undefined) =>
    `kubectl set resources ${target} ${at} -c ${r.container.name} --requests=${requests(cpu, memory)}`;
  const back = resizes.map((r) =>
    set(r, r.cpuTo !== undefined ? r.container.cpuRequestCores : undefined, r.memoryTo !== undefined ? r.container.memoryRequestBytes : undefined),
  );
  const bad = invalidName({ subdomain: [workload.name], label: [workload.namespace, ...resizes.map((r) => r.container.name)] });
  const fix: Fix = bad
    ? { commands: [], risk: "caution", rollback: noCommandFor(bad) }
    : {
        commands: resizes.map((r) => set(r, r.cpuTo, r.memoryTo)),
        risk: "caution",
        rollback: `This restarts the pods one by one. To go back: ${back.join(" && ")}. If the workload is deployed by Helm, Argo CD or Flux, change the request there instead, or the next sync undoes this.`,
      };

  return {
    region: workload.namespace,
    pattern: "over-requested-workload",
    title: `${workload.kind} ${workload.name} requests more than it uses`,
    resourceType: workload.kind,
    resourceIds: [target],
    evidence: [
      ...resizes.flatMap((r) => r.evidence),
      `Suggested: ${resizes.map((r) => `${r.container.name} ${requests(r.cpuTo, r.memoryTo).replace(/,/g, ", ").replace(/=/g, " ")}`).join("; ")} (the peak plus 15%, never below ${cpuQuantity(CPU_FLOOR_CORES)} CPU or ${memoryQuantity(MEMORY_FLOOR_BYTES)} memory)`,
      `${replicas} ${replicas === 1 ? "replica" : "replicas"}`,
      ...(history < inventory.lookbackHours * 0.9 ? [`Prometheus holds ${hours(history)} of history for it, of the ${hours(inventory.lookbackHours)} asked for`] : []),
    ],
    monthlyCostUsd: monthly,
    costBasis: `${replicas} x (${parts.join(" + ")}) x ${HOURS_PER_MONTH} h. The money is saved once the freed capacity lets the cluster run fewer or smaller nodes`,
    fix,
    confidence: confidenceFor(history),
  };
}

function unusedClaim(claim: ClaimInfo, inventory: ClusterInventory, prices: ClusterPrices): Finding | undefined {
  // A claim still waiting for a volume holds no storage, so it costs nothing.
  if (claim.phase !== "Bound" || claim.mountedBy.length > 0) return undefined;
  const size = gib(claim.capacityBytes);
  const policy = claim.reclaimPolicy;
  const bad = invalidName({ subdomain: [claim.name], label: [claim.namespace] });
  const volumeOk = claim.volumeName !== undefined && !invalidName({ subdomain: [claim.volumeName] });
  const check = `kubectl get persistentvolume ${volumeOk ? claim.volumeName : "<volume>"} --context ${inventory.context} -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'`;
  return {
    region: claim.namespace,
    pattern: "unused-volume-claim",
    title: `Volume claim ${claim.name} is mounted by no pod`,
    resourceType: "PersistentVolumeClaim",
    resourceIds: [`persistentvolumeclaim/${claim.name}`],
    evidence: [
      `Bound to volume ${claim.volumeName ?? "(unknown)"}, ${size} GiB${claim.storageClass ? `, storage class ${claim.storageClass}` : ""}`,
      "No running or pending pod mounts it",
      ...(claim.createdAt ? [`Created ${claim.createdAt}`] : []),
    ],
    monthlyCostUsd: size * prices.storageGibMonthUsd,
    costBasis: `${size} GiB x ${usd(prices.storageGibMonthUsd)}/GiB-month`,
    fix: {
      commands: bad ? [] : [`kubectl delete persistentvolumeclaim ${claim.name} -n ${claim.namespace} --context ${inventory.context}`],
      risk: "dangerous",
      rollback: bad
        ? noCommandFor(bad)
        : policy === "Retain"
          ? "The volume's reclaim policy is Retain, so deleting the claim leaves the volume and its data in place, still paid for, until the volume is deleted too."
          : policy === undefined
            ? `The volume's reclaim policy could not be read, so what deleting the claim does to the volume is unknown, and so is the saving: read it with ${check}. Delete means the claim takes the volume and its data with it; Retain means both stay, still paid for, until the volume is deleted too. Copy or snapshot the data first if any of it matters.`
            : `Deleting the claim deletes the volume and its data (reclaim policy ${policy}). Copy or snapshot the data first if any of it matters.`,
    },
    confidence: 0.8,
  };
}

function releasedVolume(volume: PersistentVolumeInfo, inventory: ClusterInventory, prices: ClusterPrices): Finding | undefined {
  if (volume.phase !== "Released") return undefined;
  const size = gib(volume.capacityBytes);
  const bad = invalidName({ subdomain: [volume.name] });
  return {
    region: volume.claim?.namespace ?? "(cluster)",
    pattern: "released-volume",
    title: `Volume ${volume.name} is Released: kept, but usable by nothing`,
    resourceType: "PersistentVolume",
    resourceIds: [`persistentvolume/${volume.name}`],
    evidence: [
      `Phase is Released${volume.claim ? `: its claim ${volume.claim.namespace}/${volume.claim.name} was deleted` : ""}`,
      `${size} GiB${volume.storageClass ? `, storage class ${volume.storageClass}` : ""}, reclaim policy ${volume.reclaimPolicy ?? "unknown"}`,
    ],
    monthlyCostUsd: size * prices.storageGibMonthUsd,
    costBasis: `${size} GiB x ${usd(prices.storageGibMonthUsd)}/GiB-month`,
    fix: {
      commands: bad ? [] : [`kubectl delete persistentvolume ${volume.name} --context ${inventory.context}`],
      risk: "dangerous",
      rollback: bad
        ? noCommandFor(bad)
        : "Deleting the volume object is permanent, and with reclaim policy Retain the disk behind it may stay in your cloud account and keep costing money: check for it there. Copy the data first if any of it matters.",
    },
    confidence: 0.9,
  };
}

/** Apply every cluster rule and return the scan result, most expensive finding first. */
export function detectCluster(inventory: ClusterInventory, prices: ClusterPrices): ScanResult {
  const kept = <T extends { ignored: boolean }>(items: T[]) => items.filter((item) => !item.ignored);
  const findings = [
    ...kept(inventory.workloads).flatMap((w) => overRequested(w, inventory, prices) ?? []),
    ...kept(inventory.claims).flatMap((c) => unusedClaim(c, inventory, prices) ?? []),
    ...kept(inventory.volumes).flatMap((v) => releasedVolume(v, inventory, prices) ?? []),
  ].sort((a, b) => b.monthlyCostUsd - a.monthlyCostUsd);

  const warnings = [...inventory.warnings];
  if (inventory.prometheus) {
    // Only workloads where nothing at all could be judged: one container with
    // history is enough for the workload to have been looked at.
    const unjudged = kept(inventory.workloads).filter((w) => w.containers.length > 0 && w.containers.every((c) => (c.historyHours ?? 0) < MIN_HISTORY_HOURS));
    if (unjudged.length > 0) {
      warnings.push(
        `${unjudged.length} workload${unjudged.length === 1 ? " has" : "s have"} under five minutes of usage history in Prometheus and ${unjudged.length === 1 ? "was" : "were"} not judged: ${unjudged.map((w) => `${w.namespace}/${w.name}`).join(", ")}`,
      );
    }
  }

  // What the over-requested findings would free, from the same judgement that raised them, for the node capacity advisory.
  const advisories = inventory.advisories
    ? detectAdvisories(
        inventory,
        prices,
        kept(inventory.workloads).flatMap((workload) => {
          const resizes = judgedResizes(workload);
          if (resizes.length === 0) return [];
          const cpuFreedPerPod = resizes.reduce((sum, r) => sum + (r.cpuTo !== undefined ? r.container.cpuRequestCores! - r.cpuTo : 0), 0);
          const memoryFreedPerPod = resizes.reduce((sum, r) => sum + (r.memoryTo !== undefined ? r.container.memoryRequestBytes! - r.memoryTo : 0), 0);
          return [{ workload, cpuFreedPerPod, memoryFreedPerPod }];
        }),
      )
    : undefined;

  return {
    accountId: inventory.context,
    // Volumes are cluster-scoped and read whole, so one can be charged to a
    // namespace outside the list read for workloads: a deleted or a system one.
    // Every namespace a finding is in belongs in the namespaces the report counts.
    regions: [...new Set([...inventory.namespaces, ...findings.map((f) => f.region)])].sort(),
    scannedAt: inventory.collectedAt,
    prices: { source: prices.source, fetchedAt: inventory.collectedAt },
    findings,
    totalMonthlyWasteUsd: findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0),
    ...(advisories ? { advisories: advisories.advisories, advisoryWarnings: advisories.warnings } : {}),
    skippedByTag: [
      ...inventory.workloads.filter((w) => w.ignored).map((w) => `${w.namespace}/${w.kind.toLowerCase()}/${w.name}`),
      ...inventory.claims.filter((c) => c.ignored).map((c) => `${c.namespace}/persistentvolumeclaim/${c.name}`),
      ...inventory.volumes.filter((v) => v.ignored).map((v) => `persistentvolume/${v.name}`),
    ],
    warnings,
    cluster: {
      context: inventory.context,
      server: inventory.server,
      prometheus: inventory.prometheus,
      lookbackHours: inventory.lookbackHours,
      prices,
    },
  };
}
