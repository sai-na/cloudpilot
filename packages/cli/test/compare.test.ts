import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forModel, summaryRequest } from "../src/advisor.js";
import { compareScans, isScanResult } from "../src/compare.js";
import { renderHtml } from "../src/html.js";
import { allowedValues, unsupportedValues } from "../src/output-check.js";
import { comparisonLine, renderMarkdown, renderText, templatedSummary } from "../src/report.js";
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
    newInRegionsNotScannedBefore: 0,
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

test("an identical scan says there is nothing new or resolved, and claims no more than that", () => {
  const result = compareScans(yesterday, scan(yesterday.findings))!;
  assert.equal(result.comparison!.newCount, 0);
  assert.match(renderText(result), /No new or resolved findings since the last scan \(2026-10-02T00:00:00Z\)\./);

  // The same finding at a different cost is neither new nor resolved, so the line must not say nothing changed.
  const dearer = compareScans(yesterday, scan([finding("vol-0aaaaaaaaaaaaaaaa", 60), finding("vol-0bbbbbbbbbbbbbbbb", 18.24)]))!;
  assert.match(renderText(dearer), /No new or resolved findings since the last scan/);
  assert.doesNotMatch(renderText(dearer), /nothing has changed/i);
});

test("findings in a region the last scan did not cover are new, and the report says why", () => {
  const today = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0bbbbbbbbbbbbbbbb", 18.24), finding("vol-0cccccccccccccccc", 9.12), finding("vol-0dddddddddddddddd", 5, "us-east-1")], {
    regions: ["ap-south-1", "us-east-1"],
  });
  const result = compareScans(yesterday, today)!;
  assert.equal(result.comparison!.newCount, 2);
  assert.equal(result.comparison!.newInRegionsNotScannedBefore, 1);
  const expected = /2 new \(\$14\.12 a month\), 0 resolved \(\$0\.00 a month\), 2 unchanged\. 1 of the new ones is in a region the last scan did not cover\./;
  for (const report of [renderText(result), renderMarkdown(result), renderHtml(result), templatedSummary(result)]) assert.match(report, expected);
  assert.deepEqual(unsupportedValues(comparisonLine(result)!, allowedValues(result)), [], "the line quotes only amounts the scan holds");
  assert.equal(forModel(result).comparison!.newInRegionsNotScannedBefore, 1);

  // The same regions as last time: nothing to explain.
  const same = compareScans(yesterday, scan([finding("vol-0cccccccccccccccc", 9.12)]))!;
  assert.equal(same.comparison!.newInRegionsNotScannedBefore, 0);
  assert.doesNotMatch(renderText(same), /did not cover/);
});

test("asking for only the new findings with no earlier scan shows everything and says so", () => {
  const first = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]);
  const note = /No earlier scan to compare with; showing every finding\./;
  for (const report of [renderText(first, { onlyNew: true }), renderMarkdown(first, undefined, undefined, { onlyNew: true }), renderHtml(first, { onlyNew: true })]) {
    assert.match(report, note);
    assert.ok(report.includes("vol-0aaaaaaaaaaaaaaaa"));
  }
  for (const report of [renderText(first), renderMarkdown(first), renderHtml(first)]) assert.doesNotMatch(report, note);
});

test("a finding in a region that was not scanned again is not called resolved", () => {
  const before = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0dddddddddddddddd", 5, "us-east-1")], { regions: ["ap-south-1", "us-east-1"] });
  const result = compareScans(before, scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]))!;
  assert.deepEqual(result.comparison!.resolved, []);
});

