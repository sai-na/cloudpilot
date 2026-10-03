/**
 * The Kubernetes scan, offline. test/fixtures/kube-lab.json holds what the
 * waste lab's API server and Prometheus really answered (see
 * test/kube-lab/record-fixture.ts), so these tests read a real cluster's
 * answers without needing one.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { compareScans } from "../src/compare.js";
import { evaluate } from "../src/evaluate.js";
import { collectCluster, kubectlReader, parseBytes, parseCpu, parsePrometheusRef, type ClusterInventory, type KubeReader, type Workload } from "../src/kube.js";
import { cpuQuantity, detectCluster, hours, memoryQuantity, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { renderHtml } from "../src/html.js";
import { templatedSummary } from "../src/report.js";
import { cli, fakeKubectl } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/kube-lab.json");
const ANSWER_KEY = resolve(here, "../../../k8s-lab/answer-key.json");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  recordedAt: string;
  identity: { context: string; server: string };
  lookbackHours: number;
  responses: Record<string, unknown>;
};

/** The recorded lab, behind the same interface the real kubectl reader has. */
function recorded(asked: string[] = []): KubeReader {
  return {
    identity: async () => fixture.identity,
    get: async (path) => {
      asked.push(path);
      if (!(path in fixture.responses)) throw new Error(`Error from server (NotFound): ${path}`);
      return fixture.responses[path];
    },
  };
}

const readLab = () => collectCluster(recorded(), { lookbackHours: fixture.lookbackHours, now: new Date(fixture.recordedAt) });

test("the recorded lab is read as it was seeded", async () => {
  const lab = await readLab();
  assert.equal(lab.context, "kind-cloudpilot-lab");
  assert.equal(lab.prometheus, "monitoring/prometheus:9090");
  assert.ok(!lab.namespaces.includes("kube-system"), "the cluster's own namespaces are not the reader's to resize");
  assert.deepEqual(lab.warnings, []);

  const workload = (name: string) => lab.workloads.find((w) => w.name === name)!;
  assert.deepEqual(
    lab.workloads.filter((w) => w.namespace === "shop").map((w) => [w.name, w.kind, w.replicas]),
    [["checkout", "Deployment", 2], ["importer", "Deployment", 1], ["reports", "Deployment", 3], ["search", "Deployment", 1], ["web", "Deployment", 1]],
  );
  const api = workload("checkout").containers[0]!;
  assert.equal(api.cpuRequestCores, 0.5);
  assert.equal(api.memoryRequestBytes, 64 * 2 ** 20);
  assert.ok(api.memoryPeakBytes! > 48 * 2 ** 20 && api.memoryPeakBytes! < 50 * 2 ** 20, "it holds the 48 MiB it was seeded with");
  assert.ok(api.cpuPeakCores! < 0.005);
  assert.ok(workload("web").containers[0]!.cpuPeakCores! > 0.09, "the control really uses its CPU");
  assert.equal(workload("importer").containers[0]!.oomKilled, true, "the kill is read from the pod's record");
  assert.equal(workload("prometheus").ignored, true, "a label on the Deployment counts, though its pods do not carry it");

  // The job that wrote to the claim has finished: a finished pod mounts nothing.
  const claim = lab.claims.find((c) => c.name === "old-exports")!;
  assert.deepEqual([claim.phase, claim.mountedBy, claim.reclaimPolicy, claim.capacityBytes], ["Bound", [], "Delete", 5 * 2 ** 30]);
  assert.equal(lab.volumes.find((v) => v.name === "archive-2025")!.phase, "Released");
});

