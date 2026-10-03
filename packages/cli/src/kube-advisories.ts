/**
 * Cluster advisories: things a person should look at that are not waste.
 *
 * Like the waste rules they are fixed and need no model, and read only what
 * the scan already read. Unlike them they have no cost that adds into the
 * total: every one is an Advisory, a type of its own, listed in its own array
 * on the scan result, so nothing that sums, compares, scores, uploads or
 * announces findings can pick one up. The one dollar figure among them, what
 * the nodes that could go are worth, is an estimate and is never added to anything.
 */
import { cpuQuantity, memoryQuantity } from "./kube-format.js";
import { invalidName, noCommandFor, safeText, type ClusterInventory, type ContainerFacts, type NodeInfo, type PodFacts, type Workload } from "./kube.js";
import { HOURS_PER_MONTH, type Advisory, type AdvisoryRule, type CapacityCase, type ClusterPrices, type Fix, type SpareCapacity } from "./types.js";

const MI = 2 ** 20;
const GI = 2 ** 30;

/** A raised memory limit is the limit plus this much, rounded up to the next 16Mi. */
export const OOM_LIMIT_RAISE = 1.25;
const OOM_LIMIT_STEP_BYTES = 16 * MI;

/** A container is "restarting repeatedly" in CrashLoopBackOff, or with at least this many restarts... */
export const RESTART_COUNT = 5;
/** ...and, where the pod says when it last stopped, one of them within this many hours of the scan. */
export const RESTART_WINDOW_HOURS = 24;

/** No node may be filled beyond this share of its allocatable CPU or memory by requests. */
export const HEADROOM_PCT = 80;

/** What the scheduler said, cut to this many characters. */
const MESSAGE_MAX = 240;

/** What the over-requested findings would free from one workload: per pod, so it can be set against the nodes its pods are on. */
export interface Freed {
  workload: Workload;
  cpuFreedPerPod: number;
  memoryFreedPerPod: number;
}

const ORDER: AdvisoryRule[] = ["out-of-memory", "restarting", "no-requests", "unschedulable", "spare-node-capacity"];

const roundUp = (value: number, step: number) => Math.ceil(value / step - 1e-9) * step;
const gib = (bytes: number) => Number((bytes / GI).toFixed(2));
const cores = (value: number) => Number(value.toFixed(2));
const pct = (part: number, whole: number) => Math.round((part / whole) * 100);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The object a pod belongs to, as kubectl names it: its workload or controller, or the pod itself when it has none. */
const resourceOf = (pod: PodFacts) => (pod.owner ? `${pod.owner.kind.toLowerCase()}/${pod.owner.name}` : `pod/${pod.name}`);
const kindOf = (pod: PodFacts) => pod.owner?.kind ?? "Pod";

interface Group<T> {
  namespace: string;
  resource: string;
  kind: string;
  container: string;
  members: T[];
}

