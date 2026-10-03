import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
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
  assert.match(html, /<span>Fix<\/span><\/label><\/h3>\n<p class="risk">Permanent\. Needs explicit approval/);
  assert.match(html, /<span>Or: Convert to gp3, saving \$11\.40 a month<\/span><\/label><\/h3>\n<p class="risk">Review before running\. It can be undone\./);
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

// The decision surface: tick fixes, watch the saving, copy one script.

const second = {
  ...result.findings[0]!,
  region: "ap-south-1",
  pattern: "bucket-without-lifecycle" as const,
  title: "Bucket with no lifecycle rule",
  resourceType: "AWS::S3::Bucket",
  resourceIds: ["logs-bucket"],
  monthlyCostUsd: 3.2,
  fix: { commands: ["aws s3api put-bucket-lifecycle-configuration --bucket logs-bucket"], risk: "caution" as const, rollback: "Remove the rule again." },
  alternative: undefined,
};
const two: ScanResult = { ...result, findings: [result.findings[0]!, second], totalMonthlyWasteUsd: 60.2 };

/** The report opened in a browser, with what it tried to copy and whether account text ever ran. */
function open(scan: ScanResult, scripts = true) {
  const copied: string[] = [];
  let alerted = false;
  const dom = new JSDOM(renderHtml(scan), {
    runScripts: scripts ? "dangerously" : undefined,
    beforeParse(window) {
      window.alert = () => {
        alerted = true;
      };
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) } });
    },
  });
  const document = dom.window.document;
  const boxes = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
  return {
    document,
    copied,
    alerted: () => alerted,
    box: (heading: RegExp) => boxes.find((b) => heading.test(b.closest("label")!.textContent!))!,
    boxes,
    bar: () => document.querySelector(".bar p")!.textContent!.replace(/\s+/g, " ").trim(),
    script: () => document.getElementById("script-text")!.textContent!,
    copy: document.getElementById("copy") as HTMLButtonElement,
  };
}

