/**
 * The MCP server's cluster tools, driven by the official MCP client. The
 * server runs live (a recording holds no cluster), with every socket blocked
 * and kubectl replaced by a stand-in that serves the recorded lab.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, fakeKubectl, TSX } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const kubectl = fakeKubectl(resolve(here, "fixtures/kube-lab.json"));
const client = new Client({ name: "cloudpilot-test", version: "0" });
const text = (result: unknown) => (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;

before(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--require", resolve(here, "block-network.cjs"), "--import", TSX, CLI, "mcp"],
      cwd: mkdtempSync(join(tmpdir(), "cloudpilot-mcp-")),
      env: { ...kubectl.env, HOME: process.env.HOME ?? "", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" },
      stderr: "ignore",
    }),
  );
});

after(() => client.close());

test("a live server offers the cluster tools next to the account ones, every one marked read-only", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["scan", "list_findings", "get_inventory", "get_prices", "get_cpu_history", "scan_cluster", "get_cluster_workloads"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is marked read-only`);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /For a Kubernetes cluster, call "scan_cluster"/);
  // The AWS ignore tag is not a legal Kubernetes label key: the model must be given the cluster form.
  assert.match(instructions, /cloudpilot\/ignore=true/);
});

test("scan_cluster says what it read and at what prices, then gives the summary and every finding", async () => {
  const result = await client.callTool({ name: "scan_cluster", arguments: { lookback_hours: 1 } });
  assert.equal(result.isError, false, text(result));
  const body = text(result);
  assert.match(body, /^Cluster kind-cloudpilot-lab, 4 namespaces scanned, scanned \S+\nPrices: \$0\.031611 per vCPU-hour, .*\(OpenCost defaults/);
  assert.match(body, /\nUsage: Prometheus at monitoring\/prometheus:9090, the last 1 hour\n/);
  assert.match(body, /Estimated waste: \$50\.64 per month across 5 findings in 1 of the 4 namespaces scanned\./);
  assert.match(body, /Lower requests save money once the freed capacity lets the cluster run fewer or smaller nodes\./);

  const scan = JSON.parse(body.slice(body.indexOf("{", body.indexOf("Findings as JSON:"))));
  assert.equal(scan.cluster.context, "kind-cloudpilot-lab");
  assert.equal(scan.totalMonthlyWasteUsd, "$50.64");
  assert.deepEqual(scan.findings.map((f: { resourceIds: string[]; monthlyCostUsd: string }) => [f.resourceIds[0], f.monthlyCostUsd]), [
    ["deployment/reports", "$24.43"],
    ["deployment/checkout", "$22.61"],
    ["deployment/search", "$3.00"],
    ["persistentvolume/archive-2025", "$0.40"],
    ["persistentvolumeclaim/old-exports", "$0.20"],
  ]);
  assert.equal(scan.findings[0].fix.commands[0], "kubectl set resources deployment/reports -n shop --context kind-cloudpilot-lab -c worker --requests=cpu=10m,memory=32Mi");
});

test("get_cluster_workloads shows what was not flagged, and why", async () => {
  const read = JSON.parse(text(await client.callTool({ name: "get_cluster_workloads", arguments: {} })));
  const named = (name: string) => read.workloads.find((w: { name: string }) => w.name === name);
  // Sized right: it uses the CPU and memory it requests.
  const web = named("web").containers[0];
  assert.deepEqual([web.cpuRequest, web.memoryRequest, web.memoryPeak, web.killedForMemory], ["100m", "64Mi", "49Mi", false]);
  // It peaked at 100.019m against a 100m request: rounded up, never down, so the peak never reads as less than it was.
  assert.equal(web.cpuPeak, "101m");
  // Killed for memory once: the reason its memory request is left alone.
  assert.equal(named("importer").containers[0].killedForMemory, true);
  assert.equal(named("prometheus").skippedByLabel, true);
  assert.deepEqual([named("reports").replicas, named("reports").containers[0].cpuRequest, named("reports").containers[0].cpuPeak], [3, "300m", "0"]);
});

test("a cluster that cannot be read is an error result the model can act on", async () => {
  const result = await client.callTool({ name: "scan_cluster", arguments: { lookback_hours: 1, namespace: "not-recorded" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /NotFound/);
});

test("a namespace that is not a Kubernetes name is refused before anything is read", async () => {
  const before = kubectl.calls().length;
  const result = await client.callTool({ name: "scan_cluster", arguments: { namespace: 'shop"} or on(1) other{' } });
  assert.equal(result.isError, true);
  assert.match(text(result), /is not a Kubernetes namespace name/);
  assert.equal(kubectl.calls().length, before, "nothing was read for a namespace that cannot name one");
});

test("the workloads carry the identity of the scan they came from, not of a scan that failed", async () => {
  // The scan above failed and left the earlier one in place: the payload must say which cluster and namespaces it describes.
  const read = JSON.parse(text(await client.callTool({ name: "get_cluster_workloads", arguments: {} })));
  assert.equal(read.context, "kind-cloudpilot-lab");
  assert.deepEqual(read.namespaces, ["default", "local-path-storage", "monitoring", "shop"]);
  assert.equal(read.prometheus, "monitoring/prometheus:9090");
  assert.equal(read.lookbackHours, 1);
  assert.match(read.collectedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a cluster only half readable says so, rather than reading as a cluster without Deployments", async () => {
  // Only ReplicaSets are unreadable, as an RBAC rule that allows pods but not apps/v1 would leave them.
  const lab = JSON.parse(readFileSync(resolve(here, "fixtures/kube-lab.json"), "utf8"));
  for (const path of Object.keys(lab.responses)) if (path.includes("replicasets")) delete lab.responses[path];
  const file = join(mkdtempSync(join(tmpdir(), "cloudpilot-half-lab-")), "kube-lab.json");
  writeFileSync(file, JSON.stringify(lab));

  const half = fakeKubectl(file);
  const blind = new Client({ name: "cloudpilot-test", version: "0" });
  await blind.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--require", resolve(here, "block-network.cjs"), "--import", TSX, CLI, "mcp"],
      cwd: mkdtempSync(join(tmpdir(), "cloudpilot-mcp-")),
      env: { ...half.env, HOME: process.env.HOME ?? "", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" },
      stderr: "ignore",
    }),
  );
  try {
    const read = JSON.parse(text(await blind.callTool({ name: "get_cluster_workloads", arguments: {} })));
    // Every Deployment is missing: a pod's Deployment is only known through its ReplicaSet.
    assert.deepEqual(read.workloads.filter((w: { kind: string }) => w.kind === "Deployment"), []);
    assert.ok(
      read.warnings.some((w: string) => /^ReplicaSets could not be read/.test(w)),
      `the payload must say what it could not read: ${JSON.stringify(read.warnings)}`,
    );
  } finally {
    await blind.close();
  }
});

test("through the MCP server too, kubectl is only ever asked to read", () => {
  const calls = kubectl.calls();
  assert.ok(calls.length > 10);
  for (const call of calls) {
    const rest = call[0] === "--context" ? call.slice(2) : call;
    assert.ok(rest.slice(0, 2).join(" ") === "get --raw" || rest.join(" ") === "config view --minify -o json", `kubectl ${call.join(" ")}`);
  }
});
