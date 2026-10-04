/**
 * The in-cluster scan against the waste lab, as a pod. Needs the lab up (see
 * k8s-lab/up.sh) and the image built and loaded into it:
 *
 *   docker build -t cloudpilot:lab . && kind load docker-image cloudpilot:lab --name cloudpilot-lab
 *
 * Without the image the tests are skipped. Each run makes a namespace of its own
 * and a binding for one service account in it, runs two pods there, and deletes
 * everything it made when it ends. It never touches `shop` or `monitoring`.
 * Run: npm run test:kube-lab
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const CONTEXT = "kind-cloudpilot-lab";
const NODE = "cloudpilot-lab-control-plane";
const IMAGE = process.env.CLOUDPILOT_LAB_IMAGE ?? "cloudpilot:lab";
const NS = "cp-incluster-test";
const MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../deploy/kube-watch.yaml");

const kubectl = (args: string[], input?: string) => spawnSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8", input });

/** Whether the image is on the lab's node: the node is a container, so ask its runtime. */
const loaded = (() => {
  const [repo, tag] = IMAGE.split(":");
  const images = spawnSync("docker", ["exec", NODE, "crictl", "images"], { encoding: "utf8" });
  return images.status === 0 && new RegExp(`/${repo}\\s+${tag}\\s`).test(images.stdout);
})();
const skip = loaded ? false : `${IMAGE} is not loaded into the lab: docker build -t ${IMAGE} . && kind load docker-image ${IMAGE} --name cloudpilot-lab`;

const watch = parseAllDocuments(readFileSync(MANIFEST, "utf8")).map((d) => d.toJS()).find((d) => d.kind === "Deployment");

const clean = () => {
  kubectl(["delete", "namespace", NS, "--ignore-not-found", "--wait=true", "--timeout=120s"]);
  kubectl(["delete", "clusterrolebinding", NS, "--ignore-not-found"]);
};

before(() => {
  if (!loaded) return;
  clean();
  // A namespace held to the same standard the manifest's namespace is, so a pod that breaks it is not admitted.
  const made = kubectl(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        { apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "pod-security.kubernetes.io/enforce": "restricted" } } },
        { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "reader", namespace: NS } },
        // The role the documented manifest creates: everything a scan lists, and no Prometheus (that binding lives in `monitoring`, which a test leaves alone).
        {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "ClusterRoleBinding",
          metadata: { name: NS },
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cloudpilot-readonly" },
          subjects: [{ kind: "ServiceAccount", name: "reader", namespace: NS }],
        },
      ],
    }),
  );
  assert.equal(made.status, 0, made.stderr);
});

after(clean);

/** A pod with the Deployment's own security settings, running `args`, and what it did: its phase and what it logged. */
function runPod(name: string, args: string[], env: Array<{ name: string; value: string }>) {
  const spec = structuredClone(watch.spec.template.spec);
  const container = spec.containers[0];
  Object.assign(container, { image: IMAGE, imagePullPolicy: "Never", args, env });
  Object.assign(spec, { serviceAccountName: "reader", restartPolicy: "Never" });
  const made = kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "Pod", metadata: { name, namespace: NS }, spec }));
  assert.equal(made.status, 0, made.stderr);
  let phase = "";
  for (let waited = 0; waited < 120 && phase !== "Succeeded" && phase !== "Failed"; waited += 2) {
    spawnSync("sleep", ["2"]);
    phase = kubectl(["-n", NS, "get", "pod", name, "-o", "jsonpath={.status.phase}"]).stdout;
    const waiting = kubectl(["-n", NS, "get", "pod", name, "-o", "jsonpath={.status.containerStatuses[0].state.waiting.reason}"]).stdout;
    assert.ok(!/ErrImageNeverPull|InvalidImageName|CreateContainerConfigError/.test(waiting), `${name}: ${waiting}`);
  }
  const logs = kubectl(["-n", NS, "logs", name]);
  return { phase, logs: logs.stdout + logs.stderr, pod: JSON.parse(kubectl(["-n", NS, "get", "pod", name, "-o", "json"]).stdout) };
}

test("a pod with no kubeconfig scans the lab through its service account, under the manifest's security settings", { skip }, () => {
  const run = runPod("with-name", ["kube", "--json", "--lookback-hours", "1"], [{ name: "CLOUDPILOT_CLUSTER_NAME", value: CONTEXT }]);
  assert.equal(run.phase, "Succeeded", run.logs);
  assert.match(run.logs, /^Reading cluster kind-cloudpilot-lab from inside it, as this pod's service account \(read-only\)\.\.\.$/m);

  // What kubectl logs gives is the notes and then the JSON.
  const lines = run.logs.split("\n");
  const result = JSON.parse(lines.slice(lines.findIndex((l) => l.startsWith("{"))).join("\n"));
  assert.equal(result.cluster.context, CONTEXT);
  // The volumes need only the role; the usage behind the other three needs Prometheus, whose binding is not part of this test.
  assert.deepEqual(result.findings.map((f: { pattern: string }) => f.pattern).sort(), ["released-volume", "unused-volume-claim"]);
  for (const f of result.findings) for (const command of f.fix.commands) assert.match(command, / --context kind-cloudpilot-lab( |$)/);
  assert.match(result.warnings[0], /^Prometheus \(monitoring\/prometheus:9090\) could not be queried: .*forbidden/i);

  // The API server's own account of the pod: the settings in the manifest are the settings it ran with.
  assert.deepEqual(run.pod.spec.securityContext, watch.spec.template.spec.securityContext);
  assert.deepEqual(run.pod.spec.containers[0].securityContext, watch.spec.template.spec.containers[0].securityContext);
  assert.equal(run.pod.status.containerStatuses[0].state.terminated.exitCode, 0);
});

test("a pod that is not told which cluster it is in stops before reading anything", { skip }, () => {
  const run = runPod("no-name", ["kube", "--json", "--lookback-hours", "1"], []);
  assert.equal(run.phase, "Failed");
  assert.match(run.logs, /CloudPilot is running inside a cluster, where there is no kubeconfig and so no context name\. Name the cluster with --cluster-name <name> \(or CLOUDPILOT_CLUSTER_NAME\)/);
  assert.doesNotMatch(run.logs, /Reading cluster/);
});

test("the service account a pod reads as can change nothing", { skip }, () => {
  const as = (...args: string[]) => kubectl(["--as", `system:serviceaccount:${NS}:reader`, "auth", "can-i", ...args]).stdout.trim().split("\n").pop();
  assert.equal(as("list", "pods", "--all-namespaces"), "yes");
  for (const action of ["delete pods", "patch deployments.apps", "create deployments.apps", "delete persistentvolumeclaims", "delete persistentvolumes", "list secrets", "create pods --subresource=exec"]) {
    assert.equal(as(...action.split(" "), "-n", "shop"), "no", action);
  }
});