/** One group per container of one object, over every pod of it that shows the condition. */
function grouped<T extends { pod: PodFacts; container: ContainerFacts }>(hits: T[]): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const hit of hits) {
    const key = `${hit.pod.namespace}\u0000${resourceOf(hit.pod)}\u0000${hit.container.name}`;
    const group = groups.get(key) ?? { namespace: hit.pod.namespace, resource: resourceOf(hit.pod), kind: kindOf(hit.pod), container: hit.container.name, members: [] };
    group.members.push(hit);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const livePods = (inventory: ClusterInventory) => (inventory.advisories?.pods ?? []).filter((p) => !p.ignored);
const byName = (a: PodFacts, b: PodFacts) => a.name.localeCompare(b.name);
const latest = (times: Array<string | undefined>) => times.filter((t): t is string => Boolean(t) && Number.isFinite(Date.parse(t!))).sort().at(-1);
const mostPods = (n: number) => (n > 1 ? ` ${n} of its pods show this.` : "");

function outOfMemory(inventory: ClusterInventory): Advisory[] {
  const hits = livePods(inventory).flatMap((pod) =>
    pod.containers.filter((c) => c.terminated?.reason === "OOMKilled").map((container) => ({ pod, container })),
  );
  return grouped(hits).map((g) => {
    const pods = g.members.map((m) => m.pod).sort(byName);
    const when = latest(g.members.map((m) => m.container.terminated?.finishedAt));
    const limit = Math.max(0, ...g.members.map((m) => m.container.memoryLimitBytes ?? 0));
    const restarts = Math.max(...g.members.map((m) => m.container.restartCount));
    const exit = g.members.find((m) => m.container.terminated?.finishedAt === when)?.container.terminated?.exitCode;
    const owner = pods[0]!.ownerIsWorkload ? pods[0]!.owner : undefined;
    const bad = owner ? invalidName({ subdomain: [owner.name], label: [g.namespace, g.container] }) : undefined;
    const target = owner && !bad ? g.resource : undefined;
    const raised = limit > 0 ? roundUp(limit * OOM_LIMIT_RAISE, OOM_LIMIT_STEP_BYTES) : undefined;
    const at = `-n ${g.namespace} --context ${inventory.context}`;
    const set = (memory: number) => `kubectl set resources ${target} ${at} -c ${g.container} --limits=memory=${memoryQuantity(memory)}`;
    const suggestion: Fix | undefined =
      target && raised !== undefined
        ? {
            commands: [set(raised)],
            risk: "caution",
            rollback: `This restarts the pods one by one, and lets each use more memory on its node. To go back: ${set(limit)}. If the workload is deployed by Helm, Argo CD or Flux, change the limit there instead, or the next sync undoes this.`,
          }
        : undefined;
    return {
      rule: "out-of-memory",
      title: `Container ${g.container} of ${g.resource} was killed for running out of memory`,
      kind: g.kind,
      resource: g.resource,
      namespace: g.namespace,
      container: g.container,
      evidence: [
        `Container ${g.container} was last killed for running out of memory (reason OOMKilled${exit !== undefined ? `, exit code ${exit}` : ""})${when ? ` at ${when}` : ", at a time the pod does not record"}.${mostPods(pods.length)}`,
        limit > 0 ? `Its memory limit is ${memoryQuantity(limit)}` : "It has no memory limit, so the kill came from the node running short of memory or from a limit set somewhere else",
        `It has restarted ${plural(restarts, "time")}`,
        "The over-requested rule already leaves this container's memory request alone while the kill is on the pod's record, so no finding asks for it to be lowered",
      ],
      advice:
        suggestion
          ? `Raise the memory limit and watch whether the kills stop. The figure suggested is the limit plus 25%, rounded up to the next 16Mi: the right one depends on the workload, and only its owner knows what it needs.`
          : bad
            ? `Raise the memory limit and watch whether the kills stop. The right figure depends on the workload. ${noCommandFor(bad)}`
            : limit > 0
            ? "Raise the memory limit and watch whether the kills stop. This pod is not part of a Deployment, StatefulSet or DaemonSet, so the change belongs wherever it is created. The right figure depends on the workload."
            : "Give the container a memory request and limit, then watch whether the kills stop. The right figures depend on the workload, and only its owner knows what it needs.",
      ...(suggestion ? { suggestion } : {}),
      countedInTotal: false,
    };
  });
}

function restarting(inventory: ClusterInventory): Advisory[] {
  const now = Date.parse(inventory.collectedAt);
  const windowMs = RESTART_WINDOW_HOURS * 3_600_000;
  const hits = livePods(inventory).flatMap((pod) =>
    pod.containers.flatMap((container) => {
      const loop = container.waitingReason === "CrashLoopBackOff";
      const stopped = container.terminated?.finishedAt === undefined ? NaN : Date.parse(container.terminated.finishedAt);
      // Where the pod gives no time for its last stop that can be read, the count alone has to do.
      const timed = Number.isFinite(stopped) && Number.isFinite(now);
      const recent = timed ? now - stopped <= windowMs : true;
      const often = container.restartCount >= RESTART_COUNT && recent;
      return loop || often ? [{ pod, container, loop, timed }] : [];
    }),
  );
  return grouped(hits).map((g) => {
    // The pod named in the evidence has to be one the rest of it is true of, so where any
    // pod of the group is looping the worst is picked from those: only they are in the loop.
    const looping = g.members.filter((m) => m.loop);
    const pool = looping.length > 0 ? looping : g.members;
    const worst = [...pool].sort((a, b) => b.container.restartCount - a.container.restartCount || byName(a.pod, b.pod))[0]!;
    const c = worst.container;
    const bad = invalidName({ subdomain: [worst.pod.name], label: [g.namespace, g.container] });
    const stopped = c.terminated;
    const state = [stopped?.reason ? `reason ${stopped.reason}` : "", stopped?.exitCode !== undefined ? `exit code ${stopped.exitCode}` : "", stopped?.finishedAt ? `at ${stopped.finishedAt}` : ""].filter(Boolean);
    const why = worst.loop
      ? "It is in CrashLoopBackOff: Kubernetes is waiting longer and longer between its restarts"
      : `It has restarted at least ${RESTART_COUNT} times${worst.timed ? `, the last within ${RESTART_WINDOW_HOURS} hours of the scan` : stopped?.finishedAt === undefined ? " (the pod does not say when it last stopped)" : " (the time the pod gives for its last stop cannot be read, so the window was not checked)"}`;
    return {
      rule: "restarting",
      title: `Container ${g.container} of ${g.resource} keeps restarting`,
      kind: g.kind,
      resource: g.resource,
      namespace: g.namespace,
      container: g.container,
      evidence: [
        `Container ${g.container} of pod ${worst.pod.name} has restarted ${plural(c.restartCount, "time")}.${mostPods(g.members.length)}`,
        why,
        state.length > 0 ? `Its last state was terminated: ${state.join(", ")}` : "The pod records no earlier stop for it",
      ],
      advice: bad
        ? `CloudPilot cannot tell why from what it reads, and prints no fix. The log of the run before the last restart usually says. ${noCommandFor(bad)}`
        : `CloudPilot cannot tell why from what it reads, and prints no fix. The log of the run before the last restart usually says: kubectl logs ${worst.pod.name} -n ${g.namespace} --context ${inventory.context} -c ${g.container} --previous`,
      countedInTotal: false,
    };
  });
}

function noRequests(inventory: ClusterInventory): Advisory[] {
  const unset = (value: number | undefined) => !(value !== undefined && value > 0);
  return inventory.workloads
    .filter((w) => !w.ignored)
    .flatMap((w): Advisory[] => {
      const missing = w.containers.filter((c) => unset(c.cpuRequestCores) || unset(c.memoryRequestBytes));
      if (missing.length === 0) return [];
      const noCpu = missing.some((c) => unset(c.cpuRequestCores));
      const noMemory = missing.some((c) => unset(c.memoryRequestBytes));
      return [
        {
          rule: "no-requests",
          title: `${w.kind} ${w.name} sets no ${noCpu && noMemory ? "CPU or memory" : noCpu ? "CPU" : "memory"} request`,
          kind: w.kind,
          resource: `${w.kind.toLowerCase()}/${w.name}`,
          namespace: w.namespace,
          evidence: missing.map((c) => {
            const lacking = [unset(c.cpuRequestCores) ? "CPU" : "", unset(c.memoryRequestBytes) ? "memory" : ""].filter(Boolean).join(" or ");
            return `Container ${c.name} sets no ${lacking} request`;
          }),
          advice:
            "Without requests the scheduler cannot place the pods sensibly, and CloudPilot cannot judge whether they ask for too much. Set them from what the workload uses.",
          countedInTotal: false,
        },
      ];
    });
}

function unschedulable(inventory: ClusterInventory): Advisory[] {
  const groups = new Map<string, { namespace: string; resource: string; kind: string; pods: PodFacts[] }>();
  for (const pod of livePods(inventory).filter((p) => p.unscheduled)) {
    const key = `${pod.namespace}\u0000${resourceOf(pod)}`;
    const group = groups.get(key) ?? { namespace: pod.namespace, resource: resourceOf(pod), kind: kindOf(pod), pods: [] };
    group.pods.push(pod);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => {
    const pods = [...g.pods].sort(byName);
    const first = pods[0]!;
    const since = pods.map((p) => p.unscheduled?.since).filter(Boolean).sort()[0];
    const message = safeText(first.unscheduled?.message, MESSAGE_MAX);
    return {
      rule: "unschedulable",
      title: `${g.resource} cannot be scheduled`,
      kind: g.kind,
      resource: g.resource,
      namespace: g.namespace,
      evidence: [
        `Pod ${first.name} is Pending, and its PodScheduled condition is False${first.unscheduled?.reason ? ` (reason ${safeText(first.unscheduled.reason, 60)})` : ""}.${pods.length > 1 ? ` ${pods.length} of its pods are waiting.` : ""}`,
        message ? `The scheduler says: "${message}"` : "The scheduler gave no message",
        ...(since ? [`Waiting since ${since}`] : []),
      ],
      advice:
        "The scheduler's message names what it could not find: free CPU or memory, a node that matches a selector or affinity, a free volume. CloudPilot prints no fix, because which of those to change depends on what the workload needs. A node autoscaler may be adding a node already.",
      countedInTotal: false,
    };
  });
}

/** Nodes needed to hold these requests with no node above the headroom, by totals, between one and all of them. */
function nodesNeeded(cpu: number, memory: number, perNode: { cpuCores: number; memoryBytes: number }, nodes: number): number {
  const room = HEADROOM_PCT / 100;
  const byCpu = Math.ceil(cpu / (room * perNode.cpuCores) - 1e-9);
  const byMemory = Math.ceil(memory / (room * perNode.memoryBytes) - 1e-9);
  return Math.min(nodes, Math.max(1, byCpu, byMemory));
}

const LEFT_OUT: Record<NonNullable<NodeInfo["leftOut"]>, string> = { "control-plane": "control plane", tainted: "tainted NoSchedule or NoExecute", cordoned: "cordoned" };

/**
 * Whether the requests would fit on fewer nodes of the same size, now and
 * once the over-requested findings' suggestions are applied. An estimate by
 * totals; it says what it leaves out. It returns nothing unless some node
 * could go.
 */
export function spareNodeCapacity(inventory: ClusterInventory, prices: ClusterPrices, freed: Freed[]): Advisory | undefined {
  const nodes = inventory.advisories?.nodes ?? [];
  const pool = nodes.filter((n) => !n.leftOut);
  const out = nodes.filter((n) => n.leftOut);
  // One node cannot be made fewer, and a cluster with none that run ordinary workloads has nothing to count.
  if (pool.length < 2) return undefined;

  const sum = (pick: (n: NodeInfo) => number) => pool.reduce((total, n) => total + pick(n), 0);
  const allocatable = { cpuCores: sum((n) => n.allocatableCpuCores), memoryBytes: sum((n) => n.allocatableMemoryBytes) };
  const perNode = { cpuCores: allocatable.cpuCores / pool.length, memoryBytes: allocatable.memoryBytes / pool.length };
  const requestedNow = { cpu: sum((n) => n.requestedCpuCores), memory: sum((n) => n.requestedMemoryBytes) };

  // What the findings free is only freed where the pods are: on the nodes counted.
  const counted = new Set(pool.map((n) => n.name));
  let freedCpu = 0;
  let freedMemory = 0;
  for (const f of freed) {
    // A workload with no pod bound to a node has no `nodes`, and none of its pods is in the requests above.
    const pods = Object.entries(f.workload.nodes ?? {}).reduce((total, [node, n]) => total + (counted.has(node) ? n : 0), 0);
    freedCpu += pods * f.cpuFreedPerPod;
    freedMemory += pods * f.memoryFreedPerPod;
  }
  const requestedAfter = { cpu: Math.max(0, requestedNow.cpu - freedCpu), memory: Math.max(0, requestedNow.memory - freedMemory) };

  const caseOf = (requested: { cpu: number; memory: number }): CapacityCase => {
    const needed = nodesNeeded(requested.cpu, requested.memory, perNode, pool.length);
    // CPU is worked in cores but means millicores: round away the dust floating-point addition leaves.
    return { requestedCpuCores: Math.round(requested.cpu * 1000) / 1000, requestedMemoryBytes: requested.memory, nodesNeeded: needed, removable: pool.length - needed };
  };
  const now = caseOf(requestedNow);
  const after = caseOf(requestedAfter);
  if (after.removable === 0) return undefined;

  const nodeWorth = (perNode.cpuCores * prices.cpuHourUsd + (perNode.memoryBytes / GI) * prices.memoryGibHourUsd) * HOURS_PER_MONTH;
  const estimated = Number((after.removable * nodeWorth).toFixed(2));
  const basis = `${plural(after.removable, "node")} x (${cores(perNode.cpuCores)} CPU x $${prices.cpuHourUsd}/vCPU-hour + ${gib(perNode.memoryBytes)} GiB x $${prices.memoryGibHourUsd}/GiB-hour) x ${HOURS_PER_MONTH} h`;
  const capacity: SpareCapacity = { headroomPct: HEADROOM_PCT, nodes: pool.length, excludedNodes: out.map((n) => n.name), perNode, allocatable, now, afterSuggestions: after };

  const ofAllocatable = (cpu: number, memory: number) =>
    `${cores(cpu)} CPU of ${cores(allocatable.cpuCores)} allocatable (${pct(cpu, allocatable.cpuCores)}%), ${gib(memory)} GiB of memory of ${gib(allocatable.memoryBytes)} GiB allocatable (${pct(memory, allocatable.memoryBytes)}%)`;
  const fits = (c: CapacityCase) => (c.removable === 0 ? `need all ${pool.length} nodes` : `would fit on ${plural(c.nodesNeeded, "node")}, so up to ${c.removable} could be removed`);
  const hasFindings = freed.length > 0;

  return {
    rule: "spare-node-capacity",
    title:
      now.removable === after.removable
        ? `The requests would fit on fewer nodes: up to ${after.removable} of ${pool.length} could be removed`
        : `The requests would fit on fewer nodes: ${now.removable === 0 ? "none" : `up to ${now.removable}`} of ${pool.length} could be removed now, up to ${after.removable} once the suggested requests are applied`,
    kind: "Cluster",
    resource: `cluster/${inventory.context}`,
    namespace: "(cluster)",
    evidence: [
      `${plural(nodes.length, "node")} read; ${pool.length} can run ordinary workloads${out.length > 0 ? `. Left out: ${out.map((n) => `${n.name} (${LEFT_OUT[n.leftOut!]})`).join(", ")}` : ""}`,
      `Requests of the pods on those ${pool.length}: ${ofAllocatable(requestedNow.cpu, requestedNow.memory)}`,
      `With no node above ${HEADROOM_PCT}% of its allocatable CPU or memory, the requests as they are now ${fits(now)}. The average node is ${cores(perNode.cpuCores)} CPU and ${gib(perNode.memoryBytes)} GiB`,
      ...(hasFindings
        ? [`If the suggested requests of the over-requested findings were applied, the requests would be ${cores(requestedAfter.cpu)} CPU and ${gib(requestedAfter.memory)} GiB of memory, which ${fits(after)}`]
        : []),
      "This is an estimate by totals. It ignores affinity and anti-affinity rules, taints and tolerations, the DaemonSet pod each node must run, pod disruption budgets, local volumes and the headroom a spike needs",
      `Removing ${plural(after.removable, "node")} would be worth about $${estimated.toFixed(2)} a month at this scan's prices (${basis})`,
      hasFindings
        ? "That money is not added to the total or to any finding: the over-requested findings already count the CPU and memory they free, and adding the two would count it twice"
        : "That money is not added to the total",
    ],
    advice:
      "Lowering requests does not remove a node. A person, or a node autoscaler, has to. How a node is removed depends on the provider and on how the node group is managed, so CloudPilot prints no command for it.",
    countedInTotal: false,
    estimatedMonthlyUsd: estimated,
    estimateBasis: basis,
    capacity,
  };
}

/** Every advisory, in a fixed order, and the reads they needed that could not be made. */
export function detectAdvisories(inventory: ClusterInventory, prices: ClusterPrices, freed: Freed[]): { advisories: Advisory[]; warnings: string[] } {
  const spare = spareNodeCapacity(inventory, prices, freed);
  const advisories = [...outOfMemory(inventory), ...restarting(inventory), ...noRequests(inventory), ...unschedulable(inventory), ...(spare ? [spare] : [])];
  advisories.sort(
    (a, b) =>
      ORDER.indexOf(a.rule) - ORDER.indexOf(b.rule) ||
      a.namespace.localeCompare(b.namespace) ||
      a.resource.localeCompare(b.resource) ||
      (a.container ?? "").localeCompare(b.container ?? ""),
  );
  return { advisories, warnings: [...(inventory.advisories?.warnings ?? [])] };
}
