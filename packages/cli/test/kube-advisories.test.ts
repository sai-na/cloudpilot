/**
 * Cluster advisories: the five rules on hand-built clusters, what they leave
 * alone, and the guarantee that matters most: an advisory is not waste, so
 * nothing that handles findings changes when advisories are present.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { forModel, groundRules, summaryRequest } from "../src/advisor.js";
import { carryForward, compareScans } from "../src/compare.js";
import { evaluate } from "../src/evaluate.js";
import { HEADROOM_PCT, OOM_LIMIT_RAISE, RESTART_COUNT, RESTART_WINDOW_HOURS } from "../src/kube-advisories.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { collectCluster, safeText, type ClusterInventory, type ContainerFacts, type KubeReader, type NodeInfo, type PodFacts, type Workload } from "../src/kube.js";
import { compose, freshFindings } from "../src/notify.js";
import { allowedValues, unsupportedValues } from "../src/output-check.js";
import { renderMarkdown, renderPlainText, renderText, templatedSummary } from "../src/report.js";
import { renderHtml } from "../src/html.js";
import { JSDOM } from "jsdom";
import { scanJson } from "../src/upload.js";
import type { ScanResult } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const ANSWER_KEY = resolve(here, "../../../k8s-lab/answer-key.json");
const lab = JSON.parse(readFileSync(resolve(here, "fixtures/kube-lab.json"), "utf8")) as {
  recordedAt: string;
  identity: { context: string; server: string };
  lookbackHours: number;
  responses: Record<string, any>;
};

const MI = 2 ** 20;
const GI = 2 ** 30;

// Hand-built clusters.

const container = (over: Partial<ContainerFacts> = {}): ContainerFacts => ({ name: "app", restartCount: 0, ...over });
const pod = (over: Partial<PodFacts> = {}): PodFacts => ({
  namespace: "prod",
  name: "api-7558c476b-9ngzv",
  phase: "Running",
  owner: { kind: "Deployment", name: "api" },
  ownerIsWorkload: true,
  containers: [container()],
  ignored: false,
  ...over,
});
const node = (name: string, over: Partial<NodeInfo> = {}): NodeInfo => ({
  name,
  allocatableCpuCores: 4,
  allocatableMemoryBytes: 16 * GI,
  requestedCpuCores: 0,
  requestedMemoryBytes: 0,
  pods: 0,
  ...over,
});
const workload = (over: Partial<Workload> = {}): Workload => ({
  kind: "Deployment",
  name: "api",
  namespace: "prod",
  replicas: 1,
  ignored: false,
  containers: [{ name: "app", cpuRequestCores: 0.1, memoryRequestBytes: 128 * MI, oomKilled: false }],
  ...over,
});
const cluster = (over: { pods?: PodFacts[]; nodes?: NodeInfo[]; workloads?: Workload[]; collectedAt?: string; warnings?: string[] } = {}): ClusterInventory => ({
  context: "prod-cluster",
  collectedAt: over.collectedAt ?? "2026-10-03T12:00:00Z",
  namespaces: ["prod"],
  workloads: over.workloads ?? [],
  claims: [],
  volumes: [],
  prometheus: "monitoring/prometheus:9090",
  lookbackHours: 168,
  warnings: over.warnings ?? [],
  advisories: { pods: over.pods ?? [], nodes: over.nodes, warnings: [] },
});
const advise = (inventory: ClusterInventory) => detectCluster(inventory, OPENCOST_DEFAULTS).advisories!;
const only = (inventory: ClusterInventory) => {
  const found = advise(inventory);
  assert.equal(found.length, 1, JSON.stringify(found.map((a) => a.title)));
  return found[0]!;
};

// 1. Out of memory

const killed = (over: Partial<ContainerFacts> = {}) =>
  container({ name: "job", memoryLimitBytes: 256 * MI, restartCount: 1, terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-03T11:00:00Z" }, ...over });

test("a container last killed for running out of memory is reported with which, when, its limit, and a limit to try", () => {
  const a = only(cluster({ pods: [pod({ containers: [killed()] })] }));
  assert.equal(a.rule, "out-of-memory");
  assert.deepEqual([a.kind, a.resource, a.namespace, a.container, a.countedInTotal], ["Deployment", "deployment/api", "prod", "job", false]);
  assert.equal(a.title, "Container job of deployment/api was killed for running out of memory");
  assert.deepEqual(a.evidence, [
    "Container job was last killed for running out of memory (reason OOMKilled, exit code 137) at 2026-10-03T11:00:00Z.",
    "Its memory limit is 256Mi",
    "It has restarted 1 time",
    "The over-requested rule already leaves this container's memory request alone while the kill is on the pod's record, so no finding asks for it to be lowered",
  ]);
  // The limit plus 25%: 256Mi x 1.25 = 320Mi.
  assert.equal(OOM_LIMIT_RAISE, 1.25);
  assert.deepEqual(a.suggestion!.commands, ["kubectl set resources deployment/api -n prod --context prod-cluster -c job --limits=memory=320Mi"]);
  assert.equal(a.suggestion!.risk, "caution");
  assert.match(a.suggestion!.rollback, /To go back: kubectl set resources deployment\/api -n prod --context prod-cluster -c job --limits=memory=256Mi\./);
  assert.match(a.advice, /the right one depends on the workload/);
  assert.equal(a.estimatedMonthlyUsd, undefined);
});

test("the raised limit is rounded up to the next 16Mi, and a Gi is written as one", () => {
  const raised = (limit: number) => only(cluster({ pods: [pod({ containers: [killed({ memoryLimitBytes: limit })] })] })).suggestion!.commands[0]!.split("--limits=memory=")[1];
  assert.equal(raised(100 * MI), "128Mi"); // 125Mi
  assert.equal(raised(500 * MI), "640Mi"); // 625Mi
  assert.equal(raised(1 * GI), "1280Mi"); // 1280Mi
  assert.equal(raised(3 * GI), "3840Mi"); // 3.75Gi
  assert.equal(raised(819 * MI), "1Gi"); // 1023.75Mi, up to 1024Mi, which is written as a whole Gi
});

test("a kill with no limit to build on, or a pod that no workload owns, gets no command", () => {
  const noLimit = only(cluster({ pods: [pod({ containers: [killed({ memoryLimitBytes: undefined })] })] }));
  assert.equal(noLimit.suggestion, undefined);
  assert.ok(noLimit.evidence.includes("It has no memory limit, so the kill came from the node running short of memory or from a limit set somewhere else"));
  assert.match(noLimit.advice, /memory request and limit/);

  const job = only(cluster({ pods: [pod({ name: "import-x7k2p", owner: { kind: "Job", name: "import" }, ownerIsWorkload: false, containers: [killed()] })] }));
  assert.deepEqual([job.kind, job.resource, job.suggestion], ["Job", "job/import", undefined]);
  assert.match(job.advice, /not part of a Deployment, StatefulSet or DaemonSet/);

  const bare = only(cluster({ pods: [pod({ name: "tool", owner: undefined, ownerIsWorkload: false, containers: [killed()] })] }));
  assert.deepEqual([bare.kind, bare.resource], ["Pod", "pod/tool"]);
});

test("pods of one workload that show the same kill are one advisory, with the latest time", () => {
  const a = only(
    cluster({
      pods: [
        pod({ name: "api-1", containers: [killed({ terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-03T09:00:00Z" }, restartCount: 2 })] }),
        pod({ name: "api-2", containers: [killed({ terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-03T11:30:00Z" }, restartCount: 4 })] }),
      ],
    }),
  );
  assert.match(a.evidence[0]!, /at 2026-10-03T11:30:00Z\. 2 of its pods show this\.$/);
  assert.equal(a.evidence[2], "It has restarted 4 times");
});

test("a stop for another reason, a labelled pod and a container that was never killed raise nothing", () => {
  const failed = container({ name: "job", terminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-03T11:00:00Z" } });
  assert.deepEqual(advise(cluster({ pods: [pod({ containers: [failed] }), pod({ name: "api-2", ignored: true, containers: [killed()] }), pod({ name: "api-3" })] })), []);
});

// 2. Restarting repeatedly

const stopped = (hoursBefore: number | undefined, over: Partial<NonNullable<ContainerFacts["terminated"]>> = {}): ContainerFacts["terminated"] => ({
  reason: "Error",
  exitCode: 1,
  ...(hoursBefore === undefined ? {} : { finishedAt: new Date(Date.parse("2026-10-03T12:00:00Z") - hoursBefore * 3_600_000).toISOString() }),
  ...over,
});

test("a container in CrashLoopBackOff is reported with its restart count, its last state and where to read why, and no fix", () => {
  const a = only(cluster({ pods: [pod({ containers: [container({ restartCount: 3, waitingReason: "CrashLoopBackOff", terminated: stopped(0.1, { exitCode: 2 }) })] })] }));
  assert.equal(a.rule, "restarting");
  assert.equal(a.title, "Container app of deployment/api keeps restarting");
  assert.deepEqual(a.evidence, [
    "Container app of pod api-7558c476b-9ngzv has restarted 3 times.",
    "It is in CrashLoopBackOff: Kubernetes is waiting longer and longer between its restarts",
    "Its last state was terminated: reason Error, exit code 2, at 2026-10-03T11:54:00.000Z",
  ]);
  assert.equal(a.suggestion, undefined);
  assert.match(a.advice, /kubectl logs api-7558c476b-9ngzv -n prod --context prod-cluster -c app --previous$/);
});

test("five restarts, the last within a day, is repeated restarting; four, or five long ago, is not", () => {
  assert.deepEqual([RESTART_COUNT, RESTART_WINDOW_HOURS], [5, 24]);
  const restarts = (count: number, last: ContainerFacts["terminated"]) => advise(cluster({ pods: [pod({ containers: [container({ restartCount: count, terminated: last })] })] }));
  const a = restarts(5, stopped(3))[0]!;
  assert.match(a.evidence[1]!, /^It has restarted at least 5 times, the last within 24 hours of the scan$/);
  assert.deepEqual(restarts(4, stopped(3)), [], "four is under the threshold");
  assert.deepEqual(restarts(12, stopped(72)), [], "twelve restarts, but the last was three days ago: it has settled");
  // The edge of the window: a day exactly is in, a second more is out.
  assert.equal(restarts(6, stopped(24)).length, 1);
  assert.deepEqual(restarts(6, stopped(24 + 1 / 3600)), []);
  // Where the pod does not say when, the count has to do, and the evidence says that is what it did.
  const unknown = restarts(7, stopped(undefined))[0]!;
  assert.match(unknown.evidence[1]!, /\(the pod does not say when it last stopped\)$/);
  assert.deepEqual(restarts(2, undefined), []);
  assert.deepEqual(advise(cluster({ pods: [pod({ ignored: true, containers: [container({ restartCount: 9, terminated: stopped(1) })] })] })), []);
});

test("of several pods restarting, the worst one is shown and the rest are counted", () => {
  const a = only(
    cluster({
      pods: [
        pod({ name: "api-1", containers: [container({ restartCount: 6, terminated: stopped(1) })] }),
        pod({ name: "api-2", containers: [container({ restartCount: 11, terminated: stopped(2) })] }),
      ],
    }),
  );
  assert.equal(a.evidence[0], "Container app of pod api-2 has restarted 11 times. 2 of its pods show this.");
});

test("where some pods of a group are looping, the pod the evidence names is one of those", () => {
  const a = only(
    cluster({
      pods: [
        pod({ name: "api-a", containers: [container({ restartCount: 3, waitingReason: "CrashLoopBackOff", terminated: stopped(0.5) })] }),
        pod({ name: "api-b", containers: [container({ restartCount: 9, terminated: stopped(1) })] }),
      ],
    }),
  );
  // api-b has restarted more, but it is not the one in CrashLoopBackOff, and the next line says it is.
  assert.equal(a.evidence[0], "Container app of pod api-a has restarted 3 times. 2 of its pods show this.");
  assert.equal(a.evidence[1], "It is in CrashLoopBackOff: Kubernetes is waiting longer and longer between its restarts");
  assert.match(a.advice, /kubectl logs api-a -n prod /);
});

test("a last stop the pod times in a way that cannot be read is not reported as within the window", () => {
  const a = only(cluster({ pods: [pod({ containers: [container({ restartCount: 7, terminated: { reason: "Error", exitCode: 1, finishedAt: "whenever" } })] })] }));
  assert.equal(a.evidence[1], "It has restarted at least 5 times (the time the pod gives for its last stop cannot be read, so the window was not checked)");
});

test("what the cluster says about a stop is made safe to print before it is read into an advisory", async () => {
  const reader: KubeReader = {
    identity: async () => ({ context: "prod-cluster" }),
    get: async (path) => {
      if (path.startsWith("/api/v1/namespaces?")) return { items: [{ metadata: { name: "prod" } }] };
      if (path.startsWith("/api/v1/pods?"))
        return {
          items: [
            {
              metadata: { name: "api-0", namespace: "prod", ownerReferences: [{ kind: "StatefulSet", name: "api", controller: true }] },
              spec: { containers: [{ name: "app" }] },
              status: {
                phase: "Running",
                containerStatuses: [{ name: "app", restartCount: 8, state: { waiting: { reason: "Crash\u001b[31mLoop" } }, lastState: { terminated: { reason: "Er\nror\u0007", exitCode: 1, finishedAt: "2026-10-03T11:00:00Z" } } }],
              },
            },
          ],
        };
      return { items: [] };
    },
  };
  const read = await collectCluster(reader, { lookbackHours: 1, now: new Date("2026-10-03T12:00:00Z") });
  const [a] = detectCluster(read, OPENCOST_DEFAULTS).advisories!.filter((x) => x.rule === "restarting");
  assert.ok(a);
  assert.doesNotMatch(JSON.stringify(a), /\\u001b|\\u0007|\\n/);
  assert.match(a.evidence[2]!, /^Its last state was terminated: reason Er ror, exit code 1, at 2026-10-03T11:00:00Z$/);
});

// 3. No requests

test("a workload container with no CPU or no memory request is reported once per workload, with no dollar figure", () => {
  const found = advise(
    cluster({
      workloads: [
        workload({ name: "both", containers: [{ name: "a", oomKilled: false }] }),
        workload({ name: "cpu", containers: [{ name: "a", memoryRequestBytes: 64 * MI, oomKilled: false }] }),
        workload({ name: "memory", kind: "StatefulSet", containers: [{ name: "a", cpuRequestCores: 0.1, oomKilled: false }] }),
        // A request of zero asks for nothing.
        workload({ name: "zero", kind: "DaemonSet", containers: [{ name: "a", cpuRequestCores: 0, memoryRequestBytes: 0, oomKilled: false }] }),
        workload({
          name: "two",
          containers: [
            { name: "main", cpuRequestCores: 0.1, memoryRequestBytes: 64 * MI, oomKilled: false },
            { name: "sidecar", memoryRequestBytes: 8 * MI, oomKilled: false },
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(found.map((a) => [a.rule, a.resource, a.title]), [
    ["no-requests", "daemonset/zero", "DaemonSet zero sets no CPU or memory request"],
    ["no-requests", "deployment/both", "Deployment both sets no CPU or memory request"],
    ["no-requests", "deployment/cpu", "Deployment cpu sets no CPU request"],
    ["no-requests", "deployment/two", "Deployment two sets no CPU request"],
    ["no-requests", "statefulset/memory", "StatefulSet memory sets no memory request"],
  ]);
  assert.deepEqual(found.find((a) => a.resource === "deployment/two")!.evidence, ["Container sidecar sets no CPU request"]);
  for (const a of found) {
    assert.match(a.advice, /^Without requests the scheduler cannot place the pods sensibly, and CloudPilot cannot judge whether they ask for too much\./);
    assert.deepEqual([a.estimatedMonthlyUsd, a.suggestion, a.countedInTotal], [undefined, undefined, false]);
    assert.doesNotMatch(JSON.stringify(a), /\$/);
  }
});

test("workloads that set both requests, and labelled ones, are left alone", () => {
  const set = { name: "a", cpuRequestCores: 0.1, memoryRequestBytes: 64 * MI, oomKilled: false };
  assert.deepEqual(advise(cluster({ workloads: [workload({ containers: [set] }), workload({ name: "kept", ignored: true, containers: [{ name: "a", oomKilled: false }] })] })), []);
});

// 4. Cannot be scheduled

const waiting = (over: Partial<NonNullable<PodFacts["unscheduled"]>> = {}) => ({
  reason: "Unschedulable",
  message: "0/3 nodes are available: 3 Insufficient cpu. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.",
  since: "2026-10-03T11:40:00Z",
  ...over,
});

test("a pod the scheduler cannot place is reported with the scheduler's own message", () => {
  const a = only(cluster({ pods: [pod({ phase: "Pending", unscheduled: waiting() })] }));
  assert.equal(a.rule, "unschedulable");
  assert.equal(a.title, "deployment/api cannot be scheduled");
  assert.deepEqual(a.evidence, [
    "Pod api-7558c476b-9ngzv is Pending, and its PodScheduled condition is False (reason Unschedulable).",
    'The scheduler says: "0/3 nodes are available: 3 Insufficient cpu. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod."',
    "Waiting since 2026-10-03T11:40:00Z",
  ]);
  assert.equal(a.suggestion, undefined);

  const two = only(cluster({ pods: [pod({ name: "api-1", phase: "Pending", unscheduled: waiting() }), pod({ name: "api-2", phase: "Pending", unscheduled: waiting({ since: "2026-10-03T11:20:00Z" }) })] }));
  assert.match(two.evidence[0]!, / 2 of its pods are waiting\.$/);
  assert.equal(two.evidence[2], "Waiting since 2026-10-03T11:20:00Z");
});

test("the scheduler's message is cut to a safe length and has no control characters", () => {
  const nasty = `0/3 nodes are available.\n\u001b[31mred\u001b[0m\t${"x".repeat(500)}`;
  const a = only(cluster({ pods: [pod({ phase: "Pending", unscheduled: waiting({ message: nasty }) })] }));
  const said = a.evidence[1]!;
  assert.doesNotMatch(said, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.doesNotMatch(said, /\n/);
  const quoted = said.slice('The scheduler says: "'.length, -1);
  assert.ok(quoted.length <= 240 && quoted.endsWith("..."), `${quoted.length}`);
  assert.equal(safeText("a\u0000b\nc", 10), "a b c");
});

test("a direction override or a zero-width mark in what the cluster says never reaches what is printed", () => {
  const trick = "0/3 nodes are available\u202e: the pod is fine\u202c\u200b.";
  const a = only(cluster({ pods: [pod({ phase: "Pending", unscheduled: waiting({ message: trick }) })] }));
  assert.equal(a.evidence[1], 'The scheduler says: "0/3 nodes are available : the pod is fine ."');
  assert.doesNotMatch(JSON.stringify(a), /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/);
  assert.equal(safeText("a\u202eb\u2066c\ufeffd"), "a b c d");
});

test("a pod that is pending for another reason, and running pods, are not unschedulable", async () => {
  const mk = (name: string, phase: string, conditions: object[]) => ({
    metadata: { name, namespace: "prod", ownerReferences: [{ kind: "StatefulSet", name: "db", controller: true }] },
    spec: { containers: [{ name: "db" }] },
    status: { phase, conditions },
  });
  const reader: KubeReader = {
    identity: async () => ({ context: "prod-cluster" }),
    get: async (path) => {
      if (path.startsWith("/api/v1/namespaces?")) return { items: [{ metadata: { name: "prod" } }] };
      if (path.startsWith("/api/v1/pods?"))
        return {
          items: [
            // Placed, and waiting for its image to be pulled: PodScheduled is True.
            mk("db-0", "Pending", [{ type: "PodScheduled", status: "True" }]),
            mk("db-1", "Running", [{ type: "PodScheduled", status: "True" }]),
            // PodScheduled False on a pod that is not Pending is not the scheduler failing.
            mk("db-2", "Running", [{ type: "PodScheduled", status: "False" }]),
            mk("db-3", "Pending", [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available: 1 Insufficient memory." }]),
          ],
        };
      if (path.startsWith("/api/v1/nodes?")) return { items: [] };
      return { items: [] };
    },
  };
  const read = await collectCluster(reader, { lookbackHours: 1, now: new Date("2026-10-03T12:00:00Z") });
  const found = detectCluster(read, OPENCOST_DEFAULTS).advisories!.filter((a) => a.rule === "unschedulable");
  assert.deepEqual(found.map((a) => [a.resource, a.evidence[0]]), [["statefulset/db", "Pod db-3 is Pending, and its PodScheduled condition is False (reason Unschedulable)."]]);
});

// 5. Spare node capacity

const spare = (inventory: ClusterInventory) => advise(inventory).find((a) => a.rule === "spare-node-capacity");

test("requests that would fit on fewer nodes: the arithmetic, the headroom, and what a node is worth at the scan's prices", () => {
  // Four nodes of 4 CPU and 16Gi. The pods request 2+1+0.5+0.5 = 4 CPU and 4+2+1+1 = 8Gi.
  const nodes = [
    node("n1", { requestedCpuCores: 2, requestedMemoryBytes: 4 * GI, pods: 4 }),
    node("n2", { requestedCpuCores: 1, requestedMemoryBytes: 2 * GI, pods: 2 }),
    node("n3", { requestedCpuCores: 0.5, requestedMemoryBytes: GI, pods: 1 }),
    node("n4", { requestedCpuCores: 0.5, requestedMemoryBytes: GI, pods: 1 }),
  ];
  const a = spare(cluster({ nodes }))!;
  assert.equal(HEADROOM_PCT, 80);
  // No node above 80%: 3.2 CPU and 12.8Gi per node. 4 / 3.2 = 1.25 -> 2 nodes by CPU; 8 / 12.8 = 0.63 -> 1 by memory. Two nodes, so two can go.
  assert.deepEqual(a.capacity, {
    headroomPct: 80,
    nodes: 4,
    excludedNodes: [],
    perNode: { cpuCores: 4, memoryBytes: 16 * GI },
    allocatable: { cpuCores: 16, memoryBytes: 64 * GI },
    now: { requestedCpuCores: 4, requestedMemoryBytes: 8 * GI, nodesNeeded: 2, removable: 2 },
    afterSuggestions: { requestedCpuCores: 4, requestedMemoryBytes: 8 * GI, nodesNeeded: 2, removable: 2 },
  });
  assert.equal(a.title, "The requests would fit on fewer nodes: up to 2 of 4 could be removed");
  // A node is worth (4 x $0.031611 + 16 x $0.004237) x 730 h = $141.79, and two of them $283.58.
  assert.equal(a.estimatedMonthlyUsd, 283.58);
  assert.equal(a.estimateBasis, "2 nodes x (4 CPU x $0.031611/vCPU-hour + 16 GiB x $0.004237/GiB-hour) x 730 h");
  assert.deepEqual([a.kind, a.resource, a.namespace, a.countedInTotal], ["Cluster", "cluster/prod-cluster", "(cluster)", false]);
  assert.deepEqual(a.evidence.slice(0, 3), [
    "4 nodes read; 4 can run ordinary workloads",
    "Requests of the pods on those 4: 4 CPU of 16 allocatable (25%), 8 GiB of memory of 64 GiB allocatable (13%)",
    "With no node above 80% of its allocatable CPU or memory, the requests as they are now would fit on 2 nodes, so up to 2 could be removed. The average node is 4 CPU and 16 GiB",
  ]);
  assert.ok(a.evidence.some((e) => /^This is an estimate by totals\. It ignores affinity and anti-affinity rules, taints and tolerations, the DaemonSet pod each node must run, pod disruption budgets/.test(e)));
  assert.ok(a.evidence.includes("Removing 2 nodes would be worth about $283.58 a month at this scan's prices (2 nodes x (4 CPU x $0.031611/vCPU-hour + 16 GiB x $0.004237/GiB-hour) x 730 h)"));
  // No findings: nothing else to count it twice with.
  assert.equal(a.evidence.at(-1), "That money is not added to the total");
  assert.equal(a.suggestion, undefined);
  assert.match(a.advice, /CloudPilot prints no command for it/);
});

test("control-plane, tainted and cordoned nodes are named and left out; one node, or no node to spare, raises nothing", () => {
  const busy = { requestedCpuCores: 0.5, requestedMemoryBytes: GI, pods: 1 };
  const nodes = [node("cp", { leftOut: "control-plane", requestedCpuCores: 3, requestedMemoryBytes: 8 * GI }), node("gpu", { leftOut: "tainted" }), node("drain", { leftOut: "cordoned" }), node("a", busy), node("b", busy), node("c", busy)];
  const a = spare(cluster({ nodes }))!;
  assert.deepEqual(a.capacity!.excludedNodes, ["cp", "gpu", "drain"]);
  assert.equal(a.capacity!.nodes, 3);
  assert.deepEqual(a.capacity!.allocatable, { cpuCores: 12, memoryBytes: 48 * GI });
  // The control plane's own requests are not the question.
  assert.equal(a.capacity!.now.requestedCpuCores, 1.5);
  assert.equal(a.evidence[0], "6 nodes read; 3 can run ordinary workloads. Left out: cp (control plane), gpu (tainted NoSchedule or NoExecute), drain (cordoned)");

  assert.equal(spare(cluster({ nodes: [node("only", busy)] })), undefined, "one node cannot be made fewer");
  assert.equal(spare(cluster({ nodes: [node("cp", { leftOut: "control-plane" }), node("a", busy)] })), undefined, "one that runs workloads, however many are left out");
  const full = { requestedCpuCores: 3, requestedMemoryBytes: 12 * GI, pods: 9 };
  assert.equal(spare(cluster({ nodes: [node("a", full), node("b", full)] })), undefined, "both are filled to the headroom: nothing to spare");
  assert.equal(spare(cluster({ nodes: undefined })), undefined, "no nodes read");
});

test("what the over-requested findings free turns 'none now' into 'one could go', and is counted only where the pods are", () => {
  // Two nodes of 4 CPU and 8Gi; 'api' has one pod on each, requesting 3 CPU and idle. The control plane runs a third pod of it.
  const api = workload({
    replicas: 3,
    nodes: { a: 1, b: 1, cp: 1 },
    containers: [{ name: "app", cpuRequestCores: 3, memoryRequestBytes: 64 * MI, cpuPeakCores: 0.001, memoryPeakBytes: 10 * MI, historyHours: 168, oomKilled: false }],
  });
  const inventory = cluster({
    workloads: [api],
    nodes: [
      node("a", { allocatableMemoryBytes: 8 * GI, requestedCpuCores: 3, requestedMemoryBytes: 64 * MI, pods: 1 }),
      node("b", { allocatableMemoryBytes: 8 * GI, requestedCpuCores: 3, requestedMemoryBytes: 64 * MI, pods: 1 }),
      node("cp", { leftOut: "control-plane", allocatableMemoryBytes: 8 * GI, requestedCpuCores: 3, requestedMemoryBytes: 64 * MI, pods: 1 }),
    ],
  });
  const result = detectCluster(inventory, OPENCOST_DEFAULTS);
  const a = result.advisories!.find((x) => x.rule === "spare-node-capacity")!;
  // Now: 6 CPU over two nodes of 3.2 usable CPU needs both. After: each of the two pods asks for 10m, so 0.02 CPU: one node does.
  assert.deepEqual([a.capacity!.now.requestedCpuCores, a.capacity!.now.removable], [6, 0]);
  assert.deepEqual([a.capacity!.afterSuggestions.requestedCpuCores, a.capacity!.afterSuggestions.nodesNeeded, a.capacity!.afterSuggestions.removable], [0.02, 1, 1]);
  assert.equal(a.title, "The requests would fit on fewer nodes: none of 2 could be removed now, up to 1 once the suggested requests are applied");
  assert.ok(a.evidence.some((e) => /^If the suggested requests of the over-requested findings were applied, the requests would be 0\.02 CPU and /.test(e)));
  assert.ok(a.evidence.includes("That money is not added to the total or to any finding: the over-requested findings already count the CPU and memory they free, and adding the two would count it twice"));
  // One node of 4 CPU and 8Gi is worth (4 x $0.031611 + 8 x $0.004237) x 730 h.
  assert.equal(a.estimatedMonthlyUsd, Number((((4 * 0.031611 + 8 * 0.004237) * 730)).toFixed(2)));
  // The money of the finding is its own, and the node's is not in it.
  assert.equal(result.findings.length, 1);
  assert.equal(result.totalMonthlyWasteUsd, result.findings[0]!.monthlyCostUsd);
  assert.notEqual(result.totalMonthlyWasteUsd, result.findings[0]!.monthlyCostUsd + a.estimatedMonthlyUsd!);
});

test("nodes that could not be read give one warning of their own, and every other result is as it was", async () => {
  const denied: KubeReader = {
    identity: async () => ({ context: lab.identity.context }),
    get: async (path) => {
      if (path.startsWith("/api/v1/nodes?")) throw new Error('Error from server (Forbidden): nodes is forbidden: User "alice" cannot list resource "nodes" in API group "" at the cluster scope');
      if (!(path in lab.responses)) throw new Error(`NotFound: ${path}`);
      return lab.responses[path];
    },
  };
  const options = { lookbackHours: lab.lookbackHours, now: new Date(lab.recordedAt) };
  const refused = detectCluster(await collectCluster(denied, options), OPENCOST_DEFAULTS);
  const plain = detectCluster(await collectCluster(readerOf(lab.responses), { ...options, advisories: false }), OPENCOST_DEFAULTS);
  assert.deepEqual(refused.advisoryWarnings, ['Spare node capacity could not be checked: the nodes could not be read: Error from server (Forbidden): nodes is forbidden: User "alice" cannot list resource "nodes" in API group "" at the cluster scope']);
  // The findings, the total and the warnings the findings depend on are exactly what a scan with no advisories gives.
  assert.deepEqual(refused.warnings, []);
  for (const key of ["findings", "totalMonthlyWasteUsd", "warnings", "skippedByTag", "regions"] as const) assert.deepEqual(refused[key], plain[key], key);
  // The advisories that need no nodes are still there.
  assert.deepEqual(refused.advisories!.map((a) => a.rule), ["out-of-memory", "no-requests"]);
  // The warning is shown with the others.
  assert.match(renderText(refused, { plain: true }), /1 check\(s\) could not run:\n {2}- Spare node capacity could not be checked: the nodes could not be read: Error from server \(Forbidden\)/);
});

test("--namespace cannot say what is spare, because a node is loaded by every namespace's pods, and says so without reading nodes", async () => {
  const asked: string[] = [];
  const reader: KubeReader = {
    identity: async () => ({ context: "prod" }),
    get: async (path) => {
      asked.push(path);
      if (path.includes("/proxy/")) throw new Error("no prometheus");
      return { items: [] };
    },
  };
  const read = await collectCluster(reader, { lookbackHours: 1, namespace: "shop" });
  assert.ok(!asked.some((p) => p.startsWith("/api/v1/nodes")));
  assert.match(read.advisories!.warnings[0]!, /^Spare node capacity was not checked: --namespace reads the pods of one namespace only/);
});

test("which nodes take part is read from role labels, taints and cordons, and each node is loaded by every namespace's pods", async () => {
  const mkNode = (name: string, extra: object = {}, labels: object = {}) => ({ metadata: { name, labels }, status: { allocatable: { cpu: "4", memory: "16Gi" } }, ...extra });
  const mkPod = (name: string, namespace: string, nodeName: string, phase: string, cpu: string, memory: string) => ({
    metadata: { name, namespace },
    spec: { nodeName, containers: [{ name: "c", resources: { requests: { cpu, memory } } }, { name: "d", resources: { requests: { cpu: "100m" } } }] },
    status: { phase },
  });
  const reader: KubeReader = {
    identity: async () => ({ context: "prod" }),
    get: async (path) => {
      if (path.startsWith("/api/v1/namespaces?")) return { items: [{ metadata: { name: "prod" } }, { metadata: { name: "kube-system" } }] };
      if (path.startsWith("/api/v1/nodes?"))
        return {
          items: [
            mkNode("w2"),
            mkNode("cp", {}, { "node-role.kubernetes.io/control-plane": "" }),
            mkNode("old", {}, { "node-role.kubernetes.io/master": "" }),
            mkNode("tainted", { spec: { taints: [{ key: "gpu", effect: "NoSchedule" }] } }),
            mkNode("prefer", { spec: { taints: [{ key: "spot", effect: "PreferNoSchedule" }] } }),
            mkNode("evict", { spec: { taints: [{ key: "x", effect: "NoExecute" }] } }),
            mkNode("drain", { spec: { unschedulable: true } }),
            { metadata: { name: "blank" }, status: {} },
          ],
        };
      if (path.startsWith("/api/v1/pods?"))
        return {
          items: [
            mkPod("a", "prod", "w2", "Running", "500m", "1Gi"),
            // The cluster's own namespace loads a node too, though its pods are not judged.
            mkPod("dns", "kube-system", "w2", "Running", "250m", "128Mi"),
            mkPod("done", "prod", "w2", "Succeeded", "4", "8Gi"),
            mkPod("unplaced", "prod", "", "Pending", "4", "8Gi"),
          ],
        };
      return { items: [] };
    },
  };
  const read = await collectCluster(reader, { lookbackHours: 1, now: new Date("2026-10-03T12:00:00Z") });
  const nodes = read.advisories!.nodes!;
  assert.deepEqual(nodes.map((n) => [n.name, n.leftOut ?? null]), [["cp", "control-plane"], ["drain", "cordoned"], ["evict", "tainted"], ["old", "control-plane"], ["prefer", null], ["tainted", "tainted"], ["w2", null]]);
  const w2 = nodes.find((n) => n.name === "w2")!;
  // 500m + 100m (second container) + 250m + 100m; finished and unplaced pods are not on the node.
  assert.deepEqual([w2.requestedCpuCores, w2.requestedMemoryBytes, w2.pods], [0.95, GI + 128 * MI, 2]);
  assert.match(read.advisories!.warnings[0]!, /^A node reported no allocatable CPU or memory and was left out of the spare node capacity check: blank$/);
});

// An advisory is not a finding.

const readerOf = (responses: Record<string, any>): KubeReader => ({
  identity: async () => lab.identity,
  get: async (path) => {
    if (!(path in responses)) throw new Error(`NotFound: ${path}`);
    return responses[path];
  },
});
const OPTIONS = { lookbackHours: lab.lookbackHours, now: new Date(lab.recordedAt) };

/** The lab's pods spread over three nodes of 2 CPU and 4Gi, so that the node arithmetic has something to say. */
function threeNodeLab() {
  const spread = structuredClone(lab.responses);
  const proto = spread["/api/v1/nodes?limit=500"].items[0];
  const names = ["worker-1", "worker-2", "worker-3"];
  spread["/api/v1/nodes?limit=500"].items = names.map((name) => ({ ...proto, metadata: { name, labels: { "kubernetes.io/hostname": name } }, status: { ...proto.status, allocatable: { cpu: "2", memory: "4Gi" } } }));
  spread["/api/v1/pods?limit=500"].items.forEach((p: any, i: number) => (p.spec.nodeName = names[i % 3]));
  return spread;
}