test("the rules find exactly what the lab's answer key says, at its prices and with its commands", async () => {
  const result = detectCluster(await readLab(), OPENCOST_DEFAULTS);
  const evaluation = await evaluate(result, ANSWER_KEY);
  assert.deepEqual(evaluation.scores.map((s) => [s.id, s.found, s.costOk, s.fix]), [
    ["KW1", true, true, "exact"],
    ["KW2", true, true, "exact"],
    ["KW3", true, true, "exact"],
    ["KW4", true, true, "exact"],
    ["KW5", true, true, "exact"],
  ]);
  assert.deepEqual(evaluation.extra, [], "the right-sized workload and the one killed for memory are left alone");
  assert.ok(evaluation.passed);

  assert.deepEqual(result.skippedByTag, ["monitoring/deployment/prometheus"]);
  assert.equal(result.accountId, "kind-cloudpilot-lab");
  assert.equal(result.cluster!.prometheus, "monitoring/prometheus:9090");
  assert.ok(result.findings.every((f) => f.region === "shop"));
  // A few minutes of history is a hint, and the finding says so.
  const reports = result.findings.find((f) => f.resourceIds[0] === "deployment/reports")!;
  assert.equal(reports.confidence, 0.4);
  assert.ok(reports.evidence.some((e) => /^Prometheus holds \d+ minutes of history for it, of the 1 hour asked for$/.test(e)), reports.evidence.join("\n"));
});

