import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareScans } from "../src/compare.js";
import { collectCluster } from "../src/kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { allowedValues, unsupportedValues } from "../src/output-check.js";
import { templatedSummary } from "../src/report.js";
import type { Finding, ScanResult } from "../src/types.js";

const finding = (id: string, cost: number, extra: Partial<Finding> = {}): Finding => ({
  region: "ap-south-1",
  pattern: "unattached-ebs-volume",
  title: "Unattached 500 GB gp2 volume",
  resourceType: "AWS::EC2::Volume",
  resourceIds: [id],
  evidence: ["State is available"],
  monthlyCostUsd: cost,
  costBasis: "500 GB x $0.114/GB-month (gp2)",
  fix: { commands: [`aws ec2 delete-volume --volume-id ${id}`], risk: "dangerous", rollback: "Permanent." },
  confidence: 0.95,
  ...extra,
});

const result: ScanResult = {
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "2026-10-03T00:00:00Z" },
  findings: [
    finding("vol-0e689fadd62ef9054", 57, {
      alternative: { commands: ["aws ec2 modify-volume"], risk: "caution", rollback: "Reversible.", description: "Convert to gp3", monthlySavingUsd: 11.4 },
    }),
    finding("vol-0dda4dbd98e6572b8", 18.24),
  ],
  totalMonthlyWasteUsd: 75.24,
  skippedByTag: ["vol-0aaaaaaaaaaaaaaaa"],
  warnings: [],
};
const allowed = allowedValues(result);

test("text that only repeats scan values is accepted", () => {
  const text = "Fix vol-0e689fadd62ef9054 first: $57/month, or save $11.40 by converting. Total $75.24. gp2 is $0.114 per GB.";
  assert.deepEqual(unsupportedValues(text, allowed), []);
});

test("an invented volume ID is rejected", () => {
  assert.deepEqual(unsupportedValues("Also delete vol-0123456789abcdef0, it costs $57.", allowed), ["vol-0123456789abcdef0"]);
});

test("an invented or recomputed dollar amount is rejected", () => {
  assert.deepEqual(unsupportedValues("That is $902.88 per year.", allowed), ["$902.88"]);
  assert.deepEqual(unsupportedValues("Both volumes together cost $75.25.", allowed), ["$75.25"]);
});

test("the templated summary passes its own check and reports skipped resources", () => {
  const summary = templatedSummary(result);
  assert.deepEqual(unsupportedValues(summary, allowed), []);
  assert.match(summary, /Estimated waste: \$75\.24 per month across 2 findings/);
  assert.match(summary, /1 resource was skipped because of the tag cloudpilot:ignore=true: vol-0aaaaaaaaaaaaaaaa/);
  assert.match(summary, /Nothing has been changed/);
});

test("across several regions the templated summary says where the waste is", () => {
  const multi: ScanResult = {
    ...result,
    regions: ["ap-south-1", "eu-west-1", "us-east-1"],
    findings: [finding("vol-0e689fadd62ef9054", 57), finding("vol-0dda4dbd98e6572b8", 18.24, { region: "us-east-1" })],
  };
  const summary = templatedSummary(multi);
  assert.match(summary, /across 2 findings in 2 of the 3 regions scanned\./);
  assert.match(summary, /By region:\n- ap-south-1: 1 finding, \$57\.00 per month\.\n- us-east-1: 1 finding, \$18\.24 per month\.\n- 1 other region: nothing found\./);
  assert.deepEqual(unsupportedValues(summary, allowedValues(multi)), []);
});

// A cluster's text is held to the same standard: the objects, namespaces and figures it names must be in the scan.

const lab = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/kube-lab.json"), "utf8")) as {
  recordedAt: string;
  identity: { context: string; server: string };
  lookbackHours: number;
  responses: Record<string, unknown>;
};
const inventory = await collectCluster(
  {
    identity: async () => lab.identity,
    get: async (path) => {
      if (!(path in lab.responses)) throw new Error(`NotFound: ${path}`);
      return lab.responses[path];
    },
  },
  { lookbackHours: lab.lookbackHours, now: new Date(lab.recordedAt) },
);
const clusterResult = detectCluster(inventory, OPENCOST_DEFAULTS);
const fromFindings = allowedValues(clusterResult);
const fromLookups = allowedValues(clusterResult, { cluster: inventory });

test("a cluster text that only repeats scan values is accepted", () => {
  const text = [
    "Shrink deployment/reports first: its container worker requests 300m CPU and 512Mi of memory and used under 1m and under 1Mi.",
    "That is $24.43 a month, and $50.64 for all five findings, at $0.031611 per vCPU-hour.",
    "kubectl set resources deployment/reports -n shop --context kind-cloudpilot-lab -c worker --requests=cpu=10m,memory=32Mi",
    "Also shop/deployment/checkout ($22.61), deployment/search, persistentvolume/archive-2025 and persistentvolumeclaim/old-exports.",
    "monitoring/deployment/prometheus was skipped by its label.",
  ].join("\n");
  assert.deepEqual(unsupportedValues(text, fromFindings), []);
});

test("an invented workload, volume or qualified name is rejected", () => {
  const bad = (text: string) => unsupportedValues(text, fromFindings);
  assert.deepEqual(bad("Also shrink deployment/ghost."), ["deployment/ghost"]);
  assert.deepEqual(bad("Delete persistentvolumeclaim/scratch."), ["persistentvolumeclaim/scratch"]);
  assert.deepEqual(bad("Scale statefulset/db and daemonset/agent."), ["statefulset/db", "daemonset/agent"]);
  // A real workload in the wrong namespace, and an invented one in the right one.
  assert.deepEqual(bad("Look at payments/deployment/reports."), ["payments/deployment/reports"]);
  assert.deepEqual(bad("Look at shop/deployment/ghost."), ["shop/deployment/ghost"]);
  // A volume belongs to no namespace.
  assert.deepEqual(bad("Look at shop/persistentvolume/archive-2025."), ["shop/persistentvolume/archive-2025"]);
  // However it is wrapped, and even as one path of a longer one.
  assert.deepEqual(bad("`deployment/ghost`, (deployment/phantom)"), ["deployment/ghost", "deployment/phantom"]);
  assert.deepEqual(bad("namespace/shop/deployment/ghost"), ["shop/deployment/ghost"]);
});