const scanOf = async (responses: Record<string, any>, advisories = true) => detectCluster(await collectCluster(readerOf(responses), { ...OPTIONS, advisories }), OPENCOST_DEFAULTS);
const labWith = await scanOf(lab.responses);
const labWithout = await scanOf(lab.responses, false);
const spread = await scanOf(threeNodeLab());

test("the lab fixture's own advisories: the OOM kill and the workload with no requests; its one node is the control plane", () => {
  assert.deepEqual(labWith.advisories!.map((a) => [a.rule, a.resource, a.namespace]), [
    ["out-of-memory", "deployment/importer", "shop"],
    ["no-requests", "deployment/local-path-provisioner", "local-path-storage"],
  ]);
  assert.deepEqual(labWith.advisoryWarnings, []);
  assert.equal(labWithout.advisories, undefined);
  assert.equal(labWithout.advisoryWarnings, undefined);
});

test("with advisories present, the findings, the total and everything the findings depend on are exactly as without them", () => {
  for (const withAdvisories of [labWith, spread]) {
    for (const key of ["findings", "totalMonthlyWasteUsd", "skippedByTag", "warnings", "regions", "accountId", "scannedAt", "prices", "cluster"] as const) {
      assert.deepEqual(withAdvisories[key], labWithout[key], key);
    }
  }
  assert.equal(labWith.findings.length, 5);
  assert.equal(labWith.totalMonthlyWasteUsd.toFixed(2), "50.64");
  // The one dollar figure among the advisories is not in the total, and adding it would show.
  const spareAdvisory = spread.advisories!.find((a) => a.rule === "spare-node-capacity")!;
  assert.equal(spareAdvisory.estimatedMonthlyUsd, 117.05);
  assert.equal(spread.totalMonthlyWasteUsd.toFixed(2), "50.64");
});