test("reading a cluster only ever asks the API server to GET lists and Prometheus queries", async () => {
  const asked: string[] = [];
  await collectCluster(recorded(asked), { lookbackHours: fixture.lookbackHours, now: new Date(fixture.recordedAt) });
  const kinds = asked.map((path) => path.replace(/\?.*$/, "").replace(/^.*\/proxy\//, "prometheus:"));
  assert.deepEqual([...new Set(kinds)].sort(), [
    "/api/v1/namespaces",
    "/api/v1/persistentvolumeclaims",
    "/api/v1/persistentvolumes",
    "/api/v1/pods",
    "/api/v1/services",
    "/apis/apps/v1/deployments",
    "/apis/apps/v1/replicasets",
    "prometheus:api/v1/query",
  ]);
});

// The rules on their own, over hand-built inventories.

const MI = 2 ** 20;
const workload = (over: Partial<Workload> & { containers: Workload["containers"] }): Workload => ({ kind: "Deployment", name: "api", namespace: "prod", replicas: 1, ignored: false, ...over });
const inventory = (over: Partial<ClusterInventory>): ClusterInventory => ({
  context: "prod-cluster",
  collectedAt: "2026-10-03T00:00:00Z",
  namespaces: ["prod"],
  workloads: [],
  claims: [],
  volumes: [],
  prometheus: "monitoring/prometheus:9090",
  lookbackHours: 168,
  warnings: [],
  ...over,
});
const idle = { cpuPeakCores: 0.001, memoryPeakBytes: 10 * MI, historyHours: 168, oomKilled: false };

test("a container killed for running out of memory never has its memory request lowered", () => {
  const killed = { name: "app", cpuRequestCores: 0.01, memoryRequestBytes: 1024 * MI, ...idle, oomKilled: true };
  assert.deepEqual(detectCluster(inventory({ workloads: [workload({ containers: [killed] })] }), OPENCOST_DEFAULTS).findings, []);

  // Its CPU can still come down, and the finding says why memory was left alone.
  const [finding] = detectCluster(inventory({ workloads: [workload({ containers: [{ ...killed, cpuRequestCores: 2 }] })] }), OPENCOST_DEFAULTS).findings;
  assert.deepEqual(finding!.fix.commands, ["kubectl set resources deployment/api -n prod --context prod-cluster -c app --requests=cpu=10m"]);
  assert.ok(finding!.evidence.includes("Container app has been killed for running out of memory, so its memory request is left alone"));
});

test("the suggestion is the peak plus headroom, and small differences are not worth a restart", () => {
  const busy = { name: "app", cpuRequestCores: 4, memoryRequestBytes: 8192 * MI, cpuPeakCores: 0.3, memoryPeakBytes: 800 * MI, historyHours: 168, oomKilled: false };
  const [finding] = detectCluster(inventory({ workloads: [workload({ replicas: 50, containers: [busy] })] }), OPENCOST_DEFAULTS).findings;
  // 0.3 x 1.15 = 0.345, rounded up to 350m; 800Mi x 1.15 = 920Mi, rounded up to 928Mi.
  assert.deepEqual(finding!.fix.commands, ["kubectl set resources deployment/api -n prod --context prod-cluster -c app --requests=cpu=350m,memory=928Mi"]);
  assert.match(finding!.fix.rollback, /To go back: kubectl set resources deployment\/api -n prod --context prod-cluster -c app --requests=cpu=4,memory=8Gi\./);
  const expected = 50 * ((4 - 0.35) * 0.031611 + ((8192 - 928) / 1024) * 0.004237) * 730;
  assert.ok(Math.abs(finding!.monthlyCostUsd - expected) < 1e-6);
  assert.equal(finding!.confidence, 0.9);
  assert.equal(finding!.fix.risk, "caution");

  // 20m against a 10m suggestion is twice over, but 10m is not worth restarting pods for.
  const small = { name: "app", cpuRequestCores: 0.02, memoryRequestBytes: 90 * MI, ...idle };
  assert.deepEqual(detectCluster(inventory({ workloads: [workload({ containers: [small] })] }), OPENCOST_DEFAULTS).findings, []);
  // Using most of what it asks for.
  const fitted = { name: "app", cpuRequestCores: 1, memoryRequestBytes: 1024 * MI, cpuPeakCores: 0.6, memoryPeakBytes: 700 * MI, historyHours: 168, oomKilled: false };
  assert.deepEqual(detectCluster(inventory({ workloads: [workload({ containers: [fitted] })] }), OPENCOST_DEFAULTS).findings, []);
});

test("a workload with too little history, or none, is not judged, and the scan says which", () => {
  const fresh = workload({ name: "new", containers: [{ name: "app", cpuRequestCores: 2, memoryRequestBytes: 2048 * MI, ...idle, historyHours: 0.05 }] });
  const unseen = workload({ name: "unseen", containers: [{ name: "app", cpuRequestCores: 2, memoryRequestBytes: 2048 * MI, oomKilled: false }] });
  const result = detectCluster(inventory({ workloads: [fresh, unseen] }), OPENCOST_DEFAULTS);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings, ["2 workloads have under five minutes of usage history in Prometheus and were not judged: prod/new, prod/unseen"]);

  // With no Prometheus the reader has already said so once; it is not repeated per workload.
  const blind = detectCluster(inventory({ workloads: [unseen], prometheus: undefined, warnings: ["No Prometheus service was found in the cluster."] }), OPENCOST_DEFAULTS);
  assert.deepEqual(blind.warnings, ["No Prometheus service was found in the cluster."]);
});

test("a workload is only called unjudged when no container of it could be judged", () => {
  // The sidecar has no series in Prometheus; the main container has a week of history.
  const mixed = workload({
    containers: [
      { name: "app", cpuRequestCores: 2, memoryRequestBytes: 2048 * MI, ...idle },
      { name: "envoy", cpuRequestCores: 1, memoryRequestBytes: 512 * MI, oomKilled: false },
    ],
  });
  const result = detectCluster(inventory({ workloads: [mixed] }), OPENCOST_DEFAULTS);
  assert.deepEqual(result.findings.map((f) => f.resourceIds), [["deployment/api"]]);
  assert.deepEqual(result.findings[0]!.fix.commands, ["kubectl set resources deployment/api -n prod --context prod-cluster -c app --requests=cpu=10m,memory=32Mi"]);
  assert.deepEqual(result.warnings, []);
});

test("each over-requested container of a workload gets its own command, in one finding", () => {
  const two = workload({
    kind: "StatefulSet",
    name: "db",
    containers: [
      { name: "postgres", cpuRequestCores: 2, memoryRequestBytes: 4096 * MI, ...idle },
      { name: "exporter", cpuRequestCores: 0.5, memoryRequestBytes: 64 * MI, ...idle },
    ],
  });
  const result = detectCluster(inventory({ workloads: [two] }), OPENCOST_DEFAULTS);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0]!.resourceIds, ["statefulset/db"]);
  assert.deepEqual(result.findings[0]!.fix.commands, [
    "kubectl set resources statefulset/db -n prod --context prod-cluster -c postgres --requests=cpu=10m,memory=32Mi",
    "kubectl set resources statefulset/db -n prod --context prod-cluster -c exporter --requests=cpu=10m",
  ]);
});

