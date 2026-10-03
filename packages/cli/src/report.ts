import type { Finding, Pattern, ScanResult } from "./types.js";

export const money = (n: number) => `$${n.toFixed(2)}`;

export const RISK_LABEL: Record<Finding["fix"]["risk"], string> = {
  caution: "CAUTION - review before running",
  dangerous: "DANGEROUS - permanent, needs explicit approval",
};

const ANSI = { bold: 1, dim: 2, cyan: 36, yellow: 33 } as const;

/** Colour for a terminal only: plain text when piped, or when NO_COLOR is set. */
function styleText(style: keyof typeof ANSI, text: string): string {
  const wanted = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : process.stdout.isTTY && !process.env.NO_COLOR;
  return wanted ? `\u001b[${ANSI[style]}m${text}\u001b[0m` : text;
}

/**
 * An opaque ID too long to read, such as an S3 upload ID of a hundred
 * characters, cut down for a heading. Fix commands always carry the whole ID.
 * The limit sits above the longest bucket name (63), which is never cut.
 */
export const shortId = (id: string) => (id.length > 64 ? `${id.slice(0, 16)}...${id.slice(-6)}` : id);

/** "ap-south-1" for one region, "17 regions" for several. */
export const regionLabel = (regions: string[]) => (regions.length === 1 ? regions[0]! : `${regions.length} regions`);

/** Regions that have at least one finding, in name order. */
export const regionsWithFindings = (result: ScanResult) => [...new Set(result.findings.map((f) => f.region))].sort();

export function header(result: ScanResult): string[] {
  const where = result.regions.length === 1 ? `region ${result.regions[0]}` : `${result.regions.length} regions scanned`;
  return [
    `Account ${result.accountId}, ${where}, scanned ${result.scannedAt}`,
    `Prices: ${result.prices.source}, fetched ${result.prices.fetchedAt}`,
  ];
}

/** One line on what changed since the earlier scan, when there was one to compare with. */
export function comparisonLine(result: ScanResult): string | undefined {
  const c = result.comparison;
  if (!c) return undefined;
  if (c.newCount === 0 && c.resolved.length === 0) return `Nothing has changed since the last scan (${c.previousScannedAt}).`;
  return `Since the last scan (${c.previousScannedAt}): ${c.newCount} new (${money(c.newMonthlyUsd)} a month), ${c.resolved.length} resolved (${money(c.resolvedMonthlyUsd)} a month), ${c.unchangedCount} unchanged.`;
}

/** The findings a report lists: all of them, or with onlyNew just those the earlier scan did not have. */
export function shownFindings(result: ScanResult, onlyNew = false): Finding[] {
  return onlyNew && result.comparison ? result.findings.filter((f) => f.isNew) : result.findings;
}

const resolvedLines = (result: ScanResult) =>
  (result.comparison?.resolved ?? []).map((r) => `${r.title} (${r.resourceIds.map(shortId).join(", ")}), ${money(r.monthlyCostUsd)} a month`);

export interface ReportOptions {
  /** List only the findings that are new since the earlier scan. */
  onlyNew?: boolean;
}

