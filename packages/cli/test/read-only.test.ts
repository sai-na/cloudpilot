/** CloudPilot's promise is that it only reads. This test holds the code and the README to it. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = ["src/collect.ts", "src/pricing.ts"].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

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
  for (const file of ["advisor", "assistant", "detect", "evaluate", "html", "index", "mcp", "output-check", "report"]) {
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

test("the one paid call is made only when the scan is asked for the bill", () => {
  const index = readFileSync(resolve(root, "src/index.ts"), "utf8");
  const collect = readFileSync(resolve(root, "src/collect.ts"), "utf8");
  // Cost Explorer is reached from one place, behind the flag.
  assert.deepEqual([...source.matchAll(/new GetCostAndUsageCommand\(/g)].length, 1);
  assert.equal([...index.matchAll(/readBill\(/g)].length, 1, "index.ts calls readBill once");
  assert.match(index, /options\.bill \? withBill\(merged, await readBill\(/);
  assert.equal([...collect.matchAll(/\breadBill\(/g)].length, 1, "collect.ts only defines it: scanning a region never reads the bill");
  assert.match(index, /\.option\("--bill", ".*\$0\.01 for this one request.*never made unless you ask"\)/);
  assert.match(readme, /AWS charges \$0\.01 for each Cost Explorer\s+request/);
  // The flag is on scan alone: ask, eval, mcp and kube cannot spend it.
  assert.equal([...index.matchAll(/\.option\("--bill"/g)].length, 1);
  assert.doesNotMatch(index.slice(index.indexOf("function withCommonOptions"), index.indexOf("const VERSION")), /--bill/);
});

test("the landing page lists every call the README lists, and its count of kinds is right", () => {
  const page = readFileSync(resolve(root, "../../site/index.html"), "utf8");
  const table = page.slice(page.indexOf('<details id="api-calls">'), page.indexOf("</details>", page.indexOf('<details id="api-calls">')));
  const rows = [...table.matchAll(/<tr><td>\w+<\/td><td>(\w+)<\/td>/g)].map((m) => m[1]!).sort();
  assert.deepEqual(rows, documented);
  assert.match(table, new RegExp(`makes: ${documented.length} kinds, none of which can change anything`));
});
