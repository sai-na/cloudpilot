/** CloudPilot's promise is that it only reads. This test holds the code and the README to it. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli, cliRun, fakeKubectl } from "./helpers.js";
import { rig } from "./autopilot-rig.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = ["src/collect.ts", "src/pricing.ts", "src/preflight.ts"].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

/** Every AWS operation the code can call: `new XCommand(` and `paginateX(`. */
const called = [
  ...new Set([
    ...[...source.matchAll(/new (\w+)Command\(/g)].map((m) => m[1]!),
    ...[...source.matchAll(/\bpaginate(\w+)\(/g)].map((m) => m[1]!),
  ]),
].sort();

const readme = readFileSync(resolve(root, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("### Every AWS API call it makes"), readme.indexOf("## What it finds"));
const documented = [...section.matchAll(/^\| \w+ \| `(\w+)` \|/gm)].map((m) => m[1]!).sort();

test("every AWS operation in the code is a read", () => {
  assert.ok(called.length > 10, "found the operations");
  for (const operation of called) assert.match(operation, /^(Describe|List|Get)[A-Z]/, `${operation} is not a read`);
});

test("the README lists exactly the AWS operations the code calls", () => {
  assert.deepEqual(documented, called);
});

test("no other source file talks to AWS", () => {
  for (const file of ["advisor", "anomaly", "apply", "assistant", "audit", "autopilot", "detect", "evaluate", "html", "index", "mcp", "notify", "output-check", "report", "watch"]) {
    const text = readFileSync(resolve(root, `src/${file}.ts`), "utf8");
    assert.doesNotMatch(text, /@aws-sdk\/client-/, `${file}.ts imports an AWS client`);
  }
});

/** Every action the documented read-only policy allows, as written (wildcards intact). */
const policy = JSON.parse(readFileSync(resolve(root, "../../docs/cloudpilot-readonly-policy.json"), "utf8")) as {
  Statement: Array<{ Effect: string; Action: string[] }>;
};
const allowed = policy.Statement.flatMap((s) => s.Action);
const grants = (action: string) => allowed.some((a) => (a.endsWith("*") ? action.startsWith(a.slice(0, -1)) : a === action));

test("the documented policy allows reads only", () => {
  for (const statement of policy.Statement) assert.equal(statement.Effect, "Allow");
  for (const action of allowed) assert.match(action, /^[a-z0-9]+:(Describe|List|Get)/, `${action} is not a read`);
});

test("the documented policy grants every permission the README lists, and the README lists the new database read", () => {
  const permissions = [...section.matchAll(/^\| \w+ \| `\w+` \| (`[^|]+`|none needed) \|/gm)].map((m) => m[1]!).filter((p) => p !== "none needed");
  assert.equal(permissions.length, documented.length - 1, "every row but STS names a permission");
  for (const permission of permissions) assert.ok(grants(permission.replaceAll("`", "")), `${permission} is not in docs/cloudpilot-readonly-policy.json`);
  assert.ok(documented.includes("DescribeDBInstances"));
  assert.ok(grants("rds:DescribeDBInstances"));
  // The database read is asked for by name, not with a wildcard that would also allow rds:Download* or rds:Describe* beyond it.
  assert.ok(allowed.includes("rds:DescribeDBInstances"));
  assert.ok(!allowed.some((a) => a.startsWith("rds:") && a !== "rds:DescribeDBInstances"));
});

test("every AWS SDK package is pinned to one exact version", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  const sdk = Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@aws-sdk/"));
  for (const wanted of ["client-rds", "client-elastic-load-balancing-v2", "client-cost-explorer"]) assert.ok(sdk.some(([name]) => name === `@aws-sdk/${wanted}`), `${wanted} is a dependency`);
  for (const [name, version] of sdk) assert.equal(version, "3.929.0", `${name} must be pinned to exactly 3.929.0`);
});

test("the README lists the NAT gateway, load balancer and bill reads, and the policy names each one", () => {
  for (const operation of ["DescribeNatGateways", "DescribeLoadBalancers", "DescribeLoadBalancerAttributes", "DescribeTargetGroups", "DescribeTargetHealth", "DescribeTags", "GetCostAndUsage"]) {
    assert.ok(documented.includes(operation), `${operation} is in the README table`);
    assert.ok(called.includes(operation), `${operation} is called`);
  }
  // NAT gateways are read through ec2:Describe*, which the policy already holds.
  assert.ok(grants("ec2:DescribeNatGateways"));
  // Load balancers and the bill are asked for by name, never with a wildcard that would allow more.
  const elb = ["DescribeLoadBalancers", "DescribeLoadBalancerAttributes", "DescribeTargetGroups", "DescribeTargetHealth", "DescribeTags"].map((o) => `elasticloadbalancing:${o}`);
  for (const action of elb) assert.ok(allowed.includes(action), `${action} is in the policy`);
  assert.deepEqual(allowed.filter((a) => a.startsWith("elasticloadbalancing:")).sort(), elb.sort());
  assert.deepEqual(allowed.filter((a) => a.startsWith("ce:")), ["ce:GetCostAndUsage"]);
});

/**
 * The one paid call is made only by `scan --bill` and by `anomalies`, and each
 * says what it costs. That the call is made only when asked for is proved
 * against a recording in replay.test.ts and against a stand-in in
 * anomalies-cli.test.ts; here the reach of the flag and of the command is checked.
 */
test("the paid call is offered by scan --bill and by anomalies alone, each says what it costs, and no other command takes --bill", () => {
  const help = cli(["scan", "--help"], { blockNetwork: true });
  assert.equal(help.status, 0, help.stderr);
  const flags = help.stdout.replace(/\s+/g, " ");
  assert.match(flags, /--bill\b/, "scan offers the flag");
  assert.match(flags, /AWS charges \$0\.01 for this one request, so it is never made unless you ask/, "scan's help says what it costs");
  assert.match(readme, /AWS charges \$0\.01 for each Cost Explorer\s+request/);
  const anomalies = cli(["anomalies", "--help"], { blockNetwork: true });
  assert.equal(anomalies.status, 0, anomalies.stderr);
  assert.match(anomalies.stdout.replace(/\s+/g, " "), /AWS charges \$0\.01 for each Cost Explorer request, and this makes one\./, "anomalies' help says what it costs");
  assert.doesNotMatch(anomalies.stdout, /--bill/);
  // eval's own required option has to be given, or that is what it complains about first.
  for (const [command, ...before] of [["ask"], ["eval", "--manifest", "/dev/null"], ["mcp"], ["kube"], ["anomalies"]]) {
    const own = cli([command!, "--help"], { blockNetwork: true });
    assert.match(own.stdout, /Options:/, `${command} --help lists its options`);
    assert.doesNotMatch(own.stdout.replace(/\s+/g, " "), /--bill/, `${command} must not offer --bill`);
    const run = cli([command!, ...before, "--bill"], { blockNetwork: true });
    assert.notEqual(run.status, 0, `${command} --bill must be refused`);
    assert.match(run.stderr, /unknown option '--bill'/, `${command} --bill must be refused as an unknown option`);
  }
  // No other command reads Cost Explorer: not even a help page of theirs names the operation, and the MCP server has no such tool.
  for (const command of ["ask", "mcp", "kube", "watch", "init"]) {
    assert.doesNotMatch(cli([command, "--help"], { blockNetwork: true }).stdout, /Cost Explorer/, `${command} has no Cost Explorer option`);
  }
});

test("the landing page lists every call the README lists, and its count of kinds is right", () => {
  const page = readFileSync(resolve(root, "../../site/index.html"), "utf8");
  const table = page.slice(page.indexOf('<details id="api-calls">'), page.indexOf("</details>", page.indexOf('<details id="api-calls">')));
  const rows = [...table.matchAll(/<tr><td>\w+<\/td><td>(\w+)<\/td>/g)].map((m) => m[1]!).sort();
  assert.deepEqual(rows, documented);
  assert.match(table, new RegExp(`makes: ${documented.length} kinds, none of which can change anything`));
});

/**
 * The promise for watch: it only reads unless --autopilot is given. A watch
 * with fixes waiting to be run, and stand-in aws and kubectl programs on the
 * PATH that write down every start, starts none of them.
 */
test("watch without --autopilot starts no aws and no kubectl write, on an account with fixes it could run and on a cluster", async () => {
  const account = await rig({ volumes: [{ id: "vol-0a1b2c3d4e5f60001", attachedTo: "i-0a1b2c3d4e5f60003" }], buckets: [{ name: "neglected" }] });
  try {
    const run = await account.run(account.watchArgs());
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /gp2 volume can move to gp3/, "the fixes were there to be run");
    assert.deepEqual(account.calls(), [], "no stand-in aws or kubectl was started");
    assert.ok(account.requests.length > 5 && account.requests.every((q) => (q.action ? /^(Describe|Get)[A-Z]/.test(q.action) : q.method === "GET")), "and AWS was sent only reads");
    assert.equal(existsSync(account.file("audit.jsonl")), false);
    assert.match(run.stderr, /read-only\./);
  } finally {
    await account.close();
  }

  // The cluster: the stand-in kubectl is started to read, and only to read.
  const kubectl = fakeKubectl(resolve(root, "test/fixtures/kube-lab.json"));
  const run = await cliRun(["watch", "--kube", "--max-runs", "1", "--lookback-hours", "1"], { env: kubectl.env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /requests more than it uses/, "the cluster has a fix it could run");
  const calls = kubectl.calls();
  assert.ok(calls.length > 3);
  for (const call of calls) {
    const rest = call[0] === "--context" ? call.slice(2) : call;
    assert.ok((rest[0] === "get" && rest[1] === "--raw") || rest.join(" ") === "config view --minify -o json", `kubectl ${call.join(" ")}`);
  }
  assert.match(run.stderr, /read-only\./);
});
