/**
 * Live tests against the Kubernetes waste lab, a kind cluster on this machine.
 * Bring it up with k8s-lab/up.sh --confirm and give its Prometheus ten minutes.
 * Run: npm run test:kube-lab
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLI, TSX } from "../helpers.js";

const CONTEXT = "kind-cloudpilot-lab";
const ANSWER_KEY = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../k8s-lab/answer-key.json");

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/kube-lab.json");
/** The identity created by docs/cloudpilot-kube-readonly.yaml. */
const LEAST_ACCESS = "system:serviceaccount:cloudpilot:cloudpilot";

const kube = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", TSX, CLI, "kube", "--context", CONTEXT, "--lookback-hours", "1", ...args], {
    encoding: "utf8",
    cwd: mkdtempSync(join(tmpdir(), "cloudpilot-kube-lab-")),
    env: { ...process.env, NO_COLOR: "1" },
  });

/** Everything in the lab that a scan could conceivably have changed, as the API server holds it. */
const snapshot = () =>
  execFileSync("kubectl", ["--context", CONTEXT, "get", "deployments,persistentvolumeclaims,persistentvolumes", "--all-namespaces", "-o", "custom-columns=NAMESPACE:.metadata.namespace,KIND:.kind,NAME:.metadata.name,VERSION:.metadata.resourceVersion", "--no-headers"], { encoding: "utf8" })
    .split("\n")
    // apply.test.ts changes a workload on purpose, in a namespace of its own, and may be running at the same time.
    .filter((line) => !line.startsWith("cloudpilot-apply-test "))
    .join("\n");

test("a live scan of the lab finds exactly what its answer key says", () => {
  const run = kube("--answer-key", ANSWER_KEY);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Found 5\/5, cost within 1% 5\/5, fix command matches 5\/5 \(5\/5 exact\)\.\nNo findings outside the answer key\.\n\nPASS/);
});

test("scanning leaves every workload and volume exactly as it was", () => {
  const before = snapshot();
  const run = kube("--json");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).findings.length, 5);
  assert.equal(snapshot(), before, "no object's resourceVersion moved");
});

test("pointing at a Prometheus that is not there says so and still reports the volumes", () => {
  const run = kube("--prometheus", "monitoring/not-there:9090", "--json");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.findings.map((f: { pattern: string }) => f.pattern).sort(), ["released-volume", "unused-volume-claim"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^Prometheus \(monitoring\/not-there:9090\) could not be queried: .*Requests were not compared with real use\.$/);
});

test("the documented least-access role can make every read a scan makes, and can do nothing else", () => {
  const as = (...args: string[]) => spawnSync("kubectl", ["--context", CONTEXT, "--as", LEAST_ACCESS, ...args], { encoding: "utf8" });
  // Every path a scan asks for, as recorded from this lab.
  const paths = Object.keys(JSON.parse(readFileSync(FIXTURE, "utf8")).responses);
  assert.ok(paths.length >= 10);
  for (const path of paths) {
    const read = as("get", "--raw", path);
    assert.equal(read.status, 0, `${path}\n${read.stderr}`);
  }
  for (const action of ["delete pods", "patch deployments.apps", "create deployments.apps", "delete persistentvolumes", "delete persistentvolumeclaims", "list secrets", "get configmaps", "create pods/exec", "get pods/log"]) {
    assert.equal(as("auth", "can-i", ...action.split(" "), "--all-namespaces").stdout.trim(), "no", action);
  }
  // Its one way into Prometheus is that one service: no other service can be reached through it.
  assert.notEqual(as("get", "--raw", "/api/v1/namespaces/kube-system/services/kube-dns:9153/proxy/metrics").status, 0);
});
