/**
 * The manifest that runs the watch inside the cluster it watches:
 * deploy/kube-watch.yaml. It is read the way Kubernetes reads it, and the
 * command in its Deployment is run for real, as the pod runs it: with no
 * kubeconfig, the cluster named by an environment variable, and kubectl a
 * stand-in that serves the recorded lab. The live run is in test/kube-lab.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { cliRun, fakeKubectl } from "./helpers.js";
import { hook, SECRET } from "./webhook.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const FIXTURE = resolve(here, "fixtures/kube-lab.json");

interface Doc {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [key: string]: any;
}
const load = (file: string): Doc[] => parseAllDocuments(readFileSync(join(ROOT, file), "utf8")).map((d) => d.toJS());
const watchFile = load("deploy/kube-watch.yaml");
const roleFile = load("docs/cloudpilot-kube-readonly.yaml");
const named = (docs: Doc[], kind: string, name: string) => docs.find((d) => d.kind === kind && d.metadata.name === name)!;

const deployment = named(watchFile, "Deployment", "cloudpilot-watch");
const pod = deployment.spec.template.spec;
const container = pod.containers[0];

test("the manifest's access is exactly the documented read-only access, and nothing is added to it", () => {
  const documented = roleFile.map((d) => `${d.kind}/${d.metadata.namespace ?? ""}/${d.metadata.name}`);
  assert.ok(documented.length >= 6);
  for (const doc of roleFile) {
    const same = named(watchFile, doc.kind, doc.metadata.name);
    assert.ok(same, `${doc.kind} ${doc.metadata.name} is in the manifest`);
    // The namespace the manifest creates also carries a Pod Security label; everything else must match as written.
    const { labels: _own, ...ownMeta } = same.metadata;
    const { labels: _theirs, ...theirMeta } = doc.metadata;
    assert.deepEqual({ ...same, metadata: ownMeta }, { ...doc, metadata: theirMeta }, `${doc.kind} ${doc.metadata.name}`);
  }
  // Besides those, the one Deployment: no Secret, no other role, no other binding.
  assert.deepEqual(
    watchFile.map((d) => `${d.kind}/${d.metadata.namespace ?? ""}/${d.metadata.name}`).filter((id) => !documented.includes(id)),
    ["Deployment/cloudpilot/cloudpilot-watch"],
  );
  // And what the rules allow is reading: no write verb, no Secrets, no ConfigMaps.
  for (const rule of watchFile.filter((d) => /Role$/.test(d.kind)).flatMap((d) => d.rules ?? [])) {
    for (const verb of rule.verbs) assert.ok(["get", "list"].includes(verb), `verb ${verb}`);
    for (const resource of rule.resources) assert.ok(!["secrets", "configmaps", "pods/exec", "pods/log", "*"].includes(resource), `resource ${resource}`);
  }
});

test("the pod is what the scanner preaches: non-root, read-only, no privilege, no capabilities, one small writable place", () => {
  assert.equal(pod.serviceAccountName, "cloudpilot");
  assert.equal(pod.automountServiceAccountToken, true, "the token is how it reads the API server");
  assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } });
  assert.deepEqual(container.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } });
  for (const field of ["hostNetwork", "hostPID", "hostIPC"]) assert.ok(!pod[field], field);
  // Enforced at a version, so a cluster upgrade cannot change what is admitted here under the scanner's nose.
  assert.deepEqual(named(watchFile, "Namespace", "cloudpilot").metadata.labels, {
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/enforce-version": "v1.37",
  });

  // The only volume is an emptyDir with a ceiling, and it is where the command runs, so the baseline lands there.
  assert.deepEqual(pod.volumes, [{ name: "work", emptyDir: { sizeLimit: "64Mi" } }]);
  assert.deepEqual(container.volumeMounts, [{ name: "work", mountPath: "/work" }]);
  assert.equal(container.workingDir, "/work");

  // One watcher, replaced only after the old one has gone.
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.deepEqual(container.args.slice(0, 2), ["watch", "--kube"]);
});

test("it asks for little, says what for, and has a memory limit but no CPU limit", () => {
  assert.deepEqual(container.resources, { requests: { cpu: "10m", memory: "80Mi" }, limits: { memory: "256Mi" } });
});

test("nothing is pulled and nothing is sent until the person has filled in their own image, name and webhook", () => {
  // A name Kubernetes cannot pull (upper case is not allowed in one), so a registry never gets a say.
  assert.equal(container.image, "REPLACE-WITH-YOUR-CLOUDPILOT-IMAGE");
  // The webhook is the person's Secret, never a value in the file.
  assert.ok(!watchFile.some((d) => d.kind === "Secret"));
  const env = Object.fromEntries(container.env.map((e: { name: string }) => [e.name, e]));
  assert.deepEqual(env.CLOUDPILOT_NOTIFY.valueFrom, { secretKeyRef: { name: "cloudpilot-webhook", key: "url" } });
  assert.deepEqual(Object.keys(env).sort(), ["CLOUDPILOT_CLUSTER_NAME", "CLOUDPILOT_NOTIFY"]);
  // Nothing the cluster reads from this file names a destination: a URL could only be in a comment, which Kubernetes never sees.
  assert.ok(!/https?:\/\//.test(JSON.stringify(watchFile)), "no URL in anything the cluster reads");
});

// The command in the Deployment, run as the pod runs it.

/** A process in the pod: the Deployment's own arguments and environment, with kubectl replaced by a stand-in. */
async function inThePod(env: Record<string, string>, extra: string[] = ["--max-runs", "1", "--lookback-hours", "1"]) {
  const kubectl = fakeKubectl(FIXTURE);
  const given = Object.fromEntries(
    container.env.filter((e: { value?: string }) => e.value !== undefined).map((e: { name: string; value: string }) => [e.name, e.value]),
  );
  const run = await cliRun([...container.args, ...extra], { env: { ...kubectl.pod, ...given, ...env } });
  return { ...run, kubectl };
}

