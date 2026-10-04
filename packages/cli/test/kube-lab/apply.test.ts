/**
 * apply, for real, against the Kubernetes waste lab (a kind cluster on this
 * machine). It works in a namespace of its own, which it creates and removes,
 * so the lab's seeded workloads are never touched.
 * Run: npm run test:kube-lab
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ScanResult } from "../../src/types.js";
import { CLI, TSX } from "../helpers.js";

const CONTEXT = "kind-cloudpilot-lab";
const NAMESPACE = "cloudpilot-apply-test";
const kubectl = (...args: string[]) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });
const request = () => kubectl("-n", NAMESPACE, "get", "deployment", "apply-target", "-o", "jsonpath={.spec.template.spec.containers[0].resources.requests.cpu}");

const MANIFEST = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: apply-target
  namespace: ${NAMESPACE}
  labels: { cloudpilot/ignore: "true" }
spec:
  replicas: 1
  selector:
    matchLabels: { app: apply-target }
  template:
    metadata:
      labels: { app: apply-target }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: app
          image: busybox:1.36
          command: ["sleep", "infinity"]
          resources:
            requests: { cpu: 200m, memory: 16Mi }
`;

before(() => {
  spawnSync("kubectl", ["--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=true"], { encoding: "utf8" });
  execFileSync("kubectl", ["--context", CONTEXT, "apply", "-f", "-"], { input: MANIFEST, encoding: "utf8" });
});

after(() => {
  spawnSync("kubectl", ["--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=false"], { encoding: "utf8" });
});

test("apply lowers a real workload's request, records it, and the way back it recorded restores it", () => {
  const set = (cpu: string) => `kubectl set resources deployment/apply-target -n ${NAMESPACE} --context ${CONTEXT} -c app --requests=cpu=${cpu}`;
  const scan: ScanResult = {
    accountId: CONTEXT,
    regions: [NAMESPACE],
    scannedAt: new Date().toISOString(),
    prices: { source: "opencost-defaults", fetchedAt: "" },
    findings: [
      {
        region: NAMESPACE,
        pattern: "over-requested-workload",
        title: "Deployment apply-target requests more than it uses",
        resourceType: "Deployment",
        resourceIds: ["deployment/apply-target"],
        evidence: [],
        monthlyCostUsd: 4.38,
        costBasis: "",
        fix: { commands: [set("10m")], risk: "caution", rollback: `To go back: ${set("200m")}.` },
        confidence: 0.4,
      },
    ],
    totalMonthlyWasteUsd: 4.38,
    skippedByTag: [],
    warnings: [],
    cluster: { context: CONTEXT, lookbackHours: 1, prices: { source: "opencost-defaults", cpuHourUsd: 0.031611, memoryGibHourUsd: 0.004237, storageGibMonthUsd: 0.04 } },
  };
  const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-apply-lab-"));
  mkdirSync(join(cwd, ".cloudpilot"));
  writeFileSync(join(cwd, ".cloudpilot", `last-kube-scan-${CONTEXT}.json`), JSON.stringify(scan));
  const cloudpilot = (...args: string[]) => spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, NO_COLOR: "1" } });

  assert.equal(request(), "200m");
  // Unattended and unapproved: refused, and the cluster is as it was.
  assert.equal(cloudpilot("apply", "deployment/apply-target").status, 1);
  assert.equal(request(), "200m");

  const run = cloudpilot("apply", "deployment/apply-target", "--yes");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(request(), "10m");

  const entries = readFileSync(join(cwd, ".cloudpilot/audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.map((e) => e.outcome), ["refused", "applied"]);
  assert.equal(entries[1].commands[0].exitCode, 0);

  // The way back is a command of the same kind: run exactly what the record says.
  const back = /To go back: (kubectl .*)\.$/.exec(entries[1].wayBack)![1]!.split(" ");
  execFileSync(back[0]!, back.slice(1), { encoding: "utf8" });
  assert.equal(request(), "200m");
});
