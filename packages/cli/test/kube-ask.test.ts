/** The model's side of a cluster: the rules it is given, the lookups it may use, and the providers' use of both. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTools, clusterWorkloads, groundRules, summaryRequest, type AskContext } from "../src/advisor.js";
import { collectCluster } from "../src/kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { ask, summarize } from "../src/openai.js";
import type { ScanResult } from "../src/types.js";
import { fakeOpenAI, looksUp, says } from "./helpers.js";

const lab = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/kube-lab.json"), "utf8")) as {
  recordedAt: string;
  identity: { context: string; server: string };
  lookbackHours: number;
  responses: Record<string, unknown>;
};
const cluster = await collectCluster(
  { identity: async () => lab.identity, get: async (path) => lab.responses[path] },
  { lookbackHours: lab.lookbackHours, now: new Date(lab.recordedAt) },
);
const result = detectCluster(cluster, OPENCOST_DEFAULTS);
const account: ScanResult = { accountId: "1", regions: ["ap-south-1"], scannedAt: "", prices: { source: "price-file", fetchedAt: "" }, findings: [], totalMonthlyWasteUsd: 0, skippedByTag: [], warnings: [] };

test("the rules for an account are the AWS rules and nothing else", () => {
  const rules = groundRules(account);
  assert.match(rules, /^You are CloudPilot, a read-only cloud cost advisor for AWS\./);
  assert.match(rules, /priced every finding from the AWS Price List/);
  assert.match(rules, /Costs for snapshots and AMIs are upper bounds/);
  assert.match(rules, /Resources tagged cloudpilot:ignore=true were skipped on purpose/);
  assert.doesNotMatch(rules, /kubectl|namespace|cluster|node/i);
});

test("the rules for a cluster speak of the context and namespaces, the label, nodes and the usage history", () => {
  const rules = groundRules(result);
  assert.match(rules, /^You are CloudPilot, a read-only cost advisor for Kubernetes clusters\./);
  assert.match(rules, /read the cluster through kubectl/);
  assert.match(rules, /kubectl context where an AWS scan names an account, and namespaces where it names regions/);
  assert.match(rules, /Objects labelled or annotated cloudpilot\/ignore=true were skipped on purpose and are listed under skippedByTag \(a Kubernetes label, not an AWS tag\)/);
  assert.match(rules, /saves money only once the freed capacity lets the cluster run fewer or smaller nodes/);
  assert.match(rules, /Say how much history each one rests on/);
  assert.match(rules, /A warnings entry means part of the cluster could not be read/);
  assert.match(rules, /You cannot change anything in the cluster/);
  assert.doesNotMatch(rules, /AWS Price List|snapshots|AMIs|cloudpilot:ignore|in the account/);
});

test("what both kinds of rules say is the same words", () => {
  for (const sentence of [
    "Never estimate a number yourself; if the data does not contain it, say so.",
    "The fix commands are proposals for a human to review and run. Never say or imply that something was fixed, deleted or changed.",
    'Each fix carries a risk level and a "way back" note. When you recommend a fix marked dangerous, say what is permanent about it.',
    "Write plain text for a terminal: short paragraphs and simple lists, no Markdown tables or headings.",
  ]) {
    assert.ok(groundRules(account).includes(sentence), sentence);
    assert.ok(groundRules(result).includes(sentence), sentence);
  }
});

test("the summary request asks about the cluster, and for the history the findings rest on", () => {
  const request = summaryRequest(result);
  assert.match(request, /who owns this cluster/);
  assert.match(request, /how much usage history the requests findings rest on/);
  assert.match(request, /"totalMonthlyWasteUsd":"\$50\.64"/);
  assert.match(summaryRequest(account), /who owns this account/);
});

const askContext = (): AskContext => ({ result, cluster });

test("a cluster question gets the findings and the workloads, flagged or not, and nothing that reaches the cluster", async () => {
  const tools = buildTools(askContext());
  assert.deepEqual(tools.map((t) => t.name), ["list_findings", "get_cluster_workloads"]);
  const findings = JSON.parse(await tools[0]!.run({}));
  assert.equal(findings.totalMonthlyWasteUsd, "$50.64");
  assert.equal(findings.cluster.context, "kind-cloudpilot-lab");
  const workloads = JSON.parse(await tools[1]!.run({}));
  assert.deepEqual(workloads.workloads.map((w: { name: string }) => w.name).includes("web"), true);
  assert.equal(workloads.workloads.find((w: { name: string }) => w.name === "prometheus").skippedByLabel, true);
});

test("the workloads lookup is one piece of code, shared with the MCP server, which only adds how it gets a cluster", async () => {
  const shared = clusterWorkloads(async () => cluster);
  const mcp = clusterWorkloads(async () => cluster, " Runs scan_cluster with its defaults first if no cluster has been scanned yet.");
  assert.equal(await shared.run({}), await mcp.run({}));
  assert.equal(mcp.description, `${shared.description} Runs scan_cluster with its defaults first if no cluster has been scanned yet.`);
  assert.equal(buildTools(askContext())[1]!.description, shared.description);
});

test("OpenAI is given the cluster's rules and tools for a question, and again with each lookup's result", async () => {
  const model = await fakeOpenAI([looksUp("get_cluster_workloads"), says("deployment/web asks for what it uses.")]);
  Object.assign(process.env, model.env);
  const used: string[] = [];
  try {
    assert.equal(await ask("why not web?", { ...askContext(), llm: { model: "test-model" }, onToolUse: (name) => used.push(name) }), "deployment/web asks for what it uses.");
  } finally {
    model.close();
  }
  assert.deepEqual(used, ["get_cluster_workloads"]);
  assert.equal(model.requests.length, 2);
  for (const request of model.requests) assert.match(request.instructions, /^You are CloudPilot, a read-only cost advisor for Kubernetes clusters\./);
  assert.deepEqual(model.requests[0].tools.map((t: { name: string }) => t.name), ["list_findings", "get_cluster_workloads"]);
  assert.equal(JSON.parse(model.requests[1].input[0].output).context, "kind-cloudpilot-lab");
});

test("OpenAI summarises a cluster scan under the cluster's rules, and an account scan under the AWS ones", async () => {
  const model = await fakeOpenAI([says("one"), says("two")]);
  Object.assign(process.env, model.env);
  try {
    await summarize(result, { model: "test-model" });
    await summarize(account, { model: "test-model" });
  } finally {
    model.close();
  }
  assert.match(model.requests[0].instructions, /Kubernetes clusters/);
  assert.match(model.requests[0].input, /owns this cluster/);
  assert.match(model.requests[1].instructions, /^You are CloudPilot, a read-only cloud cost advisor for AWS\./);
  assert.match(model.requests[1].input, /owns this account/);
});
