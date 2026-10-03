/**
 * Names a cluster hands back. The API server checks most of them, but an
 * owner reference's kind and name only have to be non-empty, so what a pod
 * says it belongs to can be anything. None of it may reach a terminal, a
 * report or a printed command as it is, and a name that is not a valid
 * Kubernetes name never goes into a command at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplyError, plan } from "../src/apply.js";
import { renderHtml } from "../src/html.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { collectCluster, displayName, invalidName, type ClusterInventory, type KubeReader, type PodFacts, type Workload } from "../src/kube.js";
import { renderMarkdown, renderPlainText, renderText } from "../src/report.js";

const MI = 2 ** 20;
const GI = 2 ** 30;
const NOW = new Date("2026-10-03T12:00:00Z");

/** A terminal retitle, a bell, a shell command after a semicolon, a code span, markup and quotes. */
const EVIL = "x\u001b]0;pwned\u0007; id #`<script>alert(\"x\")</script>'";

/** Bytes a terminal acts on: everything below space but the newline, and DEL and the C1 range. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
/** What styleText draws colour with, which is the one escape sequence the report may carry. */
const COLOUR = /\u001b\[[0-9;]*m/g;

interface Cluster {
  pods?: any[];
  replicaSets?: any[];
  claims?: any[];
  volumes?: any[];
  nodes?: any[];
  /** Prometheus answers by pod name, for pods of namespace prod and container app. */
  usage?: { cpu: Record<string, number>; memory: Record<string, number>; since: Record<string, number> };
}

const series = (by: Record<string, number>) => ({
  status: "success",
  data: { result: Object.entries(by).map(([pod, value]) => ({ metric: { namespace: "prod", pod, container: "app" }, value: [0, String(value)] })) },
});

function reader(c: Cluster): KubeReader {
  return {
    identity: async () => ({ context: "prod-cluster" }),
    get: async (path) => {
      if (path.startsWith("/api/v1/namespaces?")) return { items: [{ metadata: { name: "prod" } }] };
      if (path.startsWith("/api/v1/pods?")) return { items: c.pods ?? [] };
      if (path.startsWith("/apis/apps/v1/replicasets?")) return { items: c.replicaSets ?? [] };
      if (path.startsWith("/api/v1/persistentvolumeclaims?")) return { items: c.claims ?? [] };
      if (path.startsWith("/api/v1/persistentvolumes?")) return { items: c.volumes ?? [] };
      if (path.startsWith("/api/v1/nodes?")) return { items: c.nodes ?? [] };
      if (path.startsWith("/api/v1/services?") && c.usage) return { items: [{ metadata: { name: "prometheus-server", namespace: "obs" }, spec: { ports: [{ name: "http", port: 80 }] } }] };
      if (path.includes("/proxy/") && c.usage) {
        const promql = decodeURIComponent(path.split("query=")[1]!);
        if (promql.includes("container_cpu_usage_seconds_total")) return series(c.usage.cpu);
        if (promql.includes("timestamp(")) return series(c.usage.since);
        return series(c.usage.memory);
      }
      return { items: [] };
    },
  };
}

const read = (c: Cluster) => collectCluster(reader(c), { lookbackHours: 168, now: NOW });

const killedPod = (owner: object) => ({
  metadata: { name: "web-0", namespace: "prod", ownerReferences: [owner] },
  spec: { containers: [{ name: "app", resources: { limits: { memory: "100Mi" }, requests: { cpu: "100m", memory: "64Mi" } } }] },
  status: { phase: "Running", containerStatuses: [{ name: "app", restartCount: 1, lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-03T11:00:00Z" } } }] },
});

/** Every way the scan is shown. None may carry a control byte. */
function shown(result: ReturnType<typeof detectCluster>) {
  return {
    plain: renderText(result, { plain: true }),
    coloured: renderText(result).replace(COLOUR, ""),
    plainDocument: renderPlainText(result),
    markdown: renderMarkdown(result),
    html: renderHtml(result),
    json: JSON.stringify(result, null, 2),
  };
}

test("a name that is not a valid Kubernetes name is shown safely, and a valid one is shown as it is", () => {
  assert.equal(displayName("my-app.v2_x"), "my-app.v2_x");
  assert.equal(displayName("api-7558c476b-9ngzv"), "api-7558c476b-9ngzv");
  const shownName = displayName(EVIL);
  assert.ok(!CONTROL.test(shownName) && !/[`<>"';# ]/.test(shownName), shownName);
  // Nothing is trimmed or squeezed, so a name never reads as the name of another object.
  assert.equal(displayName("\u0001api\u0001"), "?api?");
  assert.equal(displayName("a".repeat(300)).length, 253);
  assert.equal(displayName("a".repeat(70), 63).length, 63);
});

test("only a valid Kubernetes name may go into a command: a subdomain for most objects, a label for a namespace or a container", () => {
  const subdomain = (name: string) => invalidName({ subdomain: [name] }) === undefined;
  const label = (name: string) => invalidName({ label: [name] }) === undefined;
  for (const ok of ["a", "api", "my.app-1", "pg.data-0", "pvc-0a1b2c3d-1111-2222-3333-444455556666", "ip-10-0-1-2.ec2.internal", "a".repeat(253)]) assert.ok(subdomain(ok), ok);
  for (const bad of ["", "-a", "a-", "A", "Api", "a_b", "a..b", "a.-b", "a b", "a;b", "a$(id)", "a`id`", "a\n", "x".repeat(254), "a/b"]) assert.ok(!subdomain(bad), JSON.stringify(bad));
  for (const ok of ["app", "sidecar-2", "a".repeat(63)]) assert.ok(label(ok), ok);
  for (const bad of ["a.b", "a".repeat(64), "App", "a_b", "", "a b"]) assert.ok(!label(bad), JSON.stringify(bad));
  // What is shown for a name is never taken for a valid one by being shown.
  assert.equal(invalidName({ subdomain: ["Bad Name"] }), "Bad?Name");
});

test("an owner name from a pod's ownerReferences cannot put a control byte, markup or a command anywhere in the scan", async () => {
  const inventory = await read({ pods: [killedPod({ kind: "StatefulSet", name: EVIL, controller: true })] });
  const result = detectCluster(inventory, OPENCOST_DEFAULTS);
  const advisory = result.advisories!.find((a) => a.rule === "out-of-memory")!;

  // The object is still reported, under a name that is safe to print, with no command and the reason why.
  assert.equal(advisory.resource, `statefulset/${displayName(EVIL)}`);
  assert.equal(advisory.suggestion, undefined);
  assert.match(advisory.advice, /No command is printed for it: ".*" is not a valid Kubernetes name/);

  const out = shown(result);
  for (const [form, text] of Object.entries(out)) {
    assert.ok(!text.includes("kubectl set resources"), `${form} prints a command for it`);
    assert.ok(!text.includes("pwned\u0007") && !text.includes("<script>alert") && !text.includes("; id #"), `${form} carries the name raw`);
  }
  for (const form of ["plain", "coloured", "plainDocument", "markdown"] as const) assert.ok(!CONTROL.test(out[form]), `${form} carries a control byte`);
  assert.ok(!out.json.includes("\\u001b") && !out.json.includes("\\u0007"));
  // The Markdown code span holds the name and nothing that could end it.
  const object = out.markdown.split("\n").find((l) => l.startsWith("- **Object:**"))!;
  assert.equal(object, `- **Object:** StatefulSet \`statefulset/${displayName(EVIL)}\` in prod, container \`app\``);
});

test("a Deployment name taken from its ReplicaSet's owner reference is held to the same rule, and a legitimate one is not", async () => {
  const usage = (pod: string) => ({ cpu: { [pod]: 0.1 }, memory: { [pod]: 100 * MI }, since: { [pod]: NOW.getTime() / 1000 - 100 * 3600 } });
  const pod = (name: string, rs: string) => ({
    metadata: { name, namespace: "prod", ownerReferences: [{ kind: "ReplicaSet", name: rs, controller: true }] },
    spec: { containers: [{ name: "app", resources: { requests: { cpu: "2", memory: "2Gi" } } }] },
    status: { phase: "Running" },
  });
  const rs = (name: string, deployment: string) => ({ metadata: { name, namespace: "prod", ownerReferences: [{ kind: "Deployment", name: deployment }] } });
  const run = async (deployment: string) =>
    detectCluster(await read({ pods: [pod("api-7558c476b-9ngzv", "api-7558c476b")], replicaSets: [rs("api-7558c476b", deployment)], usage: usage("api-7558c476b-9ngzv") }), OPENCOST_DEFAULTS);

  const good = (await run("api.v2")).findings[0]!;
  assert.equal(good.title, "Deployment api.v2 requests more than it uses");
  assert.deepEqual(good.fix.commands, ["kubectl set resources deployment/api.v2 -n prod --context prod-cluster -c app --requests=cpu=120m,memory=128Mi"]);

  const evil = await run(EVIL);
  assert.equal(evil.findings.length, 1, "the workload is still reported");
  const finding = evil.findings[0]!;
  assert.equal(finding.title, `Deployment ${displayName(EVIL)} requests more than it uses`);
  assert.deepEqual(finding.fix.commands, []);
  assert.match(finding.fix.rollback, /^No command is printed for it: /);
  // The money is still counted: the waste is real, only the command is withheld.
  assert.ok(finding.monthlyCostUsd > 0);
  const out = shown(evil);
  for (const [form, text] of Object.entries(out)) assert.ok(!text.includes("kubectl set resources"), form);
  for (const form of ["plain", "coloured", "plainDocument", "markdown"] as const) assert.ok(!CONTROL.test(out[form]), form);
  assert.match(out.plain, /no fix command: No command is printed for it/);
  assert.match(out.markdown, /- \*\*No fix command:\*\* No command is printed for it/);
  assert.match(out.html, /No fix command/);
  // Nothing is offered for the script, so nothing can be ticked into it.
  assert.ok(!/<input type="checkbox"/.test(out.html));
});

test("a claim or a volume that is not validly named is reported with no delete command, and its neighbours keep theirs", async () => {
  const claim = (name: string, volume: string) => ({
    metadata: { name, namespace: "prod" },
    spec: { volumeName: volume, resources: { requests: { storage: "10Gi" } } },
    status: { phase: "Bound", capacity: { storage: "10Gi" } },
  });
  const pv = (name: string, claimName: string) => ({
    metadata: { name },
    spec: { capacity: { storage: "20Gi" }, persistentVolumeReclaimPolicy: "Retain", claimRef: { namespace: "prod", name: claimName } },
    status: { phase: "Released" },
  });
  const result = detectCluster(
    await read({
      claims: [claim("pg.data-0", "pvc-1"), claim("Data_Claim", "pvc-2"), claim(EVIL, "pvc-3")],
      volumes: [pv("pvc-old", "gone"), pv(EVIL, "gone")],
    }),
    OPENCOST_DEFAULTS,
  );
  const by = (id: string) => result.findings.find((f) => f.resourceIds[0] === id)!;

  assert.deepEqual(by("persistentvolumeclaim/pg.data-0").fix.commands, ["kubectl delete persistentvolumeclaim pg.data-0 -n prod --context prod-cluster"]);
  assert.deepEqual(by("persistentvolume/pvc-old").fix.commands, ["kubectl delete persistentvolume pvc-old --context prod-cluster"]);
  for (const id of ["persistentvolumeclaim/Data_Claim", `persistentvolumeclaim/${displayName(EVIL)}`, `persistentvolume/${displayName(EVIL)}`]) {
    const f = by(id);
    assert.ok(f, id);
    assert.deepEqual(f.fix.commands, [], id);
    assert.equal(f.fix.risk, "dangerous");
    assert.match(f.fix.rollback, /^No command is printed for it: /);
  }
  const out = shown(result);
  for (const form of ["plain", "coloured", "plainDocument", "markdown"] as const) assert.ok(!CONTROL.test(out[form]), form);
  assert.ok(!out.plain.includes("kubectl delete persistentvolumeclaim Data_Claim") && !out.plain.includes(`kubectl delete persistentvolume ${EVIL}`));
});

test("a claim bound to a volume with an invalid name does not print that name in the command that checks the volume", async () => {
  const result = detectCluster(
    await read({
      claims: [{ metadata: { name: "data", namespace: "prod" }, spec: { volumeName: "pv;id", resources: { requests: { storage: "1Gi" } } }, status: { phase: "Bound", capacity: { storage: "1Gi" } } }],
    }),
    OPENCOST_DEFAULTS,
  );
  const f = result.findings[0]!;
  assert.deepEqual(f.fix.commands, ["kubectl delete persistentvolumeclaim data -n prod --context prod-cluster"]);
  assert.match(f.fix.rollback, /read it with kubectl get persistentvolume <volume> --context prod-cluster/);
});

test("owner, workload and node names that the scan holds are safe even if they came from a recording", () => {
  // Hand-built, so nothing went through collectCluster: the rules and the reports still do not trust the names.
  const pod: PodFacts = {
    namespace: "prod",
    name: "web-0",
    phase: "Running",
    owner: { kind: "StatefulSet", name: EVIL },
    ownerIsWorkload: true,
    containers: [{ name: "app", restartCount: 1, memoryLimitBytes: 100 * MI, terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-03T11:00:00Z" } }],
    ignored: false,
  };
  const workload: Workload = {
    kind: "Deployment",
    name: EVIL,
    namespace: "prod",
    replicas: 1,
    ignored: false,
    containers: [{ name: "app", cpuRequestCores: 2, memoryRequestBytes: 2 * GI, cpuPeakCores: 0.1, memoryPeakBytes: 100 * MI, historyHours: 100, oomKilled: false }],
  };
  const inventory: ClusterInventory = {
    context: "prod-cluster",
    collectedAt: NOW.toISOString(),
    namespaces: ["prod"],
    workloads: [workload],
    claims: [],
    volumes: [],
    lookbackHours: 168,
    warnings: [],
    advisories: { pods: [pod], warnings: [] },
  };
  const result = detectCluster(inventory, OPENCOST_DEFAULTS);
  assert.deepEqual(result.findings[0]!.fix.commands, []);
  assert.equal(result.advisories!.find((a) => a.rule === "out-of-memory")!.suggestion, undefined);

  // HTML: the name is text, whatever it holds.
  const html = renderHtml(result);
  assert.ok(!html.includes("<script>alert"), "markup from a name reached the page");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  // Markdown: a backtick in a name cannot end the code span it is in.
  const object = renderMarkdown(result).split("\n").find((l) => l.startsWith("- **Object:**"))!;
  assert.equal(object.split("`").length - 1, 4, object);
  const table = renderMarkdown(result).split("\n").find((l) => l.startsWith("| 1 |"))!;
  assert.ok(table.includes(` | \`deployment/${EVIL.replace(/`/g, "'")}\` | prod |`), table);
});

test("a pod that restarts under an invalid name gets no log command, and one with a valid name keeps it", async () => {
  const restarting = (pod: string, owner: object) => ({
    metadata: { name: pod, namespace: "prod", ownerReferences: [owner] },
    spec: { containers: [{ name: "app" }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", restartCount: 9, state: { waiting: { reason: "CrashLoopBackOff" } } }] },
  });
  const advice = async (owner: object) => detectCluster(await read({ pods: [restarting("web-0", owner)] }), OPENCOST_DEFAULTS).advisories!.find((a) => a.rule === "restarting")!.advice;
  assert.match(await advice({ kind: "StatefulSet", name: "web" }), /kubectl logs web-0 -n prod --context prod-cluster -c app --previous/);
  // The pod's own name is checked by the API server; here the pod is named validly and so keeps the command.
  assert.match(await advice({ kind: "StatefulSet", name: EVIL }), /kubectl logs web-0 -n prod/);
  const bad = detectCluster(await read({ pods: [restarting("Web_0", { kind: "StatefulSet", name: "web" })] }), OPENCOST_DEFAULTS).advisories!.find((a) => a.rule === "restarting")!;
  assert.ok(!bad.advice.includes("kubectl logs"));
  assert.match(bad.advice, /No command is printed for it: "Web_0" is not a valid Kubernetes name/);
});

test("apply has nothing to run for a finding that carries no command, and says why", async () => {
  const usage = { cpu: { "api-1": 0.1 }, memory: { "api-1": 100 * MI }, since: { "api-1": NOW.getTime() / 1000 - 100 * 3600 } };
  const bare = { metadata: { name: "api-1", namespace: "prod", ownerReferences: [{ kind: "StatefulSet", name: "Bad_Name", controller: true }] }, spec: { containers: [{ name: "app", resources: { requests: { cpu: "2", memory: "2Gi" } } }] }, status: { phase: "Running" } };
  const scan = { ...detectCluster(await read({ pods: [bare], usage }), OPENCOST_DEFAULTS), scannedAt: "2026-10-03T11:00:00Z" };
  assert.deepEqual(scan.findings.map((f) => f.resourceIds[0]), ["statefulset/Bad_Name"]);
  assert.throws(() => plan([scan], ["statefulset/Bad_Name"], { maxAgeHours: 24, now: NOW }), (err: unknown) => err instanceof ApplyError && /no command to run/.test(err.message) && /not a valid Kubernetes name/.test(err.message));
});

test("the spare node figure subtracts only what the nodes' requests include: pending pods with usage history free nothing from them", async () => {
  const node = (name: string) => ({ metadata: { name }, status: { allocatable: { cpu: "4", memory: "16Gi" } } });
  const fill = (name: string, nodeName: string) => ({
    metadata: { name, namespace: "prod" },
    spec: { nodeName, containers: [{ name: "filler", resources: { requests: { cpu: "3", memory: "1Gi" } } }] },
    status: { phase: "Running" },
  });
  // Three replicas of 'api' that no node has taken, so none is in any node's requests.
  const pending = (n: number) => ({
    metadata: { name: `api-7558c476b-aaaa${n}`, namespace: "prod", ownerReferences: [{ kind: "ReplicaSet", name: "api-7558c476b", controller: true }] },
    spec: { containers: [{ name: "app", resources: { requests: { cpu: "2", memory: "256Mi" } } }] },
    status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/2 nodes are available" }] },
  });
  const names = [1, 2, 3].map((n) => `api-7558c476b-aaaa${n}`);
  const each = (value: number) => Object.fromEntries(names.map((n) => [n, value]));
  const inventory = await read({
    nodes: [node("w1"), node("w2")],
    pods: [fill("f1", "w1"), fill("f2", "w2"), pending(1), pending(2), pending(3)],
    replicaSets: [{ metadata: { name: "api-7558c476b", namespace: "prod", ownerReferences: [{ kind: "Deployment", name: "api" }] } }],
    usage: { cpu: each(0.01), memory: each(20 * MI), since: each(NOW.getTime() / 1000 - 100 * 3600) },
  });
  const api = inventory.workloads.find((w) => w.name === "api")!;
  assert.equal(api.replicas, 3);
  assert.equal(api.nodes, undefined, "no pod of it is bound to a node");

  const result = detectCluster(inventory, OPENCOST_DEFAULTS);
  assert.equal(result.findings.length, 1, "the over-requested finding is raised from the history");
  // 6 of 8 CPU is requested on two nodes of 4: both are needed, and the pending pods change none of it.
  assert.equal(
    result.advisories!.find((a) => a.rule === "spare-node-capacity"),
    undefined,
    "freeing requests that no node counts would have made one node look spare",
  );
});
