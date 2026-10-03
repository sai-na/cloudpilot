/**
 * The scan as one self-contained HTML file: no fonts, images, scripts or
 * styles are fetched from anywhere, so it opens offline and prints cleanly.
 */
import { comparisonLine, header, money, regionsWithFindings, shortId, shownFindings, skippedLine } from "./report.js";
import type { Fix, ScanResult } from "./types.js";

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** What a reader must know before running a fix, in words as well as colour. */
const RISK_NOTE: Record<Fix["risk"], string> = {
  dangerous: "Permanent. Needs explicit approval before anyone runs it.",
  caution: "Review before running. It can be undone.",
};

const STYLE = `
/* A printed statement, audited by hand: black ink on paper, highlighter over
   the money that bought nothing, red for what cannot be undone. Light only. */
:root {
  --paper: #fcfdf8; --band: #e4f1e3; --ink: #0d0d0d; --soft: #4b4f48; --line: #b9beb2;
  --marker: #fff04a; --red: #cf2318; --red-wash: #fbeceb;
  --print: "Courier New", Courier, ui-monospace, monospace;
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 1.0625rem/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-variant-numeric: tabular-nums;
}
main { max-width: 60rem; margin: 0 auto; padding: 2.75rem 1.75rem 4rem; }
code, .id { font: 700 0.9375rem/1.45 var(--print); }

.replay {
  margin: 0; padding: 0.8rem 1.5rem; font: 700 1rem/1.4 var(--print); text-align: center; color: var(--ink);
  background: repeating-linear-gradient(-45deg, var(--marker) 0 14px, #fff8a8 14px 28px);
  border-bottom: 3px solid var(--ink);
}

h1 { font-size: clamp(2.2rem, 6.4vw, 4.25rem); line-height: 0.98; font-weight: 900; letter-spacing: -0.035em; word-spacing: 0.06em; margin: 0 0 1.5rem; max-width: 17ch; }
.facts { display: flex; flex-wrap: wrap; gap: 0.2rem 2.25rem; margin: 0 0 2.25rem; font-family: var(--print); color: var(--soft); }
.facts div { display: flex; gap: 0.5rem; }
.facts dt { font-weight: 700; color: var(--ink); }
.facts dd { margin: 0; }
.since { margin: -1rem 0 2.25rem; font-weight: 700; }
.resolved { margin-bottom: 2rem; }
.resolved h2 { font-size: 1.375rem; font-weight: 900; letter-spacing: -0.02em; margin: 0 0 0.6rem; }
.resolved ul { margin: 0; padding-left: 1.1rem; }
.new { display: inline-block; background: var(--marker); font-size: 0.8125rem; font-weight: 800; padding: 0.05em 0.5em; border-radius: 0.2em 0.6em 0.3em 0.5em; vertical-align: 0.15em; }
.summary { border-top: 3px solid var(--ink); padding-top: 1.25rem; margin-bottom: 2.5rem; }
.summary h2, .notes h2 { font-size: 1.375rem; font-weight: 900; letter-spacing: -0.02em; margin: 0 0 0.6rem; }
.summary p { margin: 0 0 0.5rem; max-width: 46rem; }
.summary ul { margin: 0 0 1rem; padding-left: 1.1rem; max-width: 46rem; }
.summary li { margin-bottom: 0.15rem; }

.finding {
  display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); column-gap: 2rem;
  border-top: 2px dashed var(--line); padding: 1.75rem 0;
}
.finding:first-of-type { border-top: 3px solid var(--ink); }
.amount { margin: 0; text-align: right; font: 700 1.5rem/1.2 var(--print); }
.amount mark { display: inline-block; background: var(--marker); color: inherit; padding: 0.05em 0.35em; border-radius: 0.2em 0.7em 0.3em 0.6em; transform: rotate(-1.2deg); }
.finding:nth-of-type(even) .amount mark { transform: rotate(0.9deg); }
.amount small { display: block; margin-top: 0.3rem; font: 400 0.875rem/1.3 var(--print); color: var(--soft); }
.finding h2 { font-size: 1.375rem; line-height: 1.2; font-weight: 800; letter-spacing: -0.015em; margin: 0 0 0.3rem; }
.where { margin: 0 0 0.9rem; font: 400 0.9375rem/1.45 var(--print); color: var(--soft); overflow-wrap: anywhere; }
.where .id { color: var(--ink); }
.finding ul { margin: 0 0 0.9rem; padding-left: 1.1rem; }
.finding li { margin-bottom: 0.15rem; overflow-wrap: anywhere; }
.basis { margin: 0 0 1.1rem; font: 400 0.9375rem/1.45 var(--print); color: var(--soft); }

.fix { border-left: 5px solid var(--ink); background: var(--band); padding: 0.9rem 1.1rem; margin: 0 0 0.75rem; }
.fix[data-risk="dangerous"] { border-left-color: var(--red); background: var(--red-wash); }
.fix h3 { font-size: 1rem; font-weight: 800; margin: 0; }
.risk { margin: 0.1rem 0 0.6rem; font-weight: 700; }
.fix[data-risk="dangerous"] .risk { color: var(--red); }
.command { display: flex; align-items: flex-start; gap: 0.75rem; background: var(--ink); color: var(--paper); padding: 0.6rem 0.6rem 0.6rem 0.9rem; margin: 0.5rem 0; }
.command code { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.command button {
  font: 800 0.875rem/1 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink); background: var(--marker);
  border: 0; padding: 0.45rem 0.8rem; min-width: 4.75rem; cursor: pointer;
}
.command button:hover { background: #fff; }
.command button:focus-visible { outline: 3px solid var(--red); outline-offset: 2px; }
.wayback { margin: 0.6rem 0 0; overflow-wrap: anywhere; }

.notes { border-top: 3px solid var(--ink); margin-top: 0.5rem; padding-top: 1.25rem; font-family: var(--print); color: var(--soft); }
.notes p, .notes li { overflow-wrap: anywhere; }

@media (max-width: 40rem) {
  main { padding-inline: 1.1rem; }
  .finding { grid-template-columns: 1fr; row-gap: 0.6rem; }
  .amount { text-align: left; }
  .amount small { display: inline; margin-left: 0.5rem; }
}
@media print {
  body { font-size: 10.5pt; }
  main { max-width: none; padding: 0; }
  .finding, .fix, .summary { break-inside: avoid; }
  .command { background: #fff; color: #000; border: 1px solid #000; }
  .command button { display: none; }
  .replay, .amount mark, .fix { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/** Copies the command next to the button; falls back to selecting it where the clipboard API is unavailable. */
const SCRIPT = `
document.addEventListener("click", function (event) {
  var button = event.target.closest("button[data-copy]");
  if (!button) return;
  var code = button.parentElement.querySelector("code");
  var done = function () {
    button.textContent = "Copied";
    setTimeout(function () { button.textContent = "Copy"; }, 1500);
  };
  var select = function () {
    var range = document.createRange();
    range.selectNodeContents(code);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    try { if (document.execCommand("copy")) done(); } catch (error) {}
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code.textContent).then(done, select);
  } else {
    select();
  }
});
`;

/** Paragraphs stay paragraphs; runs of "- " lines become a list. */
function summaryBlocks(summary: string): string {
  const blocks: string[] = [];
  for (const paragraph of summary.split(/\n{2,}/)) {
    let items: string[] = [];
    const flush = () => {
      if (items.length) blocks.push(`<ul>\n${items.map((i) => `<li>${escape(i)}</li>`).join("\n")}\n</ul>`);
      items = [];
    };
    for (const line of paragraph.split("\n")) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) items.push(bullet[1]!);
      else {
        flush();
        if (line.trim()) blocks.push(`<p>${escape(line)}</p>`);
      }
    }
    flush();
  }
  return blocks.join("\n");
}

const commands = (list: string[]) =>
  list
    .map((c) => `<div class="command"><code>${escape(c)}</code><button type="button" data-copy>Copy</button></div>`)
    .join("\n");

function fixBlock(title: string, fix: Fix): string {
  return `<section class="fix" data-risk="${fix.risk}">