test("the report opens with the fixes that can be undone already chosen, and no permanent one", () => {
  const page = open(two);
  assert.deepEqual(page.boxes.map((b) => [b.closest("label")!.textContent!.trim(), b.checked]), [
    ["Fix", false],
    ["Or: Convert to gp3, saving $11.40 a month", true],
    ["Fix", true],
  ]);
  assert.equal(page.bar(), "$14.60 a month saved by the 2 fixes in your script. All of them can be undone.");
  const script = page.script();
  assert.match(script, /^# CloudPilot fix script for AWS account 123456789012\n# From the scan of 2026-10-03T00:00:00Z\. CloudPilot has run none of this\.\n# Read every line before you run it\.\n\n/);
  assert.ok(script.includes("# Way back: Reversible.\naws ec2 modify-volume --volume-type gp3"));
  assert.ok(script.includes("(logs-bucket) in ap-south-1: saves $3.20 a month\n# Way back: Remove the rule again.\naws s3api put-bucket-lifecycle-configuration --bucket logs-bucket"));
  assert.ok(!script.includes("delete-volume"), "the permanent fix is not in the script until someone ticks it");
});

test("the page reads the same before its script runs as after, so it is right even where scripts are off", () => {
  const still = open(two, false);
  const live = open(two);
  assert.equal(still.bar(), live.bar());
  assert.equal(still.script(), live.script());
  assert.equal(still.copy.hidden, true, "no dead button where the script cannot run");
  assert.equal(live.copy.hidden, false);
});

test("ticking a fix changes the saving and the script at once, and a finding is fixed one way only", () => {
  const page = open(two);
  page.box(/^Fix$/).click();
  assert.equal(page.box(/^Or: Convert to gp3/).checked, false, "choosing the deletion drops the conversion of the same volume");
  assert.equal(page.bar(), "$60.20 a month saved by the 2 fixes in your script. 1 of them is permanent.");
  assert.equal(page.document.getElementById("risk")!.className, "permanent");
  assert.ok(page.script().includes("# PERMANENT. Permanent.\naws ec2 delete-volume --volume-id vol-0e689fadd62ef9054"));
  assert.ok(!page.script().includes("modify-volume"));

  page.box(/^Or: Convert to gp3/).click();
  assert.equal(page.box(/^Fix$/).checked, false);
  assert.equal(page.bar(), "$14.60 a month saved by the 2 fixes in your script. All of them can be undone.");
  assert.equal(page.document.getElementById("risk")!.className, "");
});

test("with nothing ticked there is nothing to copy, and the page says how to start", () => {
  const page = open(two);
  for (const box of page.boxes.filter((b) => b.checked)) box.click();
  assert.equal(page.bar(), "$0.00 a month. Nothing is in your script yet: tick a fix to add it.");
  assert.match(page.script(), /# Nothing chosen yet\. Tick a fix in the report to add it here\.\n$/);
  assert.equal(page.copy.disabled, true);
});

test("one button copies exactly the script on the page", async () => {
  const page = open(two);
  assert.equal(page.document.querySelectorAll("button").length, 1, "one button, not one per command");
  page.copy.click();
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(page.copied, [page.script()]);
  assert.equal(page.copy.textContent, "Copied");
});

test("the chosen saving for every fix matches the report's own total to the cent", () => {
  const prices = [57, 18.24, 9.12, 8.9056, 3.65, 2.736, 2.5, 1.5, 0.1, 0.2];
  const findings = prices.map((cost, n) => ({ ...second, resourceIds: [`bucket-${n}`], monthlyCostUsd: cost }));
  const total = findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0);
  const page = open({ ...result, findings, totalMonthlyWasteUsd: total });
  assert.equal(page.bar(), `$${total.toFixed(2)} a month saved by the 10 fixes in your script. All of them can be undone.`);
  assert.ok(page.document.querySelector("h1")!.textContent!.startsWith(`$${total.toFixed(2)} a month`));
});

test("text from the account stays text in the script too, and a clean account gets no script at all", () => {
  const page = open(two);
  page.box(/^Fix$/).click();
  assert.ok(page.script().includes('# Volume named <script>alert("x")</script> (vol-0e689fadd62ef9054) in us-east-1: saves $57.00 a month'));
  assert.equal(page.alerted(), false);
  assert.equal(page.document.querySelectorAll("script").length, 1);

  const clean = new JSDOM(renderHtml({ ...result, findings: [], totalMonthlyWasteUsd: 0 }), { runScripts: "dangerously" }).window.document;
  assert.equal(clean.querySelector(".bar"), null);
  assert.equal(clean.querySelector("#script"), null);
  assert.equal(clean.querySelectorAll("script").length, 0);
});

test("the report carries the landing page's own typefaces inside the file", () => {
  const html = renderHtml(result);
  const fonts = resolve(dirname(fileURLToPath(import.meta.url)), "../../../site/fonts");
  const faces = [...html.matchAll(/@font-face \{ font-family: "([^"]+)"; src: url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\("woff2"\); font-weight: ([^;]+); \}/g)];
  assert.deepEqual(faces.map((f) => [f[1], f[3]]), [["Archivo", "400 900"], ["Courier Prime", "400"], ["Courier Prime", "700"]]);
  // Byte for byte the files the page serves, so the two can never drift apart.
  for (const [n, file] of ["archivo-latin-variable.woff2", "courier-prime-latin-400.woff2", "courier-prime-latin-700.woff2"].entries()) {
    assert.ok(Buffer.from(faces[n]![2]!, "base64").equals(readFileSync(resolve(fonts, file))), file);
  }
  assert.match(html, /font: 1\.0625rem\/1\.55 Archivo, system-ui/);
  assert.match(html, /--print: "Courier Prime", "Courier New", Courier/);
  // The licence each face is used under ships with the package, byte for byte the
  // text that sits beside the font files the generator copies both from.
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(resolve(cli, "package.json"), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("licenses"), "the published tarball carries licenses/");
  for (const licence of ["OFL-Archivo.txt", "OFL-CourierPrime.txt"]) {
    assert.ok(readFileSync(resolve(cli, "licenses", licence)).equals(readFileSync(resolve(fonts, licence))), licence);
  }
});
