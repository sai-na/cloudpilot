/** CloudPilot's promise is that it only reads. This test holds the code and the README to it. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  for (const file of ["advisor", "assistant", "detect", "evaluate", "html", "index", "mcp", "output-check", "report"]) {
    const text = readFileSync(resolve(root, `src/${file}.ts`), "utf8");
    assert.doesNotMatch(text, /@aws-sdk\/client-/, `${file}.ts imports an AWS client`);
  }
});