test("a finding whose check could not run this time is not called resolved either", () => {
  // The volume listing failed, so the region came back empty: those volumes may
  // well still be there, and a check that did not run is never a fix.
  const throttled = scan([], { warnings: ["[ap-south-1] ec2:DescribeVolumes: ThrottlingException - Rate exceeded"] });
  const result = compareScans(yesterday, throttled)!;
  assert.deepEqual(result.comparison!.resolved, []);
  assert.equal(result.comparison!.resolvedMonthlyUsd, 0);
  assert.match(renderText(result), /No new or resolved findings since the last scan \(2026-10-02T00:00:00Z\)\./);
  assert.doesNotMatch(renderText(result), /Resolved since the last scan/);

  // A failed check elsewhere says nothing about the region that was read in full.
  const elsewhere = scan([], { regions: ["ap-south-1", "us-east-1"], warnings: ["[us-east-1] s3:ListAllMyBuckets: AccessDenied"] });
  assert.equal(compareScans(yesterday, elsewhere)!.comparison!.resolved.length, 2);
});

test("asking for only the new findings when nothing is new says so, and lists no commands", () => {
  const result = compareScans(yesterday, scan(yesterday.findings))!;
  const note = /Nothing new since the last scan; the 2 findings already reported are not listed\./;
  for (const report of [renderText(result, { onlyNew: true }), renderMarkdown(result, undefined, undefined, { onlyNew: true }), renderHtml(result, { onlyNew: true })]) {
    assert.match(report, note);
    assert.ok(!report.includes("vol-0aaaaaaaaaaaaaaaa"), "nothing is listed");
  }
  assert.doesNotMatch(renderText(result, { onlyNew: true }), /prints these commands/, "no commands were printed to call read-only");
  assert.match(renderText(result), /prints these commands/);

  const one = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]);
  const single = compareScans({ ...one, scannedAt: "2026-10-02T00:00:00Z" }, one)!;
  assert.match(renderText(single, { onlyNew: true }), /Nothing new since the last scan; the 1 finding already reported is not listed\./);
});

test("a report says why it did not compare, instead of claiming there was no earlier scan", () => {
  const first = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]);
  const cases = [
    { options: { onlyNew: true, noComparison: "off" } as const, says: /This scan was not compared with an earlier one; showing every finding\./ },
    { options: { onlyNew: true, noComparison: "not-comparable" } as const, says: /The scan to compare with is of a different account; showing every finding\./ },
  ];
  for (const { options, says } of cases) {
    for (const report of [renderText(first, options), renderMarkdown(first, undefined, undefined, options), renderHtml(first, options)]) {
      assert.match(report, says);
      assert.doesNotMatch(report, /No earlier scan to compare with/);
      assert.ok(report.includes("vol-0aaaaaaaaaaaaaaaa"), "every finding is still shown");
    }
  }
});

test("the command says why it did not compare when it had an earlier scan it could not use", () => {
  const first = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  assert.equal(first.status, 0, first.stderr);
  const earlier = JSON.parse(first.stdout);

  const file = join(first.cwd, "other-account.json");
  writeFileSync(file, JSON.stringify({ ...earlier, accountId: "999999999999" }));
  const mismatch = cli(["scan", "--replay", FIXTURE, "--compare", file, "--only-new"], { blockNetwork: true });
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stdout, /The scan to compare with is of a different account; showing every finding\./);
  assert.doesNotMatch(mismatch.stdout, /No earlier scan to compare with/);

  // A saved scan is sitting right there, and comparing was turned off.
  const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-test-"));
  mkdirSync(join(cwd, ".cloudpilot"));
  writeFileSync(join(cwd, ".cloudpilot/last-scan.json"), JSON.stringify(earlier));
  const off = cli(["scan", "--replay", FIXTURE, "--no-compare", "--only-new"], { blockNetwork: true, cwd });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /This scan was not compared with an earlier one; showing every finding\./);
  assert.doesNotMatch(off.stdout, /No earlier scan to compare with/);
});

test("a scan with everything fixed still says what it was costing", () => {
  const result = compareScans(yesterday, scan([]))!;
  const expected = /Since the last scan \(2026-10-02T00:00:00Z\): 0 new \(\$0\.00 a month\), 2 resolved \(\$75\.24 a month\), 0 unchanged\./;
  assert.match(renderText(result), expected);
  assert.match(renderText(result), /No waste found\./);
  assert.match(templatedSummary(result), expected);
  assert.deepEqual(unsupportedValues(templatedSummary(result), allowedValues(result)), []);
  assert.match(renderMarkdown(result), expected);
  assert.match(renderHtml(result), expected);
});