<h3>${escape(title)}</h3>
<p class="risk">${RISK_NOTE[fix.risk]}</p>
${commands(fix.commands)}
<p class="wayback"><strong>Way back:</strong> ${escape(fix.rollback)}</p>
</section>`;
}

/** The report as a complete HTML document. */
export function renderHtml(result: ScanResult, options: { summary?: string; banner?: string; onlyNew?: boolean } = {}): string {
  const count = result.findings.length;
  const headline =
    count === 0
      ? "No waste found."
      : `${money(result.totalMonthlyWasteUsd)} a month of estimated waste, in ${count} finding${count === 1 ? "" : "s"}.`;
  const [, pricesLine] = header(result);
  const regions =
    result.regions.length === 1
      ? result.regions[0]!
      : `${result.regions.length} scanned, findings in ${regionsWithFindings(result).join(", ") || "none"}`;

  const since = comparisonLine(result);
  const resolved = result.comparison?.resolved ?? [];
  const findings = shownFindings(result, options.onlyNew)
    .map(
      (f) => `<article class="finding">
<p class="amount"><mark>${money(f.monthlyCostUsd)}</mark><small>a month</small></p>
<div>
<h2>${f.isNew ? '<span class="new">New</span> ' : ""}${escape(f.title)}</h2>
<p class="where"><span class="id" title="${escape(f.resourceIds.join(", "))}">${escape(f.resourceIds.map(shortId).join(", "))}</span> in ${escape(f.region)}, ${escape(f.resourceType)}, rule confidence ${Math.round(f.confidence * 100)}%</p>
<ul>
${f.evidence.map((e) => `<li>${escape(e)}</li>`).join("\n")}
</ul>
<p class="basis">Cost: ${escape(f.costBasis)}</p>
${fixBlock("Fix", f.fix)}
${f.alternative ? fixBlock(`Or: ${f.alternative.description}, saving ${money(f.alternative.monthlySavingUsd)} a month`, f.alternative) : ""}
</div>
</article>`,
    )
    .join("\n");

  const skipped = skippedLine(result);
  const warnings =
    result.warnings.length > 0
      ? `<h2>Checks that could not run</h2>\n<ul>\n${result.warnings.map((w) => `<li>${escape(w)}</li>`).join("\n")}\n</ul>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CloudPilot scan of account ${escape(result.accountId)}</title>