test("your own prices replace the defaults, and the report says where its prices came from", () => {
  const over = workload({ containers: [{ name: "app", cpuRequestCores: 1.01, memoryRequestBytes: 64 * MI, ...idle }] });
  const claim = { name: "data", namespace: "prod", phase: "Bound", capacityBytes: 100 * 2 ** 30, volumeName: "pv-1", reclaimPolicy: "Retain", mountedBy: [], ignored: false };
  const mine = { source: "command-line" as const, cpuHourUsd: 0.05, memoryGibHourUsd: 0.01, storageGibMonthUsd: 0.1 };
  const result = detectCluster(inventory({ workloads: [over], claims: [claim] }), mine);
  assert.deepEqual(result.findings.map((f) => [f.pattern, Number(f.monthlyCostUsd.toFixed(2))]), [["over-requested-workload", 36.5], ["unused-volume-claim", 10]]);
  assert.equal(result.prices.source, "command-line");
  assert.match(result.findings[1]!.fix.rollback, /reclaim policy is Retain, so deleting the claim leaves the volume/);
});

test("a claim still waiting for a volume, a mounted one and a labelled one are not findings", () => {
  const base = { namespace: "prod", capacityBytes: 2 ** 30, volumeName: "pv-1", reclaimPolicy: "Delete" };
  const result = detectCluster(
    inventory({
      claims: [
        { ...base, name: "pending", phase: "Pending", mountedBy: [], ignored: false },
        { ...base, name: "in-use", phase: "Bound", mountedBy: ["api-0"], ignored: false },
        { ...base, name: "kept-on-purpose", phase: "Bound", mountedBy: [], ignored: true },
      ],
      volumes: [{ name: "ready", phase: "Available", capacityBytes: 2 ** 30, ignored: false }],
    }),
    OPENCOST_DEFAULTS,
  );
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.skippedByTag, ["prod/persistentvolumeclaim/kept-on-purpose"]);
});

test("a Released volume charged to a namespace outside the ones read is still counted as one", () => {
  const result = detectCluster(
    inventory({
      namespaces: ["default"],
      volumes: [{ name: "archive", phase: "Released", capacityBytes: 50 * 2 ** 30, reclaimPolicy: "Retain", claim: { namespace: "old", name: "data" }, ignored: false }],
    }),
    OPENCOST_DEFAULTS,
  );
  assert.deepEqual(result.findings.map((f) => f.region), ["old"]);
  assert.deepEqual(result.regions, ["default", "old"]);
  // The summary must not put the finding in default, the one namespace read for workloads.
  const summary = templatedSummary(result);
  assert.match(summary, /across 1 finding in 1 of the 2 namespaces scanned\./);
  assert.match(summary, /- old: 1 finding/);
  assert.match(summary, /- 1 other namespace: nothing found\./);
});

test("a claim whose volume could not be read does not promise what deleting it does", () => {
  const unread = { name: "data", namespace: "prod", phase: "Bound", capacityBytes: 2 ** 30, volumeName: "pv-1", mountedBy: [], ignored: false };
  const warning = "PersistentVolumes could not be read: persistentvolumes is forbidden";
  const [finding] = detectCluster(inventory({ claims: [unread], warnings: [warning] }), OPENCOST_DEFAULTS).findings;
  assert.doesNotMatch(finding!.fix.rollback, /reclaim policy Delete/);
  assert.match(finding!.fix.rollback, /reclaim policy could not be read/);
  assert.match(finding!.fix.rollback, /kubectl get persistentvolume pv-1 --context prod-cluster/);
});

