import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compareScans } from "../src/compare.js";
import { allowedValues, unsupportedValues } from "../src/output-check.js";
import { renderText, templatedSummary } from "../src/report.js";
import type { Finding, ScanResult } from "../src/types.js";
import { cli, FIXTURE } from "./helpers.js";

const finding = (id: string, cost: number, region = "ap-south-1"): Finding => ({
  region,
  pattern: "unattached-ebs-volume",
  title: `Unattached volume ${id}`,
  resourceType: "AWS::EC2::Volume",
  resourceIds: [id],
  evidence: [],
  monthlyCostUsd: cost,
  costBasis: "",
  fix: { commands: [`aws ec2 delete-volume --volume-id ${id}`], risk: "dangerous", rollback: "" },
  confidence: 0.95,
});

const scan = (findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult => ({
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "" },
  findings,
  totalMonthlyWasteUsd: findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0),
  skippedByTag: [],
  warnings: [],
  ...extra,
});

const yesterday = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0bbbbbbbbbbbbbbbb", 18.24)], { scannedAt: "2026-10-02T00:00:00Z" });

test("a repeat scan marks what is new and lists what was resolved", () => {
  const today = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0cccccccccccccccc", 9.12)]);
  const result = compareScans(yesterday, today)!;
  assert.deepEqual(result.findings.map((f) => [f.resourceIds[0], f.isNew]), [["vol-0aaaaaaaaaaaaaaaa", false], ["vol-0cccccccccccccccc", true]]);
  assert.deepEqual(result.comparison, {
    previousScannedAt: "2026-10-02T00:00:00Z",
    newCount: 1,
    newMonthlyUsd: 9.12,
    resolved: [{ title: "Unattached volume vol-0bbbbbbbbbbbbbbbb", region: "ap-south-1", resourceIds: ["vol-0bbbbbbbbbbbbbbbb"], monthlyCostUsd: 18.24 }],
    resolvedMonthlyUsd: 18.24,
    unchangedCount: 1,
  });

  const text = renderText(result);
  assert.match(text, /Since the last scan \(2026-10-02T00:00:00Z\): 1 new \(\$9\.12 a month\), 1 resolved \(\$18\.24 a month\), 1 unchanged\./);
  assert.match(text, /Unattached volume vol-0cccccccccccccccc  NEW/);
  assert.doesNotMatch(text, /vol-0aaaaaaaaaaaaaaaa  NEW/);
  assert.match(text, /Resolved since the last scan:\n  - Unattached volume vol-0bbbbbbbbbbbbbbbb \(vol-0bbbbbbbbbbbbbbbb\), \$18\.24 a month/);

  const onlyNew = renderText(result, { onlyNew: true });
  assert.match(onlyNew, /Showing only the 1 new finding\./);
  assert.ok(!onlyNew.includes("delete-volume --volume-id vol-0aaaaaaaaaaaaaaaa"));
  assert.ok(onlyNew.includes("delete-volume --volume-id vol-0cccccccccccccccc"));

  // The summary carries the same line, and its figures pass the output check.
  const summary = templatedSummary(result);
  assert.match(summary, /Since the last scan/);
  assert.deepEqual(unsupportedValues(summary, allowedValues(result)), []);
});

test("an identical scan says nothing has changed", () => {
  const result = compareScans(yesterday, scan(yesterday.findings))!;
  assert.equal(result.comparison!.newCount, 0);
  assert.match(renderText(result), /Nothing has changed since the last scan \(2026-10-02T00:00:00Z\)\./);
});

test("a finding in a region that was not scanned again is not called resolved", () => {
  const before = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0dddddddddddddddd", 5, "us-east-1")], { regions: ["ap-south-1", "us-east-1"] });
  const result = compareScans(before, scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]))!;
  assert.deepEqual(result.comparison!.resolved, []);
});

test("scans of different accounts are not compared", () => {
  assert.equal(compareScans(scan([], { accountId: "999999999999" }), scan([])), undefined);
});

test("the command compares with an earlier scan file and can list only what is new", () => {
  const first = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  assert.equal(first.status, 0, first.stderr);
  const earlier = JSON.parse(first.stdout);
  assert.equal(earlier.comparison, undefined, "a replay does not compare unless asked");

  // Pretend the earlier scan lacked the two most expensive findings and had one that is now gone.
  const [a, b, ...rest] = earlier.findings;
  const gone = { ...rest[0], resourceIds: ["vol-0feedfacefeedface"], title: "Unattached 100 GB gp3 volume", monthlyCostUsd: 9.12 };
  const file = join(first.cwd, "earlier.json");
  writeFileSync(file, JSON.stringify({ ...earlier, scannedAt: "2026-10-01T00:00:00Z", findings: [...rest, gone] }));

  const run = cli(["scan", "--replay", FIXTURE, "--compare", file, "--only-new"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Since the last scan \(2026-10-01T00:00:00Z\): 2 new \(\$114\.00 a month\), 1 resolved \(\$9\.12 a month\), 8 unchanged\./);
  assert.match(run.stdout, /Showing only the 2 new findings\./);
  assert.equal(run.stdout.match(/^\s+\d+\.\s+\$\d+\.\d\d\/mo /gm)?.length, 2);
  assert.match(run.stdout, /Resolved since the last scan:\n  - Unattached 100 GB gp3 volume \(vol-0feedfacefeedface\), \$9\.12 a month/);
  assert.ok(run.stdout.includes(a.resourceIds[0]) && run.stdout.includes(b.resourceIds[0]));

  const json = JSON.parse(cli(["scan", "--replay", FIXTURE, "--compare", file, "--json"], { blockNetwork: true }).stdout);
  assert.equal(json.comparison.newCount, 2);
  assert.equal(json.findings.length, 10, "JSON keeps every finding, each flagged");
  assert.equal(json.findings.filter((f: Finding) => f.isNew).length, 2);
});

test("with nothing asked, the next scan from the same directory compares with the last one by itself", () => {
  // The live test covers the real thing; here the saved last scan is what a previous run leaves behind.
  const run = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  const saved = JSON.parse(readFileSync(join(run.cwd, ".cloudpilot/last-scan.json"), "utf8"));
  assert.equal(saved.findings.length, 10);
  assert.equal(saved.comparison, undefined, "the saved scan is the plain result");
});

test("a file that is not a scan result is refused by name", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--compare", join(FIXTURE, "manifest.json")], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /manifest\.json is not a CloudPilot scan result/);
});