test("the worked example: the lab's pods on three 2-CPU 4Gi nodes", () => {
  const a = spread.advisories!.find((x) => x.rule === "spare-node-capacity")!;
  // Requests of the lab's pods in every namespace: 3.08 CPU and 3554Mi. Usable per node: 1.6 CPU, 3276.8Mi.
  assert.deepEqual(a.capacity!.now, { requestedCpuCores: 3.08, requestedMemoryBytes: 3554 * MI, nodesNeeded: 2, removable: 1 });
  // The findings free 980m (checkout) + 870m (reports) of CPU and 992Mi (search) + 1440Mi (reports) of memory.
  assert.deepEqual(a.capacity!.afterSuggestions, { requestedCpuCores: 1.23, requestedMemoryBytes: 1122 * MI, nodesNeeded: 1, removable: 2 });
  assert.equal(a.title, "The requests would fit on fewer nodes: up to 1 of 3 could be removed now, up to 2 once the suggested requests are applied");
  assert.equal(a.estimateBasis, "2 nodes x (2 CPU x $0.031611/vCPU-hour + 4 GiB x $0.004237/GiB-hour) x 730 h");
});

test("a comparison, the new-finding marks, the notice to a webhook, the summary and the lab's score ignore advisories", async () => {
  // Compared with an earlier scan that had other advisories, or none: the same comparison.
  const earlier = { ...labWithout, scannedAt: "2026-10-02T14:31:14.710Z" };
  const fewer = { ...labWith, findings: labWith.findings.slice(1), totalMonthlyWasteUsd: labWith.findings.slice(1).reduce((s, f) => s + f.monthlyCostUsd, 0) };
  for (const previous of [earlier, { ...earlier, advisories: spread.advisories }]) {
    const compared = compareScans(previous, labWith)!;
    const plain = compareScans({ ...previous, advisories: undefined }, labWithout)!;
    assert.deepEqual(compared.comparison, plain.comparison);
    assert.deepEqual(compared.findings, plain.findings);
  }
  assert.deepEqual(compareScans(labWith, fewer)!.comparison, compareScans(labWithout, { ...fewer, advisories: undefined })!.comparison);
  assert.equal(compareScans(labWith, fewer)!.comparison!.newCount, 0);
  assert.equal(carryForward(labWith, labWith).totalMonthlyWasteUsd, labWithout.totalMonthlyWasteUsd);

  // What a webhook is told, on every kind of target, and which findings are new.
  const compared = compareScans(earlier, labWith)!;
  for (const [result, base, firsts] of [[labWith, labWithout, [true]], [compared, compareScans(earlier, labWithout)!, [true, false]]] as const) {
    for (const first of firsts) {
      assert.deepEqual(freshFindings(result, first), freshFindings(base, first));
      for (const kind of ["slack", "discord", "generic"] as const) {
        assert.equal(compose({ kind: "findings", result, first }, { kind }), compose({ kind: "findings", result: base, first }, { kind }), kind);
      }
    }
  }
  const told = compose({ kind: "findings", result: spread, first: true }, { kind: "generic" });
  assert.doesNotMatch(told, /advisor|out-of-memory|spare-node|worth about|local-path-provisioner/i);

  assert.equal(templatedSummary(labWith), templatedSummary(labWithout));
  assert.equal(templatedSummary(spread), templatedSummary(labWithout));
  const evaluation = await evaluate(spread, ANSWER_KEY);
  assert.ok(evaluation.passed);
  assert.deepEqual(evaluation.extra, []);
  assert.deepEqual(evaluation.scores.map((s) => [s.id, s.found, s.costOk, s.fix]), [["KW1", true, true, "exact"], ["KW2", true, true, "exact"], ["KW3", true, true, "exact"], ["KW4", true, true, "exact"], ["KW5", true, true, "exact"]]);
});