test("a failed read in the cluster means nothing is called resolved", () => {
  const over = workload({ containers: [{ name: "app", cpuRequestCores: 2, memoryRequestBytes: 64 * MI, ...idle }] });
  const before = detectCluster(inventory({ workloads: [over] }), OPENCOST_DEFAULTS);
  // The next day Prometheus cannot be reached: the workload is still over-requested, it just could not be judged.
  const blind = detectCluster(
    inventory({ collectedAt: "2026-10-04T00:00:00Z", workloads: [workload({ containers: [{ name: "app", cpuRequestCores: 2, memoryRequestBytes: 64 * MI, oomKilled: false }] })], prometheus: undefined, warnings: ["Prometheus could not be queried."] }),
    OPENCOST_DEFAULTS,
  );
  assert.deepEqual(compareScans(before, blind)!.comparison!.resolved, []);
  // Read in full and really gone: resolved.
  const fixed = detectCluster(inventory({ collectedAt: "2026-10-04T00:00:00Z" }), OPENCOST_DEFAULTS);
  assert.equal(compareScans(before, fixed)!.comparison!.resolved.length, 1);
});

test("usage of pods that are already gone still counts towards their workload's peak", async () => {
  const pod = (name: string, owner: string) => ({
    metadata: { name, namespace: "prod", ownerReferences: [{ kind: "ReplicaSet", name: owner, controller: true }] },
    spec: { containers: [{ name: "app", resources: { requests: { cpu: "2", memory: "2Gi" } } }] },
    status: { phase: "Running" },
  });
  const series = (pods: Record<string, number>) => ({ status: "success", data: { result: Object.entries(pods).map(([p, value]) => ({ metric: { namespace: "prod", pod: p, container: "app" }, value: [0, String(value)] })) } });
  const now = new Date("2026-10-03T00:00:00Z");
  const reader: KubeReader = {
    identity: async () => ({ context: "prod-cluster" }),
    get: async (path) => {
      if (path.startsWith("/api/v1/namespaces?")) return { items: [{ metadata: { name: "prod" } }] };
      if (path.startsWith("/api/v1/pods?")) return { items: [pod("api-7558c476b-9ngzv", "api-7558c476b")] };
      if (path.startsWith("/apis/apps/v1/replicasets?")) return { items: [{ metadata: { name: "api-7558c476b", namespace: "prod", ownerReferences: [{ kind: "Deployment", name: "api" }] } }] };
      if (path.startsWith("/apis/apps/v1/deployments?")) return { items: [{ metadata: { name: "api", namespace: "prod" } }] };
      if (path.startsWith("/api/v1/services?")) return { items: [{ metadata: { name: "prometheus-server", namespace: "obs" }, spec: { ports: [{ name: "http", port: 80 }] } }] };
      if (path.includes("/proxy/")) {
        assert.ok(path.startsWith("/api/v1/namespaces/obs/services/prometheus-server:80/proxy/api/v1/query?query="), path);
        const promql = decodeURIComponent(path.split("query=")[1]!);
        // Yesterday's pod, from before a deploy, was the busy one. A pod of another workload with a similar name is not this one's.
        if (promql.includes("container_cpu_usage_seconds_total")) return series({ "api-7558c476b-9ngzv": 0.1, "api-6596b7f877-k6gnp": 1.4, "api-gateway-5b98cdc95b-j6b8f": 3 });
        if (promql.includes("timestamp(")) return series({ "api-7558c476b-9ngzv": now.getTime() / 1000 - 3600, "api-6596b7f877-k6gnp": now.getTime() / 1000 - 100 * 3600 });
        return series({ "api-7558c476b-9ngzv": 300 * MI, "api-6596b7f877-k6gnp": 1500 * MI });
      }
      return { items: [] };
    },
  };
  const read = await collectCluster(reader, { lookbackHours: 168, now });
  assert.equal(read.prometheus, "obs/prometheus-server:80");
  const app = read.workloads[0]!.containers[0]!;
  assert.deepEqual([app.cpuPeakCores, app.memoryPeakBytes, app.historyHours], [1.4, 1500 * MI, 100]);
  // 1.4 cores at peak leaves the 2-core request as it is; nothing to change.
  assert.deepEqual(detectCluster(read, OPENCOST_DEFAULTS).findings, []);
});