/** Report for a terminal. */
export function renderText(result: ScanResult, options: ReportOptions = {}): string {
  const bold = (s: string) => styleText("bold", s);
  const dim = (s: string) => styleText("dim", s);
  const lines: string[] = [bold("CloudPilot scan"), ...header(result).map(dim), ""];

  if (result.findings.length === 0) {
    lines.push("No waste found.");
  } else {
    lines.push(bold(`${result.findings.length} findings, ${money(result.totalMonthlyWasteUsd)} per month of estimated waste`));
    const since = comparisonLine(result);
    if (since) lines.push(since);
    const shown = shownFindings(result, options.onlyNew);
    if (shown.length < result.findings.length) lines.push(dim(`Showing only the ${shown.length} new finding${shown.length === 1 ? "" : "s"}.`));
    lines.push("");
    shown.forEach((f, n) => {
      lines.push(`${bold(`${String(n + 1).padStart(2)}. ${money(f.monthlyCostUsd).padStart(8)}/mo  ${f.title}`)}${f.isNew ? styleText("yellow", "  NEW") : ""}`);
      const region = result.regions.length > 1 ? `  ${f.region}` : "";
      lines.push(dim(`    ${f.resourceType}  ${f.resourceIds.map(shortId).join(", ")}${region}  rule confidence ${Math.round(f.confidence * 100)}%`));
      for (const e of f.evidence) lines.push(`    - ${e}`);
      lines.push(dim(`    cost: ${f.costBasis}`));
      lines.push(`    fix (${RISK_LABEL[f.fix.risk]}):`);
      for (const c of f.fix.commands) lines.push(styleText("cyan", `      ${c}`));
      lines.push(dim(`    way back: ${f.fix.rollback}`));
      if (f.alternative) {
        lines.push(`    or: ${f.alternative.description} (saves ${money(f.alternative.monthlySavingUsd)}/mo):`);
        for (const c of f.alternative.commands) lines.push(styleText("cyan", `      ${c}`));
      }
      lines.push("");
    });
    lines.push(dim("CloudPilot is read-only: it prints these commands and never runs them."));
  }

  const resolved = resolvedLines(result);
  if (resolved.length > 0) lines.push("", "Resolved since the last scan:", ...resolved.map((r) => `  - ${r}`));

  const skipped = skippedLine(result);
  if (skipped) lines.push("", skipped);

  if (result.warnings.length > 0) {
    lines.push("", styleText("yellow", `${result.warnings.length} check(s) could not run:`));
    for (const w of result.warnings) lines.push(styleText("yellow", `  - ${w}`));
  }
  return lines.join("\n");
}

/** Report as a Markdown document. */
export function renderMarkdown(result: ScanResult, summary?: string, banner?: string, options: ReportOptions = {}): string {
  const lines: string[] = ["# CloudPilot scan", "", ...(banner ? [`> ${banner}`, ""] : []), ...header(result).map((h) => `- ${h}`), ""];
  lines.push(`**${result.findings.length} findings, ${money(result.totalMonthlyWasteUsd)} per month of estimated waste.**`, "");
  const since = comparisonLine(result);
  if (since) lines.push(since, "");
  if (summary) lines.push("## Summary", "", summary, "");
  const resolved = resolvedLines(result);
  if (resolved.length > 0) lines.push("## Resolved since the last scan", "", ...resolved.map((r) => `- ${r}`), "");

  const shown = shownFindings(result, options.onlyNew);
  if (shown.length > 0) {
    lines.push("| # | Per month | Finding | Resource | Region | Fix risk |", "|---|---|---|---|---|---|");
    shown.forEach((f, n) => {
      lines.push(`| ${n + 1} | ${money(f.monthlyCostUsd)} | ${f.isNew ? "**New:** " : ""}${f.title} | \`${f.resourceIds.map(shortId).join("`, `")}\` | ${f.region} | ${f.fix.risk} |`);
    });
    lines.push("");
    shown.forEach((f, n) => {
      lines.push(`## ${n + 1}. ${f.title}${f.isNew ? " (new)" : ""}`, "");
      lines.push(`- **Cost:** ${money(f.monthlyCostUsd)} per month (${f.costBasis})`);
      lines.push(`- **Resource:** ${f.resourceType} \`${f.resourceIds.join("`, `")}\` in ${f.region}`);
      lines.push(`- **Rule confidence:** ${Math.round(f.confidence * 100)}%`);
      lines.push("- **Evidence:**", ...f.evidence.map((e) => `  - ${e}`));
      lines.push(`- **Fix** (${RISK_LABEL[f.fix.risk]}):`, "", "```sh", ...f.fix.commands, "```", "");
      lines.push(`- **Way back:** ${f.fix.rollback}`);
      if (f.alternative) {
        lines.push(
          `- **Alternative:** ${f.alternative.description}, saving ${money(f.alternative.monthlySavingUsd)} per month:`,
          "",
          "```sh",
          ...f.alternative.commands,
          "```",
        );
      }
      lines.push("");
    });
    lines.push("CloudPilot is read-only: it prints these commands and never runs them.", "");
  }
  const skipped = skippedLine(result);
  if (skipped) lines.push(skipped, "");
  if (result.warnings.length > 0) {
    lines.push("## Checks that could not run", "", ...result.warnings.map((w) => `- ${w}`), "");
  }
  return lines.join("\n");
}