test("an advisory has no field a finding is summed, compared, scored or announced by", () => {
  for (const a of spread.advisories!) {
    const keys = Object.keys(a);
    for (const forbidden of ["monthlyCostUsd", "costBasis", "pattern", "isNew", "region", "resourceIds", "resourceType", "fix", "alternative", "confidence"]) {
      assert.ok(!keys.includes(forbidden), `${a.rule} has ${forbidden}`);
    }
    assert.equal(a.countedInTotal, false);
    assert.ok(typeof a.title === "string" && typeof a.advice === "string" && Array.isArray(a.evidence));
  }
  // Only the spare node capacity has a figure, and it says it is an estimate that is not counted.
  assert.deepEqual(spread.advisories!.filter((a) => a.estimatedMonthlyUsd !== undefined).map((a) => a.rule), ["spare-node-capacity"]);
});

test("--upload sends what --json prints, advisories included, and they are in no total", () => {
  const body = scanJson(spread, "summary") as ScanResult & { summary: string };
  assert.equal(body.advisories!.length, 3);
  assert.equal(body.totalMonthlyWasteUsd, spread.totalMonthlyWasteUsd);
  assert.deepEqual(JSON.parse(JSON.stringify(body)).advisories, JSON.parse(JSON.stringify(spread.advisories)));
});