test("quantities are read and written the way Kubernetes writes them", () => {
  assert.deepEqual(["500m", "2", "0.25", "1k", undefined, "lots"].map(parseCpu), [0.5, 2, 0.25, 1000, undefined, undefined]);
  assert.deepEqual(["64Mi", "1Gi", "1G", "128974848", "129e6"].map(parseBytes), [64 * MI, 2 ** 30, 1e9, 128974848, 129e6]);
  assert.deepEqual([0.5, 2, 0.01, 1.5].map(cpuQuantity), ["500m", "2", "10m", "1500m"]);
  assert.deepEqual([64 * MI, 2 ** 30, 1536 * MI].map(memoryQuantity), ["64Mi", "1Gi", "1536Mi"]);
  assert.deepEqual([0.1, 1 / 60, 1, 7.5, 168].map(hours), ["6 minutes", "1 minute", "1 hour", "7.5 hours", "168 hours"]);
  assert.deepEqual(parsePrometheusRef("monitoring/prometheus:9090"), { namespace: "monitoring", service: "prometheus", port: "9090" });
  assert.throws(() => parsePrometheusRef("prometheus"), /namespace\/service:port/);
});

// The command itself, with kubectl replaced by a stand-in that serves the recorded lab.

function withKubectl() {
  const kubectl = fakeKubectl(FIXTURE);
  const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-kube-"));
  return {
    cwd,
    calls: kubectl.calls,
    run: (args: string[]) => cli(["kube", "--lookback-hours", "1", ...args], { blockNetwork: true, cwd, env: kubectl.env }),
  };
}

