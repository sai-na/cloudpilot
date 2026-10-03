import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AskContext } from "../src/advisor.js";
import { ask } from "../src/openai.js";

/** A stand-in for the Responses endpoint that replays scripted outputs and records requests. */
async function fakeOpenAI(outputs: object[][]) {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `resp_${requests.length}`, object: "response", status: "completed", model: "test", output: outputs[requests.length - 1] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  return { requests, close: () => server.close() };
}

const ctx = (used: string[]): AskContext => ({
  result: { accountId: "1", regions: ["ap-south-1"], scannedAt: "", prices: { source: "price-file", fetchedAt: "" }, findings: [], totalMonthlyWasteUsd: 42, skippedByTag: [], warnings: [] },
  inventories: [{ accountId: "1", region: "ap-south-1", collectedAt: "", volumes: [], snapshots: [], images: [], instances: [], rdsInstances: [], addresses: [], launchTemplateImageIds: [], buckets: [], warnings: [] }],
  prices: [{ region: "ap-south-1", source: "price-file", fetchedAt: "", ebsGbMonth: {}, snapshotGbMonth: 0, idleIpv4Hour: 0, instanceHour: {}, s3StandardGbMonth: 0 }],
  cpuHistory: async () => undefined,
  llm: { model: "test-model" },
  onToolUse: (name) => used.push(name),
});

test("ask runs the tools the model asks for and returns its final answer", async () => {
  const call = (call_id: string, name: string, args: string) => ({ type: "function_call", id: `fc_${call_id}`, call_id, name, arguments: args, status: "completed" });
  const fake = await fakeOpenAI([
    [call("c1", "list_findings", "{}"), call("c2", "get_inventory", '{"kind":"nonsense"}')],
    [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "  Total waste is $42.  ", annotations: [] }] }],
  ]);
  const used: string[] = [];
  try {
    assert.equal(await ask("how much?", ctx(used)), "Total waste is $42.");
  } finally {
    fake.close();
  }
  assert.deepEqual(used, ["list_findings", "get_inventory"]);
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.requests[0].tools.map((t: any) => t.name), ["list_findings", "get_inventory", "get_prices", "get_cpu_history"]);

  // The second request continues the first and carries both tool results, matched to their calls.
  assert.equal(fake.requests[1].previous_response_id, "resp_1");
  const results = fake.requests[1].input;
  assert.deepEqual(results.map((m: any) => [m.type, m.call_id]), [["function_call_output", "c1"], ["function_call_output", "c2"]]);
  assert.equal(JSON.parse(results[0].output).totalMonthlyWasteUsd, "$42.00");
  assert.match(results[1].output, /Unknown kind/);
});

test("a model that never answers costs two short waits, then the scan ends with the templated summary and says why", async () => {
  // A server that accepts the request and then says nothing.
  const { createServer: listen } = await import("node:http");
  const { cli, FIXTURE } = await import("./helpers.js");
  const silent = listen(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const port = (silent.address() as AddressInfo).port;
  try {
    const started = Date.now();
    const run = cli(["scan", "--replay", FIXTURE, "--explain", "--live-llm", "--model", "any"], {
      env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, NO_PROXY: "127.0.0.1", CLOUDPILOT_MODEL_TIMEOUT_MS: "400" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(Date.now() - started < 20_000, "it gave up instead of waiting ten minutes");
    assert.match(run.stderr, /AI explanations are unavailable: .*timed out.*Showing the templated summary instead\./i);
    assert.match(run.stdout, /Estimated waste: \$151\.53 per month across 10 findings/);
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
});