// What the model is told.

test("the model is told what an advisory is, may mention it as a fact, and is never given its figure as waste", () => {
  const rules = groundRules(spread);
  assert.match(rules, /The scan may also hold advisories: things for a person to look at that are NOT waste\./);
  assert.match(rules, /Never call an advisory waste, never add its figure to the total, and never present a dollar figure in an advisory \(estimatedMonthlyUsd\) as waste or as a saving/);
  assert.match(rules, /An advisoryWarnings entry means a check that only the advisories need could not run/);
  assert.doesNotMatch(groundRules({ cluster: undefined }), /advisories/i, "an account's rules do not mention them");

  const modelView = forModel(spread) as any;
  const spareView = modelView.advisories.find((a: Advisory) => a.rule === "spare-node-capacity");
  assert.equal(spareView.estimatedMonthlyUsd, "$117.05");
  assert.equal(spareView.capacity, undefined, "raw capacity numbers stay out; the evidence has them in words");
  assert.equal(modelView.totalMonthlyWasteUsd, "$50.64");
  assert.match(summaryRequest(spread), /The scan also has advisories: things to look at that are not waste\./);
  assert.doesNotMatch(summaryRequest(labWithout), /advisories/i, "a scan with none is asked for exactly what it was before");
});

// The output check.

test("text about advisories is accepted when it repeats the scan, and still discarded when it invents", async () => {
  const inventory = await collectCluster(readerOf(threeNodeLab()), OPTIONS);
  const known = allowedValues(spread);
  const knownWithLookups = allowedValues(spread, { cluster: inventory });
  const without = allowedValues(labWithout);

  const good = [
    "Also look at shop/deployment/importer: it was killed for running out of memory, and its limit is 256Mi.",
    "kubectl set resources deployment/importer -n shop --context kind-cloudpilot-lab -c job --limits=memory=320Mi",
    "Removing 2 nodes is worth about $117.05 a month at this scan's prices, and is not in the $50.64 total.",
    "local-path-storage/deployment/local-path-provisioner sets no request.",
  ].join("\n");
  assert.deepEqual(unsupportedValues(good, known), []);
  assert.deepEqual(unsupportedValues(good, knownWithLookups), []);
  // Without the advisories in the scan, the same sentences name things the scan never said.
  for (const unknown of ["$117.05", "shop/deployment/importer", "local-path-storage/deployment/local-path-provisioner", "320Mi"]) assert.ok(unsupportedValues(good, without).includes(unknown), unknown);

  // Invented figures and objects, in the same sections, are still thrown out.
  assert.deepEqual(unsupportedValues("Removing 2 nodes is worth about $117.06 a month.", known), ["$117.06"]);
  assert.deepEqual(unsupportedValues("Removing 3 nodes is worth $175.58.", known), ["$175.58"]);
  assert.deepEqual(unsupportedValues("Raise it to 384Mi.", known), ["384Mi"]);
  assert.deepEqual(unsupportedValues("Look at shop/deployment/ghost and payments/deployment/importer.", known), ["shop/deployment/ghost", "payments/deployment/importer"]);
  assert.deepEqual(unsupportedValues("Run kubectl get pods -n payments --context prod-eu", known), ["-n payments", "--context prod-eu"]);
});

