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
  assert.ok(sdk.some(([name]) => name === "@aws-sdk/client-rds"));
  for (const [name, version] of sdk) assert.equal(version, "3.929.0", `${name} must be pinned to exactly 3.929.0`);
});
