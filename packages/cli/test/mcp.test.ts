/**
 * The MCP server, driven by the official MCP client over stdio. Offline: the
 * server replays the committed recording with every socket blocked.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, FIXTURE, TSX } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "cloudpilot-test", version: "0" });

const text = (result: unknown) => (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;

before(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--require", resolve(here, "block-network.cjs"), "--import", TSX, CLI, "mcp", "--replay", FIXTURE],
      cwd: mkdtempSync(join(tmpdir(), "cloudpilot-mcp-")),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" },
      stderr: "ignore",
    }),
  );
});

after(() => client.close());

test("the handshake names the server and tells the model how to use it", () => {
  assert.equal(client.getServerVersion()?.name, "cloudpilot");
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /read-only/);
  assert.match(instructions, /cannot change anything/);
});

test("it offers five tools, every one marked read-only", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["scan", "list_findings", "get_inventory", "get_prices", "get_cpu_history"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is marked read-only`);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("scan returns the summary and every finding, and says it is a replay", async () => {
  const result = await client.callTool({ name: "scan", arguments: {} });
  assert.equal(result.isError, false);
  const body = text(result);
  assert.match(body, /^REPLAY MODE: recorded \S+ from account 123456789012, region ap-south-1\. No live calls\./);
  assert.match(body, /Estimated waste: \$151\.53 per month across 10 findings in ap-south-1\./);
  const findings = JSON.parse(body.slice(body.indexOf("{", body.indexOf("Findings as JSON:")))).findings;
  assert.equal(findings.length, 10);
  assert.equal(findings[0].monthlyCostUsd, "$57.00");
  assert.match(findings[0].fix.commands[0], /^aws ec2 delete-volume /);
});

test("the lookups read from that scan", async () => {
  const volumes = text(await client.callTool({ name: "get_inventory", arguments: { kind: "volumes" } }));
  const listed = JSON.parse(volumes.slice(volumes.indexOf("[")));
  assert.equal(listed.length, 5);
  assert.ok(listed.every((v: { region: string }) => v.region === "ap-south-1"));

  const prices = text(await client.callTool({ name: "get_prices", arguments: {} }));
  assert.match(prices, /"gp2":0\.114/);
});

test("a lookup the recording does not hold is an error result, not a silent live call", async () => {
  const instances = text(await client.callTool({ name: "get_inventory", arguments: { kind: "instances" } }));
  const running = JSON.parse(instances.slice(instances.indexOf("["))).find((i: { state: string }) => i.state === "running");
  const result = await client.callTool({ name: "get_cpu_history", arguments: { instance_id: running.id, hours: 3 } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Replay: no recorded response for CloudWatch GetMetricData/);
});

test("an unknown tool is refused", async () => {
  await assert.rejects(client.callTool({ name: "delete_everything", arguments: {} }), /Unknown tool: delete_everything/);
});
