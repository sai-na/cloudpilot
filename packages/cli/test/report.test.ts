import assert from "node:assert/strict";
import { test } from "node:test";
import { forModel } from "../src/advisor.js";
import { withBill } from "../src/detect.js";
import { renderHtml } from "../src/html.js";
import { allowedValues, unsupportedValues } from "../src/output-check.js";
import { billLines, renderMarkdown, renderPlainText, renderText, templatedSummary } from "../src/report.js";
import type { Bill, Finding, ScanResult } from "../src/types.js";

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

// ---- The bill ----

const wasteful = (usd: number): ScanResult => ({ ...result([{ ...finding("vol-0e689fadd62ef9054", "aws ec2 delete-volume"), monthlyCostUsd: usd }]), totalMonthlyWasteUsd: usd });
const billed = (bill: Bill, usd = 151.53) => withBill(wasteful(usd), bill);
const SPENT = "In September 2026 the account spent $1234.56 (AWS Cost Explorer, unblended cost, before credits and refunds).";
const SHARE = "The $151.53 a month of waste found is about 12.3% of last month's bill. The waste is an estimate per month at current prices; the bill is last month's actual total.";
const read: Bill = { month: "2026-09", totalUsd: 1234.56 };
const unreadable: Bill = { month: "2026-09", unavailable: "AccessDeniedException - not authorized to perform: ce:GetCostAndUsage" };

test("a scan not asked for the bill says nothing about one", () => {
  const scan = wasteful(151.53);
  assert.deepEqual(billLines(scan), []);
  // The HTML carries its fonts as base64, which can spell anything: look past the style block.
  const page = renderHtml(scan).replace(/<style>[\s\S]*<\/style>/, "");
  for (const text of [renderText(scan), renderMarkdown(scan), page, templatedSummary(scan)]) assert.doesNotMatch(text, /bill|Cost Explorer/i);
  assert.equal(JSON.stringify(forModel(scan)).includes('"bill"'), false);
});

test("every form of the report says what the account spent and what share of it the waste is", () => {
  const scan = billed(read);
  assert.deepEqual(billLines(scan), [SPENT, SHARE]);
  assert.ok(renderText(scan).includes(`${SPENT}\n${SHARE}`));
  assert.ok(renderPlainText(scan, templatedSummary(scan)).includes(SHARE));
  assert.ok(renderMarkdown(scan).includes(`${SPENT}\n${SHARE}`));
  const html = renderHtml(scan);
  assert.ok(html.includes(`<p class="bill"><span>${SPENT}</span><span>${SHARE.replaceAll("'", "&#39;")}</span></p>`), "the HTML report carries both sentences");
  assert.ok(templatedSummary(scan).includes(`${SPENT}\n${SHARE}`));
  // JSON: the figures are the scan's own, and the share is already worked out.
  assert.deepEqual(JSON.parse(JSON.stringify(scan)).bill, { month: "2026-09", totalUsd: 1234.56, wasteSharePct: 12.3 });
});

test("the share is worded as an estimate against an actual total, with no more than one decimal", () => {
  assert.match(SHARE, /about \d+\.\d% of last month's bill/);
  assert.ok(billLines(billed({ month: "2026-09", totalUsd: 1000 }, 10)).join(" ").includes("is about 1.0% of last month's bill"));
  // Waste that rounds to nothing is not written as 0.0%.
  const tiny = billLines(billed({ month: "2026-09", totalUsd: 100000 }, 0.01)).join(" ");
  assert.match(tiny, /is less than 0\.1% of last month's bill/);
  assert.doesNotMatch(tiny, /about 0/);
  // A figure AWS still calls an estimate is said to be one.
  assert.match(billLines(billed({ ...read, estimated: true }))[0]!, /AWS still marks the figure as an estimate/);
});

test("a bill that could not be read becomes a plain note in every form, never a figure", () => {
  const scan = billed(unreadable);
  const note = "The bill could not be read: AccessDeniedException - not authorized to perform: ce:GetCostAndUsage.";
  assert.deepEqual(billLines(scan), [note]);
  for (const text of [renderText(scan), renderMarkdown(scan), templatedSummary(scan), renderHtml(scan).replace(/<style>[\s\S]*<\/style>/, "")]) {
    assert.ok(text.includes(note), text.slice(0, 200));
    assert.doesNotMatch(text, /the account spent|of last month(')?s bill/);
  }
  // A reason that already ends in a full stop does not get a second.
  assert.deepEqual(billLines(billed({ month: "2026-09", unavailable: "No data." })), ["The bill could not be read: No data."]);
});

test("with no waste there is a bill but no share of it", () => {
  const scan = withBill({ ...wasteful(0), findings: [] }, read);
  assert.deepEqual(billLines(scan), [SPENT]);
  assert.match(templatedSummary(scan), /^No waste found in ap-south-1\.\nIn September 2026 the account spent \$1234\.56 /);
});

test("the model is given the bill as quotable text, and told to quote it and nothing else", () => {
  const given = forModel(billed(read)) as unknown as { bill: Record<string, unknown>; totalMonthlyWasteUsd: string };
  assert.deepEqual(given.bill, { month: "2026-09", totalUsd: "$1234.56", wasteSharePct: "about 12.3% of last month's bill" });
  assert.deepEqual((forModel(billed(unreadable)) as unknown as { bill: unknown }).bill, unreadable);
});

test("the output check accepts the bill and its share, and rejects any other figure about spend", () => {
  const scan = billed(read);
  const allowed = allowedValues(scan);
  assert.deepEqual(unsupportedValues(`The account spent $1234.56 in September; the $151.53 of waste is about 12.3% of last month's bill.`, allowed), []);
  assert.deepEqual(unsupportedValues(templatedSummary(scan), allowed), []);
  // Rounded the way a person would, still the same figure.
  assert.deepEqual(unsupportedValues("The waste is about 12% of the bill.", allowed), []);
  assert.deepEqual(unsupportedValues("The waste is about 15.3% of last month's bill.", allowed), ["15.3%"]);
  assert.deepEqual(unsupportedValues("That is 20 percent of what the account spent.", allowed), ["20 percent"]);
  assert.deepEqual(unsupportedValues("The account spent $1300.00 last month.", allowed), ["$1300.00"]);
  // A percentage that is about something else is a scan value, not a claim about the bill.
  assert.deepEqual(unsupportedValues("The instance peaked at 40% CPU.", allowed), []);
  // With no share worked out (no waste, or an unreadable bill), none may be stated.
  assert.deepEqual(unsupportedValues("The waste is 3% of the bill.", allowedValues(billed(unreadable))), ["3%"]);
  // A share that rounds to nothing is quoted as "less than 0.1%".
  const small = billed({ month: "2026-09", totalUsd: 100000 }, 0.01);
  assert.deepEqual(unsupportedValues("The waste is less than 0.1% of last month's bill.", allowedValues(small)), []);
});