// The reports.

test("the text report lists advisories after the findings and before the warnings, under their own heading, and the headline is unchanged", () => {
  const text = renderText(spread, { plain: true });
  assert.match(text, /^5 findings, \$50\.64 per month of estimated waste$/m);
  const at = (needle: string) => text.indexOf(needle);
  assert.ok(at("CloudPilot is read-only: it prints these commands and never runs them.") < at("Also worth a look (not counted as waste)"));
  assert.ok(at("Also worth a look (not counted as waste)") < at("1 resource was skipped because of the label"));
  assert.match(text, /\nAlso worth a look \(not counted as waste\)\nThese are things to look at, not waste\. None of them is in the \$50\.64 total above, none is compared with the last scan, and no figure here adds to that total\.\n/);
  assert.match(text, /^ 3\. The requests would fit on fewer nodes: up to 1 of 3 could be removed now, up to 2 once the suggested requests are applied$/m);
  assert.match(text, /^ {4}Cluster {2}cluster\/kind-cloudpilot-lab {2}rule spare-node-capacity$/m);
  assert.match(text, /^ {4}suggestion \(CAUTION - review before running\):\n {6}kubectl set resources deployment\/importer -n shop --context kind-cloudpilot-lab -c job --limits=memory=320Mi$/m);
  assert.match(text, /^ {4}what to do: Lowering requests does not remove a node\./m);
  // A scan with no advisories has no such section.
  assert.doesNotMatch(renderText(labWithout, { plain: true }), /Also worth a look/);
});

