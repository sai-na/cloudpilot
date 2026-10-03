/**
 * The scan as one self-contained HTML file: no fonts, images, scripts or
 * styles are fetched from anywhere, so it opens offline and prints cleanly.
 * Its two typefaces, the ones the landing page uses, travel inside the file.
 *
 * The reader makes one decision, not one per command: they tick the fixes
 * they want, the saving and the script follow at once, and they copy one
 * script. Fixes that can be undone start ticked; permanent ones never do.
 */
import { billLines, comparisonLine, header, money, onlyNewLine, regionsWithFindings, type ReportOptions, shortId, shownFindings, skippedLine, words } from "./report.js";
import { ARCHIVO, COURIER_PRIME_400, COURIER_PRIME_700 } from "./fonts.js";
import type { Finding, Fix, ScanResult } from "./types.js";

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** What a reader must know before running a fix, in words as well as colour. */
const RISK_NOTE: Record<Fix["risk"], string> = {
  dangerous: "Permanent. Needs explicit approval before anyone runs it.",
  caution: "Review before running. It can be undone.",
};

const face = (family: string, weight: string, data: string) =>
  `@font-face { font-family: "${family}"; src: url(data:font/woff2;base64,${data}) format("woff2"); font-weight: ${weight}; }`;

const STYLE = `
${face("Archivo", "400 900", ARCHIVO)}
${face("Courier Prime", "400", COURIER_PRIME_400)}
${face("Courier Prime", "700", COURIER_PRIME_700)}
/* A printed statement, audited by hand: black ink on paper, highlighter over
   the money that bought nothing, red for what cannot be undone. Light only. */
:root {
  --paper: #fcfdf8; --band: #e4f1e3; --ink: #0d0d0d; --soft: #4b4f48; --line: #b9beb2;
  --marker: #fff04a; --red: #cf2318; --red-wash: #fbeceb; --red-on-ink: #ff9a90;
  --print: "Courier Prime", "Courier New", Courier, ui-monospace, monospace;
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 1.0625rem/1.55 Archivo, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
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
.bill { margin: 0 0 2.25rem; font-weight: 700; }
.bill span { display: block; }
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
.fix label { display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer; }
.fix input { flex: none; width: 1.25rem; height: 1.25rem; margin: 0.1rem 0 0; accent-color: var(--ink); cursor: pointer; }
.fix[data-risk="dangerous"] input { accent-color: var(--red); }
.fix input:focus-visible { outline: 3px solid var(--red); outline-offset: 2px; }
.fix:has(input:checked) { border-left-width: 11px; }
.risk { margin: 0.1rem 0 0.6rem; font-weight: 700; }
.fix[data-risk="dangerous"] .risk { color: var(--red); }
.command { background: var(--ink); color: var(--paper); padding: 0.6rem 0.9rem; margin: 0.5rem 0; }
.command code { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
.wayback { margin: 0.6rem 0 0; overflow-wrap: anywhere; }

.script { border-top: 3px solid var(--ink); padding-top: 1.25rem; margin-bottom: 2rem; scroll-margin-top: 1rem; }
.script h2 { font-size: 1.375rem; font-weight: 900; letter-spacing: -0.02em; margin: 0 0 0.6rem; }
.script p { margin: 0 0 0.9rem; max-width: 46rem; }
.script pre { margin: 0; background: var(--ink); color: var(--paper); padding: 1rem 1.1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.script code { font-weight: 400; }

/* The decision, always in view: what the ticked fixes save, and the one button. */
.bar {
  position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1.5rem;
  margin: 2rem -1.75rem 0; padding: 0.9rem 1.75rem; background: var(--ink); color: var(--paper);
}
.bar p { flex: 1 1 20rem; margin: 0; }
.bar strong { display: inline-block; font: 700 1.375rem/1.2 var(--print); background: var(--marker); color: var(--ink); padding: 0.05em 0.35em; margin-right: 0.2rem; border-radius: 0.2em 0.7em 0.3em 0.6em; }
.bar .permanent { color: var(--red-on-ink); font-weight: 700; }
.bar a { color: var(--paper); }
.bar button {
  font: 800 1rem/1 Archivo, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink); background: var(--marker);
  border: 0; padding: 0.7rem 1.1rem; min-width: 8.5rem; cursor: pointer;
}
.bar button:hover { background: #fff; }
.bar button:disabled { background: var(--line); cursor: not-allowed; }
.bar a:focus-visible, .bar button:focus-visible { outline: 3px solid var(--red-on-ink); outline-offset: 2px; }

.notes { border-top: 3px solid var(--ink); margin-top: 0.5rem; padding-top: 1.25rem; font-family: var(--print); color: var(--soft); }
.notes p, .notes li { overflow-wrap: anywhere; }

@media (max-width: 40rem) {
  main { padding-inline: 1.1rem; }
  .finding { grid-template-columns: 1fr; row-gap: 0.6rem; }
  .amount { text-align: left; }
  .amount small { display: inline; margin-left: 0.5rem; }
  .bar { margin-inline: -1.1rem; padding-inline: 1.1rem; }
}
@media print {
  body { font-size: 10.5pt; }
  main { max-width: none; padding: 0; }
  .finding, .fix, .summary { break-inside: avoid; }
  .command, .script pre { background: #fff; color: #000; border: 1px solid #000; }
  .bar { position: static; margin-inline: 0; background: #fff; color: #000; border: 1px solid #000; }
  .bar .permanent { color: var(--red); }
  .bar a, .bar button { display: none; }
  .replay, .amount mark, .bar strong, .fix { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/**
 * The words and the script that follow from what is ticked. This one piece of
 * JavaScript is run here for the first paint and shipped in the page for every
 * change after it, so the two can never disagree.
 */
const SHARED = `
function tally(count, usd, permanent) {
  if (count === 0) return ["$0.00", "a month. Nothing is in your script yet: tick a fix to add it.", ""];
  var fixes = count === 1 ? "the 1 fix" : "the " + count + " fixes";
  var risk = permanent === 0
    ? (count === 1 ? "It can be undone." : "All of them can be undone.")
    : (count === 1 ? "It is permanent." : permanent + " of them " + (permanent === 1 ? "is" : "are") + " permanent.");
  return ["$" + usd.toFixed(2), "a month saved by " + fixes + " in your script.", risk];
}
function scriptText(head, parts) {
  return head + "\\n\\n" + (parts.length ? parts.join("\\n\\n") : "# Nothing chosen yet. Tick a fix in the report to add it here.") + "\\n";
}
`;
const shared = new Function(`${SHARED}; return { tally: tally, scriptText: scriptText };`)() as {
  tally(count: number, usd: number, permanent: number): [saving: string, sentence: string, risk: string];
  scriptText(head: string, parts: string[]): string;
};

/** Keeps the tally and the script in step with the ticked fixes, and copies the script. */
const pageScript = (head: string) => `
(function () {
  ${SHARED}
  var HEAD = ${JSON.stringify(head).replace(/</g, "\\u003c")};
  var code = document.getElementById("script-text");
  if (!code) return;
  var boxes = Array.prototype.slice.call(document.querySelectorAll("input[data-lines]"));
  var copy = document.getElementById("copy");
  var show = function (id, text) { document.getElementById(id).textContent = text; };

  function update() {
    var chosen = boxes.filter(function (box) { return box.checked; });
    var usd = chosen.reduce(function (sum, box) { return sum + Number(box.getAttribute("data-usd")); }, 0);
    var permanent = chosen.filter(function (box) { return box.getAttribute("data-risk") === "dangerous"; }).length;
    var words = tally(chosen.length, usd, permanent);
    show("saving", words[0]);
    show("tally", words[1]);
    show("risk", words[2]);
    document.getElementById("risk").className = permanent ? "permanent" : "";
    code.textContent = scriptText(HEAD, chosen.map(function (box) { return box.getAttribute("data-lines"); }));
    copy.disabled = chosen.length === 0;
  }

  document.addEventListener("change", function (event) {
    var box = event.target;
    if (boxes.indexOf(box) === -1) return;
    // A finding is fixed one way or the other, never both.
    if (box.checked) {
      boxes.forEach(function (other) {
        if (other !== box && other.getAttribute("data-finding") === box.getAttribute("data-finding")) other.checked = false;
      });
    }
    update();
  });

  copy.addEventListener("click", function () {
    var done = function () {
      copy.textContent = "Copied";
      setTimeout(function () { copy.textContent = "Copy script"; }, 1500);
    };
    // Where the clipboard is unavailable, select the script so it can be copied by hand.
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

  copy.hidden = false;
  update();
})();
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

const commands = (list: string[]) => list.map((c) => `<div class="command"><code>${escape(c)}</code></div>`).join("\n");

/** One thing a reader can put in their script: a finding's fix, or its gentler alternative. */
interface Choice {
  /** Which finding it belongs to: a finding takes one of its choices at most. */
  finding: number;
  heading: string;
  fix: Fix;
  savingUsd: number;
  /** Ticked when the report opens. Only ever a fix that can be undone. */
  chosen: boolean;
  /** What it adds to the script. */
  lines: string;
}

const comment = (text: string) => `# ${text.replace(/\s*\n\s*/g, " ")}`;

function scriptLines(f: Finding, fix: Fix, what: string, savingUsd: number): string {
  return [
    comment(`${what} (${f.resourceIds.map(shortId).join(", ")}) in ${f.region}: saves ${money(savingUsd)} a month`),
    comment(fix.risk === "dangerous" ? `PERMANENT. ${fix.rollback}` : `Way back: ${fix.rollback}`),
    ...fix.commands,
  ].join("\n");
}

function choicesFor(f: Finding, finding: number): Choice[] {
  const alt = f.alternative;
  const main: Choice = { finding, heading: "Fix", fix: f.fix, savingUsd: f.monthlyCostUsd, chosen: f.fix.risk === "caution", lines: scriptLines(f, f.fix, f.title, f.monthlyCostUsd) };
  if (!alt) return [main];
  return [
    main,
    {
      finding,
      heading: `Or: ${alt.description}, saving ${money(alt.monthlySavingUsd)} a month`,
      fix: alt,
      savingUsd: alt.monthlySavingUsd,
      chosen: !main.chosen && alt.risk === "caution",
      lines: scriptLines(f, alt, `${f.title}: ${alt.description}`, alt.monthlySavingUsd),
    },
  ];
}

function fixBlock(c: Choice): string {
  return `<section class="fix" data-risk="${c.fix.risk}">
<h3><label><input type="checkbox" data-finding="${c.finding}" data-usd="${c.savingUsd}" data-risk="${c.fix.risk}" data-lines="${escape(c.lines)}"${c.chosen ? " checked" : ""}><span>${escape(c.heading)}</span></label></h3>
<p class="risk">${RISK_NOTE[c.fix.risk]}</p>
${commands(c.fix.commands)}
<p class="wayback"><strong>Way back:</strong> ${escape(c.fix.rollback)}</p>
</section>`;
}

/** The report as a complete HTML document. */
export function renderHtml(result: ScanResult, options: ReportOptions & { summary?: string; banner?: string } = {}): string {
  const count = result.findings.length;
  const headline =
    count === 0
      ? "No waste found."
      : `${money(result.totalMonthlyWasteUsd)} a month of estimated waste, in ${count} finding${count === 1 ? "" : "s"}.`;
  const [, pricesLine, usageLine] = header(result);
  const { scope, places } = words(result);
  const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);
  const regions =
    result.regions.length === 1
      ? result.regions[0]!
      : `${result.regions.length} scanned, findings in ${regionsWithFindings(result).join(", ") || "none"}`;

  const since = comparisonLine(result);
  const bill = billLines(result);
  const resolved = result.comparison?.resolved ?? [];
  const shown = shownFindings(result, options.onlyNew);
  const note = [since, onlyNewLine(result, shown, options)].filter(Boolean).join(" ");
  const choices = shown.map(choicesFor);
  const chosen = choices.flat().filter((c) => c.chosen);
  const head = [
    `# CloudPilot fix script for ${result.cluster ? "cluster" : "AWS account"} ${result.accountId}`,
    `# From the scan of ${result.scannedAt}. CloudPilot has run none of this.`,
    "# Read every line before you run it.",
  ].join("\n");
  const [saving, sentence, risk] = shared.tally(
    chosen.length,
    chosen.reduce((sum, c) => sum + c.savingUsd, 0),
    chosen.filter((c) => c.fix.risk === "dangerous").length,
  );
  const findings = shown
    .map(
      (f, n) => `<article class="finding">
<p class="amount"><mark>${money(f.monthlyCostUsd)}</mark><small>a month</small></p>
<div>
<h2>${f.isNew ? '<span class="new">New</span> ' : ""}${escape(f.title)}</h2>
<p class="where"><span class="id" title="${escape(f.resourceIds.join(", "))}">${escape(f.resourceIds.map(shortId).join(", "))}</span> in ${escape(f.region)}, ${escape(f.resourceType)}, rule confidence ${Math.round(f.confidence * 100)}%</p>
<ul>
${f.evidence.map((e) => `<li>${escape(e)}</li>`).join("\n")}
</ul>
<p class="basis">Cost: ${escape(f.costBasis)}</p>
${choices[n]!.map(fixBlock).join("\n")}
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
<title>CloudPilot scan of ${scope} ${escape(result.accountId)}</title>
<style>${STYLE}</style>
</head>
<body>
${options.banner ? `<p class="replay" role="note">${escape(options.banner)}</p>` : ""}
<main>
<h1>${escape(headline)}</h1>
<dl class="facts">
<div><dt>${capital(scope)}</dt><dd>${escape(result.accountId)}</dd></div>
<div><dt>${capital(places)}</dt><dd>${escape(regions)}</dd></div>
<div><dt>Scanned</dt><dd>${escape(result.scannedAt)}</dd></div>
<div><dt>Prices</dt><dd>${escape((pricesLine ?? "").replace(/^Prices: /, ""))}</dd></div>
${usageLine ? `<div><dt>Usage</dt><dd>${escape(usageLine.replace(/^Usage: /, ""))}</dd></div>` : ""}
</dl>
${note ? `<p class="since">${escape(note)}</p>` : ""}
${bill.length > 0 ? `<p class="bill">${bill.map((l) => `<span>${escape(l)}</span>`).join("")}</p>` : ""}
${resolved.length > 0 ? `<section class="resolved">\n<h2>Resolved since the last scan</h2>\n<ul>\n${resolved.map((r) => `<li>${escape(r.title)} (${escape(r.resourceIds.map(shortId).join(", "))}), ${money(r.monthlyCostUsd)} a month</li>`).join("\n")}\n</ul>\n</section>` : ""}
${options.summary ? `<section class="summary">\n<h2>Summary</h2>\n${summaryBlocks(options.summary)}\n</section>` : ""}
${findings}
${
  shown.length > 0
    ? `<section class="script" id="script">
<h2>Your script</h2>
<p>Every fix you tick lands here, as one script to read and run yourself. Fixes that can be undone start ticked. Permanent ones are left for you to decide.</p>
<pre><code id="script-text">${escape(shared.scriptText(head, chosen.map((c) => c.lines)))}</code></pre>
</section>`
    : ""
}
<section class="notes">
<p>End of statement. This scan was read-only: it printed these commands and ran none of them.</p>
${skipped ? `<p>${escape(skipped)}</p>` : ""}
${warnings}
</section>
${
  shown.length > 0
    ? `<div class="bar" role="status">
<p><strong id="saving">${saving}</strong> <span id="tally">${sentence}</span> <span id="risk">${risk}</span></p>
<a href="#script">Read the script</a>
<button type="button" id="copy" hidden>Copy script</button>
</div>`
    : ""
}
</main>
${shown.length > 0 ? `<script>${pageScript(head)}</script>` : ""}
</body>
</html>
`;
}