/** How many resources the ignore tag left out, so skipping is never silent. */
export function skippedLine(result: ScanResult): string | undefined {
  const n = result.skippedByTag.length;
  if (n === 0) return undefined;
  return `${n} resource${n === 1 ? " was" : "s were"} skipped because of the tag cloudpilot:ignore=true: ${result.skippedByTag.join(", ")}`;
}

export const KIND: Record<Pattern, string> = {
  "unattached-ebs-volume": "Unattached EBS volumes",
  "gp2-volume": "gp2 volumes that could be gp3",
  "idle-elastic-ip": "Idle Elastic IPs",
  "stopped-instance": "Stopped instances still paying for storage",
  "idle-instance": "Idle running instances",
  "orphaned-snapshot": "Snapshots of deleted volumes",
  "unused-ami": "Unused AMIs",
  "bucket-without-lifecycle": "Buckets with no lifecycle rule",
  "incomplete-multipart-upload": "Incomplete multipart uploads",
};

/**
 * A summary built from the findings alone, with no model involved. Shown when
 * no model is available, or when a model's text fails the output check.
 * `shortenIds` cuts very long IDs down, for a summary a person will read;
 * callers that pass the text to a model leave it off and get whole IDs.
 */
export function templatedSummary(result: ScanResult, options: { shortenIds?: boolean } = {}): string {
  const label = (ids: string[]) => (options.shortenIds ? ids.map(shortId) : ids).join(", ");
  if (result.findings.length === 0) {
    return [`No waste found in ${regionLabel(result.regions)}.`, ...(skippedLine(result) ? [skippedLine(result)!] : [])].join("\n");
  }
  const where =
    result.regions.length === 1
      ? result.regions[0]!
      : `${regionsWithFindings(result).length} of the ${result.regions.length} regions scanned`;
  const lines = [
    `Estimated waste: ${money(result.totalMonthlyWasteUsd)} per month across ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} in ${where}.`,
    ...(comparisonLine(result) ? [comparisonLine(result)!] : []),
    "",
    "By kind, most expensive first:",
  ];
  const groups = new Map<Pattern, Finding[]>();
  for (const f of result.findings) groups.set(f.pattern, [...(groups.get(f.pattern) ?? []), f]);
  const total = (fs: Finding[]) => fs.reduce((sum, f) => sum + f.monthlyCostUsd, 0);
  for (const [pattern, fs] of [...groups].sort((a, b) => total(b[1]) - total(a[1]))) {
    const risk = fs[0]!.fix.risk === "dangerous" ? "the fix is permanent" : "the fix can be reviewed and reversed";
    lines.push(`- ${KIND[pattern]}: ${fs.length} finding${fs.length === 1 ? "" : "s"}, ${money(total(fs))} per month; ${risk}.`);
  }

  if (result.regions.length > 1) {
    const withFindings = regionsWithFindings(result);
    lines.push("", "By region:");
    for (const region of withFindings) {
      const fs = result.findings.filter((f) => f.region === region);
      lines.push(`- ${region}: ${fs.length} finding${fs.length === 1 ? "" : "s"}, ${money(total(fs))} per month.`);
    }
    const clean = result.regions.length - withFindings.length;
    if (clean > 0) lines.push(`- ${clean} other region${clean === 1 ? "" : "s"}: nothing found.`);
  }

  const top = result.findings[0]!;
  lines.push("", `Largest single finding: ${top.title} (${label(top.resourceIds)}), ${money(top.monthlyCostUsd)} per month.`);
  const safest = result.findings
    .flatMap((f) => (f.alternative ? [{ ids: f.resourceIds, saving: f.alternative.monthlySavingUsd, what: f.alternative.description }] : []))
    .sort((a, b) => b.saving - a.saving)[0];
  if (safest) {
    lines.push(`Lowest-risk saving: ${safest.what} (${label(safest.ids)}), ${money(safest.saving)} per month, reversible.`);
  }
  if (groups.has("orphaned-snapshot") || groups.has("unused-ami")) {
    lines.push("Snapshot and AMI costs are upper bounds based on provisioned size.");
  }
  const skipped = skippedLine(result);
  if (skipped) lines.push(skipped);
  lines.push("Nothing has been changed: every fix is a proposal for a person to review and run.");
  return lines.join("\n");
}