test("--only-new cuts the findings and not the advisories, which are not compared", () => {
  const earlier = { ...labWithout, scannedAt: "2026-10-02T14:31:14.710Z" };
  const compared = compareScans(earlier, spread)!;
  const text = renderText(compared, { plain: true, onlyNew: true });
  assert.match(text, /Nothing new since the last scan; the 5 findings already reported are not listed\./);
  assert.match(text, /Also worth a look \(not counted as waste\)/);
  assert.match(text, /^ 1\. Container job of deployment\/importer was killed for running out of memory$/m);
});

test("with no waste at all the advisories still have their section, and the headline still says no waste", () => {
  const none = { ...spread, findings: [], totalMonthlyWasteUsd: 0, skippedByTag: [] };
  const text = renderText(none, { plain: true });
  assert.match(text, /^No waste found\.$/m);
  assert.match(text, /None of them is in the \$0\.00 total above/);
  assert.match(text, /^Also worth a look \(not counted as waste\)$/m);
});

test("Markdown and plain-text reports carry the section too, without colour codes", () => {
  const md = renderMarkdown(spread, "A summary.");
  assert.match(md, /\n## Also worth a look \(not counted as waste\)\n\nThese are things to look at, not waste\./);
  assert.match(md, /\n### 1\. Container job of deployment\/importer was killed for running out of memory\n/);
  assert.match(md, /- \*\*Suggestion\*\* \(CAUTION - review before running\):\n\n```sh\nkubectl set resources deployment\/importer -n shop --context kind-cloudpilot-lab -c job --limits=memory=320Mi\n```/);
  // The findings table is still five rows.
  assert.equal(md.split("\n").filter((l) => /^\| \d+ \| \$/.test(l)).length, 5);
  assert.ok(md.indexOf("## 5.") < md.indexOf("## Also worth a look"));
  const plain = renderPlainText(spread, "A summary.");
  assert.match(plain, /Also worth a look \(not counted as waste\)/);
  assert.doesNotMatch(plain, /\u001b\[/);
});

test("the HTML report lists them in a section of their own, with no tick box, and the script and the saving are untouched", () => {
  const withIt = new JSDOM(renderHtml(spread, { summary: "S." }), { runScripts: "dangerously" }).window.document;
  const without = new JSDOM(renderHtml(labWithout, { summary: "S." }), { runScripts: "dangerously" }).window.document;
  const section = withIt.querySelector("section.advisories")!;
  assert.equal(section.querySelector("h2")!.textContent, "Also worth a look (not counted as waste)");
  assert.equal(section.querySelectorAll("article.advisory").length, 3);
  assert.equal(section.querySelectorAll("input, button").length, 0, "no tick box and nothing to press");
  assert.ok(section.textContent!.includes("kubectl set resources deployment/importer -n shop --context kind-cloudpilot-lab -c job --limits=memory=320Mi"));
  // The same boxes, saving and script as a report with no advisories.
  assert.equal(withIt.querySelectorAll("input[type=checkbox]").length, without.querySelectorAll("input[type=checkbox]").length);
  assert.equal(withIt.getElementById("script-text")!.textContent, without.getElementById("script-text")!.textContent);
  assert.ok(!withIt.getElementById("script-text")!.textContent!.includes("--limits"));
  assert.equal(withIt.querySelector(".bar p")!.textContent, without.querySelector(".bar p")!.textContent);
  assert.equal(withIt.querySelector("h1")!.textContent, without.querySelector("h1")!.textContent);
  // After the script, before the end of the statement.
  assert.ok(withIt.getElementById("script")!.compareDocumentPosition(section) & 4);
  assert.ok(section.compareDocumentPosition(withIt.querySelector(".notes")!) & 4);
  assert.equal(without.querySelector("section.advisories"), null);

  // Whatever the cluster said is text, never markup.
  const hostile = { ...spread, advisories: [{ ...spread.advisories![0]!, title: "<img src=x onerror=alert(1)>", evidence: ['<script>alert("x")</script>'] }] };
  const html = renderHtml(hostile);
  assert.ok(!html.includes("<img src=x") && !html.includes('<script>alert("x")'));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  // Only advisories, no findings: no script and no bar to put it in.
  const alone = new JSDOM(renderHtml({ ...spread, findings: [], totalMonthlyWasteUsd: 0 })).window.document;
  assert.equal(alone.querySelector("h1")!.textContent, "No waste found.");
  assert.equal(alone.getElementById("script"), null);
  assert.equal(alone.querySelectorAll("article.advisory").length, 3);
});

// The roles that let it read.

test("the documented role and the manifest's role both allow listing nodes, and only listing", () => {
  const root = resolve(here, "../../..");
  for (const file of ["docs/cloudpilot-kube-readonly.yaml", "deploy/kube-watch.yaml"]) {
    const role = parseAllDocuments(readFileSync(resolve(root, file), "utf8")).map((d) => d.toJS()).find((d) => d.kind === "ClusterRole");
    const rule = role.rules.find((r: { resources: string[] }) => r.resources.includes("nodes"));
    assert.deepEqual(rule.verbs, ["list"], file);
    assert.deepEqual(rule.apiGroups, [""], file);
  }
});