test("run as the pod runs it, the command scans from inside, tells the webhook once, and writes only under its working directory", async () => {
  const server = await hook(() => ({ status: 200, body: "ok" }));
  try {
    const run = await inThePod({ CLOUDPILOT_CLUSTER_NAME: "prod-eu", CLOUDPILOT_NOTIFY: server.url });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /^Watching cluster prod-eu every 6h, read-only\. Messages go to 127\.0\.0\.1:\d+\./m);
    assert.match(run.stderr, /^Reading cluster prod-eu from inside it, as this pod's service account \(read-only\)\.\.\.$/m);
    assert.equal(server.requests.length, 1);
    const body = JSON.parse(server.requests[0]!.body);
    assert.equal(body.event, "first-report");
    assert.match(body.text, /^CloudPilot: first report, 5 findings, \$50\.64 a month, cluster prod-eu\n/);
    // The one thing it keeps is the baseline, in the directory the manifest gives it as an emptyDir.
    assert.deepEqual(readdirSync(run.cwd), [".cloudpilot"]);
    assert.deepEqual(readdirSync(join(run.cwd, ".cloudpilot")), ["watch-kube-prod-eu.json"]);
    for (const call of run.kubectl.calls()) assert.notEqual(call[0], "--context", `kubectl ${call.join(" ")}`);
    assert.ok(!(run.stdout + run.stderr).includes(SECRET));
  } finally {
    await server.close();
  }
});

test("left as it is shipped, the placeholder name is refused before anything is read", async () => {
  const run = await inThePod({});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /"<your-kubectl-context-name>" cannot be a cluster name: use the kubectl context name your team uses for it/);
  assert.equal(run.kubectl.started(), false, "kubectl was not even started");
  assert.equal(existsSync(join(run.cwd, ".cloudpilot")), false);
});

test("the Secret made but the name left as shipped: the webhook hears why, rather than a pod crash-looping in silence", async () => {
  const server = await hook(() => ({ status: 200, body: "ok" }));
  try {
    // The one step of the three the README asks for that nothing else can catch: the Secret exists, so CLOUDPILOT_NOTIFY is set.
    const run = await inThePod({ CLOUDPILOT_NOTIFY: server.url });
    assert.equal(run.status, 1);
    assert.equal(run.kubectl.started(), false, "kubectl was not even started");
    assert.equal(server.requests.length, 1, "a watch that cannot start says so once");
    const body = JSON.parse(server.requests[0]!.body);
    assert.equal(body.event, "check-failed");
    assert.match(body.error, /"<your-kubectl-context-name>" cannot be a cluster name/);
    assert.equal(body.subject, "cluster <your-kubectl-context-name>");
  } finally {
    await server.close();
  }
});
