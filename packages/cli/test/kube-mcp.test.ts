/**
 * The MCP server's cluster tools, driven by the official MCP client. The
 * server runs live (a recording holds no cluster), with every socket blocked
 * and kubectl replaced by a stand-in that serves the recorded lab.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
  assert.match(client.getInstructions() ?? "", /For a Kubernetes cluster, call "scan_cluster"/);
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
  const workloads = JSON.parse(text(await client.callTool({ name: "get_cluster_workloads", arguments: {} })));
  const named = (name: string) => workloads.find((w: { name: string }) => w.name === name);
  // Sized right: it uses the CPU and memory it requests.
  const web = named("web").containers[0];
  assert.deepEqual([web.cpuRequest, web.memoryRequest, web.memoryPeak, web.killedForMemory], ["100m", "64Mi", "49Mi", false]);
  assert.ok(Number.parseInt(web.cpuPeak, 10) >= 90, web.cpuPeak);
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

test("through the MCP server too, kubectl is only ever asked to read", () => {
  const calls = kubectl.calls();
  assert.ok(calls.length > 10);
  for (const call of calls) {
    const rest = call[0] === "--context" ? call.slice(2) : call;
    assert.ok(rest.slice(0, 2).join(" ") === "get --raw" || rest.join(" ") === "config view --minify -o json", `kubectl ${call.join(" ")}`);
  }
});
