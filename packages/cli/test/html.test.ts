import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHtml } from "../src/html.js";
import type { ScanResult } from "../src/types.js";

const result: ScanResult = {
  accountId: "123456789012",
  regions: ["ap-south-1", "us-east-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "2026-10-03T00:00:00Z" },
  findings: [
    {
      region: "us-east-1",
      pattern: "unattached-ebs-volume",
      title: 'Volume named <script>alert("x")</script>',
      resourceType: "AWS::EC2::Volume",
      resourceIds: ["vol-0e689fadd62ef9054"],
      evidence: ["Name tag: a & b"],
      monthlyCostUsd: 57,
      costBasis: "500 GB x $0.114/GB-month (gp2)",
      fix: { commands: ["aws ec2 delete-volume --volume-id vol-0e689fadd62ef9054"], risk: "dangerous", rollback: "Permanent." },
      alternative: { commands: ["aws ec2 modify-volume --volume-type gp3"], risk: "caution", rollback: "Reversible.", description: "Convert to gp3", monthlySavingUsd: 11.4 },
      confidence: 0.95,
    },
  ],
  totalMonthlyWasteUsd: 57,
  skippedByTag: ["vol-0aaaaaaaaaaaaaaaa"],
  warnings: ["[us-east-1] s3:ListBucket x: AccessDenied"],
};

test("text from the account is escaped, never run", () => {
  const html = renderHtml(result);
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes("Volume named &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("Name tag: a &amp; b"));
});

test("the report shows total, regions, risk in words, the alternative, skipped resources and failed checks", () => {
  const html = renderHtml(result, { summary: "First paragraph.\n\nSecond paragraph.\n- one <b>\n- two" });
  assert.match(html, /<h1>\$57\.00 a month of estimated waste, in 1 finding\.<\/h1>/);
  assert.match(html, /<dt>Regions<\/dt><dd>2 scanned, findings in us-east-1<\/dd>/);
  assert.match(html, /data-risk="dangerous">\n<h3>Fix<\/h3>\n<p class="risk">Permanent\. Needs explicit approval/);
  assert.match(html, /data-risk="caution">\n<h3>Or: Convert to gp3, saving \$11\.40 a month<\/h3>/);
  assert.match(html, /<p>First paragraph\.<\/p>\n<p>Second paragraph\.<\/p>\n<ul>\n<li>one &lt;b&gt;<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /1 resource was skipped because of the tag cloudpilot:ignore=true/);
  assert.match(html, /Checks that could not run/);
  assert.ok(!html.includes('class="replay"'));
});

test("an empty account gets a plain statement, not an empty list", () => {
  const html = renderHtml({ ...result, findings: [], totalMonthlyWasteUsd: 0 });
  assert.match(html, /<h1>No waste found\.<\/h1>/);
  assert.ok(!html.includes('<article class="finding">'));
});
