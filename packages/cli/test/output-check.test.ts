import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedValues, unsupportedValues } from "../src/output-check.js";
import { templatedSummary } from "../src/report.js";
import type { Finding, PriceBook, ScanResult } from "../src/types.js";

const finding = (id: string, cost: number, extra: Partial<Finding> = {}): Finding => ({
  region: "ap-south-1",
  pattern: "unattached-ebs-volume",
  title: "Unattached 500 GB gp2 volume",
  resourceType: "AWS::EC2::Volume",
  resourceIds: [id],
  evidence: ["State is available"],
  monthlyCostUsd: cost,
  costBasis: "500 GB x $0.114/GB-month (gp2)",
  fix: { commands: [`aws ec2 delete-volume --volume-id ${id}`], risk: "dangerous", rollback: "Permanent." },
  confidence: 0.95,
  ...extra,
});

const result: ScanResult = {
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "2026-10-03T00:00:00Z" },
  findings: [
    finding("vol-0e689fadd62ef9054", 57, {
      alternative: { commands: ["aws ec2 modify-volume"], risk: "caution", rollback: "Reversible.", description: "Convert to gp3", monthlySavingUsd: 11.4 },
    }),
    finding("vol-0dda4dbd98e6572b8", 18.24),
  ],
  totalMonthlyWasteUsd: 75.24,
  skippedByTag: ["vol-0aaaaaaaaaaaaaaaa"],
  warnings: [],
};
const allowed = allowedValues(result);

test("text that only repeats scan values is accepted", () => {
  const text = "Fix vol-0e689fadd62ef9054 first: $57/month, or save $11.40 by converting. Total $75.24. gp2 is $0.114 per GB.";
  assert.deepEqual(unsupportedValues(text, allowed), []);
});

test("an invented volume ID is rejected", () => {
  assert.deepEqual(unsupportedValues("Also delete vol-0123456789abcdef0, it costs $57.", allowed), ["vol-0123456789abcdef0"]);
});

test("an invented or recomputed dollar amount is rejected", () => {
  assert.deepEqual(unsupportedValues("That is $902.88 per year.", allowed), ["$902.88"]);
  assert.deepEqual(unsupportedValues("Both volumes together cost $75.25.", allowed), ["$75.25"]);
});

test("the templated summary passes its own check and reports skipped resources", () => {
  const summary = templatedSummary(result);
  assert.deepEqual(unsupportedValues(summary, allowed), []);
  assert.match(summary, /Estimated waste: \$75\.24 per month across 2 findings/);
  assert.match(summary, /1 resource was skipped because of the tag cloudpilot:ignore=true: vol-0aaaaaaaaaaaaaaaa/);
  assert.match(summary, /Nothing has been changed/);
});

test("across several regions the templated summary says where the waste is", () => {
  const multi: ScanResult = {
    ...result,
    regions: ["ap-south-1", "eu-west-1", "us-east-1"],
    findings: [finding("vol-0e689fadd62ef9054", 57), finding("vol-0dda4dbd98e6572b8", 18.24, { region: "us-east-1" })],
  };
  const summary = templatedSummary(multi);
  assert.match(summary, /across 2 findings in 2 of the 3 regions scanned\./);
  assert.match(summary, /By region:\n- ap-south-1: 1 finding, \$57\.00 per month\.\n- us-east-1: 1 finding, \$18\.24 per month\.\n- 1 other region: nothing found\./);
  assert.deepEqual(unsupportedValues(summary, allowedValues(multi)), []);
});

const priceBook: PriceBook = {
  region: "ap-south-1",
  source: "aws-price-list-api",
  fetchedAt: "2026-10-03T00:00:00Z",
  ebsGbMonth: { gp2: 0.114, gp3: 0.0912 },
  snapshotGbMonth: 0.05,
  idleIpv4Hour: 0.005,
  instanceHour: { "m5.xlarge": 0.214 },
  rdsInstanceHour: { "db.t3.micro|MySQL|Single-AZ": 0.034 },
  rdsStorageGbMonth: { "gp3|MySQL|Single-AZ": 0.1265 },
  instanceSpecs: { "m5.large": { vcpu: 2, memoryGib: 8 } },
  s3StandardGbMonth: 0.025,
};

test("every price in a book the model was given may be quoted back, including database prices", () => {
  const withPrices = allowedValues(result, { prices: [priceBook] });
  const text = "The database costs $0.034 per hour and its storage $0.1265 per GB-month; an m5.xlarge is $0.214 per hour and a snapshot $0.05 per GB.";
  assert.deepEqual(unsupportedValues(text, withPrices), []);
});

test("an amount no price book contains is still rejected", () => {
  const withPrices = allowedValues(result, { prices: [priceBook] });
  assert.deepEqual(unsupportedValues("The database costs $0.099 per hour.", withPrices), ["$0.099"]);
});
