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
  inventories: [{ accountId: "1", region: "ap-south-1", collectedAt: "", volumes: [], snapshots: [], images: [], instances: [], addresses: [], launchTemplateImageIds: [], buckets: [], warnings: [] }],
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
