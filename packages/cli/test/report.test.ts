import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtml } from "../src/html.js";
import { renderMarkdown, renderText, templatedSummary } from "../src/report.js";
import type { Finding, ScanResult } from "../src/types.js";

const UPLOAD_ID = "ulI75LezK.EE_twji.a13HgMCaVpm_IN5_tBAxGP2xjY1Wer4Hwv05Iz6XXIBPyRmHym.XoTvnxJU3D1W44PtnBDS8mGJErres2zzD.8J.WOz.C4mYCsfjMOHv_gpu6n";
const LONG_BUCKET = "b".repeat(63);

const finding = (id: string, command: string): Finding => ({
  region: "ap-south-1",
  pattern: "incomplete-multipart-upload",
  title: "Incomplete multipart upload",
  resourceType: "AWS::S3::MultipartUpload",
  resourceIds: [id],
  evidence: ["Never completed"],
  monthlyCostUsd: 0,
  costBasis: "5242880 bytes",
  fix: { commands: [command], risk: "caution", rollback: "The upload starts again." },
  confidence: 0.9,
});

const result = (findings: Finding[]): ScanResult => ({
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "2026-10-03T00:00:00Z" },
  findings,
  totalMonthlyWasteUsd: 0,
  skippedByTag: [],
  warnings: [],
});

const abort = `aws s3api abort-multipart-upload --bucket b --key k --upload-id ${UPLOAD_ID}`;
const SHORT = "ulI75LezK.EE_twj..._gpu6n";

test("a very long ID is shortened in the heading but kept whole in the fix command", () => {
  const text = renderText(result([finding(UPLOAD_ID, abort)]));
  const heading = text.split("\n").find((line) => line.includes("AWS::S3::MultipartUpload"))!;
  assert.ok(heading.includes(SHORT), heading);
  assert.ok(!heading.includes(UPLOAD_ID));
  assert.ok(heading.length < 100, `heading is ${heading.length} characters`);
  assert.ok(text.includes(abort), "the fix command still carries the whole ID");
});

test("ordinary IDs and the longest possible bucket name are left alone", () => {
  const text = renderText(
    result([finding("vol-0e689fadd62ef9054", "aws ec2 delete-volume"), finding(LONG_BUCKET, `aws s3api delete-bucket --bucket ${LONG_BUCKET}`)]),
  );
  assert.ok(text.includes("vol-0e689fadd62ef9054"));
  assert.ok(text.includes(LONG_BUCKET));
  assert.ok(!text.includes("..."), "nothing was cut");
});

test("the heading is plain ASCII, so a terminal in any code page shows it as written", () => {
  const text = renderText(result([finding(UPLOAD_ID, abort)]));
  assert.ok(!/[^\u0000-\u007f]/.test(text), "the report is ASCII only");
});

test("the summary a person reads shortens a very long ID; the one a model reads keeps it whole", () => {
  const scan = result([
    { ...finding(UPLOAD_ID, abort), alternative: { description: "Set a lifecycle rule", monthlySavingUsd: 1, commands: [abort], risk: "caution", rollback: "Remove the rule." } },
  ]);

  const shown = templatedSummary(scan, { shortenIds: true });
  assert.ok(shown.includes(`Largest single finding: Incomplete multipart upload (${SHORT})`), shown);
  assert.ok(shown.includes(`Set a lifecycle rule (${SHORT})`), shown);
  assert.ok(!shown.includes(UPLOAD_ID));
  assert.ok(
    shown.split("\n").every((line) => line.length < 100),
    "no summary line wraps a terminal",
  );

  const forModel = templatedSummary(scan);
  assert.ok(forModel.includes(UPLOAD_ID), "a model is still given the whole ID");
  assert.ok(!forModel.includes(SHORT));
});

test("the Markdown table and the HTML report shorten it too, and HTML keeps the whole ID on hover", () => {
  const markdown = renderMarkdown(result([finding(UPLOAD_ID, abort)]));
  const row = markdown.split("\n").find((line) => line.startsWith("| 1 |"))!;
  assert.ok(row.includes(SHORT) && !row.includes(UPLOAD_ID), row);
  assert.ok(markdown.includes(abort));

  const html = renderHtml(result([finding(UPLOAD_ID, abort)]));
  assert.ok(html.includes(`<span class="id" title="${UPLOAD_ID}">${SHORT}</span>`));
  assert.ok(html.includes(`<code>${abort}</code>`));
});