test("every report says when the list was cut down to the new findings", () => {
  const today = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0cccccccccccccccc", 9.12)]);
  const result = compareScans(yesterday, today)!;
  const note = /Showing only the 1 new finding\./;
  for (const report of [renderText(result, { onlyNew: true }), renderMarkdown(result, undefined, undefined, { onlyNew: true }), renderHtml(result, { onlyNew: true })]) {
    assert.match(report, note);
    assert.ok(!report.includes("vol-0aaaaaaaaaaaaaaaa"), "the unchanged finding is left out");
  }
  // Without the flag no report claims to be filtered.
  for (const report of [renderText(result), renderMarkdown(result), renderHtml(result)]) assert.doesNotMatch(report, note);
});

test("a scan result with a finding missing its cost is not comparable", () => {
  const complete = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]);
  assert.equal(isScanResult(JSON.parse(JSON.stringify(complete))), true);
  for (const broken of [{}, { pattern: "gp2-volume", region: "ap-south-1", title: "x", resourceIds: ["vol-1"] }, { ...complete.findings[0], monthlyCostUsd: null }]) {
    assert.equal(isScanResult({ ...complete, findings: [broken] }), false, JSON.stringify(broken));
  }
});

test("the comparison reaches a model as fixed dollar strings, like every other amount", () => {
  const before = scan([finding("vol-0aaaaaaaaaaaaaaaa", 0.1), finding("vol-0bbbbbbbbbbbbbbbb", 0.2)], { scannedAt: "2026-10-02T00:00:00Z" });
  const result = compareScans(before, scan([finding("vol-0cccccccccccccccc", 0.1), finding("vol-0dddddddddddddddd", 0.2)]))!;
  assert.equal(result.comparison!.resolvedMonthlyUsd, 0.30000000000000004, "the sum really does carry float error");

  const payload = forModel(result).comparison!;
  assert.equal(payload.newMonthlyUsd, "$0.30");
  assert.equal(payload.resolvedMonthlyUsd, "$0.30");
  assert.deepEqual(payload.resolved.map((r) => r.monthlyCostUsd), ["$0.10", "$0.20"]);
  // The prompt is what the model quotes from, and it may hold no amount the report would not print.
  assert.ok(!summaryRequest(result).includes("0.30000000000000004"));
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

test("a replay leaves the saved last scan alone: a recording is not the account as it is now", () => {
  // What a live scan saves, and the automatic comparison with it, are covered in test/lab/record-replay.test.ts.
  const fresh = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(existsSync(join(fresh.cwd, ".cloudpilot/last-scan.json")), false, "a replay does not create a baseline");

  // And one that is already there survives a replay byte for byte.
  const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-test-"));
  const baseline = JSON.stringify(yesterday);
  mkdirSync(join(cwd, ".cloudpilot"));
  writeFileSync(join(cwd, ".cloudpilot/last-scan.json"), baseline);
  const again = cli(["scan", "--replay", FIXTURE], { blockNetwork: true, cwd });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(cwd, ".cloudpilot/last-scan.json"), "utf8"), baseline);
});

test("a file that is not a scan result is refused by name", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--compare", join(FIXTURE, "manifest.json")], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /manifest\.json is not a CloudPilot scan result/);
});

test("a scan file whose findings are the wrong shape is refused by name, not reported as $NaN", () => {
  const first = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  const earlier = JSON.parse(first.stdout);
  const file = join(first.cwd, "half-written.json");
  const { pattern, region, title, resourceIds } = earlier.findings[0];
  writeFileSync(file, JSON.stringify({ ...earlier, findings: [{ pattern, region, title, resourceIds }] }));

  const run = cli(["scan", "--replay", FIXTURE, "--compare", file], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /half-written\.json is not a CloudPilot scan result/);
  assert.ok(!run.stdout.includes("NaN"));
});