<style>${STYLE}</style>
</head>
<body>
${options.banner ? `<p class="replay" role="note">${escape(options.banner)}</p>` : ""}
<main>
<h1>${escape(headline)}</h1>
<dl class="facts">
<div><dt>Account</dt><dd>${escape(result.accountId)}</dd></div>
<div><dt>Regions</dt><dd>${escape(regions)}</dd></div>
<div><dt>Scanned</dt><dd>${escape(result.scannedAt)}</dd></div>
<div><dt>Prices</dt><dd>${escape((pricesLine ?? "").replace(/^Prices: /, ""))}</dd></div>
</dl>
${since ? `<p class="since">${escape(since)}</p>` : ""}
${resolved.length > 0 ? `<section class="resolved">\n<h2>Resolved since the last scan</h2>\n<ul>\n${resolved.map((r) => `<li>${escape(r.title)} (${escape(r.resourceIds.map(shortId).join(", "))}), ${money(r.monthlyCostUsd)} a month</li>`).join("\n")}\n</ul>\n</section>` : ""}
${options.summary ? `<section class="summary">\n<h2>Summary</h2>\n${summaryBlocks(options.summary)}\n</section>` : ""}
${findings}
<section class="notes">
<p>End of statement. CloudPilot is read-only: it printed these commands and ran none of them.</p>
${skipped ? `<p>${escape(skipped)}</p>` : ""}
${warnings}
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