test("a workload the scan read but did not flag may be named once the model was given the workloads", () => {
  assert.deepEqual(unsupportedValues("deployment/web is sized right.", fromFindings), ["deployment/web"]);
  assert.deepEqual(unsupportedValues("deployment/web is sized right, as is shop/deployment/importer.", fromLookups), []);
  // Read is not the same as flagged: a claim the model was never shown stays out of reach.
  assert.deepEqual(unsupportedValues("persistentvolumeclaim/other is fine.", fromLookups), ["persistentvolumeclaim/other"]);
  // What it was shown of the workloads includes their quantities, but not figures the scan never computed.
  assert.deepEqual(unsupportedValues("web requests 100m and 64Mi.", fromLookups), []);
  assert.deepEqual(unsupportedValues("web requests 100m and 64Mi.", fromFindings), ["100m", "64Mi"]);
});

test("a figure that is not in the cluster scan is rejected, and so is a unit converted", () => {
  const bad = (text: string) => unsupportedValues(text, fromFindings);
  assert.deepEqual(bad("That saves $24.44, or $293.16 a year."), ["$24.44", "$293.16"]);
  assert.deepEqual(bad("Lower it to 50m CPU and 128Mi."), ["50m", "128Mi"]);
  // The scan says 1Gi: 1024Mi is the same number, but not one the scan gave.
  assert.deepEqual(bad("The indexer requests 1Gi."), []);
  assert.deepEqual(bad("The indexer requests 1024Mi, which is 1.5Gi."), ["1024Mi", "1.5Gi"]);
  // A unit price the scan used is fine; one it did not is not.
  assert.deepEqual(bad("$0.04 per GiB-month"), []);
  assert.deepEqual(bad("$0.05 per GiB-month"), ["$0.05"]);
});

test("the prices a cluster was costed with may be quoted even when no finding's note carries them", () => {
  const mine = { ...clusterResult, cluster: { ...clusterResult.cluster!, prices: { ...clusterResult.cluster!.prices, source: "command-line" as const, cpuHourUsd: 0.07 } } };
  assert.deepEqual(unsupportedValues("At $0.07 per vCPU-hour.", allowedValues({ ...mine, findings: [] })), []);
  assert.deepEqual(unsupportedValues("At $0.08 per vCPU-hour.", allowedValues({ ...mine, findings: [] })), ["$0.08"]);
});

test("a command may only point at the cluster and namespaces the scan covered", () => {
  const bad = (text: string) => unsupportedValues(text, fromFindings);
  assert.deepEqual(bad("kubectl get pods -n shop --context kind-cloudpilot-lab"), []);
  assert.deepEqual(bad("kubectl get pods --namespace=monitoring"), []);
  assert.deepEqual(bad("kubectl get pods -n payments"), ["-n payments"]);
  assert.deepEqual(bad("kubectl get pods --namespace billing --context prod-eu."), ["--namespace billing", "--context prod-eu."]);
  // The sentence's own full stop is not part of the context.
  assert.deepEqual(bad("Run it with --context kind-cloudpilot-lab."), []);
  // A placeholder is not a name, and "-n" outside a kubectl line is prose.
  assert.deepEqual(bad("kubectl get pods -n <namespace>\nIt is shown with -n alone, as in -n payments."), []);
});

test("ordinary words, and the names of kinds, are not taken for objects", () => {
  const prose = [
    "Each deployment/statefulset pair is judged on its own.",
    "Deployments, StatefulSets and DaemonSets are judged; a persistent volume claim is not a Deployment/StatefulSet.",
    "The build/deploy/test pipeline and a rolling deployment of the web tier.",
    "Read https://kubernetes.io/docs/concepts/workloads/controllers/deployment/rollout for how a rollout works.",
    "See docs/deployment-guide, replica/deployment counts, and the persistentvolumeclaim/ prefix.",
    "A pvc/pv pair, sts/db and deploy/web are short forms that no scan prints.",
    "It held about 5 minutes of history, 10 mins of load, a GiB of memory and 2 CPUs.",
    "That is 3 replicas over 168 hours at 90% confidence in 1 of the 4 namespaces.",
  ].join("\n");
  assert.deepEqual(unsupportedValues(prose, fromFindings), []);
});

test("an account scan is checked as before, and its text is not held to cluster forms", () => {
  assert.deepEqual(unsupportedValues("Keep deployment/ghost and 300m of it, -n anywhere.", allowed), []);
});

test("what a comparison resolved is still the scan's to name", () => {
  const next = { ...detectCluster({ ...inventory, workloads: inventory.workloads.filter((w) => w.name !== "reports") }, OPENCOST_DEFAULTS), scannedAt: "2026-10-04T00:00:00Z" };
  const compared = compareScans(clusterResult, next)!;
  assert.ok(compared.comparison!.resolved.length > 0);
  assert.deepEqual(unsupportedValues("deployment/reports is resolved: $24.43 a month less.", allowedValues(compared)), []);
  assert.deepEqual(unsupportedValues("deployment/reports is resolved.", allowedValues(next)), ["deployment/reports"]);
});