test("cloudpilot kube reports the cluster in its own words, and kubectl is only ever asked to read", () => {
  const lab = withKubectl();
  const run = lab.run(["--html", "report.html"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Reading cluster kind-cloudpilot-lab through kubectl \(read-only\)\.\.\./);
  assert.match(run.stdout, /^Cluster kind-cloudpilot-lab, 4 namespaces scanned, scanned \S+$/m);
  assert.match(run.stdout, /^Prices: \$0\.031611 per vCPU-hour, \$0\.004237 per GiB-hour of memory, \$0\.04 per GiB-month of storage \(OpenCost defaults; set your own with/m);
  assert.match(run.stdout, /^Usage: Prometheus at monitoring\/prometheus:9090, the last 1 hour$/m);
  assert.match(run.stdout, /^5 findings, \$50\.64 per month of estimated waste$/m);
  assert.match(run.stdout, /kubectl set resources deployment\/reports -n shop --context kind-cloudpilot-lab -c worker --requests=cpu=10m,memory=32Mi/);
  assert.match(run.stdout, /1 resource was skipped because of the label cloudpilot\/ignore=true: monitoring\/deployment\/prometheus/);
  assert.match(run.stdout, /Estimated waste: \$50\.64 per month across 5 findings in 1 of the 4 namespaces scanned\./);
  assert.match(run.stdout, /By namespace:\n- shop: 5 findings, \$50\.64 per month\.\n- 3 other namespaces: nothing found\./);

  for (const call of lab.calls()) {
    const rest = call[0] === "--context" ? call.slice(2) : call;
    assert.ok(rest.slice(0, 2).join(" ") === "get --raw" || rest.join(" ") === "config view --minify -o json", `kubectl ${call.join(" ")}`);
  }

  // The HTML report: the resizes can be undone, so they start ticked; the deletions do not.
  const page = new JSDOM(readFileSync(join(lab.cwd, "report.html"), "utf8"), { runScripts: "dangerously" }).window.document;
  assert.equal(page.title, "CloudPilot scan of cluster kind-cloudpilot-lab");
  assert.deepEqual([...page.querySelectorAll(".facts dt")].map((dt) => dt.textContent), ["Cluster", "Namespaces", "Scanned", "Prices", "Usage"]);
  assert.equal(page.querySelector(".bar p")!.textContent!.replace(/\s+/g, " ").trim(), "$50.04 a month saved by the 3 fixes in your script. All of them can be undone.");
  const script = page.getElementById("script-text")!.textContent!;
  assert.match(script, /^# CloudPilot fix script for cluster kind-cloudpilot-lab\n/);
  assert.ok(script.includes("kubectl set resources deployment/checkout -n shop --context kind-cloudpilot-lab -c api --requests=cpu=10m"));
  assert.ok(!script.includes("kubectl delete"));
});

test("a second scan of the same cluster says by itself that nothing is new, from a baseline kept per cluster", () => {
  const lab = withKubectl();
  const first = lab.run([]);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /since the last scan/i);
  assert.ok(existsSync(join(lab.cwd, ".cloudpilot/last-kube-scan-kind-cloudpilot-lab.json")));
  assert.equal(existsSync(join(lab.cwd, ".cloudpilot/last-scan.json")), false, "the AWS account's baseline is a different file and is not touched");

  const second = lab.run(["--json"]);
  assert.equal(second.status, 0, second.stderr);
  const json = JSON.parse(second.stdout);
  assert.deepEqual([json.comparison.newCount, json.comparison.resolved.length, json.comparison.unchangedCount], [0, 0, 5]);
  assert.equal(json.cluster.context, "kind-cloudpilot-lab");
  assert.match(json.summary, /No new or resolved findings since the last scan/);
});

test("the command scores itself against the lab's answer key", () => {
  const run = withKubectl().run(["--answer-key", ANSWER_KEY]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Found 5\/5, cost within 1% 5\/5, fix command matches 5\/5 \(5\/5 exact\)\.\nNo findings outside the answer key\.\n\nPASS/);
});

test("without kubectl the command says what it needs", () => {
  const run = cli(["kube"], { blockNetwork: true, env: { PATH: dirname(process.execPath) } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /kubectl was not found on your PATH\. CloudPilot reads a cluster through kubectl, with the access you already have\./);
});

test("a blank price or lookback is refused, not read as zero", () => {
  const lab = withKubectl();
  for (const [flag, message] of [
    ["--cpu-hour-usd", /--cpu-hour-usd takes a number that is zero or more\. Got ""\./],
    ["--memory-gib-hour-usd", /--memory-gib-hour-usd takes a number that is zero or more\. Got ""\./],
    ["--storage-gib-month-usd", /--storage-gib-month-usd takes a number that is zero or more\. Got ""\./],
    ["--lookback-hours", /--lookback-hours takes a number that is zero or more\. Got ""\./],
  ] as [string, RegExp][]) {
    const run = lab.run([flag, ""]);
    assert.notEqual(run.status, 0, `${flag} "" was accepted: ${run.stdout}`);
    assert.match(run.stderr, message);
  }
});

test("a cluster's report never claims an AWS account", () => {
  const html = renderHtml(detectCluster(inventory({ workloads: [workload({ containers: [{ name: "app", cpuRequestCores: 2, memoryRequestBytes: 64 * MI, ...idle }] })] }), OPENCOST_DEFAULTS));
  assert.doesNotMatch(html, /AWS account|Account<|Regions</);
});

test("a kubectl that never answers is stopped at the timeout init gives it, and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-kube-hang-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A kubectl that reads nothing and answers far too late to be waited for.
  writeFileSync(join(bin, "kubectl"), "#!/usr/bin/env node\nsetTimeout(() => process.stdout.write('{}'), 10_000);\n");
  chmodSync(join(bin, "kubectl"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${dirname(process.execPath)}`;
  try {
    const started = Date.now();
    await assert.rejects(kubectlReader(undefined, 300).get("/api/v1/pods?limit=1"), /kubectl did not answer within 0\.3 seconds\./);
    assert.ok(Date.now() - started < 5_000, "the call was stopped rather than waited out");
  } finally {
    process.env.PATH = path;
  }
});
